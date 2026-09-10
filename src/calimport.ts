/*
 * M365-001 part 2 — the calendar import (#99).
 *
 * Reads a week of Outlook events and proposes time entries. PREVIEW, ADJUST, APPROVE: nothing is written
 * until the approve button is pressed, and every proposal is editable on the way through — the
 * recurring requirement was to review, adjust, and only then approve or finalize.
 *
 * ON DEMAND, NOT CONTINUOUS. "I don't need that to run until the end of the week... I do not need to know
 * the time count until the week is over." So there are no change notifications, no webhook and no
 * subscription to renew — a button that pulls a week is the whole trigger, and that removed real machinery
 * from the design rather than deferring it.
 *
 * WHY THIS IS A PROPOSAL AND NOT AN IMPORT
 * ---------------------------------------
 * A calendar is a claim about where time went, not a record of it. Meetings run over, get cancelled without
 * being deleted, and whole afternoons of work never appear. Three things a real Outlook calendar can
 * produce make that concrete, and each one is handled explicitly below rather than averaged away:
 *
 *   - a large share of events in a given week can carry no category at all
 *   - a "quick call" event can fully CONTAIN a longer working session, so summing durations overstates
 *     the actual time worked
 *   - a typo'd category (e.g. a misspelled client name) would become a customer called that, because the
 *     client-tag convention is a bare company name (definitions.md §5a)
 *
 * THE ACCURACY BUDGET IS NOT EVEN. A billable client row becomes an invoice, so an error there reaches
 * somebody else's money; everything else is the operator looking at their own week. Rows that would bill
 * are marked, and the ones that cannot be attributed are refused rather than guessed at.
 */

import { Hono } from "hono";
import { activityOptions, loadActivities } from "./activities";
import { pickableEngagements } from "./engagements";
import { graphBase, msAccessToken, msConnection } from "./msgraph";
import { esc, layout, select } from "./views";
import { BILLABLE_ACTIVITY, type Bindings, type D1Db } from "./types";
import { shiftWeek, weekBounds } from "./weeks";

const app = new Hono<{ Bindings: Bindings }>();
const ACTOR = "operator";
const today = () => new Date().toISOString().slice(0, 10);

/** Graph's shape, only the fields used. Anything else in the payload is ignored rather than modelled. */
interface GraphEvent {
  id: string;
  subject?: string | null;
  categories?: string[] | null;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string | null;
  location?: { displayName?: string | null } | null;
  start?: { dateTime?: string; timeZone?: string } | null;
  end?: { dateTime?: string; timeZone?: string } | null;
}

/** Why a row is not ticked by default, or needs a look before it is. */
export type FlagKind =
  | "no_activity"
  | "unknown_activity"
  | "two_activities"
  | "two_clients"
  | "unknown_client"
  | "ambiguous_client"
  | "hand_edited"
  | "no_engagement"
  | "overlap"
  | "all_day"
  | "cancelled"
  | "free"
  | "zero_length"
  | "already_imported";

export interface ProposedEntry {
  event_id: string;
  subject: string;
  date: string;
  start: string;
  end: string;
  hours: number;
  activity: string | null;
  /** The bare company name from the categories, before matching. */
  client_name: string | null;
  engagement_id: number | null;
  engagement_label: string | null;
  location: string | null;
  /**
   * The operator's comment, if this event has been imported before. Carried into the preview so
   * re-importing a week shows what was already written and round-trips it back untouched — the
   * alternative is a blank box that silently erases the comment on approve, which is exactly the
   * failure this field was added to fix (migration 0017).
   */
  comment: string | null;
  flags: FlagKind[];
  /** Ticked by default? False whenever a human needs to decide something first. */
  include: boolean;
}

/*
 * Each flag has a SHORT label for the row and a sentence for the legend below the table.
 *
 * Not one long string in a pill: `.pill` is white-space:nowrap, so a sentence in one pushed this page 162px
 * wider than a 390px phone — measured, and the second time that mistake has been made in this codebase
 * (the first was the Needs Attention row in REL-027). Pills are labels; explanations are prose.
 *
 * The sentence appears ONCE, in a legend listing only the flags actually present this week. Repeating
 * "importing both double-counts the same time" on both halves of every overlap is noise that trains you to
 * stop reading the flags at all.
 */
