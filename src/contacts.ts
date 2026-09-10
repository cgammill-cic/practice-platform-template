// Contact record + interactions (REL-003), add/edit (REL-009), meeting scheduling and resolution +
// interaction editing (REL-012), resolution integrity (REL-014), reach-out-later intervals (REL-015),
// action items on the record and in the resolution flow (REL-025).
// The contact list and its search live in contactList.ts (REL-017) — they were originally here under
// REL-002 and the superseded handler was removed in #37.
// Every write records an audit event (AUD-001) with a real field-level diff (AUD-003).

import { Hono } from "hono";
import {
  DEPARTMENTS,
  DIRECTIONS,
  INTERACTION_TYPES,
  MAX_PRIORITY_TIER,
  MAX_TOUCH_INTERVAL_DAYS,
  MEETING_FORMATS,
  MEETING_OUTCOMES,
  SOURCES,
  STAGES,
  STATUSES,
  ENGAGEMENT_STATUSES,
  PURSUIT_ROLES,
  STRENGTHS,
  TERMINAL_STAGES,
  TOUCH_INTERVALS,
  labelFor,
  stageLabel,
  type Bindings,
  type Contact,
  type D1Db,
  type Interaction,
} from "./types";
import { isAttempt, reconcileAttemptLadder } from "./attempts";
import { pursuitsForContact } from "./pursuits";
import { esc, followUpPill, formatTime, layout, select } from "./views";
import { historyBlock, historyEntry } from "./history";
import { contactActionBlock, contactActions, insertActionItem } from "./actions";

const ACTOR = "operator";
/** How many interactions the contact record shows. Everything older lives on the full history page. */
const RECENT_HISTORY = 5;
const today = () => new Date().toISOString().slice(0, 10);
/**
 * N days after a date, defaulting to today.
 *
 * The `from` parameter was added for the keep-in-touch cadence (REL-027): a cadence counts from the
 * interaction's OWN date, not from now, so recording last Tuesday's coffee on a 30-day rhythm produces a
 * date 30 days after that coffee rather than 30 days after the data entry. Every existing caller omits it
 * and keeps the previous behaviour byte for byte.
 */
const plusDays = (n: number, from?: string) =>
  new Date((from ? Date.parse(`${from}T00:00:00Z`) : Date.now()) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * last_touch answers "how long since I actually spoke to this person" and feeds every staleness
 * calculation, including the REL-008 escalation ladder. A future date poisons all of it, so any date
 * later than today is clamped. Found 2026-07-30: a meeting scheduled for Aug 7 was resolved as Held
 * on Jul 30 and set last_touch eight days into the future (#30).
 */
const notFuture = (d: string) => (d > today() ? today() : d);

/*
 * RESOLVING next_follow_up WHEN A PARKING STAGE OR A CADENCE CHANGES (2026-08-18).
 *
 * The report: moving a contact to Stay Connected and setting a connection range still left it showing
 * as overdue — updating the stage to Reach out later, Stay connected, Pray, or Complete needs to move
 * a stale follow-up date forward automatically rather than leaving it exactly where it was.
 *
 * WHY IT WAS BROKEN. The cadence (REL-027) only ever fired when an INTERACTION was recorded. Setting a
 * stage or an interval on the contact form wrote both values and left `next_follow_up` exactly as it was —
 * so a date left over from a previous action stayed put and stayed overdue.
 *
 * FIRING ON THE CADENCE CHANGE TOO IS LOAD-BEARING, and this is the part the literal request would have
 * missed. The actual sequence, recovered from one contact's real history:
 *
 *     14:54:47  stage complete → stay_connected      (no interval set yet)
 *     14:55:47  touch_interval_days none → 180        (a SEPARATE save, stage unchanged)
 *
 * A rule scoped to "when the stage changes to one of the four" would have run at 14:54:47, found no
 * interval, and left the date alone — the bug would have survived the fix. Recovered from
 * contact_stage_event (migration 0020), which is the first thing that table has been useful for.
 *
 * THE RULES, decided 2026-08-18:
 *
 *   1. A DATE HE TYPED ALWAYS WINS. If the submitted follow-up differs from what was stored, that is a
 *      decision and nothing here touches it. Same principle the interaction form has always followed.
 *   2. ONLY STALE DATES ARE RECOMPUTED — missing, or already past. A future date is a live commitment;
 *      moving it would be the silent class of change this codebase refuses to make. So changing a cadence
 *      from 30 to 180 days does NOT shove next week's reminder out to February.
 *   3. WITH a cadence: the date is the interval counted from the last touch, or from today if the last
 *      touch is older than that — never a date in the past, which would just be overdue again on save.
 *   4. WITHOUT a cadence, or on a terminal stage: CLEAR it. A parked contact with no rhythm genuinely has
 *      no next step, and Needs Attention says exactly that. Better a visible gap than a false deadline.
 *   5. ERASING THE DATE ON A CADENCED PARKING STAGE MEANS "RECOMPUTE", not "leave me with nothing"
 *      (added 2026-08-19; see the block on cadenceRecompute below for the 19 contacts it cost). This is
 *      the one carve-out from rule 1, and it exists because rule 1's reading of an erase was wrong:
 *      "The reason I deleted the next follow up date is because I created that date in the first place."
 *
 * Returns `undefined` when nothing should change, which the caller distinguishes from `null` (clear it).
 */
const FOLLOW_UP_RESET_STAGES = ["reach_out_later", "stay_connected", "pray", "complete"] as const;

export function resolveFollowUpOnSave(opts: {
  beforeStage: string;
  afterStage: string;
  beforeInterval: number | null;
  afterInterval: number | null;
  storedFollowUp: string | null;
  submittedFollowUp: string | null;
  lastTouch: string | null;
  todayIso: string;
}): string | null | undefined {
  const parking = FOLLOW_UP_RESET_STAGES.some((v) => v === opts.afterStage);
  const terminalStage = TERMINAL_STAGES.some((v) => v === opts.afterStage);

  /*
   * RULE 5, added 2026-08-19 after this cost a batch of contacts their follow-up dates in one sitting.
   * Erasing a populated date on a parking stage that HAS a cadence means "recompute it", not "leave me
   * with nothing".
   *
   * Rule 1 below treats any submitted-vs-stored difference as a decision, and an erase is a
   * difference — so the blank was honoured and rules 2-4 never ran. Worse, no later save could
   * recover: the recompute gate needs a stage or interval change, and on the second save neither
   * has moved. The contact sat with a cadence, no date, and dropped out of the follow-up list
   * entirely — quieter than the overdue state it replaced, and therefore worse.
   *
   * In one short working session, cadences were set on nineteen contacts, clearing the stale date each
   * time because the operator was the one who had typed it in the first place. Every single one saved
   * blank. The natural reading of the field — "I deleted the date because I created it" — and the code
   * disagreed with it.
   *
   * Deliberately NOT extended to two neighbouring cases, because there an erase is a real decision:
   *   - a parking stage with NO cadence — a parked contact with no rhythm has no next step, and
   *     Needs Attention should say so (rule 4's reasoning, unchanged);
   *   - a non-parking stage such as follow_up_action — that date is a commitment the operator owns
   *     outright.
   */
  const clearedByHand = !opts.submittedFollowUp && !!opts.storedFollowUp;
  const cadenceRecompute = clearedByHand && parking && !terminalStage && !!opts.afterInterval;

  // Rule 1: he changed the date himself. His decision, untouched.
  if (!cadenceRecompute && (opts.submittedFollowUp ?? null) !== (opts.storedFollowUp ?? null))
    return undefined;

  const stageMoved = opts.beforeStage !== opts.afterStage;
  const intervalMoved = (opts.beforeInterval ?? null) !== (opts.afterInterval ?? null);
  if (!cadenceRecompute && !stageMoved && !intervalMoved) return undefined;
  if (!parking) return undefined;

  // Rule 2: a future date is a live commitment. Only stale ones are ours to move.
  const stale = !opts.submittedFollowUp || opts.submittedFollowUp <= opts.todayIso;
  if (!stale) return undefined;

  // Rule 4: terminal, or no rhythm to compute from.
  if (terminalStage || !opts.afterInterval) return opts.submittedFollowUp ? null : undefined;

  // Rule 3: count from the last touch, but never land in the past.
  const fromTouch = plusDays(opts.afterInterval, opts.lastTouch ?? opts.todayIso);
  const next = fromTouch > opts.todayIso ? fromTouch : plusDays(opts.afterInterval, opts.todayIso);
  return next === (opts.submittedFollowUp ?? null) ? undefined : next;
}

/**
 * Where a resolved meeting lands when the operator doesn't pick a stage. A meeting cannot stay in
 * meeting_scheduled once its date is cleared — that combination is the invisible state that hid a
 * contact from every dashboard list (#30).
 */
const RESOLUTION_STAGE: Record<string, string> = {
  // Held → Follow-Up Action (REL-020, changed 2026-07-31): you usually leave a meeting owing
  // something, so the default should be "the next move is mine" rather than the vaguer
  // in_conversation. Still a prefill the operator can change on the resolution form.
  held: "follow_up_action",
  no_show: "awaiting_response",
  cancelled: "awaiting_response",
};

/** How many days out to place a follow-up when a resolution would otherwise leave none. */
const FALLBACK_FOLLOW_UP_DAYS = 7;

/**
 * How many action item rows the meeting resolution form offers (REL-025). Three: one is too few for a
 * real meeting, and an unbounded repeater is more machinery than a single-user app needs. Blank rows
 * are skipped silently, so offering three costs nothing on a meeting that produced one commitment.
 *
 * The fields are named with an index rather than repeated, because parseBody() keeps only the last
 * value for a duplicated key by default — three identically-named inputs would silently record one
 * commitment and drop two, which is the exact failure this feature exists to prevent.
 */
const RESOLUTION_ACTION_ROWS = 3;

/**
 * One-click "come back to this person later" (REL-015).
 *
 * The interval is stored as an actual follow-up DATE, not encoded in the stage name. An earlier proposal
 * split the stage into "Reach Out Later 4 weeks" and "Reach Out Later 8 weeks" and suppressed
 * those from Needs Attention until the interval elapsed. That would make the wake-up moment implicit
 * — derivable only from when the stage was last changed, which would need a new stage_changed_at
 * column and a second source of truth for when to act. An implicit date that exists only by
 * calculation is exactly what hid a contact from every list on 2026-07-30.
 *
 * "Reach Out Later" plus a follow-up of 2026-08-27 IS "reach out in four weeks", stated as a fact.
 * It then behaves correctly for free: no Needs Attention entry, no dashboard noise until the date
 * arrives, and it surfaces in Overdue Follow-Ups on the day. Any interval works, not just two.
 */
const REACH_OUT_INTERVALS: readonly (readonly [string, number])[] = [
  ["4 weeks", 28],
  ["8 weeks", 56],
  ["3 months", 91],
  ["6 months", 182],
];
const MAX_REACH_OUT_DAYS = 730;

/** Fields whose full value is too long to put in an audit summary; report the shape of the change. */
const LONG_FIELDS = new Set(["summary", "notes_link"]);

/**
 * Human-readable field-level diff for the audit trail. Returns "" when nothing changed, which the
 * callers treat as "write no audit event at all". Before AUD-003 the summaries were rendered from a
 * fixed template, so two different edits produced byte-identical before/after text and the trail
 * recorded that something changed without ever recording what.
 */
function fieldDiff(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(after)) {
    const rawB = before[key];
    const rawA = after[key];
    const b = rawB === null || rawB === undefined || rawB === "" ? null : String(rawB);
    const a = rawA === null || rawA === undefined || rawA === "" ? null : String(rawA);
    if (b === a) continue;
    if (LONG_FIELDS.has(key)) {
      parts.push(
        !b ? `${key} added (${a!.length} chars)` : !a ? `${key} cleared` : `${key} rewritten (${b.length} → ${a.length} chars)`
      );
    } else {
      parts.push(`${key} ${b ?? "none"} → ${a ?? "none"}`);
    }
  }
  return parts.join("; ");
}

/**
 * Writes one audit event.
 *
 * correlationId groups events that belong together (AUD-003, #31). Two conventions are in use, and
 * they do not collide because they answer different questions:
 *   - `delete-contact-<id>` — one operation that touched several tables, used by contactList.ts so a
 *     reader can see the contact, its action items, and its emptied organization went together.
 *   - `contact-<id>` — every event ABOUT a relationship, used below so an interaction event is
 *     traceable to its contact by a query rather than by reading prose.
 *
 * Before this, an interaction event recorded its contact only inside after_summary as "contact 3 ·
 * meeting on …". That is readable but not queryable, so "show me everything that happened to this
 * relationship" could not be answered — which is precisely what the AUD-002 viewer (#27) needs to do.
 * A dedicated audit_event.contact_id column would be the cleaner long-term shape; correlation_id
 * carries it now without a migration, and #27 can decide whether to promote it.
 */
async function audit(
  db: D1Db,
  entity: string,
  entityId: string | number,
  action: string,
  after: string,
  before?: string,
  correlationId?: string
) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,?,?,?,?,?,'app',?)"
    )
    .bind(ACTOR, entity, String(entityId), action, before ?? null, after, correlationId ?? null)
    .run();
}

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

