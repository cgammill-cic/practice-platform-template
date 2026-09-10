// Log emails as interactions, a week at a time (MAIL-001).
//
// THE CHORE THIS REMOVES: sending an email and then having to separately go into the app and record that
// an email was sent to that contact. Every outreach is typed twice — once in Outlook and once here — and
// the second time is the one that gets skipped, which is how the escalation ladder ends up understating
// how often someone has been chased.
//
// WHY IT LOOKS LIKE THE CALENDAR IMPORT. Same shape, same reasons: a week at a time, a preview you tick
// before anything is written, and re-running the same week updates nothing it did not create. Mail is
// heavier than calendar, so the week bound is doing real work here — an earlier unbounded contact import
// proved what happens when a Worker is handed an unbounded set.
//
// ---------------------------------------------------------------------------------------------------
// THE FOUR DECISIONS WORTH ARGUING ABOUT
//
// 1. DIRECTION COMES FROM THE SENDER, NOT THE FOLDER. `from` equal to the connected mailbox means
//    outbound; anything else is inbound. Folder would have been the obvious choice and is wrong: a sent
//    message filed into a project folder is still something the operator sent, and an inbound message
//    they archive is still a reply. Getting this backwards is not cosmetic — outbound counts as an
//    ATTEMPT on the escalation ladder and inbound must not, or every reply received would read as another
//    chase and the "who has gone quiet" list would invert.
//
// 2. Mail.ReadBasic, NOT Mail.Read. ReadBasic carries sender, recipients, subject, date — everything an
//    interaction record needs — and excludes message bodies. The app therefore cannot read what the
//    operator wrote to a client or what they wrote back, which is the right default for a tool whose
//    whole value proposition to clients is discretion. Widening to Mail.Read is one string and one
//    consent click if bodies are ever wanted pulled into notes.
//
// 3. DEDUPLICATION USES `interaction.outlook_ref`, WHICH ALREADY EXISTED. An earlier migration created
//    that column and nothing had ever written to it — every existing interaction has it NULL. So this
//    feature needs NO schema change at all, which is worth stating because the obvious move was to add
//    a column and it would have been redundant.
//
// 4. NOTHING IS TICKED THAT WAS ALREADY LOGGED, and re-running a week is safe. The preview reads the
//    refs already stored and marks those rows as done rather than hiding them, so the answer to "did I
//    already log Tuesday?" is on screen instead of inferred from an absence.
// ---------------------------------------------------------------------------------------------------
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not move anyone's stage. An inbound reply from a contact
// sitting in Awaiting Response is a strong signal that the stage is stale, and surfacing that is the
// obvious next feature — but a screen that silently reclassifies relationships while logging email is
// two features wearing one coat, and the stage is the field the operator curates most carefully.
//
// ---------------------------------------------------------------------------------------------------
// REVIEW STATE — "unticked" was never a decision
//
// THE PROBLEM. The preview re-fetches the live mailbox on every visit. A message never logged and never
// excluded reappears every single time that week is opened, forever — an unresolved message just keeps
// showing up on the list. Two different gaps produced that one symptom:
//
//   1. There was no way to say "no" to a SINGLE message that sticks. Fixed with email_import_exclusion
//      (migration 0024) — a real, persisted "excluded", not a checkbox left unticked. See that migration
//      for why it is its own table rather than a row in `interaction`.
//   2. There was no way to say "no" to a PERSON. Someone doing active project work can produce mail every
//      day, and none of it is worth a prompt once that pattern is recognized (a busy back-and-forth
//      counterpart is the common case). Fixed with contact.email_import_ignore (same migration) — the
//      same shape as 0011's no_linkedin: a flag nobody defaults to a claim about, only ever set by a
//      person clicking a button, and reversible from the "Currently ignored" list below the preview.
//
// THE DEFAULT PICK, PER CONTACT PER DAY, in order: if an inbound message exists that day, it is the
// primary — a reply is proof the relationship moved, and the likeliest evidence it was answered. If not,
// the first outbound message sent that day is the primary instead. So among a contact's PENDING messages
// on one day: the first inbound one wins if there is any inbound at all; otherwise the first outbound one
// by time. This is a DEFAULT, not a rule — every pending row still carries its own checkbox, so any other
// message that day can be ticked instead or as well. Excluding one message never touches the others;
// picking a different primary is just ticking a different box, not a separate action.

import { Hono } from "hono";
import { reconcileAttemptLadder } from "./attempts";
import { graphBase, msAccessToken, msConnection } from "./msgraph";
import { esc, layout } from "./views";
import { weekBounds, shiftWeek } from "./weeks";
import type { Bindings, D1Db } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

const ACTOR = "operator";

/** How many inserts go in one D1 batch. An earlier import died doing this one row at a time. */
const BATCH_SIZE = 50;