const FLAG_TEXT: Record<FlagKind, { short: string; why: string }> = {
  no_activity: { short: "no category", why: "The event has no activity category. Pick one, or leave the row unticked." },
  unknown_activity: {
    short: "unknown category",
    why: "The category on the event is not one of the ten activities — almost always a spelling that has drifted from the Outlook standard (definitions.md §5a). Because client categories are bare company names, a misspelled activity also looks like a new client, which is why these rows show two flags.",
  },
  two_activities: { short: "two categories", why: "Two activity categories on one event. Pick which one it actually was." },
  two_clients: { short: "two clients", why: "Two client categories on one event. Pick which customer this time should bill to." },
  unknown_client: { short: "unknown client", why: "That client category does not match any organization in the platform, by name or by its Outlook category. Add the customer first, set its Outlook category on the Customers page, or import the row with no customer." },
  ambiguous_client: { short: "two customers match", why: "More than one organization answers to that category — either two share the same Outlook category, or one's category equals another's name. Nothing is guessed, because picking the wrong one on a Client Delivery row bills the wrong company. Make the categories distinct on the Customers page, or set the customer here by hand." },
  no_engagement: { short: "no engagement", why: "The organization exists but has no engagement to log against. Create one on the Customers page if this time needs to be attributed. A prospective or on-hold engagement counts — only completed ones are excluded." },
  overlap: { short: "overlap", why: "This event overlaps another one on the same day. Importing both counts the same time twice — flagged on both, because which of the two is the real block is your call." },
  all_day: { short: "all-day", why: "An all-day event, so its length is a guess rather than a fact. Set the hours you actually worked." },
  cancelled: { short: "cancelled", why: "Cancelled in Outlook, so it probably did not happen." },
  free: { short: "shown as Free", why: "Marked Free rather than Busy in Outlook, which usually means a placeholder rather than worked time." },
  zero_length: { short: "no duration", why: "Start and end are the same, so there are no hours to import." },
  hand_edited: {
    /*
     * "corrected", not "you corrected this" — the longer label measured 5px of horizontal overflow on a
     * 390px phone when it sat beside "already imported", because `.pill` is white-space:nowrap. That is the
     * THIRD time this exact mistake has been made in this codebase (REL-027's Needs Attention row, then the
     * flag sentences on this very page). Pills are labels. If a label needs a verb and a pronoun to be
     * clear, the clarity belongs in the legend, which is where the full sentence below already lives.
     */
    short: "corrected",
    why: "You edited this entry after it was imported, so it no longer matches Outlook — most often because a meeting ran longer than it was booked for. It is left unticked and the import will NOT overwrite your version. Tick it only if you want Outlook's numbers back instead; that is treated as a deliberate instruction and hands the row back to the import.",
  },
  already_imported: { short: "already imported", why: "A previous import of this week already created an entry for this event. Approving again updates that entry rather than adding a second one." },
};

/** Flags that must never be silently ticked past: each one needs a decision, not a default. */
const BLOCKING: FlagKind[] = [
  "no_activity",
  "unknown_activity",
  "two_activities",
  "two_clients",
  "ambiguous_client",
  "hand_edited",
  "overlap",
  "all_day",
  "cancelled",
  "free",
  "zero_length",
];

/*
 * THE FALLBACK TIMEZONE, when Graph will not say what the mailbox uses.
 *
 * Set to Central because that is the fallback that matched the operator's own mailbox setting when this
 * was written — a deployment with a different home timezone should update this constant to match.
 *
 * WINDOWS NAME, NOT IANA — `America/Chicago` would be the modern spelling, but `/me/mailboxSettings`
 * returns Windows names ("Central Standard Time"), and this value goes into the same `Prefer:
 * outlook.timezone` header as that one. Keeping both in one vocabulary means the fallback path and the
 * normal path cannot behave differently, and Graph has accepted Windows names since forever whereas its
 * IANA support has been added over time and is the riskier bet for a value that only ever runs when
 * something has already gone wrong.
 *
 * "STANDARD TIME" STILL MEANS CDT IN AUGUST. The Windows zone id names the zone, not the current offset —
 * `Central Standard Time` observes daylight saving and resolves to CDT from March to November. It reads
 * like a bug and is not one. Do not "fix" it to `Central Daylight Time`, which is not a valid zone id.
 */
const FALLBACK_TIMEZONE = "Central Standard Time";

/**
 * The timezone to read the calendar in, so a 7pm Central meeting lands on the right DAY.
 *
 * Graph returns UTC unless asked otherwise, and an evening event in Central is the next day in UTC — which
 * would silently move hours between weeks at the boundary. Asked of the mailbox first rather than assumed:
 * that is one call, and it is what makes this correct for anyone whose working timezone is not the
 * fallback above (PKG-001).
 *
 * WHEN THAT CALL FAILS, CENTRAL IS A BETTER GUESS THAN UTC — and the previous version guessed UTC, which
 * is nobody's actual working day. UTC is only the honest answer if the alternative is a fabrication; here
 * there is a known right answer for the one person using this. Overridable with `MS_TIMEZONE` so a
 * distributed copy sets its own without editing code, and the page always says which of the two it used,
 * because an assumption you can see is an assumption you can correct.
 *
 * WHY NOT THE BROWSER'S TIMEZONE. The obvious idea — read `Intl.DateTimeFormat().resolvedOptions()
 * .timeZone` from the laptop — cannot work here: the calendar is fetched server-side while rendering the
 * GET, before any script on the page has run. Getting it would take a redirect round-trip to hand the zone
 * back, which is real machinery to replace a value the mailbox already answers correctly and a constant
 * covers when it does not.
 */