/**
 * last_touch is derived from the interactions, so it must be recomputed whenever one is created,
 * edited, or deleted — otherwise correcting a mistyped date would leave the contact showing a touch
 * that no longer exists. Future-dated interactions are excluded: a meeting booked for next week is
 * not a touch that has happened yet.
 */
async function recomputeLastTouch(db: D1Db, contactId: number) {
  await db
    .prepare(
      `UPDATE contact SET
         last_touch = (SELECT MAX(date) FROM interaction WHERE contact_id = ? AND date <= date('now')),
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(contactId, contactId)
    .run();
}

/** Resolve an organization name to an id, creating the organization if needed. */
async function resolveOrganization(db: D1Db, name: string | null): Promise<number | null> {
  if (!name) return null;
  const existing = await db
    .prepare("SELECT id FROM organization WHERE lower(name) = lower(?)")
    .bind(name)
    .first<{ id: number }>();
  if (existing) return existing.id;
  await db.prepare("INSERT INTO organization (name) VALUES (?)").bind(name).run();
  const created = await db
    .prepare("SELECT id FROM organization WHERE lower(name) = lower(?)")
    .bind(name)
    .first<{ id: number }>();
  if (created) await audit(db, "organization", created.id, "create", `created via contact form: ${name}`);
  return created?.id ?? null;
}

/** Duplicate check: either email matches (work or personal, cross-wise), or name + organization match. */
async function findDuplicates(
  db: D1Db,
  data: { full_name: string; email_work: string | null; email_personal: string | null; organization_id: number | null },
  excludeId?: number
): Promise<Contact[]> {
  const emails = [data.email_work, data.email_personal].filter(Boolean) as string[];
  const emailClause = emails.length
    ? `OR lower(ifnull(c.email_work,'')) IN (${emails.map(() => "lower(?)").join(",")})
       OR lower(ifnull(c.email_personal,'')) IN (${emails.map(() => "lower(?)").join(",")})`
    : "";
  const { results } = await db
    .prepare(
      `SELECT c.*, o.name AS organization_name FROM contact c LEFT JOIN organization o ON o.id = c.organization_id
       WHERE c.id != ?
         AND ( (lower(c.full_name) = lower(?) AND ifnull(c.organization_id,-1) = ifnull(?,-1)) ${emailClause} )
       LIMIT 5`
    )
    .bind(excludeId ?? -1, data.full_name, data.organization_id, ...emails, ...emails)
    .all<Contact>();
  return results;
}

const app = new Hono<{ Bindings: Bindings }>();

// ---------------------------------------------------------------- new / edit form (REL-009)

function contactForm(opts: {
  contact?: Partial<Contact> & { organization_name?: string | null };
  orgNames: string[];
  /** Active contacts, for the referral type-ahead (REL-005). */
  people?: readonly { full_name: string; organization_name: string | null }[];
  /** The current referrer's name, so an edit round-trips instead of silently clearing the link. */
  referralName?: string | null;
  error?: string;
  duplicates?: Contact[];
  confirmToken?: boolean;
}): string {
  const c = opts.contact ?? {};
  const isEdit = Boolean(c.id);
  const action = isEdit ? `/contacts/${c.id}/edit` : "/contacts/new";
  const dupWarning = opts.duplicates?.length
    ? `<div class="flash warn"><b>Possible duplicate.</b> ${opts.duplicates
        .map((d) => `<a href="/contacts/${d.id}">${esc(d.full_name)}${d.organization_name ? ` (${esc(d.organization_name)})` : ""}</a>`)
        .join(", ")} already ${opts.duplicates.length > 1 ? "exist" : "exists"} with a matching email or name + organization. Save again to create anyway.</div>`
    : "";
  const datalist = `<datalist id="orgs">${opts.orgNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>`;
  /*
   * Referral source (REL-005, #16). A type-ahead over names rather than a <select> listing every contact,
   * which is the pattern REL-024 settled on for action items, and resolved server-side by exact name with
   * an ambiguous name refused rather than guessed at (resolveReferrer below).
   *
   * Names, not ids, in the input: this is a field a person types into, and a person's name is what
   * they know. That differs from the /templates and /audit links added in #59, which carry ids because a
   * link has no typist to disambiguate for it.
   */
  const peopleList = `<datalist id="people">${(opts.people ?? [])
    .map((k) => `<option value="${esc(k.full_name)}">${esc(k.organization_name ?? "")}</option>`)
    .join("")}</datalist>`;

  return `<main>
  <h1>${isEdit ? `Edit ${esc(c.full_name)}` : "Add Contact"}</h1>
  <p class="sub">${isEdit ? "Changes are recorded in the audit trail." : "Only a name is required — fill in what you know now."}</p>
  ${opts.error ? `<div class="flash warn">${esc(opts.error)}</div>` : ""}
  ${dupWarning}
  <form method="post" action="${action}" class="card">
    ${opts.confirmToken ? '<input type="hidden" name="confirm_duplicate" value="1">' : ""}
    <label>Full Name <span class="hint">required</span></label>
    <input type="text" name="full_name" value="${esc(c.full_name)}" required autofocus>
    <div class="row">
      <div><label>Title</label><input type="text" name="title" value="${esc(c.title)}"></div>
      <div><label>Organization <span class="hint">new names are created automatically</span></label>
        <input type="text" name="organization" list="orgs" value="${esc(c.organization_name)}">${datalist}</div>
    </div>
    <div class="row">
      <div><label>Department</label>${select("department", DEPARTMENTS, c.department ?? null, { blank: "—" })}</div>
      <div><label>Priority Tier <span class="hint">1 = highest, 5 = lowest</span></label><input type="number" name="priority_tier" min="1" max="${MAX_PRIORITY_TIER}" value="${esc(c.priority_tier)}"></div>
    </div>
    <div class="row">
      <div><label>Work Email</label><input type="email" name="email_work" value="${esc(c.email_work)}"></div>
      <div><label>Personal Email <span class="hint">less likely to be filtered as spam</span></label><input type="email" name="email_personal" value="${esc(c.email_personal)}"></div>
    </div>
    <div class="row">
      <div><label>Phone</label><input type="text" name="phone" value="${esc(c.phone)}"></div>
      <div><label>LinkedIn URL</label><input type="url" name="linkedin_url" value="${esc(c.linkedin_url)}"></div>
    </div>
    ${/*
      REL-011 (#26). The one place the "no LinkedIn profile" mark can be set or cleared on a single
      record — the /linkedin worklist can only set it, since a marked contact leaves that list. It sits
      directly under the URL field because the two are one question with two answers, and a checkbox
      three fieldsets away from the field it contradicts is a checkbox nobody connects to anything.

      Ticking it WITH a URL present is refused rather than resolved (see validate). Both fields are on
      screen together here, so the person can see the contradiction; the worklist clears the mark
      silently when a URL is saved because there the URL is the assertion just made, and it is audited.
    */ ""}
    <label class="check"><input type="checkbox" name="no_linkedin" value="1"${c.no_linkedin ? " checked" : ""}>
      They have no LinkedIn profile <span class="hint">— keeps them off the <a href="/linkedin">Missing LinkedIn</a> worklist, and stops the chase list asking you to add a URL</span></label>
    <div class="row">
      <div><label>Stage</label>${select("stage", STAGES, c.stage ?? "not_contacted")}</div>
      <div><label>Relationship Strength</label>${select("strength", STRENGTHS, c.strength ?? null, { blank: "—" })}</div>
    </div>
    <div class="row">
      <div><label>Referred By <span class="hint">optional — start typing the name of the contact who introduced you</span></label>
        <input type="text" name="referral_source" list="people" value="${esc(opts.referralName)}" placeholder="e.g. Jane Smith">${peopleList}</div>
    </div>
    <div class="row">
      <div><label>Meeting Date <span class="hint">drives the dashboard meeting lists</span></label><input type="date" name="meeting_date" value="${esc(c.meeting_date)}"></div>
      <div><label>Meeting Time <span class="hint">free text, e.g. 10:30 am</span></label><input type="text" name="meeting_time" value="${esc(c.meeting_time)}"></div>
    </div>
    <div class="row">
      <div><label>Next Follow-Up <span class="hint">leave blank if you set a cadence below</span></label><input type="date" name="next_follow_up" value="${esc(c.next_follow_up)}"></div>
      <div><label>Last Touch <span class="hint">recalculated from interactions; future dates are ignored</span></label><input type="date" name="last_touch" value="${esc(c.last_touch)}"></div>
      <div><label>Birthday</label><input type="date" name="birthday" value="${esc(c.birthday)}"></div>
    </div>
    ${/*
      Keep-in-touch cadence (REL-027, #93). Placed beside the follow-up date because it is the thing that
      will WRITE that date: every interaction you record on this contact sets the next follow-up this many
      days out, unless you type one on the form yourself.

      A number input with suggestions rather than a select. The offered values are the common rhythms, but
      the column takes anything from 1 to 1095 days and someone will want 45 — a select would have to be
      edited to allow it, and a free field costs nothing.
    */ ""}
    <div class="row">
      <div><label>Touch Every <span class="hint">days — blank means no cadence. Suggestions: ${TOUCH_INTERVALS.join(
        ", "
      )}</span></label>
        <input type="number" name="touch_interval_days" min="1" max="${MAX_TOUCH_INTERVAL_DAYS}" list="intervals" value="${esc(
          c.touch_interval_days
        )}" placeholder="e.g. 90">
        <datalist id="intervals">${TOUCH_INTERVALS.map((d) => `<option value="${d}"></option>`).join("")}</datalist></div>
    </div>
    <p class="meta" style="margin-top:6px">Set this and recording any interaction moves the next follow-up that far out, so Stay Connected and Pray contacts keep coming back round instead of sitting in Needs Attention. On Reach Out Later, Stay Connected and Pray it also fills the follow-up date above when you leave that field blank, or clear a date you had set — counted from the last touch. It never moves a future date you typed yourself.</p>
    <label>Notes <span class="hint">any personal information you have available (how you met, family names, interests, etc.)</span></label>
    <textarea name="notes">${esc(c.notes)}</textarea>
    ${isEdit ? `<label>Status</label>${select("status", STATUSES, c.status ?? "active")}` : ""}
    <div class="actions">
      <button type="submit">${isEdit ? "Save Changes" : "Create Contact"}</button>
      <a class="btn secondary" href="${isEdit ? `/contacts/${c.id}` : "/contacts"}">Cancel</a>
    </div>
  </form>
</main>`;
}

/** Active contacts for the referral type-ahead. Ordered so the datalist reads alphabetically. */
async function people(db: D1Db): Promise<{ full_name: string; organization_name: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT c.full_name, o.name AS organization_name FROM contact c
       LEFT JOIN organization o ON o.id = c.organization_id
       WHERE c.status='active' ORDER BY c.full_name LIMIT 600`
    )
    .all<{ full_name: string; organization_name: string | null }>();
  return results;
}

/** The referrer's name, for prefilling the edit form and for a readable audit diff. */
async function referrerName(db: D1Db, id: number | null | undefined): Promise<string | null> {
  if (!id) return null;
  const row = await db.prepare("SELECT full_name FROM contact WHERE id = ?").bind(id).first<{ full_name: string }>();
  return row?.full_name ?? null;
}

/**
 * Resolves the typed referrer name to a contact id (REL-005, #16).
 *
 * Blank means "no referrer", which is the common case and must stay cheap to express. Everything else
 * is resolved by exact name against active contacts, and an ambiguous name is REFUSED rather than
 * guessed at: full_name has no unique constraint, so two same-named contacts are creatable, and
 * crediting a referral to the wrong person is the kind of error you would act on socially before
 * noticing. Same reasoning as resolveContact() in actions.ts.
 *
 * Self-reference is refused too. It is not a meaningful state, and the delete path and the report both
 * read cleaner for never having to special-case a contact that referred itself.
 */