/** Graph page size. A week of mail is well inside one page for a single-person practice. */
const PAGE_SIZE = 250;

/** Stop paging after this many messages in a week — a guard against an unbounded mailbox, not a target. */
const MAX_MESSAGES = 2000;

interface GraphAddress {
  emailAddress?: { address?: string; name?: string };
}
interface GraphMessage {
  id: string;
  subject?: string | null;
  receivedDateTime?: string;
  sentDateTime?: string;
  isDraft?: boolean;
  from?: GraphAddress;
  sender?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
}

type Status = "pending" | "excluded" | "logged";

interface Row {
  /** Stable index for the checkbox name; the Graph id is too long and ugly for a form field. */
  n: number;
  messageId: string;
  date: string;
  /** The instant used to compute `date` — kept for within-day ordering and the primary pick. */
  timestamp: string;
  direction: "outbound" | "inbound";
  subject: string;
  counterparty: string;
  contactId: number;
  contactName: string;
  organization: string | null;
  stage: string;
  status: Status;
  /** This is the default pick for its contact+day among pending messages. Pre-checked; not exclusive. */
  isPrimary: boolean;
}

const str = (v: unknown): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? null : t;
};

/**
 * Writes one audit event for the review-state actions below (excluded, un-excluded, ignored, watched
 * again). Mirrors the small per-file `audit()` helper actions.ts and contacts.ts each already have —
 * same shape, so the trail reads consistently regardless of which route wrote the row.
 */
async function audit(
  db: D1Db,
  entity: string,
  entityId: string,
  action: string,
  after: string,
  before?: string | null,
  correlationId?: string | null
) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,?,?,?,?,?,'app',?)"
    )
    .bind(ACTOR, entity, entityId, action, before ?? null, after, correlationId ?? null)
    .run();
}

/** Where every one of the small review-state POSTs below returns to. */
function backToImport(week: string | null, status?: string): string {
  const p = new URLSearchParams();
  if (week) p.set("week", week);
  if (status) p.set("status", status);
  const qs = p.toString();
  return `/email/import${qs ? `?${qs}` : ""}`;
}

const addr = (a: GraphAddress | undefined): string =>
  (a?.emailAddress?.address ?? "").trim().toLowerCase();

/**
 * THE DATE MUST BE THE LOCAL ONE, NOT THE UTC ONE, and this is not a rounding detail.
 *
 * Graph returns `receivedDateTime` and `sentDateTime` in UTC, always — unlike calendar events, message
 * timestamps do not honour the `Prefer: outlook.timezone` header, so the conversion has to happen here.
 * Slicing the first ten characters off the ISO string was the first implementation and it is wrong by a
 * whole day for anything sent after 7pm Central: 2026-09-01T20:00 local is 2026-09-02T02:00Z, so the
 * interaction would be dated the day AFTER the email was sent. Caught by a fixture, not by reasoning.
 *
 * Being a day late matters here beyond tidiness — `last_attempt_at` feeds the chase list, and a touch
 * recorded a day early or late shifts when someone appears to have gone quiet.
 *
 * The zone comes from `/me/mailboxSettings` as a WINDOWS name ("Central Standard Time"), which Intl
 * cannot use, so the handful of US zones are mapped to IANA and anything unrecognised falls back to a
 * sensible default. A wrong-but-close zone shifts a late-evening message by a day; refusing to import is
 * worse than that, so this never throws.
 */
const WINDOWS_TO_IANA: Record<string, string> = {
  "Central Standard Time": "America/Chicago",
  "Eastern Standard Time": "America/New_York",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  UTC: "UTC",
};

export function localDay(iso: string | undefined, ianaZone: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10);
  try {
    // en-CA gives YYYY-MM-DD, which is the format stored throughout this app.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: ianaZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(t));
  } catch {
    return iso.slice(0, 10);
  }
}

/** Windows zone name from the mailbox → IANA, defaulting to a sensible zone. Never throws. */
export function ianaFromWindows(windowsName: string | null | undefined): string {
  return WINDOWS_TO_IANA[(windowsName ?? "").trim()] ?? "America/Chicago";
}