async function resolveTimeZone(
  env: Bindings,
  token: string
): Promise<{ tz: string; fromMailbox: boolean }> {
  const fallback = { tz: env.MS_TIMEZONE ?? FALLBACK_TIMEZONE, fromMailbox: false };
  try {
    const res = await fetch(`${graphBase(env)}/me/mailboxSettings`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return fallback;
    const body = (await res.json()) as { timeZone?: string };
    return body.timeZone ? { tz: body.timeZone, fromMailbox: true } : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A week of events from `calendarView`, NOT `/me/events`.
 *
 * That choice is load-bearing: calendarView expands a recurring series into its individual occurrences,
 * which is what a timesheet needs. `/me/events` returns the series master instead, so a daily 30-minute
 * habit would appear once for the whole week and every occurrence after the first would vanish.
 */
async function fetchWeek(
  env: Bindings,
  token: string,
  start: string,
  end: string,
  tz: string
): Promise<{ events: GraphEvent[] } | { error: string }> {
  const url = new URL(`${graphBase(env)}/me/calendarView`);
  url.searchParams.set("startDateTime", `${start}T00:00:00`);
  url.searchParams.set("endDateTime", `${end}T23:59:59`);
  url.searchParams.set(
    "$select",
    "id,subject,categories,isAllDay,isCancelled,showAs,location,start,end"
  );
  url.searchParams.set("$top", "250");
  url.searchParams.set("$orderby", "start/dateTime");
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  // The Prefer header is how Graph is told which timezone to render times in.
  if (tz) headers.Prefer = `outlook.timezone="${tz}"`;
  try {
    const res = await fetch(url.toString(), { headers });
    if (!res.ok)
      return {
        error: `Microsoft refused the calendar request (HTTP ${res.status}). If this persists, check the app registration still has Calendars.Read.`,
      };
    const body = (await res.json()) as { value?: GraphEvent[] };
    return { events: body.value ?? [] };
  } catch (e) {
    return { error: `Could not reach Microsoft: ${String(e)}` };
  }
}

const hoursBetween = (a: string, b: string) =>
  Math.round(((Date.parse(b) - Date.parse(a)) / 3_600_000) * 100) / 100;

/**
 * Turn events into proposals.
 *
 * CATEGORY SPLIT. Any category that IS one of the ten activities is the activity; anything else is taken as
 * a client name, because that is the convention actually in use (definitions.md §5a — bare company names,
 * no `Client:` prefix). The cost of that convention is stated there and handled here: a misspelled activity
 * cannot be distinguished from a client name by shape, so `Client Deliverry` arrives as an unknown client
 * AND the event has no activity — two flags, both blocking. It is never quietly created as a customer.
 */
export async function proposeWeek(
  db: D1Db,
  events: GraphEvent[],
  engagements: { id: number; label: string }[]
): Promise<ProposedEntry[]> {
  // Organization name → active engagement, for matching a client category. Lowercased for comparison
  // because Outlook categories are typed by hand and casing varies for what is otherwise the same customer.
  /*
   * MATCH ON `calendar_tag` FIRST, FALLING BACK TO THE ORGANIZATION NAME (migration 0018).
   *
   * Nobody types a legal entity name into a calendar category. The operator writes the short name they
   * know a client by; the organization record carries the full legal name. Both are correct — the invoice
   * needs the long one, the category wants the short one — so the platform holds both rather than forcing
   * either to be wrong.
   *
   * The name is still matched when no tag is set, so every organization that already worked keeps working
   * with no data entry. A category that already matches an organization's plain name needs no tag at all.
   *
   * AND `status <> 'complete'`, NOT `status = 'active'` — same reasoning as pickableEngagements(). A
   * prospective engagement is exactly what Business Development hours attach to; refusing to match one
   * meant a freshly created customer's calendar rows came back as "no engagement" for that customer.
   */
  const { results: orgRows } = await db
    .prepare(
      `SELECT o.id AS org_id, o.name AS org_name, o.calendar_tag,
              e.id AS engagement_id, e.name AS engagement_name, e.status AS engagement_status
         FROM organization o
         LEFT JOIN engagement e ON e.organization_id = o.id AND e.status <> 'complete'
        ORDER BY o.id, (e.status <> 'active'), e.id`
    )
    .all<{
      org_id: number;
      org_name: string;
      calendar_tag: string | null;
      engagement_id: number | null;
      engagement_name: string | null;
      engagement_status: string | null;
    }>();
  const byOrg = new Map<string, { engagement_id: number | null; label: string; org_id: number }>();
  /*
   * Two organizations resolving to the same category is not a database error — `calendar_tag` is
   * deliberately not UNIQUE (see 0018) — so it is caught here, where the two candidates can actually be
   * named on the row instead of failing at a constraint with a message no one can act on.
   */
  const ambiguous = new Set<string>();
  for (const r of orgRows) {
    const key = (r.calendar_tag ?? r.org_name).trim().toLowerCase();
    if (!key) continue;
    const seen = byOrg.get(key);
    if (seen) {
      // A second ROW for the same organization is just its second engagement — the ORDER BY has already put
      // the active one first, so the first row wins. A different organization is a genuine collision.
      if (seen.org_id !== r.org_id) ambiguous.add(key);
      continue;
    }
    byOrg.set(key, {
      org_id: r.org_id,
      engagement_id: r.engagement_id,
      label: r.engagement_name ? `${r.org_name} — ${r.engagement_name}` : r.org_name,
    });
  }

  /*
   * Rows a previous import created, with whatever the operator has since written on them. Only `source =
   * 'calendar'` rows are read: a hand-typed entry that happens to carry an outlook_ref is not this
   * import's to update, so pulling its comment into the preview would put someone else's words in a box
   * that then writes them to a different row.
   */
  const { results: seen } = await db
    .prepare(
      "SELECT outlook_ref, note, hand_edited FROM time_entry WHERE outlook_ref IS NOT NULL AND source = 'calendar'"
    )
    .all<{ outlook_ref: string; note: string | null; hand_edited: number }>();
  const already = new Map(seen.map((r) => [r.outlook_ref, r]));

  // Loaded once per proposal run rather than passed in, so every caller of proposeWeek automatically sees
  // an activity added a moment ago (self-service, migration 0026) with no extra plumbing.
  const activityValues = (await loadActivities(db)).map((a) => a.name);

  const proposals: ProposedEntry[] = [];
  for (const ev of events) {
    const startRaw = ev.start?.dateTime;
    const endRaw = ev.end?.dateTime;
    if (!startRaw || !endRaw) continue;
    const flags: FlagKind[] = [];

    const cats = (ev.categories ?? []).filter((c) => c && c.trim());
    const activities = cats.filter((c) => activityValues.includes(c));
    const others = cats.filter((c) => !activityValues.includes(c));

    let activity: string | null = null;
    if (activities.length === 1) activity = activities[0];
    else if (activities.length > 1) flags.push("two_activities");
    else if (others.length) flags.push("unknown_activity");
    else flags.push("no_activity");

    let clientName: string | null = null;
    let engagementId: number | null = null;
    let engagementLabel: string | null = null;
    if (others.length === 1) {
      clientName = others[0];
      const key = clientName.trim().toLowerCase();
      const match = byOrg.get(key);
      if (ambiguous.has(key)) {
        // Two customers answer to this category. Naming one would be a coin toss on a row that may bill.
        flags.push("ambiguous_client");
        engagementLabel = match?.label ?? null;
      } else if (!match) flags.push("unknown_client");
      else if (match.engagement_id === null) {
        flags.push("no_engagement");
        engagementLabel = match.label;
      } else {
        engagementId = match.engagement_id;
        engagementLabel = match.label;
      }
    } else if (others.length > 1) {
      flags.push("two_clients");
    }

    const hours = hoursBetween(startRaw, endRaw);
    if (!(hours > 0)) flags.push("zero_length");
    if (ev.isAllDay) flags.push("all_day");
    if (ev.isCancelled) flags.push("cancelled");
    if ((ev.showAs ?? "busy") === "free") flags.push("free");
    if (already.has(ev.id)) flags.push("already_imported");
    // A row the operator has since corrected. Flagged AND blocking, so re-importing a week never quietly
    // reverts a correction to hours that may be on an invoice (migration 0019).
    if (already.get(ev.id)?.hand_edited) flags.push("hand_edited");

    proposals.push({
      event_id: ev.id,
      subject: ev.subject ?? "(no subject)",
      date: startRaw.slice(0, 10),
      start: startRaw.slice(11, 16),
      end: endRaw.slice(11, 16),
      // Clamped to the CHECK constraint's ceiling so an odd all-day event cannot make the save fail.
      hours: Math.min(24, Math.max(0, hours)),
      activity,
      client_name: clientName,
      engagement_id: engagementId,
      engagement_label: engagementLabel,
      location: ev.location?.displayName ?? null,
      comment: already.get(ev.id)?.note ?? null,
      flags,
      include: false,
    });
  }

  /*
   * OVERLAPS. Flagged on BOTH events, not just the later one — neither is more wrong than the other, and
   * which of the two is the real block is the operator's call. Compared within a day, after sorting by
   * start.
   *
   * This is the check that stops the import overbilling. A shorter working session fully contained inside
   * a longer calendar block would otherwise have both durations summed, overstating the actual time spent.
   */
  const byDay = new Map<string, ProposedEntry[]>();
  for (const p of proposals) {
    const list = byDay.get(p.date) ?? [];
    list.push(p);
    byDay.set(p.date, list);
  }
  for (const list of byDay.values()) {
    const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        // Touching end-to-start is not an overlap: a 14:00 end and a 14:00 start are adjacent.
        if (sorted[j].start < sorted[i].end) {
          if (!sorted[i].flags.includes("overlap")) sorted[i].flags.push("overlap");
          if (!sorted[j].flags.includes("overlap")) sorted[j].flags.push("overlap");
        }
      }
    }
  }

  /*
   * Ticked by default only when there is nothing to decide: an activity is known, and no blocking flag is
   * present. `already_imported` and `no_engagement` are deliberately NOT blocking — re-importing a week is
   * a normal thing to do, and an activity with no customer is valid for internal work. But a Client
   * Delivery row with no engagement is left unticked, because that hour cannot be invoiced and importing it
   * silently would hide the problem.
   */
  for (const p of proposals) {
    const blocked = p.flags.some((f) => BLOCKING.includes(f));
    const billableWithoutCustomer = p.activity === BILLABLE_ACTIVITY && p.engagement_id === null;
    p.include = Boolean(p.activity) && !blocked && !billableWithoutCustomer;
  }

  return proposals.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

// ---------------------------------------------------------------- the page

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayName = (iso: string) => DAY_NAMES[new Date(`${iso}T00:00:00Z`).getUTCDay()] ?? iso;
const fmtH = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
};

/*
 * A HEADING ROW PER DAY, CARRYING THAT DAY'S HOURS.
 *
 * Added on request: it should be easy to see the total number of hours in the batch for each day.
 *
 * TWO NUMBERS, NOT ONE, because they are different questions and on a real week they disagree. "On the
 * calendar" is every event that day; "ticked" is what pressing the button would actually record. A single
 * figure would have to be one or the other: the calendar total reads as a promise the import does not keep
 * (most of a real week is unticked), and the ticked total alone hides how much of the day is being left
 * behind. Shown side by side, the gap IS the information — it is the day's unresolved time.
 *
 * AND THE CALENDAR TOTAL IS MARKED WHEN IT LIES. On a day containing an overlap, summing durations counts
 * the same clock time twice — an overlapping pair of events can sum to well more hours than the actual
 * window they occupy. Presenting that inflated total as "hours on the calendar" with no qualifier would
 * be the double-count wearing the costume of a total, on a page whose whole job is to stop exactly that
 * reaching an invoice.
 */
function dayHeader(date: string, rows: ProposedEntry[]): string {
  const all = rows.reduce((n, p) => n + p.hours, 0);
  const ticked = rows.filter((p) => p.include).reduce((n, p) => n + p.hours, 0);
  const overlapped = rows.some((p) => p.flags.includes("overlap"));
  return `<tr class="dayhead" data-dayhead="${esc(date)}">
    <td colspan="5" style="background:var(--bg-alt,#f6f6f4);border-top:2px solid var(--line)">
      <b>${esc(dayName(date))}</b> <span class="meta">${esc(date)}</span>
      <span style="float:right"><b data-day-ticked="${esc(date)}">${esc(
        fmtH(ticked)
      )}</b> <span class="meta">ticked of ${esc(fmtH(all))} on the calendar${
        overlapped ? " — includes an overlap, so it double-counts" : ""
      }</span></span>
    </td></tr>`;
}

const flagPill = (f: FlagKind) =>
  `<span class="pill ${f === "already_imported" || f === "no_engagement" ? "grey" : "amber"}">${esc(
    FLAG_TEXT[f].short
  )}</span>`;

function row(
  p: ProposedEntry,
  i: number,
  engagements: { id: number; label: string }[],
  activityOpts: readonly (readonly [string, string])[]
): string {
  const billable = p.activity === BILLABLE_ACTIVITY;
  return `<tr data-date="${esc(p.date)}">
    <td data-label="Include" style="text-align:center">
      ${
        /* The checkbox sits in a padded label so the tap target is ~48px. A bare checkbox renders 13px
           tall, which is a miss on a phone — and the wrong one to miss, since ticking is the only thing
           this page asks you to do. Padding rather than a scaled-up box: a 44px checkbox looks broken. */ ""
      }<label style="display:inline-block;padding:12px;cursor:pointer"><input type="checkbox" name="inc_${i}" value="1"${
        p.include ? " checked" : ""
      } style="width:22px;height:22px" aria-label="Import ${esc(p.subject)}"></label>
      <input type="hidden" name="ev_${i}" value="${esc(p.event_id)}">
      <input type="hidden" name="date_${i}" value="${esc(p.date)}">
      <input type="hidden" name="subject_${i}" value="${esc(p.subject)}"></td>
    <td><b>${esc(p.subject)}</b>
      <div class="meta">${esc(p.date)} · ${esc(p.start)}–${esc(p.end)}${
        p.location ? ` · ${esc(p.location)}` : ""
      }</div>
      ${p.client_name ? `<div class="meta">category: ${esc(p.client_name)}</div>` : ""}
      ${p.flags.length ? `<div style="margin-top:4px">${p.flags.map(flagPill).join(" ")}</div>` : ""}
      ${
        /* Comments live INSIDE the event cell, not in a sixth column. Five columns already measured tight
           at 390px, and a sixth text input is what turned this page 162px wider than the phone last time.
           Under the subject is also where the sentence belongs: it is about this event, not a parallel
           attribute of it. */ ""
      }<input type="text" name="cmt_${i}" value="${esc(p.comment)}" placeholder="comments (optional)"
        aria-label="Comments for ${esc(p.subject)}" style="margin-top:6px"></td>
    <td data-label="Hours"><input type="text" name="hours_${i}" value="${esc(
      p.hours
    )}" style="max-width:80px" inputmode="decimal" aria-label="Hours"></td>
    <td data-label="Activity">${select(`act_${i}`, activityOpts, p.activity, { blank: "—" })}${
      billable ? '<div class="meta"><b>billable</b></div>' : ""
    }</td>
    <td data-label="Customer"><select name="eng_${i}" aria-label="Customer"><option value="">— none —</option>${engagements
      .map(
        (e) => `<option value="${e.id}"${e.id === p.engagement_id ? " selected" : ""}>${esc(e.label)}</option>`
      )
      .join("")}</select>${
      p.engagement_label && p.engagement_id === null
        ? `<div class="meta">${esc(p.engagement_label)} has no engagement to log against</div>`
        : ""
    }</td>
  </tr>`;
}

app.get("/time/import", async (c) => {
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("week") ?? "") ? c.req.query("week")! : today();
  const { start, end } = weekBounds(anchor);
  const conn = await msConnection(c.env.DB).catch(() => null);
  const engagements = await pickableEngagements(c.env.DB);

  const nav = `<p class="sub"><a href="/time/import?week=${esc(shiftWeek(anchor, -1))}">← previous week</a> ·
    <b>${esc(start)} to ${esc(end)}</b> ·
    <a href="/time/import?week=${esc(shiftWeek(anchor, 1))}">next week →</a> ·
    <a href="/time?week=${esc(anchor)}">time entry</a> · <a href="/health">connection</a></p>`;

  const shell = (body: string) =>
    c.html(layout({ title: "Import from Outlook", body: `<main><h1>Import from Outlook</h1>${nav}${body}</main>` }));

  if (!conn)
    return shell(
      `<div class="card empty"><p><b>Outlook is not connected.</b></p>
      <p class="meta">Connect it on the health page, then come back. Nothing here can read your calendar until then.</p>
      <div class="actions"><a class="btn" href="/health">Go to health</a></div></div>`
    );

  const token = await msAccessToken(c.env, c.env.DB);
  if ("error" in token)
    return shell(
      `<div class="card"><p class="flash warn">${esc(token.error)}</p>
      <div class="actions"><a class="btn secondary" href="/health">Open the connection panel</a></div></div>`
    );

  const zone = await resolveTimeZone(c.env, token.token);
  const fetched = await fetchWeek(c.env, token.token, start, end, zone.tz);
  if ("error" in fetched)
    return shell(`<div class="card"><p class="flash warn">${esc(fetched.error)}</p></div>`);

  const proposals = await proposeWeek(c.env.DB, fetched.events, engagements);
  const activityDefs = await loadActivities(c.env.DB);
  const ready = proposals.filter((p) => p.include).length;
  const needsLook = proposals.length - ready;
  const readyHours = proposals.filter((p) => p.include).reduce((n, p) => n + p.hours, 0);
  const billableHours = proposals
    .filter((p) => p.include && p.activity === BILLABLE_ACTIVITY)
    .reduce((n, p) => n + p.hours, 0);
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""));

  if (!proposals.length)
    return shell(
      `<div class="card empty"><p><b>No events on the calendar for this week.</b></p>
      <p class="meta">Nothing to import. An empty week is reported as empty rather than as a successful import of nothing.</p></div>`
    );

  /*
   * "ASK HOW TO APPLY IT" (2026-09-09, migration 0026). An `unknown_activity` row's single
   * non-activity category IS the candidate name — see proposeWeek()'s comment on why a misspelled
   * activity and a new client category look identical by shape. Offered once per distinct name, not once
   * per event: a whole week of Vacation/Holiday days would otherwise repeat the same prompt daily.
   * Registering it here goes through the exact same POST /activities that the standalone /activities page
   * uses, with `redirect` bringing the page back to this same week so the newly-registered rows re-match
   * immediately.
   */
  const unrecognized = [
    ...new Set(
      proposals.filter((p) => p.flags.includes("unknown_activity") && p.client_name).map((p) => p.client_name!)
    ),
  ];
  const registerPrompts = unrecognized.length
    ? `<section class="card">
    <h2>New categories seen this week</h2>
    <p class="meta" style="margin:0 0 10px">Not one of the recognized activities. Register it, and every event carrying it — this week and future weeks — will match automatically.</p>
    ${unrecognized
      .map((name) => {
        const count = proposals.filter((p) => p.client_name === name && p.flags.includes("unknown_activity")).length;
        return `<form method="post" action="/activities" class="quickset">
        <input type="hidden" name="name" value="${esc(name)}">
        <input type="hidden" name="redirect" value="/time/import?week=${esc(anchor)}">
        <span><b>${esc(name)}</b> <span class="meta">on ${count} event${count === 1 ? "" : "s"}</span></span>
        <label class="check" style="margin:0"><input type="radio" name="is_work" value="1" checked> Worked hours</label>
        <label class="check" style="margin:0"><input type="radio" name="is_work" value="0"> Not worked (like Personal)</label>
        <button class="tiny" type="submit">Register</button>
      </form>`;
      })
      .join("")}
  </section>`
    : "";

  return shell(`
  ${registerPrompts}
  <p class="sub">${proposals.length} event${proposals.length === 1 ? "" : "s"} · <b>${ready} ready</b> (${esc(
    fmt(readyHours)
  )}h${billableHours ? `, ${esc(fmt(billableHours))}h billable` : ""})${
    needsLook ? ` · ${needsLook} need${needsLook === 1 ? "s" : ""} a decision` : ""
  }${
    /* The assumption is stated on the page whenever it IS an assumption. A wrong zone does not look wrong
       — it looks like a meeting on the adjacent day — so the only way to catch it is to say so. */ ""
  }${
    zone.fromMailbox
      ? ""
      : ` · <span class="pill amber">times assumed ${esc(
          zone.tz
        )} — Outlook did not say</span>`
  }</p>
  <form method="post" action="/time/import">
    <input type="hidden" name="week" value="${esc(anchor)}">
    <input type="hidden" name="count" value="${proposals.length}">
    <table><thead><tr><th></th><th>Event</th><th>Hours</th><th>Activity</th><th>Customer</th></tr></thead>
      ${
        /* Rows keep their ORIGINAL index for the form field names — the day headings are interleaved for
           reading, but inc_/ev_/hours_ must still line up with `count` on the server. Indexing off a
           per-day loop would silently import the wrong rows. */ ""
      }<tbody>${(() => {
        const seen = new Set<string>();
        return proposals
          .map((p, i) => {
            let head = "";
            if (!seen.has(p.date)) {
              seen.add(p.date);
              head = dayHeader(
                p.date,
                proposals.filter((q) => q.date === p.date)
              );
            }
            return head + row(p, i, engagements, activityOptions(activityDefs));
          })
          .join("");
      })()}</tbody></table>
    <div class="actions" style="margin-top:14px"><button type="submit">Import the ticked rows</button>
      <a class="btn secondary" href="/time?week=${esc(anchor)}">Cancel</a>
      <span class="meta">Importing <b data-week-ticked>${esc(fmt(readyHours))}</b>h</span></div>
  </form>
  ${
    /* PROGRESSIVE ENHANCEMENT, NOT A DEPENDENCY. The server renders every total correctly; this only keeps
       them honest as you tick and retype. Without it the numbers would be right on load and quietly wrong
       one click later, which on a page about not double-counting hours is the worst of the three states.
       With JS off you still get correct totals for the proposal as offered — nothing here is the only way
       to read a number. Third inline script in the app; same reason as the other two — no framework to
       pull in for eleven lines. */ ""
  }
  <script>
  (function () {
    var form = document.querySelector('form[action="/time/import"]');
    if (!form) return;
    function recalc() {
      var week = 0;
      var byDay = {};
      form.querySelectorAll('tr[data-date]').forEach(function (tr) {
        var box = tr.querySelector('input[type=checkbox]');
        var hrs = parseFloat((tr.querySelector('input[inputmode=decimal]') || {}).value) || 0;
        var d = tr.getAttribute('data-date');
        if (byDay[d] === undefined) byDay[d] = 0;
        if (box && box.checked) { byDay[d] += hrs; week += hrs; }
      });
      Object.keys(byDay).forEach(function (d) {
        var el = form.querySelector('[data-day-ticked="' + d + '"]');
        if (el) el.textContent = String(Math.round(byDay[d] * 100) / 100);
      });
      var wk = document.querySelector('[data-week-ticked]');
      if (wk) wk.textContent = String(Math.round(week * 100) / 100);
    }
    form.addEventListener('change', recalc);
    form.addEventListener('input', recalc);
  })();
  </script>
  ${
    /* The legend, listing ONLY the flags this week actually produced — an explanation of every possible
       flag would be a wall of text about problems you do not have. */
    (() => {
      const present = [...new Set(proposals.flatMap((p) => p.flags))];
      if (!present.length) return "";
      return `<section style="margin-top:14px"><h2>What the labels mean</h2>
      <dl class="grid2">${present
        .map(
          (f) =>
            `<dt><span class="pill ${
              f === "already_imported" || f === "no_engagement" ? "grey" : "amber"
            }">${esc(FLAG_TEXT[f].short)}</span></dt><dd>${esc(FLAG_TEXT[f].why)}</dd>`
        )
        .join("")}</dl></section>`;
    })()
  }
  <p class="meta" style="margin-top:10px">Nothing is written until you press the button, and every field above is editable first. <b>Rows are ticked only when there is nothing to decide</b> — an unticked row is telling you something: no category, two categories, an overlap with another event, or Client Delivery time with no customer to bill it to. Overlaps are marked on <b>both</b> events, because which one is the real block is your call, and importing both would double-count the time. Re-importing a week <b>updates</b> the entries it created before rather than adding a second copy; anything you typed by hand is never touched. The <b>comments</b> box is yours — it is kept separate from the event's subject, carried back here if you re-import the week, and never overwritten by Outlook.</p>`);
});