async function resolveReferrer(
  db: D1Db,
  typed: string | null,
  selfId?: number
): Promise<{ id: number | null } | { error: string }> {
  if (!typed) return { id: null };
  const { results } = await db
    .prepare("SELECT id, full_name FROM contact WHERE lower(full_name) = lower(?) AND status='active'")
    .bind(typed)
    .all<{ id: number; full_name: string }>();
  if (results.length === 0)
    return { error: `No active contact named “${typed}”, so the referral source was not set. Pick a name from the suggestions, or add that person as a contact first.` };
  if (results.length > 1)
    return { error: `More than one active contact is named “${typed}”, so the referral source was not set — crediting the wrong person is worse than asking again. Open the right record to check which organization, then type the name exactly.` };
  if (selfId && results[0].id === selfId)
    return { error: "A contact cannot be their own referral source." };
  return { id: results[0].id };
}

async function orgNames(db: D1Db): Promise<string[]> {
  const { results } = await db.prepare("SELECT name FROM organization ORDER BY name LIMIT 500").all<{ name: string }>();
  return results.map((r) => r.name);
}

app.get("/contacts/new", async (c) =>
  c.html(
    layout({
      title: "Add Contact",
      body: contactForm({ orgNames: await orgNames(c.env.DB), people: await people(c.env.DB) }),
    })
  )
);

interface ParsedForm {
  full_name: string | null;
  title: string | null;
  organization: string | null;
  department: string | null;
  priority_tier: string | null;
  email_work: string | null;
  email_personal: string | null;
  phone: string | null;
  linkedin_url: string | null;
  /** REL-011. A checkbox, so absent from the body means unticked — there is no "unchanged" state. */
  no_linkedin: boolean;
  /** REL-027. Blank means no cadence; the string is validated in validate(). */
  touch_interval_days: string | null;
  birthday: string | null;
  stage: string;
  strength: string | null;
  next_follow_up: string | null;
  last_touch: string | null;
  meeting_date: string | null;
  meeting_time: string | null;
  notes: string | null;
  status: string;
  referral_source: string | null;
  confirm_duplicate: boolean;
}

async function parseContactForm(c: { req: { parseBody(): Promise<Record<string, unknown>> } }): Promise<ParsedForm> {
  const f = await c.req.parseBody();
  return {
    full_name: str(f.full_name),
    title: str(f.title),
    organization: str(f.organization),
    department: str(f.department),
    priority_tier: str(f.priority_tier),
    email_work: str(f.email_work),
    email_personal: str(f.email_personal),
    phone: str(f.phone),
    linkedin_url: str(f.linkedin_url),
    no_linkedin: f.no_linkedin === "1",
    touch_interval_days: str(f.touch_interval_days),
    birthday: str(f.birthday),
    stage: str(f.stage) ?? "not_contacted",
    strength: str(f.strength),
    next_follow_up: str(f.next_follow_up),
    last_touch: str(f.last_touch),
    meeting_date: str(f.meeting_date),
    meeting_time: str(f.meeting_time),
    notes: str(f.notes),
    status: str(f.status) ?? "active",
    referral_source: str(f.referral_source),
    confirm_duplicate: f.confirm_duplicate === "1",
  };
}

/**
 * Validation is deliberately minimal: only the name is required. A missing follow-up date on an
 * active-stage contact is surfaced on the dashboard (“Needs Attention”) rather than blocking the
 * save — changed 2026-07-30 after the block got in the way of real use.
 *
 * The one structural rule enforced here: stage and meeting date must agree, in BOTH directions.
 *
 * Meeting Scheduled requires a meeting date. Without it the contact appears in no meeting list and has
 * no next step, which is precisely how one went missing.
 *
 * And a meeting date requires the stage to be Meeting Scheduled. That half was missing until
 * 2026-08-03, and it let a record hold two facts that contradict each other: a meeting invite came in,
 * the meeting date was added for the next day, and the contact stayed in Chase Non-Responders —
 * because chaseList() selects on `stage='awaiting_response'` and nothing had moved the stage. The
 * record simultaneously said "a meeting is booked for tomorrow" and "they have never replied".
 *
 * Refused rather than auto-corrected. Quietly rewriting a stage the user did not touch is the same
 * class of move as a silent import default, and this codebase does not make it — the reason a contact
 * is in a stage should always be that someone put it there. The message names both facts and both ways
 * out, so the refusal costs one click either way.
 *
 * Note this will refuse the next edit of any record already in the contradictory state. A handful
 * existed as of 2026-08-03, each in_conversation with a booked meeting. That is the rule working: they
 * are wrong now and nothing would otherwise tell anyone.
 */
function validate(form: ParsedForm): string | null {
  if (!form.full_name) return "A full name is required.";
  const tier = form.priority_tier ? Number(form.priority_tier) : null;
  if (tier !== null && (Number.isNaN(tier) || tier < 1 || tier > MAX_PRIORITY_TIER))
    return `Priority tier must be between 1 and ${MAX_PRIORITY_TIER}.`;
  if (form.stage === "meeting_scheduled" && !form.meeting_date)
    return "Stage is Meeting Scheduled, so a Meeting Date is required — otherwise the meeting appears on no dashboard list. Set the date, or choose a different stage.";
  /*
   * REL-011: a URL and "they have no LinkedIn profile" cannot both be true. Refused rather than
   * silently resolved, for the same reason as the stage/meeting rule above — and it costs nothing, since
   * both controls are visible on the form together. The two ways out are named.
   */
  if (form.no_linkedin && form.linkedin_url)
    return "“They have no LinkedIn profile” is ticked, but a LinkedIn URL is filled in — those cannot both be true. Untick the box if the URL is right, or clear the URL if they really are not on LinkedIn.";
  if (form.touch_interval_days) {
    const n = Number(form.touch_interval_days);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TOUCH_INTERVAL_DAYS)
      return `“Touch Every” must be a whole number of days between 1 and ${MAX_TOUCH_INTERVAL_DAYS}, or blank for no cadence.`;
  }
  if (form.meeting_date && form.stage !== "meeting_scheduled")
    return `A Meeting Date is set (${form.meeting_date}), so the stage should be Meeting Scheduled — it is currently ${stageLabel(form.stage)}, which says no meeting is on the calendar. A contact left this way keeps appearing on the lists for people who have not replied. Change the stage to Meeting Scheduled, or clear the Meeting Date if the meeting is not happening.`;
  return null;
}

app.post("/contacts/new", async (c) => {
  const form = await parseContactForm(c);
  const error = validate(form);
  const renderBack = async (extra: { error?: string; duplicates?: Contact[]; confirmToken?: boolean }) =>
    c.html(
      layout({
        title: "Add Contact",
        body: contactForm({
          orgNames: await orgNames(c.env.DB),
          people: await people(c.env.DB),
          referralName: form.referral_source,
          contact: {
            ...form,
            full_name: form.full_name ?? "",
            organization_name: form.organization,
            priority_tier: form.priority_tier ? Number(form.priority_tier) : null,
            // The form carries this as a checkbox boolean; Contact carries the integer SQLite stores.
            no_linkedin: form.no_linkedin ? 1 : 0,
            touch_interval_days: form.touch_interval_days ? Number(form.touch_interval_days) : null,
          },
          ...extra,
        }),
      })
    );
  if (error) return renderBack({ error });

  // Resolved before the insert so an unresolvable name loses nothing: the form comes back populated,
  // rather than the contact being created with the referral silently dropped.
  const referrer = await resolveReferrer(c.env.DB, form.referral_source);
  if ("error" in referrer) return renderBack({ error: referrer.error });

  const organization_id = await resolveOrganization(c.env.DB, form.organization);

  if (!form.confirm_duplicate) {
    const dups = await findDuplicates(c.env.DB, {
      full_name: form.full_name!,
      email_work: form.email_work,
      email_personal: form.email_personal,
      organization_id,
    });
    if (dups.length) return renderBack({ duplicates: dups, confirmToken: true });
  }

  const inserted = await c.env.DB.prepare(
    `INSERT INTO contact (full_name, title, organization_id, department, email_work, email_personal, phone,
      linkedin_url, no_linkedin, birthday, stage, strength, priority_tier, last_touch, next_follow_up, meeting_date,
      meeting_time, notes, referral_source_contact_id, touch_interval_days, source, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'manual','active')`
  )
    .bind(
      form.full_name,
      form.title,
      organization_id,
      form.department,
      form.email_work,
      form.email_personal,
      form.phone,
      form.linkedin_url,
      form.no_linkedin ? 1 : 0,
      form.birthday,
      form.stage,
      form.strength,
      form.priority_tier ? Number(form.priority_tier) : null,
      form.last_touch ? notFuture(form.last_touch) : null,
      form.next_follow_up,
      form.meeting_date,
      form.meeting_time,
      form.notes,
      referrer.id,
      form.touch_interval_days ? Number(form.touch_interval_days) : null
    )
    .run();
  /*
   * The new id comes from the insert itself (#31). This was the last "SELECT id FROM contact ORDER BY
   * id DESC LIMIT 1" in the app, and it was doing two jobs, so it could fail in two ways:
   *   - the audit event would name whichever contact happened to hold the highest id, and
   *   - the redirect would land you on that stranger's record, having apparently created them.
   * The second is worse than a wrong audit row, because you would then edit the wrong person while
   * believing you were finishing the one you just added.
   */
  const createdId = inserted?.meta?.last_row_id ?? 0;
  await audit(
    c.env.DB,
    "contact",
    createdId,
    "create",
    `${form.full_name} · stage ${form.stage}${form.referral_source && referrer.id ? ` · referred by ${form.referral_source}` : ""}`,
    undefined,
    `contact-${createdId}`
  );
  return c.redirect(`/contacts/${createdId}?flash=created`);
});

app.get("/contacts/:id/edit", async (c) => {
  const contact = await c.env.DB.prepare(
    "SELECT c.*, o.name AS organization_name FROM contact c LEFT JOIN organization o ON o.id = c.organization_id WHERE c.id = ?"
  )
    .bind(c.req.param("id"))
    .first<Contact>();
  if (!contact) return c.notFound();
  return c.html(
    layout({
      title: `Edit ${contact.full_name}`,
      body: contactForm({
        contact,
        orgNames: await orgNames(c.env.DB),
        people: await people(c.env.DB),
        referralName: await referrerName(c.env.DB, contact.referral_source_contact_id),
      }),
    })
  );
});