/** The mailbox's own timezone, so dates match what the operator saw in Outlook. */
async function mailboxZone(env: Bindings, token: string): Promise<string> {
  try {
    const res = await fetch(`${graphBase(env)}/me/mailboxSettings`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return ianaFromWindows(null);
    const body = (await res.json()) as { timeZone?: string };
    return ianaFromWindows(body.timeZone);
  } catch {
    return ianaFromWindows(null);
  }
}

/**
 * Every address on a message that is not the mailbox owner. A message to three people who are all
 * contacts produces three rows — one interaction each — because an email to three people IS a touch on
 * three relationships, and collapsing it to one would silently drop two.
 */
function counterparties(m: GraphMessage, me: string): string[] {
  const all = [
    addr(m.from ?? m.sender),
    ...(m.toRecipients ?? []).map(addr),
    ...(m.ccRecipients ?? []).map(addr),
  ];
  return [...new Set(all.filter((a) => a && a !== me))];
}

/**
 * Contacts keyed by every email address they own, so a match is one lookup rather than a scan.
 *
 * Excludes anyone flagged email_import_ignore (2026-09-09): their mail should not even reach the
 * matcher, let alone the preview. This is deliberately upstream of the exclusion table below — an
 * ignored PERSON is a standing decision about the relationship, not a per-message review state.
 */
async function contactsByEmail(
  db: D1Db
): Promise<Map<string, { id: number; full_name: string; organization: string | null; stage: string }>> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.full_name, o.name AS organization, c.stage,
              lower(trim(ifnull(c.email_work,''))) AS ew, lower(trim(ifnull(c.email_personal,''))) AS ep
         FROM contact c LEFT JOIN organization o ON o.id = c.organization_id
        WHERE c.status = 'active' AND c.email_import_ignore = 0
          AND (ifnull(c.email_work,'') <> '' OR ifnull(c.email_personal,'') <> '')`
    )
    .all<{
      id: number;
      full_name: string;
      organization: string | null;
      stage: string;
      ew: string;
      ep: string;
    }>();
  const map = new Map<string, { id: number; full_name: string; organization: string | null; stage: string }>();
  for (const r of results) {
    const v = { id: r.id, full_name: r.full_name, organization: r.organization, stage: r.stage };
    // First writer wins. Two contacts sharing an address is a data problem, not something to guess at;
    // duplicate work emails are not expected in practice, and the /health check would surface it if they
    // occurred.
    if (r.ew && !map.has(r.ew)) map.set(r.ew, v);
    if (r.ep && !map.has(r.ep)) map.set(r.ep, v);
  }
  return map;
}

/**
 * A week of messages. Filtered server-side on receivedDateTime so the Worker never holds a mailbox.
 *
 * `receivedDateTime` is used for both directions rather than switching to `sentDateTime` for sent items:
 * Graph populates received on sent messages too, and using one field keeps the filter, the ordering and
 * the paging cursor consistent. The displayed date still comes from sentDateTime where present.
 */
async function fetchWeekMail(
  env: Bindings,
  token: string,
  start: string,
  end: string
): Promise<{ messages: GraphMessage[]; truncated: boolean } | { error: string }> {
  const out: GraphMessage[] = [];
  let url: string | null = null;
  const first = new URL(`${graphBase(env)}/me/messages`);
  first.searchParams.set(
    "$filter",
    `receivedDateTime ge ${start}T00:00:00Z and receivedDateTime le ${end}T23:59:59Z`
  );
  first.searchParams.set(
    "$select",
    "id,subject,receivedDateTime,sentDateTime,isDraft,from,sender,toRecipients,ccRecipients"
  );
  first.searchParams.set("$top", String(PAGE_SIZE));
  first.searchParams.set("$orderby", "receivedDateTime desc");
  url = first.toString();

  try {
    while (url) {
      const res: Response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const hint =
          res.status === 403
            ? " The app registration may not have Mail.ReadBasic yet — reconnect Outlook to grant it."
            : "";
        return { error: `Microsoft refused the mail request (HTTP ${res.status}).${hint}` };
      }
      const body = (await res.json()) as { value?: GraphMessage[]; "@odata.nextLink"?: string };
      out.push(...(body.value ?? []));
      if (out.length >= MAX_MESSAGES) return { messages: out.slice(0, MAX_MESSAGES), truncated: true };
      url = body["@odata.nextLink"] ?? null;
    }
  } catch (e) {
    return { error: `Could not reach Microsoft: ${String(e)}` };
  }
  return { messages: out, truncated: false };
}

/**
 * The default pick among one contact's pending messages on one day. First inbound message wins if there
 * is any; otherwise the first outbound one. Pure and exported so the rule can be checked directly
 * against fixtures rather than only through a live mailbox.
 */
export function pickPrimaryIndex<T extends { direction: "outbound" | "inbound"; timestamp: string }>(
  msgs: readonly T[]
): number {
  let bestInbound = -1;
  let bestOutbound = -1;
  msgs.forEach((m, i) => {
    if (m.direction === "inbound" && (bestInbound === -1 || m.timestamp < msgs[bestInbound].timestamp))
      bestInbound = i;
    if (m.direction === "outbound" && (bestOutbound === -1 || m.timestamp < msgs[bestOutbound].timestamp))
      bestOutbound = i;
  });
  return bestInbound !== -1 ? bestInbound : bestOutbound;
}

/** Build the preview rows: one per (message × matched contact), grouped by contact then newest day first. */
async function buildRows(
  db: D1Db,
  messages: GraphMessage[],
  me: string,
  zone: string
): Promise<{ rows: Row[]; scanned: number; unmatched: number }> {
  const byEmail = await contactsByEmail(db);
  const { results: refs } = await db
    .prepare("SELECT outlook_ref FROM interaction WHERE outlook_ref IS NOT NULL")
    .all<{ outlook_ref: string }>();
  const logged = new Set(refs.map((r) => r.outlook_ref));
  const { results: excl } = await db
    .prepare("SELECT message_id, contact_id FROM email_import_exclusion")
    .all<{ message_id: string; contact_id: number }>();
  const excluded = new Set(excl.map((r) => `${r.message_id}::${r.contact_id}`));

  const rows: Row[] = [];
  let unmatched = 0;
  let n = 0;
  for (const m of messages) {
    if (m.isDraft) continue; // a draft is not a touch
    const outbound = addr(m.from ?? m.sender) === me;
    const rawTimestamp = outbound ? (m.sentDateTime ?? m.receivedDateTime) : m.receivedDateTime;
    const date = localDay(rawTimestamp, zone);
    if (!date) continue;
    const parties = counterparties(m, me);
    let matchedAny = false;
    for (const p of parties) {
      const hit = byEmail.get(p);
      if (!hit) continue;
      matchedAny = true;
      const ref = `${m.id}::${hit.id}`;
      const status: Status = logged.has(ref) ? "logged" : excluded.has(ref) ? "excluded" : "pending";
      rows.push({
        n: n++,
        messageId: m.id,
        date,
        // rawTimestamp is defined whenever date is non-empty (localDay returns "" for undefined input).
        timestamp: rawTimestamp ?? date,
        direction: outbound ? "outbound" : "inbound",
        subject: (m.subject ?? "").trim() || "(no subject)",
        counterparty: p,
        contactId: hit.id,
        contactName: hit.full_name,
        organization: hit.organization,
        stage: hit.stage,
        status,
        isPrimary: false,
      });
    }
    if (!matchedAny) unmatched++;
  }

  // The default pick, per contact per day, among PENDING rows only — logged and excluded rows are
  // already decided and take no part in choosing it. See pickPrimaryIndex().
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.status !== "pending") continue;
    const key = `${r.contactId}::${r.date}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  for (const group of groups.values()) {
    const i = pickPrimaryIndex(group);
    if (i !== -1) group[i].isPrimary = true;
  }

  rows.sort((a, b) => {
    if (a.contactName !== b.contactName) return a.contactName.localeCompare(b.contactName);
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return a.timestamp.localeCompare(b.timestamp);
  });
  rows.forEach((r, i) => (r.n = i));
  return { rows, scanned: messages.length, unmatched };
}