app.post("/time/import", async (c) => {
  const f = await c.req.parseBody();
  const week = typeof f.week === "string" ? f.week : today();
  const count = Number(f.count) || 0;
  let created = 0;
  let updated = 0;
  const errors: string[] = [];
  const activityValues = (await loadActivities(c.env.DB)).map((a) => a.name);

  for (let i = 0; i < count; i++) {
    if (f[`inc_${i}`] !== "1") continue;
    const eventId = String(f[`ev_${i}`] ?? "");
    const date = String(f[`date_${i}`] ?? "");
    const subject = String(f[`subject_${i}`] ?? "");
    const activity = String(f[`act_${i}`] ?? "");
    const engRaw = String(f[`eng_${i}`] ?? "");
    const hours = Math.round(Number(f[`hours_${i}`]) * 100) / 100;
    const commentRaw = String(f[`cmt_${i}`] ?? "").trim();
    const comment = commentRaw === "" ? null : commentRaw;

    if (!eventId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`row ${i + 1} was missing its event reference`);
      continue;
    }
    if (!activityValues.includes(activity)) {
      errors.push(`${subject || `row ${i + 1}`}: pick an activity before importing it`);
      continue;
    }
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      errors.push(`${subject || `row ${i + 1}`}: ${f[`hours_${i}`]} is not a usable number of hours`);
      continue;
    }
    const engagementId = engRaw ? Number(engRaw) : null;

    /*
     * Re-import UPDATES rather than duplicates, matched on outlook_ref — and only ever touches rows the
     * import itself created (`source = 'calendar'`). A manual entry is correctable truth and the calendar is
     * a claim, so the claim never overwrites the correction (definitions.md §5c).
     */
    const existing = await c.env.DB.prepare(
      "SELECT id, note, hand_edited FROM time_entry WHERE outlook_ref = ? AND source = 'calendar'"
    )
      .bind(eventId)
      .first<{ id: number; note: string | null; hand_edited: number }>();

    if (existing) {
      /*
       * THE SUBJECT AND THE COMMENT GO TO DIFFERENT COLUMNS (migration 0017). `subject` is the calendar's
       * words and is refreshed from Outlook every time; `note` is the operator's and is only ever what the
       * box on this page held — which was prefilled with what was written before, so a re-import
       * round-trips it.
       *
       * The prefill is what makes the write safe. Writing a blank straight over an existing comment would
       * be the bug this field exists to prevent, so if the box came back empty AND the row already has a
       * comment, the old one is kept rather than erased. Clearing a comment is done on the entry itself,
       * where it is unambiguous; an empty box on a bulk import screen is far more likely to be a form that
       * lost a field than a deliberate deletion.
       */
      /*
       * A ticked row that the operator had corrected is an OVERRIDE, and the mark is cleared (migration 0019).
       *
       * The row arrived unticked and labelled "you corrected this" — `hand_edited` is in BLOCKING — so a
       * tick here cannot be inertia. It is the deliberate instruction to take Outlook's version back, and
       * leaving the flag set afterwards would mean the row stayed permanently unticked while now agreeing
       * with the calendar, which reads as a bug and trains him to ignore the flag.
       *
       * The audit line says the override happened. A correction being reverted is exactly the kind of
       * change that must not be indistinguishable from a routine refresh.
       */
      await c.env.DB.prepare(
        `UPDATE time_entry SET date=?, hours=?, activity=?, engagement_id=?, subject=?, note=?,
           hand_edited=0, updated_at=datetime('now')
          WHERE id=?`
      )
        .bind(date, hours, activity, engagementId, subject || null, comment ?? existing.note, existing.id)
        .run();
      if (existing.hand_edited)
        await c.env.DB.prepare(
          "INSERT INTO audit_event (actor, entity, entity_id, action, after_summary, source) VALUES (?,'time_entry',?,'update',?, 'calendar-import')"
        )
          .bind(
            ACTOR,
            String(existing.id),
            `${hours}h ${activity} on ${date} — your correction was deliberately replaced with Outlook's version on re-import (${subject})`
          )
          .run();
      updated++;
    } else {
      const ins = await c.env.DB.prepare(
        `INSERT INTO time_entry (date, hours, activity, engagement_id, subject, note, source, outlook_ref)
         VALUES (?,?,?,?,?,?, 'calendar', ?)`
      )
        .bind(date, hours, activity, engagementId, subject || null, comment, eventId)
        .run();
      const id = ins?.meta?.last_row_id ?? 0;
      await c.env.DB.prepare(
        "INSERT INTO audit_event (actor, entity, entity_id, action, after_summary, source) VALUES (?,'time_entry',?,'create',?, 'calendar-import')"
      )
        .bind(
          ACTOR,
          String(id),
          `${hours}h ${activity} on ${date} — imported from Outlook: ${subject}${comment ? ` — ${comment}` : ""}`
        )
        .run();
      created++;
    }
  }

  /*
   * One audit event for the batch as well as one per created row. The per-row events say what exists; this
   * one says an import happened, which is the question asked when a week's totals look different from
   * yesterday. Source is 'calendar-import' so the trail can separate imported time from typed time.
   */
  if (created || updated)
    await c.env.DB.prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, after_summary, source) VALUES (?,'time_entry',?,'update',?, 'calendar-import')"
    )
      .bind(ACTOR, `week-${week}`, `Outlook import for the week of ${week}: ${created} created, ${updated} updated`)
      .run();

  const params = new URLSearchParams({ week });
  if (errors.length) params.set("error", `${created} imported, ${updated} updated. Not imported: ${errors.join("; ")}.`);
  else if (!created && !updated) params.set("flash", "nothing");
  else params.set("flash", created && updated ? "both" : created ? "created" : "updated");
  return c.redirect(`/time?${params.toString()}`);
});

export default app;