app.post("/contacts/:id/edit", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM contact WHERE id = ?").bind(id).first<Contact>();
  if (!before) return c.notFound();
  const form = await parseContactForm(c);
  const error = validate(form);
  const referrer = error ? null : await resolveReferrer(c.env.DB, form.referral_source, id);
  const referralError = referrer && "error" in referrer ? referrer.error : null;
  if (error || referralError) {
    return c.html(
      layout({
        title: "Edit Contact",
        body: contactForm({
          orgNames: await orgNames(c.env.DB),
          people: await people(c.env.DB),
          referralName: form.referral_source,
          contact: {
            ...before,
            ...form,
            id,
            full_name: form.full_name ?? "",
            organization_name: form.organization,
            priority_tier: form.priority_tier ? Number(form.priority_tier) : null,
            no_linkedin: form.no_linkedin ? 1 : 0,
            touch_interval_days: form.touch_interval_days ? Number(form.touch_interval_days) : null,
          },
          error: error ?? referralError ?? undefined,
        }),
      })
    );
  }
  const referrerId = referrer && !("error" in referrer) ? referrer.id : null;
  // Read before the UPDATE so the diff can name the old referrer rather than printing a bare id.
  const beforeReferrer = await referrerName(c.env.DB, before.referral_source_contact_id);
  const organization_id = await resolveOrganization(c.env.DB, form.organization);
  const lastTouch = form.last_touch ? notFuture(form.last_touch) : null;

  /*
   * Recompute the follow-up date when a parking stage or a cadence changed and the stored date is stale.
   * `undefined` means leave it exactly as submitted; `null` means clear it. See resolveFollowUpOnSave.
   */
  const resolvedFollowUp = resolveFollowUpOnSave({
    beforeStage: before.stage,
    afterStage: form.stage ?? before.stage,
    beforeInterval: before.touch_interval_days ?? null,
    afterInterval: form.touch_interval_days ? Number(form.touch_interval_days) : null,
    storedFollowUp: before.next_follow_up ?? null,
    submittedFollowUp: form.next_follow_up,
    lastTouch: lastTouch ?? before.last_touch ?? null,
    todayIso: today(),
  });
  const nextFollowUpToWrite =
    resolvedFollowUp === undefined ? form.next_follow_up : resolvedFollowUp;

  await c.env.DB.prepare(
    `UPDATE contact SET full_name=?, title=?, organization_id=?, department=?, email_work=?, email_personal=?,
      phone=?, linkedin_url=?, no_linkedin=?, birthday=?, stage=?, strength=?, priority_tier=?, last_touch=?, next_follow_up=?,
      meeting_date=?, meeting_time=?, notes=?, status=?, referral_source_contact_id=?, touch_interval_days=?,
      updated_at=datetime('now') WHERE id=?`
  )
    .bind(
      form.full_name,
      form.title,
      organization_id,
      form.department,
      form.email_work,
      form.email_personal,
      form.phone,
      form.linkedin_url,
      form.no_linkedin ? 1 : 0,
      form.birthday,
      form.stage,
      form.strength,
      form.priority_tier ? Number(form.priority_tier) : null,
      lastTouch,
      nextFollowUpToWrite,
      form.meeting_date,
      form.meeting_time,
      form.notes,
      form.status,
      referrerId,
      form.touch_interval_days ? Number(form.touch_interval_days) : null,
      id
    )
    .run();

  const diff = fieldDiff(
    {
      full_name: before.full_name,
      title: before.title,
      stage: before.stage,
      strength: before.strength,
      priority_tier: before.priority_tier,
      email_work: before.email_work,
      email_personal: before.email_personal,
      phone: before.phone,
      linkedin_url: before.linkedin_url,
      // Rendered as words rather than 1/0: "no_linkedin no → yes" is a sentence in the audit trail,
      // and fieldDiff treats 0 as a value rather than as absent, so a bare number would read "0 → 1".
      no_linkedin: before.no_linkedin ? "yes" : "no",
      birthday: before.birthday,
      department: before.department,
      last_touch: before.last_touch,
      next_follow_up: before.next_follow_up,
      meeting_date: before.meeting_date,
      meeting_time: before.meeting_time,
      status: before.status,
      notes: before.notes,
      touch_interval_days: before.touch_interval_days,
      referred_by: beforeReferrer,
    },
    {
      full_name: form.full_name,
      title: form.title,
      stage: form.stage,
      strength: form.strength,
      priority_tier: form.priority_tier ? Number(form.priority_tier) : null,
      email_work: form.email_work,
      email_personal: form.email_personal,
      phone: form.phone,
      linkedin_url: form.linkedin_url,
      no_linkedin: form.no_linkedin ? "yes" : "no",
      birthday: form.birthday,
      department: form.department,
      last_touch: lastTouch,
      next_follow_up: nextFollowUpToWrite,
      meeting_date: form.meeting_date,
      meeting_time: form.meeting_time,
      status: form.status,
      notes: form.notes,
      touch_interval_days: form.touch_interval_days ? Number(form.touch_interval_days) : null,
      // Named rather than id-valued: "referred_by none → Jane Smith" is a sentence, "241" is a
      // lookup. The id is still recoverable from the contact row itself.
      referred_by: referrerId ? form.referral_source : null,
    }
  );
  if (diff) await audit(c.env.DB, "contact", id, "update", diff.slice(0, 900), before.full_name, `contact-${id}`);
  return c.redirect(`/contacts/${id}?flash=${diff ? "saved" : "nochange"}`);
});

// ---------------------------------------------------------------- reach out later (REL-015)

/**
 * Sets the stage to Reach Out Later and the follow-up date to today + the chosen interval, in one
 * click. Deliberately refuses when a meeting is scheduled: the only way a meeting leaves the
 * dashboard is by being resolved, and a snooze must not become a silent back door around that.
 *
 * THE INTERVAL ALSO BECOMES THE CADENCE WHEN THERE ISN'T ONE (REL-029, 2026-08-19).
 *
 * Until this, the action set a date and nothing else, so "reach out in 3 months" was a single alarm:
 * the date arrived, the contact went overdue, and the same number had to be typed again. Used on a
 * handful of contacts, it produced exactly that: they wouldn't come back round on their own, and a
 * larger check of Reach Out Later contacts found many carrying a date with no rhythm behind it. The
 * control reads like it is setting a rhythm, so it now sets one.
 *
 * ONLY WHEN THE FIELD IS EMPTY. An existing cadence is the operator's considered rhythm for that
 * person; a one-click "come back in 4 weeks" is a nudge about right now, and letting the nudge
 * overwrite the rhythm would be the silent class of change this codebase refuses. So a contact on 180
 * days who gets a 4-week nudge keeps 180 days and simply wakes up sooner this once.
 *
 * MAX_REACH_OUT_DAYS (730) is below MAX_TOUCH_INTERVAL_DAYS (1095), so any value that passes the
 * check above is a legal cadence. Asserted here rather than assumed, because the two constants are
 * declared far apart and raising the first would otherwise write a value the column rejects.
 */