const DIRECTION_PILL: Record<Row["direction"], string> = {
  outbound: '<span class="pill">sent</span>',
  inbound: '<span class="pill grey">received</span>',
};

const STATUS_LABEL: Record<"pending" | "excluded" | "logged" | "all", string> = {
  pending: "Not yet decided",
  excluded: "Excluded",
  logged: "Already logged",
  all: "Everything",
};

function page(body: string): string {
  return layout({ title: "Import Email", body: `<main>${body}</main>` });
}

// ---------------------------------------------------------------- preview

app.get("/email/import", async (c) => {
  const anchor = c.req.query("week") ?? new Date().toISOString().slice(0, 10);
  const { start, end } = weekBounds(anchor);
  const statusFilter = (["pending", "excluded", "logged", "all"] as const).includes(
    c.req.query("status") as "pending" | "excluded" | "logged" | "all"
  )
    ? (c.req.query("status") as "pending" | "excluded" | "logged" | "all")
    : "pending";
  const filterLink = (s: "pending" | "excluded" | "logged" | "all") =>
    `/email/import?week=${encodeURIComponent(anchor)}&status=${s}`;

  const nav = `<p class="meta"><a href="/email/import?week=${shiftWeek(anchor, -1)}&status=${statusFilter}">← previous week</a>
     · <b>${start} to ${end}</b> ·
     <a href="/email/import?week=${shiftWeek(anchor, 1)}&status=${statusFilter}">next week →</a></p>`;

  const conn = await msConnection(c.env.DB);
  if (!conn)
    return c.html(
      page(`<h1>Import Email</h1>
        <div class="flash warn">Outlook is not connected. <a href="/outlook">Connect it first</a>.</div>`)
    );

  const tok = await msAccessToken(c.env, c.env.DB);
  if ("error" in tok)
    return c.html(page(`<h1>Import Email</h1><div class="flash warn">${esc(tok.error)}</div>${nav}`));

  const me = (conn.account_upn ?? "").trim().toLowerCase();
  if (!me)
    return c.html(
      page(
        `<h1>Import Email</h1><div class="flash warn">The connected account has no address on file, so sent and received cannot be told apart. Reconnect Outlook.</div>${nav}`
      )
    );

  const fetched = await fetchWeekMail(c.env, tok.token, start, end);
  if ("error" in fetched)
    return c.html(page(`<h1>Import Email</h1><div class="flash warn">${esc(fetched.error)}</div>${nav}`));

  const zone = await mailboxZone(c.env, tok.token);
  const { rows: allRows, scanned, unmatched } = await buildRows(c.env.DB, fetched.messages, me, zone);

  const counts = {
    pending: allRows.filter((r) => r.status === "pending").length,
    excluded: allRows.filter((r) => r.status === "excluded").length,
    logged: allRows.filter((r) => r.status === "logged").length,
  };
  const shown = statusFilter === "all" ? allRows : allRows.filter((r) => r.status === statusFilter);
  // Whatever is pending among what's currently shown is what the big submit button can write — if the
  // filter is narrowed to Excluded or Already Logged, that is correctly nothing.
  const payloadRows = shown.filter((r) => r.status === "pending");

  const flash = c.req.query("flash");
  const FLASH: Record<string, string> = {
    excluded: "Excluded. It will not be offered again.",
    unexcluded: "Back to not-yet-decided.",
    ignored: "Ignored — their email will not appear here until you un-ignore them.",
    unignored: "Un-ignored — their email will appear again from the next visit.",
  };
  const flashHtml = flash && FLASH[flash] ? `<div class="flash ok">${esc(FLASH[flash])}</div>` : "";

  // Group for rendering: contact → date → rows. Map preserves insertion order, and rows arrive already
  // sorted contact, then day (newest first), then time — so building the groups is one pass.
  const byContact = new Map<number, { name: string; org: string | null; days: Map<string, Row[]> }>();
  for (const r of shown) {
    if (!byContact.has(r.contactId)) byContact.set(r.contactId, { name: r.contactName, org: r.organization, days: new Map() });
    const entry = byContact.get(r.contactId)!;
    const d = entry.days.get(r.date);
    if (d) d.push(r);
    else entry.days.set(r.date, [r]);
  }

  /*
   * FORMS CANNOT NEST — found the hard way. Every row's Exclude/Undo control and
   * every contact's Ignore control used to be its own <form> written inline, inside the big "Log N
   * Interactions" <form> that wraps the whole preview. HTML has no such thing as a nested form — a
   * browser parsing a <form> start tag while one is already open just drops the tag and keeps adding
   * everything after it to the OUTER form instead. The visible Exclude/Ignore buttons still looked like
   * they worked (clicking one submits *something*), but every hidden `week` input from every row got
   * flattened into the outer form too, so `week` arrived as an array instead of a string and came out
   * blank, and worse: ticking 20 checkboxes and hitting the real submit button only matched 1 of them
   * against the payload, because the browser's actual field ordering under this flattening does not
   * match what the server assumes.
   *
   * The fix is the standard escape hatch: a control can name a `form="id"` it belongs to, overriding its
   * nearest-ancestor default, so the real <form> for each action can be declared OUTSIDE the big one —
   * textually a sibling, not a descendant — while the button that submits it stays exactly where it
   * visually belongs, inline in the row. `standaloneForms` collects those real (invisible, hidden-inputs-
   * only) forms as they are built; they are rendered once, after the big form closes.
   */
  const standaloneForms: string[] = [];

  const rowLine = (r: Row, week: string): string => {
    const meta = `${esc(r.date)} · ${DIRECTION_PILL[r.direction]} ${esc(r.subject)}`;
    if (r.status === "logged") return `<div class="meta" style="padding:6px 0">${meta} — <span class="pill green">logged</span></div>`;
    if (r.status === "excluded") {
      const formId = `unexcl-${r.n}`;
      standaloneForms.push(`<form id="${formId}" method="post" action="/email/import/unexclude">
        <input type="hidden" name="message_id" value="${esc(r.messageId)}">
        <input type="hidden" name="contact_id" value="${r.contactId}">
        <input type="hidden" name="week" value="${esc(week)}">
      </form>`);
      return `<div class="meta" style="padding:6px 0">${meta} — <span class="pill grey">excluded</span>
        <button class="tiny secondary" type="submit" form="${formId}">Undo</button></div>`;
    }
    const formId = `excl-${r.n}`;
    standaloneForms.push(`<form id="${formId}" method="post" action="/email/import/exclude">
      <input type="hidden" name="message_id" value="${esc(r.messageId)}">
      <input type="hidden" name="contact_id" value="${r.contactId}">
      <input type="hidden" name="week" value="${esc(week)}">
    </form>`);
    return `<div style="padding:6px 0;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <label style="display:flex;align-items:center;gap:6px;font-weight:400">
        <input type="checkbox" name="take" value="${r.n}"${r.isPrimary ? " checked" : ""}> ${meta}${
          r.isPrimary ? ' <span class="pill">default</span>' : ""
        }
      </label>
      <button class="tiny secondary" type="submit" form="${formId}">Exclude</button>
    </div>`;
  };

  const contactBlocks = [...byContact.entries()]
    .map(([contactId, entry]) => {
      const days = [...entry.days.entries()]
        .map(
          ([date, dayRows]) =>
            `<div style="margin-top:6px">${dayRows.map((r) => rowLine(r, anchor)).join("")}</div>`
        )
        .join("");
      const ignoreFormId = `ignore-${contactId}`;
      standaloneForms.push(`<form id="${ignoreFormId}" method="post" action="/email/import/ignore">
        <input type="hidden" name="contact_id" value="${contactId}">
        <input type="hidden" name="week" value="${esc(anchor)}">
      </form>`);
      return `<section>
    <h2 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <a href="/contacts/${contactId}">${esc(entry.name)}</a>${entry.org ? ` <span class="meta" style="font-weight:400">${esc(entry.org)}</span>` : ""}
      <button class="tiny secondary" type="submit" form="${ignoreFormId}" style="margin-left:auto">Ignore this person</button>
    </h2>
    ${days}
  </section>`;
    })
    .join("");

  const payload = JSON.stringify(
    payloadRows.map((r) => ({
      n: r.n,
      messageId: r.messageId,
      contactId: r.contactId,
      date: r.date,
      direction: r.direction,
      subject: r.subject,
    }))
  );

  const ignoredList = await c.env.DB.prepare(
    `SELECT c.id, c.full_name, o.name AS org FROM contact c LEFT JOIN organization o ON o.id = c.organization_id
      WHERE c.email_import_ignore = 1 ORDER BY c.full_name`
  ).all<{ id: number; full_name: string; org: string | null }>();

  return c.html(
    page(`<h1>Import Email</h1>
  <p class="sub">Emails to and from people in your contacts. Nothing is written until you confirm.</p>
  ${nav}
  ${flashHtml}
  <p class="phone-only flash warn">This is desk work — the preview is a wide table. Do it on a computer if you can.</p>

  <div class="card">
    <dl class="kv">
      <dt>Messages in the week</dt><dd>${scanned}</dd>
      <dt>Matched to a contact</dt><dd><b>${allRows.length}</b> row${allRows.length === 1 ? "" : "s"}</dd>
      <dt>No matching contact</dt><dd>${unmatched}</dd>
    </dl>
    ${
      fetched.truncated
        ? `<p class="flash warn" style="margin:10px 0 0">That week had more than ${MAX_MESSAGES} messages, so this is the newest ${MAX_MESSAGES}. Import it, then run the week again to pick up the rest.</p>`
        : ""
    }
    <p class="meta" style="margin:10px 0 0">A message to several contacts becomes one interaction per person — an
      email to three people is a touch on three relationships. <b>Sent</b> counts as an outreach attempt on the
      escalation ladder; <b>received</b> does not. Nobody's stage is changed. Within one contact's day, the row
      marked <b>default</b> is the one this page pre-ticks — the first message received that day, or if none was
      received, the first one sent — but every row is its own checkbox, so pick a different one, or several, if you
      want.</p>
  </div>

  <div class="card">
    <p class="meta" style="margin:0">Show:
      ${(["pending", "excluded", "logged", "all"] as const)
        .map((s) =>
          s === statusFilter
            ? `<b>${STATUS_LABEL[s]} (${s === "all" ? allRows.length : counts[s]})</b>`
            : `<a href="${filterLink(s)}">${STATUS_LABEL[s]} (${s === "all" ? allRows.length : counts[s]})</a>`
        )
        .join(" · ")}
    </p>
  </div>

  <form method="post" action="/email/import">
    <input type="hidden" name="payload" value="${esc(payload)}">
    <input type="hidden" name="week" value="${esc(anchor)}">
    <div class="actions" style="margin:0 0 14px">
      <button type="submit"${payloadRows.length ? "" : " disabled"}>Log ${payloadRows.length} Interaction${payloadRows.length === 1 ? "" : "s"}</button>
      <a class="btn secondary" href="/">Back to dashboard</a>
    </div>
    ${contactBlocks || `<p class="meta">Nothing matches this filter for this week.</p>`}
  </form>

  ${standaloneForms.join("")}

  ${
    ignoredList.results.length
      ? `<section>
    <h2>Currently ignored (${ignoredList.results.length})</h2>
    <p class="meta" style="margin:0 0 10px">Their email never reaches this page until you un-ignore them.</p>
    <table><tbody>${ignoredList.results
      .map(
        (r) => `<tr>
      <td><a href="/contacts/${r.id}">${esc(r.full_name)}</a>${r.org ? ` <span class="meta">· ${esc(r.org)}</span>` : ""}</td>
      <td style="text-align:right">
        <form method="post" action="/email/import/unignore" style="display:inline">
          <input type="hidden" name="contact_id" value="${r.id}">
          <input type="hidden" name="week" value="${esc(anchor)}">
          <button class="tiny secondary" type="submit">Un-ignore</button>
        </form>
      </td>
    </tr>`
      )
      .join("")}</tbody></table>
  </section>`
      : ""
  }

  <section>
    <h2>What this writes</h2>
    <ul class="meta" style="margin:0;padding-left:20px;line-height:1.7">
      <li>One interaction per ticked row — type <b>Email</b>, the direction shown, dated the day the message was sent or received, with the subject line as the subject.</li>
      <li><b>Re-running a week is safe.</b> Rows already logged show as "logged" and cannot be ticked, so nothing is written twice.</li>
      <li><b>Excluded is a real "no".</b> Click Exclude on a row and it stops appearing among the not-yet-decided ones — permanently, until you click Undo on it under the Excluded filter.</li>
      <li><b>Ignore a person</b> and none of their mail is matched at all, going forward, until you un-ignore them below.</li>
      <li>Each affected contact's <b>last touch</b> is recomputed and the <b>escalation ladder</b> is reconciled forward — sent mail can raise the attempt count, received mail never does.</li>
      <li>Only people with an email address on file can be matched. An unmatched message is counted above but never guessed at.</li>
    </ul>
  </section>`)
  );
});