app.post("/contacts/:id/reach-out-later", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM contact WHERE id = ?").bind(id).first<Contact>();
  if (!before) return c.notFound();

  const f = await c.req.parseBody();
  const days = Number(str(f.days) ?? "");
  if (!Number.isInteger(days) || days < 1 || days > MAX_REACH_OUT_DAYS)
    return c.redirect(`/contacts/${id}?flash=badinterval`);
  if (before.meeting_date) return c.redirect(`/contacts/${id}?flash=meetingfirst`);

  const target = plusDays(days);
  const adoptCadence = (before.touch_interval_days ?? null) === null && days <= MAX_TOUCH_INTERVAL_DAYS;

  await c.env.DB.prepare(
    `UPDATE contact SET stage='reach_out_later', next_follow_up=?,
       touch_interval_days=COALESCE(touch_interval_days, ?), updated_at=datetime('now') WHERE id=?`
  )
    .bind(target, adoptCadence ? days : null, id)
    .run();
  await audit(
    c.env.DB,
    "contact",
    id,
    "update",
    `reach out later in ${days} days · stage ${before.stage} → reach_out_later; next_follow_up ${before.next_follow_up ?? "none"} → ${target}${
      adoptCadence
        ? `; touch_interval_days none → ${days} (the interval becomes the cadence when there isn't one)`
        : before.touch_interval_days
          ? `; cadence left at every ${before.touch_interval_days} days`
          : ""
    }`,
    before.full_name,
    `contact-${id}`
  );
  return c.redirect(`/contacts/${id}?flash=${adoptCadence ? "snoozedcadence" : "snoozed"}`);
});

// ---------------------------------------------------------------- full history page (REL-003)

app.get("/contacts/:id/history", async (c) => {
  const id = Number(c.req.param("id"));
  const contact = await c.env.DB.prepare("SELECT full_name FROM contact WHERE id = ?")
    .bind(id)
    .first<{ full_name: string }>();
  if (!contact) return c.notFound();
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM interaction WHERE contact_id = ? ORDER BY date DESC, id DESC"
  )
    .bind(id)
    .all<Interaction>();

  return c.html(
    layout({
      title: `History · ${contact.full_name}`,
      body: `<main>
  <h1>Interaction History</h1>
  <p class="sub"><a href="/contacts/${id}">${esc(contact.full_name)}</a> · ${results.length} interaction${results.length === 1 ? "" : "s"}</p>
  ${results.length ? `<div class="hist">${results.map(historyEntry).join("")}</div>` : '<div class="card empty">No interactions recorded yet.</div>'}
  <p class="meta" style="margin-top:14px"><a href="/contacts/${id}">← Back to ${esc(contact.full_name)}</a></p>
</main>`,
    })
  );
});

// ---------------------------------------------------------------- contact record (REL-003)

/**
 * Interaction entry form. Prefilled when resolving a scheduled meeting — including the stage the
 * resolution should move the contact to, so "Leave Unchanged" can no longer strand a held meeting in
 * Meeting Scheduled with no meeting date (#30).
 */
function interactionForm(opts: {
  contactId: number;
  prefill?: {
    date?: string | null;
    type?: string;
    outcome?: string;
    subject?: string;
    nextFollowUp?: string;
    stage?: string;
    format?: string | null;
  };
  resolveMeeting?: string;
  /**
   * The meeting currently on this contact's calendar, when there is one and we are not already
   * resolving it. Drives the inline resolution offer below (added 2026-08-11).
   */
  bookedMeeting?: { date: string; time: string | null };
  /** The contact's cadence today, shown so the field can say what it would be changing. */
  currentInterval?: number | null;
}): string {
  const p = opts.prefill ?? {};
  const resolving = Boolean(opts.resolveMeeting);
  return `<form method="post" action="/contacts/${opts.contactId}/interactions">
      ${opts.resolveMeeting ? `<input type="hidden" name="resolve_meeting" value="${esc(opts.resolveMeeting)}">` : ""}
      <div class="row">
        <div><label>Date</label><input type="date" name="date" value="${esc(p.date ?? today())}" max="${today()}" required></div>
        <div><label>Type</label>${select("type", INTERACTION_TYPES, p.type ?? "meeting")}</div>
        <div><label>Direction</label>${select("direction", DIRECTIONS, "two_way", { blank: "—" })}</div>
      </div>
      ${/*
        Format (REL-026, #92). ALWAYS SHOWN rather than revealed when Type is Meeting or Call, which is what
        the issue asked for. Doing that properly needs JavaScript to watch the type select, and this app has
        exactly two scripts, both for things with no server-side alternative. The cost of always showing it
        is a field that is meaningless on an email; the cost of the JavaScript is a third script and a form
        that behaves differently with scripting off. The label says who it is for, and it is never required.
      */ ""}
      <div class="row">
        <div><label>Format <span class="hint">for meetings and calls — meal, coffee, Teams…</span></label>${select(
          "format",
          MEETING_FORMATS,
          p.format ?? null,
          { blank: "—" }
        )}</div>
      </div>
      <label>Subject</label>
      <input type="text" name="subject" value="${esc(p.subject)}" placeholder="e.g. Intro call">
      <label>Summary</label>
      <textarea name="summary" placeholder="What was discussed, what was committed…"></textarea>
      <div class="row">
        <div><label>OneNote Link <span class="hint">paste “Copy Link to Page”</span></label><input type="url" name="notes_link"></div>
        ${/*
          The `required` attribute that used to sit on this field when resolving a meeting is GONE
          (2026-08-11) — a stage of Complete needs to be saveable without a follow-up date.
          It was a browser-side rule that could not see which stage had been chosen, so resolving a
          meeting to Complete was refused before the request was ever sent — while the SERVER, which
          has always exempted the terminal stages a few lines into the POST handler, would have saved
          it correctly. Verified by submitting stage=complete with an empty date past the browser: it
          saved clean, no date, meeting cleared.

          Nothing is lost by removing it. A live stage with no date typed still gets the fallback date
          filled in server-side; a terminal stage correctly gets none. The server was already the
          authority here — this stops the form disagreeing with it.
        */ ""}
        <div><label>Set Next Follow-Up${resolving ? ' <span class="hint">leave blank if the stage you pick is finished with — otherwise a date is set for you</span>' : ""}</label><input type="date" name="next_follow_up" value="${esc(p.nextFollowUp)}"></div>
      </div>
      <div class="row">
        <div><label>Move Stage To${resolving ? ' <span class="hint">required — the meeting is clearing</span>' : ""}</label>${select(
          "stage",
          STAGES,
          p.stage ?? null,
          resolving ? {} : { blank: "Leave Unchanged" }
        )}</div>
        <div><label>Outcome</label><input type="text" name="outcome" value="${esc(p.outcome)}" placeholder="optional"></div>
      </div>
      ${/*
        TOUCH EVERY, ON THIS FORM (REL-034, 2026-08-25).
        The reported gap: changing the status to Stay Connected on an interaction meant a second trip to
        the person's record just to set the touch-every-day amount, with no way to do both at once.

        The gap was real and narrow: Move Stage To could park someone in Stay Connected right here, but
        the rhythm that makes that stage mean anything lived on another screen. So the one decision
        arrived in two visits, and the second visit is the one you forget — which is how 19 contacts ended
        up in Stay Connected with no cadence in the first place (REL-028).

        DELIBERATELY NOT PREFILLED, and this is the part worth arguing about. Prefilling the current
        interval would make the field look like the whole truth and make an empty box mean "clear it",
        which is the exact ambiguity that cost those 19 contacts their follow-up dates. Left blank it can
        only ever ADD or CHANGE a cadence, never remove one, and the label says so. Clearing a cadence
        stays on the contact form, where it is a deliberate act rather than a side effect of logging a
        call.

        Shown for every stage rather than only the three that use a cadence. The stage is chosen in this
        same form, so the server cannot know at render time which one you will pick, and conditioning it
        client-side would mean a fourth inline script to watch a select. The hint carries the caveat
        instead.
      */ ""}
      <div class="row">
        <div><label>Touch Every <span class="hint">days — ${
          opts.currentInterval
            ? `now every ${opts.currentInterval}; blank keeps it`
            : "blank means no cadence, as now"
        }. Used by Reach Out Later, Stay Connected and Pray</span></label>
          <input type="number" name="touch_interval_days" min="1" max="${MAX_TOUCH_INTERVAL_DAYS}" list="intervals" placeholder="e.g. 90">
          <datalist id="intervals">${TOUCH_INTERVALS.map((d) => `<option value="${d}"></option>`).join("")}</datalist></div>
      </div>
      ${
        /*
         * RESOLVE THE BOOKED MEETING WITHOUT LEAVING THIS FORM (2026-08-11) — the two-screen path below
         * needed streamlining.
         *
         * The friction being removed, reproduced end to end on 2026-08-11: setting Move Stage To on this
         * form while a meeting was still on the calendar recorded the interaction and SILENTLY DROPPED
         * the stage move (see stageWouldOrphanMeeting in the POST handler), leaving a flash that told
         * you to go and resolve the meeting instead. Opening the saved entry to fix it then showed a
         * second, different message — "tick the box below to move the contact" — whose box sits 2,596
         * characters further down that page, which on a phone is well below the fold. Two messages, two
         * screens, and a stage change that has to be typed twice.
         *
         * This asks the question on the form where the problem arises. It does NOT clear the meeting
         * silently: an outcome is required, because the settled rule is that a meeting only ever leaves
         * the calendar by someone recording what happened to it, and "cleared" is not an outcome.
         *
         * Checked by default, deliberately. If you are logging an interaction on a contact with a
         * meeting booked, the overwhelmingly likely case is that this IS that meeting — and the cost of
         * the wrong default is asymmetric: unticking is one click, whereas leaving it unticked is how
         * the stage move gets dropped and you end up on the two-screen path again.
         *
         * Known and accepted: the action-item rows only render on the dedicated resolution form, so a
         * meeting resolved from here does not capture commitments inline. The Action Items section is on
         * this same page, immediately above, and the flash says so when nothing was named.
         */
        !resolving && opts.bookedMeeting
          ? // The label text is wrapped in a single <span> on purpose. label.check is display:flex, so
            // every top-level node inside it becomes a flex ITEM — the <b> around the date turned the
            // sentence into three side-by-side columns on a 390px screen (seen in the screenshot, not
            // reasoned about). One span means the flex container has two children and the text inside it
            // wraps as prose. align-items:flex-start because the sentence runs to three lines on a phone
            // and a vertically centred checkbox beside three lines of text points at nothing.
            `<div class="quickset" style="display:block">
        <label class="check" style="margin-top:0;align-items:flex-start"><input type="checkbox" name="clear_meeting" value="1" checked style="margin-top:4px">
          <span>This is the meeting booked for <b>${esc(opts.bookedMeeting.date)}</b>${
            opts.bookedMeeting.time ? ` at ${esc(formatTime(opts.bookedMeeting.time))}` : ""
          } — clear it from the calendar</span></label>
        <div style="max-width:260px;margin-top:8px"><label>What happened</label>${select(
          "clear_meeting_outcome",
          MEETING_OUTCOMES,
          "held"
        )}</div>
        <p class="meta" style="margin-top:8px">Ticked, this records the outcome and clears the meeting date in the same save, so the stage you chose above actually applies. Unticked, the meeting stays booked — and a stage change will be kept back, because a booked meeting on a stage that says no meeting is booked is the contradiction this refuses to create.</p>
      </div>`
          : ""
      }
      ${resolving ? actionItemFields() : ""}
      <div class="actions"><button type="submit">${resolving ? "Resolve Meeting" : "Record Interaction"}</button></div>
    </form>`;
}

/**
 * Action item capture on the resolution form (REL-025). This is the moment the commitment is made, so
 * it is the moment to record it — typing it into the summary as prose and re-entering it at /actions
 * afterwards is how it gets lost. Each item created here is linked to the interaction being recorded,
 * which is the first time interaction_id is populated anywhere in the app: the column, its index, and
 * the "from the 30 July Intro call" provenance line have existed since migration 0006 and no form had
 * ever posted one.
 */
function actionItemFields(): string {
  const rows = Array.from(
    { length: RESOLUTION_ACTION_ROWS },
    (_, i) => `<div class="row" style="margin-top:8px">
        <div style="flex:1 1 260px"><input type="text" name="action_description_${i}" placeholder="${
          i === 0 ? "e.g. Send the 10-day agent deployment overview" : "another commitment (optional)"
        }"></div>
        <div style="flex:0 1 170px"><input type="date" name="action_due_${i}"></div>
      </div>`
  ).join("");
  return `<div style="margin-top:18px;padding-top:14px;border-top:1px dashed var(--line)">
      <label>What did you commit to? <span class="hint">one per line, with a due date if you have one — blank rows are ignored</span></label>
      ${rows}
      <p class="meta" style="margin-top:10px">These become action items linked to this meeting, so the item carries its own provenance and shows up on this record, on the dashboard, and at <a href="/actions">Action Items</a>. A commitment with no due date is not hidden — it sorts to the top, because it is the one nothing else will raise.</p>
    </div>`;
}

/**
 * Reads the action item rows off a resolution submission. A row with a due date but no description is
 * an error rather than an empty row — a date on its own means something was meant to be typed and
 * wasn't, and silently discarding it would lose the commitment while looking like success.
 */
function parseActionItems(
  f: Record<string, unknown>
): { items: { description: string; dueDate: string | null }[] } | { error: string } {
  const items: { description: string; dueDate: string | null }[] = [];
  for (let i = 0; i < RESOLUTION_ACTION_ROWS; i++) {
    const description = str(f[`action_description_${i}`]);
    const dueDate = str(f[`action_due_${i}`]);
    if (!description) {
      if (dueDate) return { error: "actionnodesc" };
      continue;
    }
    items.push({ description, dueDate });
  }
  return { items };
}

app.get("/contacts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const contact = await c.env.DB.prepare(
    "SELECT c.*, o.name AS organization_name FROM contact c LEFT JOIN organization o ON o.id = c.organization_id WHERE c.id = ?"
  )
    .bind(id)
    .first<Contact>();
  if (!contact) return c.notFound();

  // Only the most recent few are fetched for this page; the header count is the true total, so
  // "History (100)" stays honest no matter how many are displayed.
  const { results: recent } = await c.env.DB.prepare(
    "SELECT * FROM interaction WHERE contact_id = ? ORDER BY date DESC, id DESC LIMIT ?"
  )
    .bind(id, RECENT_HISTORY)
    .all<Interaction>();
  const totalRow = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM interaction WHERE contact_id = ?")
    .bind(id)
    .first<{ n: number }>();
  const totalInteractions = totalRow?.n ?? recent.length;

  // Open loops, fetched in full: a contact with more commitments than fits on a screen is a signal in
  // itself, and truncating the one list that says what you owe would defeat the point.
  const actionItems = await contactActions(c.env.DB, id);
  const openActions = actionItems.filter((a) => !a.done).length;

  /** The work this person is named on (PURS-001) — see the note beside the section that renders it. */
  const pursuits = await pursuitsForContact(c.env.DB, id);

  /*
   * Referrals, both directions (REL-005, #16). Two facts that read very differently:
   *   - who introduced you to this person, which is a single field and belongs in the attribute list;
   *   - whom this person has introduced you to, which is the thing that makes someone visibly a
   *     referral source and belongs in a section of its own.
   * Inactive referrals are included in the outbound list. A contact you have since inactivated was
   * still introduced by this person, and quietly dropping them would understate what the relationship
   * has been worth.
   */
  const referredBy = await c.env.DB.prepare(
    "SELECT id, full_name FROM contact WHERE id = ?"
  )
    .bind(contact.referral_source_contact_id)
    .first<{ id: number; full_name: string }>();
  const { results: referred } = await c.env.DB.prepare(
    `SELECT c.id, c.full_name, c.stage, c.status, o.name AS organization_name
       FROM contact c LEFT JOIN organization o ON o.id = c.organization_id
      WHERE c.referral_source_contact_id = ? ORDER BY c.full_name`
  )
    .bind(id)
    .all<{ id: number; full_name: string; stage: string; status: string; organization_name: string | null }>();

  const flash = c.req.query("flash");
  const flashMap: Record<string, string> = {
    created: "Contact created.",
    saved: "Changes saved.",
    nochange: "Nothing changed, so nothing was saved.",
    logged: "Interaction recorded.",
    loggedstagekept:
      "Interaction recorded, but the stage was left as it is — a meeting is still on the calendar for this contact, and moving the stage would leave that meeting booked on a stage that says no meeting is booked. Resolve it as Held, No-Show or Cancelled and the stage moves with it.",
    resolved: "Meeting resolved and recorded in history.",
    edited: "Interaction updated.",
    deleted: "Interaction deleted.",
    snoozed: "Moved to Reach Out Later with a follow-up date set. The cadence already set for this contact was left alone.",
    snoozedcadence:
      "Moved to Reach Out Later, and that interval is now the keep-in-touch cadence too — so this contact will keep coming back round on the same rhythm instead of going overdue once. Change or clear it under Touch Every on the edit form.",
    meetingfirst:
      "This contact has a meeting scheduled. Resolve the meeting first — Held, No-Show, or Cancelled — then set a reach-out-later date.",
    badinterval: "That reach-out-later interval was not valid, so nothing changed.",
    badcadence: `“Touch Every” must be a whole number of days between 1 and ${MAX_TOUCH_INTERVAL_DAYS}, or blank to leave the cadence as it is. Nothing was saved — the interaction was not recorded either, so re-enter it.`,
    actionadded: "Action item added.",
    actiondone: "Marked done.",
    actionreopened: "Reopened.",
    actiondeleted: "Action item deleted.",
    actionnoname: "An action item needs a description, so nothing was saved.",
    actionnodesc:
      "One of the action item rows had a due date but no description, so the meeting was recorded and no action items were created. A date on its own means something was meant to be typed — add the commitments below.",
    resolvednoitems:
      "Meeting resolved and recorded in history. The stage now says the next move is yours, but nothing was named — if you committed to something, add it below so it is not carried in memory alone.",
  };
  const flashWarn = new Set([
    "nochange",
    "meetingfirst",
    "badinterval",
    "actionnoname",
    "actionnodesc",
    "resolvednoitems",
  ]);
  const flashHtml =
    flash && flashMap[flash]
      ? `<div class="flash ${flashWarn.has(flash) ? "warn" : "ok"}">${esc(flashMap[flash])}</div>`
      : "";

  // Resolving a meeting prefills the interaction form — the ONLY way to clear a meeting is to record
  // what happened, so nothing leaves the dashboard without leaving a trace.
  const logMeeting = c.req.query("log_meeting");
  const outcomeLabel = labelFor(MEETING_OUTCOMES, logMeeting ?? null);
  const resolving = Boolean(logMeeting && MEETING_OUTCOMES.some(([v]) => v === logMeeting));
  const meetingIsFuture = Boolean(contact.meeting_date && contact.meeting_date > today());
  const prefill = resolving
    ? {
        // A meeting cannot have been held on a date that has not arrived yet, so an early resolution
        // dates the interaction today rather than inheriting the future meeting date (#30).
        date: contact.meeting_date && contact.meeting_date <= today() ? contact.meeting_date : today(),
        type: "meeting",
        outcome: outcomeLabel,
        subject: logMeeting === "held" ? "Meeting" : `Meeting ${outcomeLabel}`,
        nextFollowUp: logMeeting === "held" ? plusDays(FALLBACK_FOLLOW_UP_DAYS) : today(),
        stage: RESOLUTION_STAGE[logMeeting!] ?? "in_conversation",
      }
    : undefined;

  const meetingPanel = contact.meeting_date
    ? `<section>
    <h2>Scheduled Meeting</h2>
    <p><b>${esc(contact.meeting_date)}</b>${contact.meeting_time ? ` at ${esc(contact.meeting_time)}` : ""}${
        contact.meeting_date < today() ? ' <span class="pill red">date has passed</span>' : ""
      }</p>
    <p class="meta">Resolving a meeting always records an interaction — that is how it leaves the dashboard.</p>
    <div class="actions">
      ${MEETING_OUTCOMES.map(
        ([v, label]) =>
          `<a class="btn${v === "held" ? "" : " secondary"}" href="/contacts/${contact.id}?log_meeting=${v}#record">${esc(label)}</a>`
      ).join("")}
      <a class="btn secondary" href="/contacts/${contact.id}/edit">Reschedule</a>
    </div>
  </section>`
    : "";

  // Quick-set intervals are hidden while a meeting is scheduled — resolving it is the next step, and
  // offering a snooze there would invite exactly the silent drop this app exists to prevent.
  const reachOutLater = contact.meeting_date
    ? ""
    : `<div class="quickset">
      <span class="meta">Reach out later:</span>
      ${REACH_OUT_INTERVALS.map(
        ([label, days]) =>
          `<form method="post" action="/contacts/${contact.id}/reach-out-later"><input type="hidden" name="days" value="${days}"><button class="secondary" type="submit">${esc(label)}</button></form>`
      ).join("")}
      <span class="meta">${
        contact.touch_interval_days
          ? `sets Reach Out Later and a follow-up date · cadence stays every ${esc(contact.touch_interval_days)} days`
          : "sets Reach Out Later, a follow-up date, and the same interval as the cadence"
      }</span>
    </div>`;

  return c.html(
    layout({
      title: contact.full_name,
      body: `<main>
  ${flashHtml}
  ${
    resolving
      ? `<div class="flash warn">Recording this meeting as <b>${esc(outcomeLabel)}</b>. Fill in what happened and submit — the meeting clears from the dashboard once the interaction is saved.${
          meetingIsFuture
            ? ` <b>Note:</b> this meeting is scheduled for ${esc(contact.meeting_date)}, which has not arrived yet. The interaction is dated today instead. If you meant to move the meeting, use <a href="/contacts/${contact.id}/edit">Reschedule</a>.`
            : ""
        }</div>`
      : ""
  }
  <h1>${esc(contact.full_name)}</h1>
  ${/* The company name is now a link (ORG-001) — the address, industry and notes live there, and until
       today there was nowhere to click through to. */ ""}
  <p class="sub">${esc(contact.title ?? "")}${contact.title && contact.organization_name ? " · " : ""}${
    contact.organization_id && contact.organization_name
      ? `<a href="/organizations/${contact.organization_id}/edit">${esc(contact.organization_name)}</a>`
      : esc(contact.organization_name ?? "")
  }</p>

  <!--
    Phone only (UX-001, #56). Logging a note in the car straight after a meeting is the highest-value
    mobile flow in the app — capture at the moment of memory rather than hours later, which is the
    failure this platform exists to prevent. On a phone the form sits at the very bottom, below the
    relationship fields, the action items and the history, so reaching it means a long scroll one-handed.
    This is an anchor to the form that is already there rather than a second form: one link, no new write
    path, nothing to keep in sync. Hidden on desktop, where the form is a short scroll away and the extra
    button would be clutter.
  -->
  <p class="phone-only"><a class="btn" href="#record">Record an interaction ↓</a></p>

  ${meetingPanel}

  <section>
    <h2>Relationship</h2>
    <dl class="grid2">
      <dt>Stage</dt><dd>${esc(stageLabel(contact.stage))}${
        contact.stage === "meeting_scheduled" && !contact.meeting_date
          ? ' <span class="pill red">no meeting date — set one or change the stage</span>'
          : ""
      }</dd>
      <dt>Strength</dt><dd>${esc(labelFor(STRENGTHS, contact.strength))}</dd>
      <dt>Meeting</dt><dd>${contact.meeting_date ? `${esc(contact.meeting_date)}${contact.meeting_time ? ` at ${esc(contact.meeting_time)}` : ""}` : "—"}</dd>
      <dt>Next Follow-Up</dt><dd>${followUpPill(contact.next_follow_up, contact.stage)}${
        contact.touch_interval_days
          ? ` <span class="meta">then every ${esc(contact.touch_interval_days)} days</span>`
          : ""
      }</dd>
      ${/* Stated on the record because it explains a date that will appear to move on its own (REL-027). */ ""}
      <dt>Keep In Touch</dt><dd>${
        contact.touch_interval_days
          ? `every ${esc(contact.touch_interval_days)} days <span class="meta">— set when you record an interaction</span>`
          : '— <span class="meta">no cadence</span>'
      }</dd>
      <dt>Last Touch</dt><dd>${esc(contact.last_touch ?? "—")}</dd>
      <dt>Work Email</dt><dd>${contact.email_work ? `<a href="mailto:${esc(contact.email_work)}">${esc(contact.email_work)}</a>` : "—"}</dd>
      <dt>Personal Email</dt><dd>${contact.email_personal ? `<a href="mailto:${esc(contact.email_personal)}">${esc(contact.email_personal)}</a>` : "—"}</dd>
      <dt>Phone</dt><dd>${esc(contact.phone ?? "—")}</dd>
      <dt>LinkedIn</dt><dd>${
        contact.linkedin_url
          ? `<a href="${esc(contact.linkedin_url)}" target="_blank" rel="noopener">Profile ↗</a>`
          : contact.no_linkedin
            ? // Said on the record, not left as a bare dash: the mark changes what the chase list will
              // suggest for this contact, so a reader deserves to know it is set and that it was a choice.
              '<span class="pill grey">no profile</span> <span class="meta">marked as not on LinkedIn</span>'
            : `— <span class="meta"><a href="/linkedin">find it</a></span>`
      }</dd>
      <dt>Birthday</dt><dd>${esc(contact.birthday ?? "—")}</dd>
      <dt>Department</dt><dd>${esc(contact.department ?? "—")}</dd>
      <dt>Priority Tier</dt><dd>${esc(contact.priority_tier ?? "—")}</dd>
      <dt>Referred By</dt><dd>${
        referredBy ? `<a href="/contacts/${referredBy.id}">${esc(referredBy.full_name)}</a>` : "—"
      }</dd>
      <dt>Source</dt><dd>${esc(labelFor(SOURCES, contact.source))}</dd>
      <dt>Status</dt><dd>${esc(labelFor(STATUSES, contact.status))}</dd>
    </dl>
    ${contact.notes ? `<div style="margin-top:12px"><b style="font-size:13px;color:var(--muted)">NOTES</b><div style="white-space:pre-wrap">${esc(contact.notes)}</div></div>` : ""}
    ${/*
      The two links deferred out of REL-008 Part A and AUD-002. Both destinations already take the
      contact as a query parameter, so this is a link rather than a new route.

      Both are keyed by id. Not because names collide today — production was checked and every contact
      has a distinct name — but because full_name has no unique constraint and is
      editable from the Edit Contact form beside these links. A name-keyed link would break silently
      the first time a name is corrected. An id cannot go stale that way.

      (An earlier version of this comment justified the choice by claiming the database has two contacts
      with the same name. It does not, and never did; the claim was inherited from templates.ts and
      repeated without checking. Corrected in the same breath as fixing it there.)
    */ ""}
    <div class="actions">
      <a class="btn secondary" href="/contacts/${contact.id}/edit">Edit Contact</a>
      <a class="btn secondary" href="/templates?contact=${contact.id}">Message Templates</a>
      <a class="btn secondary" href="/audit?contact=${contact.id}">Audit Trail</a>
    </div>
    ${reachOutLater}
  </section>

  ${
    referred.length
      ? `<section>
    <h2>Referrals Made (${referred.length})</h2>
    <table><tbody>${referred
      .map(
        (k) => `<tr>
        <td><a href="/contacts/${k.id}"><b>${esc(k.full_name)}</b></a>${
          k.organization_name ? `<div class="meta">${esc(k.organization_name)}</div>` : ""
        }</td>
        <td><span class="pill grey">${esc(stageLabel(k.stage))}</span>${
          k.status === "inactive" ? ' <span class="pill">inactive</span>' : ""
        }</td>
      </tr>`
      )
      .join("")}</tbody></table>
    <p class="meta" style="margin-top:8px">People ${esc(contact.full_name)} introduced you to. <a href="/referrals">All referral sources</a>.</p>
  </section>`
      : ""
  }

  ${/*
    PURSUITS THIS PERSON IS NAMED ON (PURS-001). The motivating question was whether there were others
    being missed, buried in a person's record — the answer once before was action items, and the same
    failure was about to be built again: a role on a pursuit would have been visible only from the
    pursuit. Being named as a decision maker is a fact about the relationship, so it belongs on the
    relationship.
  */ ""}
  ${
    pursuits.length
      ? `<section>
    <h2>Pursuits (${pursuits.length})</h2>
    <table><thead><tr><th>Pursuit</th><th>Their role</th><th>Status</th></tr></thead><tbody>${pursuits
      .map(
        (p) => `<tr>
        <td><a href="/engagements/${p.id}/edit"><b>${esc(p.name)}</b></a>${
          p.organization_name ? `<div class="meta">${esc(p.organization_name)}</div>` : ""
        }</td>
        <td data-label="Their role">${esc(labelFor(PURSUIT_ROLES, p.role))}</td>
        <td data-label="Status"><span class="pill grey">${esc(labelFor(ENGAGEMENT_STATUSES, p.status))}</span></td>
      </tr>`
      )
      .join("")}</tbody></table>
    <p class="meta" style="margin-top:8px">Work ${esc(contact.full_name)} is named on. <a href="/pursuits">The whole pipeline</a>.</p>
  </section>`
      : ""
  }

  <section id="actions">
    <h2>Action Items${openActions ? ` (${openActions} open)` : ""}</h2>
    ${contactActionBlock(contact.id, actionItems)}
  </section>

  <section>
    <h2>History (${totalInteractions})</h2>
    ${historyBlock(contact.id, recent, totalInteractions)}
  </section>

  <section id="record">
    <h2>${resolving ? `Resolve Meeting — ${esc(outcomeLabel)}` : "Record an Interaction"}</h2>
    ${interactionForm({
      contactId: contact.id,
      prefill,
      resolveMeeting: resolving ? logMeeting! : undefined,
      bookedMeeting: contact.meeting_date ? { date: contact.meeting_date, time: contact.meeting_time } : undefined,
      currentInterval: contact.touch_interval_days ?? null,
    })}
  </section>
</main>`,
    })
  );
});

app.post("/contacts/:id/interactions", async (c) => {
  const id = Number(c.req.param("id"));
  const contact = await c.env.DB.prepare("SELECT * FROM contact WHERE id = ?").bind(id).first<Contact>();
  if (!contact) return c.notFound();
  const f = await c.req.parseBody();
  const date = notFuture(str(f.date) ?? today());
  const type = str(f.type) ?? "note";
  // Read once and reused below: the insert stores it, and whether this interaction is an outreach
  // attempt (#82) depends on it.
  const direction = str(f.direction);
  /*
   * Two ways in, one code path (2026-08-11).
   *
   * `resolve_meeting` is the dedicated resolution form, reached from the dashboard meeting rows.
   * `clear_meeting` is the checkbox now offered on the ordinary record-page form when a meeting is
   * booked, and it carries its own outcome select. Both collapse to the same local variable here, so
   * everything downstream — the stage default, clearing the date and time, the audit line, the flash —
   * is the code that has been in production since #30 rather than a second implementation of it.
   *
   * The outcome is validated against MEETING_OUTCOMES rather than trusted. An unrecognized value would
   * otherwise fall through RESOLUTION_STAGE's lookup to in_conversation and clear a real meeting off the
   * calendar with no honest record of what happened to it.
   */
  const clearOutcome = str(f.clear_meeting_outcome);
  /*
   * `contact.meeting_date` is part of the test, not just of the redirect. An earlier version validated
   * the outcome and left the "is there actually a meeting" check to the line below — which meant a
   * clear_meeting posted against a contact with no booked meeting cleared nothing (correct) but still
   * stamped "Held" onto the interaction's outcome (wrong: a meeting that was never on the calendar did
   * not happen). Found by a test run that reused a contact whose meeting a previous run had already
   * cleared, which is the kind of state a real week produces too — two tabs open, submit the older one.
   */
  const inlineOutcome =
    f.clear_meeting === "1" &&
    contact.meeting_date &&
    clearOutcome &&
    MEETING_OUTCOMES.some(([v]) => v === clearOutcome)
      ? clearOutcome
      : null;
  const resolveMeeting = str(f.resolve_meeting) ?? inlineOutcome;

  /*
   * Resolution integrity (#30). The browser enforces both of these on the form, but the server
   * enforces them too — a resolved meeting must never leave the contact in an unreachable state:
   *   1. the stage moves off meeting_scheduled, because meeting_date is about to be cleared, and
   *   2. a non-terminal stage gets a follow-up date, so the relationship has a next step.
   */
  let newStage = str(f.stage);
  if (resolveMeeting && (!newStage || newStage === "meeting_scheduled")) {
    newStage = RESOLUTION_STAGE[resolveMeeting] ?? "in_conversation";
  }
  /*
   * The other way a contact ends up holding two contradictory facts (found 2026-08-03 alongside the
   * meeting/stage report above). "Stage This Moved To" will happily move a contact off meeting_scheduled
   * while a meeting_date is still set, because meeting_date is only cleared when resolve_meeting is
   * present. The result is a booked meeting on a stage that says no meeting is booked — which is the
   * state a couple of real contacts were found to be in, and this is almost certainly how they got
   * there. The form-level rule in validate() cannot see this path; it has to be caught here.
   *
   * The interaction is still recorded — refusing the whole save would throw away what the user typed,
   * and #37's lesson is that validation which gets in the way gets worked around. Only the stage move
   * is dropped, and the flash says so. Resolving the meeting is the move that legitimately changes the
   * stage here, and it is one click away on the record.
   */
  const stageWouldOrphanMeeting = Boolean(
    !resolveMeeting && contact.meeting_date && newStage && newStage !== "meeting_scheduled"
  );
  if (stageWouldOrphanMeeting) newStage = null;

  let nextFollowUp = str(f.next_follow_up);
  const landingStage = newStage ?? contact.stage;
  // The shared TERMINAL_STAGES is `as const`, so its element type is the four literals rather than
  // string, and landingStage is a free-form form value. Widening at the use site rather than
  // loosening the export keeps the literal union available to callers that want it.
  const landingTerminal = (TERMINAL_STAGES as readonly string[]).includes(landingStage);
  /*
   * FOLLOW-UP DATE PRECEDENCE (REL-027, #93). Three sources, in this order:
   *
   *   1. A date typed on the form. Always wins — the field is the decision, and overwriting it would make
   *      the form lie about what it saved.
   *   2. The contact's keep-in-touch cadence, counted from THIS INTERACTION'S date rather than from today,
   *      so a back-dated touch produces the date it would have produced at the time.
   *   3. Only when resolving a meeting, the generic fallback that has always been here.
   *
   * The cadence beats the generic fallback deliberately: after a catch-up with a Stay Connected contact on
   * a 90-day rhythm, the right next date is 90 days out, not the short guess that suits chasing someone who
   * has gone quiet. Terminal stages get nothing either way — finished is finished, and #14 is the record of
   * what happens when finished contacts carry dates.
   */
  /*
   * A cadence typed on THIS form takes precedence over the stored one when computing the date below
   * (REL-034). Setting Stay Connected and "every 90 days" in one submit has to produce a date 90 days
   * out, not one computed from whatever rhythm the contact used to have — otherwise the form would
   * save the new cadence and schedule by the old one, which is the sort of quiet disagreement between
   * two fields that takes an afternoon to find.
   *
   * Blank means leave the stored cadence alone; it can never clear one. See the form comment.
   */
  const submittedInterval = str(f.touch_interval_days);
  let newInterval: number | null = null;
  if (submittedInterval !== null) {
    const n = Number(submittedInterval);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TOUCH_INTERVAL_DAYS)
      return c.redirect(`/contacts/${id}?flash=badcadence`);
    if (n !== (contact.touch_interval_days ?? null)) newInterval = n;
  }
  const effectiveInterval = newInterval ?? contact.touch_interval_days;

  if (!nextFollowUp && !landingTerminal && effectiveInterval) {
    nextFollowUp = plusDays(effectiveInterval, date);
  }
  if (resolveMeeting && !nextFollowUp && !landingTerminal) {
    nextFollowUp = plusDays(FALLBACK_FOLLOW_UP_DAYS);
  }

  // Read before the interaction is written so a bad row is reported without a half-done save: the
  // meeting still records, but the flash says why no action items were created.
  const parsedActions = parseActionItems(f);

  // next_follow_up_set / stage_moved_to are stored ON the interaction so the history reads as a
  // narrative: what happened, and what was decided next (migration 0003).
  const inserted = await c.env.DB.prepare(
    `INSERT INTO interaction (contact_id, date, type, direction, subject, summary, notes_link, outcome,
      next_follow_up_set, stage_moved_to, format) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      id,
      date,
      type,
      direction,
      str(f.subject),
      str(f.summary),
      str(f.notes_link),
      /*
       * The dedicated resolution form prefills the Outcome text box with "Held" / "No-Show" /
       * "Cancelled", so the history line says what happened to the meeting. The inline checkbox added
       * 2026-08-11 has an outcome select of its own and leaves that text box empty, so without this the
       * interaction would record the stage move and stay silent on the outcome — found by reading the
       * stored row back, not by looking at the screen. Anything typed by hand still wins.
       */
      str(f.outcome) ?? (inlineOutcome ? labelFor(MEETING_OUTCOMES, inlineOutcome) : null),
      nextFollowUp,
      newStage,
      // Validated against the list rather than trusted: an unrecognised value would be refused by the
      // CHECK constraint from 0014 as a 500, and a sentence is better than a stack trace.
      MEETING_FORMATS.some(([v]) => v === str(f.format)) ? str(f.format) : null
    )
    .run();

  // Stage and follow-up update only if supplied. When resolving a meeting, the date/time clear in the
  // same statement. last_touch is NOT set here — it is derived from the interactions, so it is
  // recomputed below and can neither run ahead of today nor regress when back-dating a touch.
  await c.env.DB
    .prepare(
      `UPDATE contact SET
         next_follow_up = COALESCE(?, next_follow_up),
         stage = COALESCE(?, stage),
         touch_interval_days = COALESCE(?, touch_interval_days),
         meeting_date = CASE WHEN ? IS NOT NULL THEN NULL ELSE meeting_date END,
         meeting_time = CASE WHEN ? IS NOT NULL THEN NULL ELSE meeting_time END,
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(nextFollowUp, newStage, newInterval, resolveMeeting, resolveMeeting, id)
    .run();

  /*
   * An outreach recorded here is an attempt, and the ladder has to know (#82).
   *
   * Before this, `last_attempt_at` and `escalation_rung` were maintained ONLY by the dashboard chase
   * buttons, so an email logged on this form was invisible to the chase list. An outbound email
   * recorded here, on 2026-08-04, produced a chase list that said "no attempt recorded" while the same
   * row said "1 attempt · tried email" — and sorted that contact above people never contacted at all.
   * Which form recorded the outreach is an implementation detail; whether the outreach happened is not.
   *
   * The definition lives in attempts.ts and is shared with the query that draws the count, so the two
   * cannot drift apart again by being written twice.
   *
   * THE DATE ONLY MOVES FORWARD. This form accepts a back-dated interaction, and last_attempt_at means
   * "when did I last reach out" — so recording a call you forgot from last week must not reset the
   * silence clock to last week when you emailed them yesterday. The rung still increments: the attempt
   * did happen, it is simply not the most recent one.
   *
   * NEXT_FOLLOW_UP IS DELIBERATELY NOT TOUCHED, which is the one place this differs from the chase
   * button. That button owns the whole decision, so it sets a date three business days out (2026-08-04).
   * This form has a "Set Next Follow-Up" field on screen, and overwriting what the operator
   * typed — or filling in a date they deliberately left empty — would make the form lie about what it
   * saved. The field is the decision here.
   */
  const attempt = isAttempt(type, direction);
  if (attempt) {
    await c.env.DB.prepare(
      `UPDATE contact SET
         escalation_rung = escalation_rung + 1,
         last_attempt_at = CASE WHEN last_attempt_at IS NULL OR last_attempt_at < ? THEN ? ELSE last_attempt_at END,
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(date, date, id)
      .run();
  }

  await recomputeLastTouch(c.env.DB, id);

  // The audit event identifies the interaction it created, not the contact it belongs to (AUD-003).
  // The id comes from last_row_id rather than "ORDER BY id DESC LIMIT 1" (#31) — the old query returns
  // the highest id at read time, which is this insert's row only if nothing wrote in between.
  const interactionId = inserted?.meta?.last_row_id ?? 0;
  await audit(
    c.env.DB,
    "interaction",
    interactionId,
    "create",
    `contact ${id} · ${type} on ${date}${resolveMeeting ? ` · meeting resolved (${resolveMeeting})` : ""}${
      newStage ? ` · stage ${contact.stage} → ${newStage}` : ""
    }${nextFollowUp ? ` · follow-up ${contact.next_follow_up ?? "none"} → ${nextFollowUp}` : ""}${
      newInterval ? ` · cadence ${contact.touch_interval_days ?? "none"} → every ${newInterval} days` : ""
    }`,
    undefined,
    `contact-${id}`
  );

  /*
   * The rung moved, so the trail says so — in the same words the chase button uses, because it is the
   * same fact however it was recorded. Without this, the only evidence for a changed ladder position
   * would be the interaction event above, which does not mention the ladder at all.
   */
  if (attempt) {
    const wasBackdated = Boolean(contact.last_attempt_at && contact.last_attempt_at >= date);
    const nowAttemptAt = wasBackdated ? contact.last_attempt_at : date;
    await audit(
      c.env.DB,
      "contact",
      id,
      "update",
      `attempt ${contact.escalation_rung} → ${contact.escalation_rung + 1} by ${type} on ${date}; last_attempt_at ${
        contact.last_attempt_at ?? "none"
      } → ${nowAttemptAt}${wasBackdated ? " (unchanged — this attempt predates the last one recorded)" : ""}`,
      undefined,
      `contact-${id}`
    );
  }

  /*
   * Action items from the meeting (REL-025). Each is linked to the interaction just recorded, so the
   * item states where it came from and the history reads as a narrative: met, discussed, promised these
   * two things. Every item writes its own audit event, the same as one added from /actions — a
   * commitment created in bulk is not a lesser fact.
   *
   * Interaction id 0 would mean last_row_id came back empty. Link nothing rather than link to a row
   * that does not exist: interaction_id is nullable by design (migration 0006), and an item with no
   * provenance is recoverable where an item pointing at the wrong interaction is not.
   */
  if ("error" in parsedActions) return c.redirect(`/contacts/${id}?flash=${parsedActions.error}#actions`);

  let createdActions = 0;
  for (const item of parsedActions.items) {
    await insertActionItem(c.env.DB, {
      contactId: id,
      interactionId: interactionId || null,
      description: item.description,
      dueDate: item.dueDate,
      contactName: contact.full_name,
    });
    createdActions++;
  }

  if (!resolveMeeting)
    return c.redirect(`/contacts/${id}?flash=${stageWouldOrphanMeeting ? "loggedstagekept" : "logged"}`);

  /*
   * Resolved as Held with nothing named. Not blocked — #37's lesson was that validation which gets in
   * the way gets worked around, and there are real meetings where you leave owing nothing. But the
   * stage is now saying the next move is yours, so the mismatch is stated once rather than left for the
   * dashboard to hint at.
   */
  /*
   * …but only when the stage it landed on actually says the next move is yours (2026-08-11).
   *
   * This used to fire on any Held resolution, and its wording — "The stage now says the next move is
   * yours, but nothing was named" — is a sentence about follow_up_action specifically. Resolving to
   * Complete produced it while the operator was recording that there is no next move; resolving to In
   * Conversation produced it about a stage that makes no claim either way. Held only DEFAULTS to
   * follow_up_action (RESOLUTION_STAGE), and the operator is free to pick something else, so the test
   * has to be the stage that landed rather than the outcome that was chosen. Terminal stages fall out
   * of this for free, which is what was reported.
   */
  if (resolveMeeting === "held" && !createdActions && landingStage === "follow_up_action")
    return c.redirect(`/contacts/${id}?flash=resolvednoitems#actions`);
  return c.redirect(`/contacts/${id}?flash=resolved`);
});

// ---------------------------------------------------------------- edit / delete an interaction (REL-012)

app.get("/interactions/:id/edit", async (c) => {
  const iid = Number(c.req.param("id"));
  const i = await c.env.DB.prepare("SELECT * FROM interaction WHERE id = ?").bind(iid).first<Interaction>();
  if (!i) return c.notFound();
  const contact = await c.env.DB.prepare("SELECT id, full_name, stage FROM contact WHERE id = ?")
    .bind(i.contact_id)
    .first<{ id: number; full_name: string; stage: string }>();
  if (!contact) return c.notFound();

  // Editing history does not silently rewrite the contact's current state — but when the two disagree
  // it says so, and offers to reconcile in one click. Before #30 the divergence was invisible: an
  // interaction could claim it moved the contact to a stage the contact was never moved to.
  const stageDivergence =
    i.stage_moved_to && i.stage_moved_to !== contact.stage
      ? // "the box below" was well over a screen's worth of markup below this banner — eight fields, and
        // on a phone well past the fold, which is how it came to read as a box that does not exist
        // (2026-08-11). The box cannot move above the two fields it acts on, so the reference becomes a
        // link instead.
        `<div class="flash warn">This interaction records a move to <b>${esc(stageLabel(i.stage_moved_to))}</b>, but ${esc(contact.full_name)} is currently in <b>${esc(stageLabel(contact.stage))}</b>. <a href="#applybox">Tick the box near the bottom of this form</a> to move the contact, or leave it to keep the history as a historical note only.</div>`
      : "";

  return c.html(
    layout({
      title: "Edit Interaction",
      body: `<main>
  <h1>Edit Interaction</h1>
  <p class="sub"><a href="/contacts/${contact.id}">${esc(contact.full_name)}</a> · recorded ${esc(i.date)}</p>
  ${stageDivergence}
  <form method="post" action="/interactions/${i.id}/edit" class="card">
    <div class="row">
      <div><label>Date</label><input type="date" name="date" value="${esc(i.date)}" max="${today()}" required></div>
      <div><label>Type</label>${select("type", INTERACTION_TYPES, i.type)}</div>
      <div><label>Direction</label>${select("direction", DIRECTIONS, i.direction, { blank: "—" })}</div>
    </div>
    <label>Subject</label>
    <input type="text" name="subject" value="${esc(i.subject)}">
    <label>Summary</label>
    <textarea name="summary">${esc(i.summary)}</textarea>
    <div class="row">
      <div><label>OneNote Link</label><input type="url" name="notes_link" value="${esc(i.notes_link)}"></div>
      <div><label>Outcome</label><input type="text" name="outcome" value="${esc(i.outcome)}"></div>
    </div>
    <div class="row">
      <div><label>Format <span class="hint">for meetings and calls</span></label>${select(
        "format",
        MEETING_FORMATS,
        i.format,
        { blank: "—" }
      )}</div>
    </div>
    <div class="row">
      <div><label>Follow-Up This Set <span class="hint">shown on the history line</span></label><input type="date" name="next_follow_up_set" value="${esc(i.next_follow_up_set)}"></div>
      <div><label>Stage This Moved To</label>${select("stage_moved_to", STAGES, i.stage_moved_to, { blank: "—" })}</div>
    </div>
    <label class="check" id="applybox"><input type="checkbox" name="apply_to_contact" value="1"> Also apply this stage and follow-up date to ${esc(contact.full_name)} now</label>
    <p class="meta" style="margin-top:8px">Unticked, these two fields correct the history record only — the contact's current stage and follow-up date are unchanged. Ticked, the contact is updated to match and both changes are audited.</p>
    <div class="actions">
      <button type="submit">Save Changes</button>
      <a class="btn secondary" href="/contacts/${contact.id}">Cancel</a>
    </div>
  </form>
  <form method="post" action="/interactions/${i.id}/delete" class="card">
    <h2>Delete This Interaction</h2>
    <p class="meta">Removes the record permanently and recalculates the contact's last-touch date. The deletion itself is written to the audit trail.</p>
    <div class="actions"><button type="submit" class="danger">Delete Interaction</button></div>
  </form>
</main>`,
    })
  );
});