// ---------------------------------------------------------------- review-state actions

app.post("/email/import/exclude", async (c) => {
  const f = await c.req.parseBody();
  const messageId = str(f.message_id);
  const contactId = Number(str(f.contact_id));
  const week = str(f.week);
  if (messageId && contactId) {
    const contact = await c.env.DB.prepare("SELECT full_name FROM contact WHERE id = ?")
      .bind(contactId)
      .first<{ full_name: string }>();
    if (contact) {
      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO email_import_exclusion (message_id, contact_id) VALUES (?,?)"
      )
        .bind(messageId, contactId)
        .run();
      await audit(
        c.env.DB,
        "email_import_exclusion",
        String(contactId),
        "create",
        `message excluded from email import for ${contact.full_name}`,
        undefined,
        `contact-${contactId}`
      );
    }
  }
  return c.redirect(backToImport(week, "pending"));
});

app.post("/email/import/unexclude", async (c) => {
  const f = await c.req.parseBody();
  const messageId = str(f.message_id);
  const contactId = Number(str(f.contact_id));
  const week = str(f.week);
  if (messageId && contactId) {
    const contact = await c.env.DB.prepare("SELECT full_name FROM contact WHERE id = ?")
      .bind(contactId)
      .first<{ full_name: string }>();
    const res = await c.env.DB.prepare(
      "DELETE FROM email_import_exclusion WHERE message_id = ? AND contact_id = ?"
    )
      .bind(messageId, contactId)
      .run();
    if (contact && (res?.meta?.changes ?? 0) > 0) {
      await audit(
        c.env.DB,
        "email_import_exclusion",
        String(contactId),
        "delete",
        `message un-excluded for ${contact.full_name} — back to not-yet-decided`,
        undefined,
        `contact-${contactId}`
      );
    }
  }
  return c.redirect(backToImport(week, "excluded"));
});