app.post("/interactions/:id/edit", async (c) => {
  const iid = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM interaction WHERE id = ?").bind(iid).first<Interaction>();
  if (!before) return c.notFound();
  const f = await c.req.parseBody();
  const after = {
    date: notFuture(str(f.date) ?? before.date),
    type: str(f.type) ?? before.type,
    direction: str(f.direction),
    subject: str(f.subject),
    summary: str(f.summary),
    notes_link: str(f.notes_link),
    outcome: str(f.outcome),
    next_follow_up_set: str(f.next_follow_up_set),
    stage_moved_to: str(f.stage_moved_to),
    format: MEETING_FORMATS.some(([v]) => v === str(f.format)) ? str(f.format) : null,
  };
  const applyToContact = f.apply_to_contact === "1";

  const diff = fieldDiff(
    {
      date: before.date,
      type: before.type,
      direction: before.direction,
      subject: before.subject,
      summary: before.summary,
      notes_link: before.notes_link,
      outcome: before.outcome,
      next_follow_up_set: before.next_follow_up_set,
      stage_moved_to: before.stage_moved_to,
      format: before.format,
    },
    after
  );

  // An edit that changes nothing writes nothing — no UPDATE, no audit event (AUD-003).
  if (!diff && !applyToContact) return c.redirect(`/contacts/${before.contact_id}?flash=nochange`);

  /*
   * ATTEMPT TRACKING IS RECONCILED HERE, FORWARD ONLY (REL-035, 2026-08-26). This reverses the previous
   * decision on this block, and the old text is kept below because its reasoning is still half right.
   *
   * WHAT IT USED TO SAY: "Attempt tracking is deliberately not recomputed here… Changing an
   * interaction's type, direction or date can change whether it was an attempt, and when. Following that
   * through to `escalation_rung` and `last_attempt_at` is exactly what #57 refused: these are stored
   * rather than derived so that correcting a typo on an old interaction cannot silently reorder Monday's
   * worklist… The cost is honest: fixing a mistyped date leaves the rung counting an attempt whose date
   * has moved… The health check in attempts.ts only flags the opposite direction — history ahead of the
   * ladder — for this reason: stored-ahead-of-derived is this decision working, not drift."
   *
   * WHY IT CHANGED. That last sentence was wrong, and production proved it. Moving an interaction's date
   * FORWARD puts history ahead of the ladder — the exact state the check calls drift — so the decision
   * was manufacturing the condition its own guard reports as a problem. On 2026-08-26 an interaction's
   * date was edited from 2026-08-11 to 2026-08-26; `last_attempt_at` stayed at 2026-08-11, and the chase
   * list was ready to call that contact fifteen days silent on the morning they were emailed.
   *
   * WHAT SURVIVES. The fear was real: a correction to old history must not reorder the worklist against
   * the contact. Forward-only reconciliation answers it — the date can only move later and the rung can only
   * rise, so an edit can never make someone look MORE neglected than they are, and can never delete
   * evidence of outreach. Backdating an interaction still leaves the ladder untouched, which is the case
   * #57 actually cared about. See reconcileAttemptLadder for the full argument.
   *
   * last_touch is recomputed rather than floored, because it has always been derived and says so.
   */

  if (diff) {
    await c.env.DB.prepare(
      `UPDATE interaction SET date=?, type=?, direction=?, subject=?, summary=?, notes_link=?, outcome=?,
        next_follow_up_set=?, stage_moved_to=?, format=? WHERE id=?`
    )
      .bind(
        after.date,
        after.type,
        after.direction,
        after.subject,
        after.summary,
        after.notes_link,
        after.outcome,
        after.next_follow_up_set,
        after.stage_moved_to,
        after.format,
        iid
      )
      .run();
    await recomputeLastTouch(c.env.DB, before.contact_id);

    /*
     * Read the ladder before and after so the audit trail names the change. Without this the only
     * evidence that an edit moved the ladder would be the field diff of the interaction, which does not
     * mention the ladder at all — the same gap #82 closed on the create path.
     */
    const ladderBefore = await c.env.DB.prepare(
      "SELECT escalation_rung, last_attempt_at FROM contact WHERE id = ?"
    )
      .bind(before.contact_id)
      .first<{ escalation_rung: number; last_attempt_at: string | null }>();
    await reconcileAttemptLadder(c.env.DB, before.contact_id);
    const ladderAfter = await c.env.DB.prepare(
      "SELECT escalation_rung, last_attempt_at FROM contact WHERE id = ?"
    )
      .bind(before.contact_id)
      .first<{ escalation_rung: number; last_attempt_at: string | null }>();

    await audit(
      c.env.DB,
      "interaction",
      iid,
      "update",
      diff.slice(0, 900),
      `contact ${before.contact_id}`,
      `contact-${before.contact_id}`
    );

    if (
      ladderBefore &&
      ladderAfter &&
      (ladderBefore.escalation_rung !== ladderAfter.escalation_rung ||
        (ladderBefore.last_attempt_at ?? null) !== (ladderAfter.last_attempt_at ?? null))
    ) {
      await audit(
        c.env.DB,
        "contact",
        before.contact_id,
        "update",
        `attempt ${ladderBefore.escalation_rung} → ${ladderAfter.escalation_rung}; last_attempt_at ${
          ladderBefore.last_attempt_at ?? "none"
        } → ${ladderAfter.last_attempt_at ?? "none"} (reconciled forward from edited interaction ${iid})`,
        undefined,
        `contact-${before.contact_id}`
      );
    }
  }

  if (applyToContact) {
    const contactBefore = await c.env.DB.prepare("SELECT stage, next_follow_up FROM contact WHERE id = ?")
      .bind(before.contact_id)
      .first<{ stage: string; next_follow_up: string | null }>();
    await c.env.DB.prepare(
      `UPDATE contact SET stage = COALESCE(?, stage), next_follow_up = COALESCE(?, next_follow_up),
        updated_at = datetime('now') WHERE id = ?`
    )
      .bind(after.stage_moved_to, after.next_follow_up_set, before.contact_id)
      .run();
    const contactDiff = fieldDiff(
      { stage: contactBefore?.stage, next_follow_up: contactBefore?.next_follow_up },
      {
        stage: after.stage_moved_to ?? contactBefore?.stage,
        next_follow_up: after.next_follow_up_set ?? contactBefore?.next_follow_up,
      }
    );
    if (contactDiff)
      await audit(
        c.env.DB,
        "contact",
        before.contact_id,
        "update",
        `${contactDiff} (applied from interaction ${iid})`,
        undefined,
        `contact-${before.contact_id}`
      );
  }

  return c.redirect(`/contacts/${before.contact_id}?flash=edited`);
});

app.post("/interactions/:id/delete", async (c) => {
  const iid = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM interaction WHERE id = ?").bind(iid).first<Interaction>();
  if (!before) return c.notFound();

  /*
   * Only the request that actually removed the row records the deletion (#51). This path already
   * deleted before auditing, so gating on meta.changes gives up nothing that was ever protected here —
   * unlike the contact delete in contactList.ts, which audits first on purpose and needed a different
   * fix. A duplicated POST's DELETE removes nothing and would otherwise write a second event for one
   * deletion.
   *
   * `?? 1` on purpose: if D1 stops reporting changes, every request audits. Losing the trail is the
   * worse failure, so an unknown count is never the reason an event goes unwritten.
   */
  const removed = await c.env.DB.prepare("DELETE FROM interaction WHERE id = ?").bind(iid).run();
  if ((removed.meta?.changes ?? 1) === 0) return c.redirect(`/contacts/${before.contact_id}?flash=deleted`);

  /*
   * As with editing, deleting an attempt does NOT decrement the rung or move last_attempt_at back (#82,
   * #57). "This one took four tries" stays true after the record of the fourth is tidied away, and a
   * delete that quietly moved a contact back up the chase list would be the invisible state change #30
   * was about. The deleted row is preserved in the audit event below, so the difference is explainable.
   */
  await recomputeLastTouch(c.env.DB, before.contact_id);
  await audit(
    c.env.DB,
    "interaction",
    iid,
    "delete",
    `contact ${before.contact_id} · deleted`,
    `${before.type} on ${before.date} · ${before.subject ?? "no subject"} · ${before.summary ?? ""}`.slice(0, 300),
    `contact-${before.contact_id}`
  );
  return c.redirect(`/contacts/${before.contact_id}?flash=deleted`);
});

export default app;