app.post("/email/import/ignore", async (c) => {
  const f = await c.req.parseBody();
  const contactId = Number(str(f.contact_id));
  const week = str(f.week);
  if (contactId) {
    const contact = await c.env.DB.prepare(
      "SELECT full_name, email_import_ignore FROM contact WHERE id = ?"
    )
      .bind(contactId)
      .first<{ full_name: string; email_import_ignore: number }>();
    if (contact && !contact.email_import_ignore) {
      await c.env.DB.prepare(
        "UPDATE contact SET email_import_ignore = 1, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(contactId)
        .run();
      await audit(
        c.env.DB,
        "contact",
        String(contactId),
        "update",
        `email import: watching → ignored — ${contact.full_name}'s messages will not be matched until un-ignored`,
        `${contact.full_name}: email import watching`,
        `contact-${contactId}`
      );
    }
  }
  return c.redirect(backToImport(week, "pending"));
});

app.post("/email/import/unignore", async (c) => {
  const f = await c.req.parseBody();
  const contactId = Number(str(f.contact_id));
  const week = str(f.week);
  if (contactId) {
    const contact = await c.env.DB.prepare(
      "SELECT full_name, email_import_ignore FROM contact WHERE id = ?"
    )
      .bind(contactId)
      .first<{ full_name: string; email_import_ignore: number }>();
    if (contact && contact.email_import_ignore) {
      await c.env.DB.prepare(
        "UPDATE contact SET email_import_ignore = 0, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(contactId)
        .run();
      await audit(
        c.env.DB,
        "contact",
        String(contactId),
        "update",
        `email import: ignored → watching again — ${contact.full_name}`,
        `${contact.full_name}: email import ignored`,
        `contact-${contactId}`
      );
    }
  }
  return c.redirect(backToImport(week, "pending"));
});

// ---------------------------------------------------------------- commit

app.post("/email/import", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const week = typeof body.week === "string" ? body.week : "";
  const takeRaw = body.take;
  const take = new Set(
    (Array.isArray(takeRaw) ? takeRaw : takeRaw === undefined ? [] : [takeRaw]).map((v) => Number(v))
  );

  let offered: {
    n: number;
    messageId: string;
    contactId: number;
    date: string;
    direction: "outbound" | "inbound";
    subject: string;
  }[] = [];
  try {
    offered = JSON.parse(typeof body.payload === "string" ? body.payload : "[]");
  } catch {
    return c.redirect("/email/import");
  }
  const chosen = offered.filter((r) => take.has(r.n));
  if (!chosen.length) return c.redirect(`/email/import${week ? `?week=${encodeURIComponent(week)}` : ""}`);

  /*
   * Re-check the refs at write time rather than trusting the preview, which may be minutes old. The
   * importer learned this the hard way: the check that protects the data is the one that runs against
   * current state at the moment of the write, not the one that drew the screen.
   */
  const { results: refs } = await c.env.DB.prepare(
    "SELECT outlook_ref FROM interaction WHERE outlook_ref IS NOT NULL"
  ).all<{ outlook_ref: string }>();
  const seen = new Set(refs.map((r) => r.outlook_ref));

  const insert = c.env.DB.prepare(
    `INSERT INTO interaction (contact_id, date, type, direction, subject, outlook_ref)
     VALUES (?,?,'email',?,?,?)`
  );
  const statements = [];
  const touched = new Set<number>();
  let skipped = 0;
  for (const r of chosen) {
    const ref = `${r.messageId}::${r.contactId}`;
    if (seen.has(ref)) {
      skipped++;
      continue;
    }
    seen.add(ref);
    statements.push(insert.bind(r.contactId, r.date, r.direction, r.subject.slice(0, 300), ref));
    touched.add(r.contactId);
  }

  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await c.env.DB.batch(statements.slice(i, i + BATCH_SIZE));
  }

  /*
   * last_touch is derived, so it is recomputed; the ladder is reconciled FORWARD ONLY (REL-035), which
   * is what makes bulk-logging safe here. A week of sent mail can raise the attempt count and move the
   * last-attempt date later, and received mail can do neither — so importing a busy week can never make
   * a contact look more neglected than they are.
   */
  for (const id of touched) {
    await c.env.DB.prepare(
      `UPDATE contact SET last_touch = (SELECT MAX(date) FROM interaction WHERE contact_id = ? AND date <= date('now')),
        updated_at = datetime('now') WHERE id = ?`
    )
      .bind(id, id)
      .run();
    await reconcileAttemptLadder(c.env.DB, id);
  }

  await c.env.DB.prepare(
    `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id)
     VALUES (?,?,?,?,?,?,?,?)`
  )
    .bind(
      ACTOR,
      "interaction",
      "batch",
      "import",
      `${offered.length} unlogged row${offered.length === 1 ? "" : "s"} offered for the week of ${week}; ${chosen.length} selected`,
      `${statements.length} email interaction${statements.length === 1 ? "" : "s"} logged across ${touched.size} contact${
        touched.size === 1 ? "" : "s"
      }${skipped ? `; ${skipped} skipped as already logged since the preview` : ""}`,
      "mail-import",
      `mail-import-${Date.now()}`
    )
    .run();

  return c.html(
    page(`<h1>Email Logged</h1>
  <div class="card">
    <dl class="kv">
      <dt>Interactions written</dt><dd><b>${statements.length}</b></dd>
      <dt>Contacts touched</dt><dd>${touched.size}</dd>
      <dt>Skipped</dt><dd>${skipped}${skipped ? ' <span class="meta">· already logged since the preview</span>' : ""}</dd>
    </dl>
  </div>
  <div class="actions">
    <a class="btn" href="/email/import${week ? `?week=${encodeURIComponent(week)}` : ""}">Back to that week</a>
    <a class="btn secondary" href="/">Dashboard</a>
  </div>`)
  );
});

export default app;
