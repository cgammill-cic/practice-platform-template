// Shared bindings and domain types.

export interface D1Result<T> {
  results: T[];
}
/**
 * What D1 returns from run(). Only last_row_id is modelled, because it is the one field the app
 * actually needs and modelling the rest would invite reliance on shapes we have not verified.
 *
 * Reading the new id from here rather than from "SELECT id ... ORDER BY id DESC LIMIT 1" matters
 * (#31): that query returns whichever row has the highest id at read time, which is the row we just
 * wrote only if nothing else wrote in between. It also silently returns the wrong answer if a future
 * ordering ever stops correlating with insertion. last_row_id is the id of the insert that produced it.
 *
 * changes was added for #51: how many rows the statement actually touched. A DELETE by primary key
 * that reports 0 means some other request already removed the row, which is how a duplicated POST is
 * told apart from a real one. Optional here rather than required, and every caller treats "not
 * reported" as "assume it counted" — an unknown value must never be the reason an audit event goes
 * unwritten.
 */
export interface D1RunResult {
  meta?: { last_row_id?: number; changes?: number };
}
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1RunResult>;
}
export interface D1Db {
  prepare(query: string): D1Stmt;
  /**
   * Sends many statements in ONE round trip, which is also ONE Cloudflare subrequest and ONE SQLite
   * transaction — if any statement fails, D1 rolls the whole list back. Added (REL-030) after a large
   * import died: at three-to-four awaited queries per row, a big enough file needs enough minutes and
   * enough subrequests to run past Cloudflare's per-request subrequest limit.
   *
   * The return value is deliberately not modelled beyond the result rows. Callers here use batch()
   * for writes and never read per-statement metadata out of it; modelling more would invite reliance
   * on shapes we have not verified, same reasoning as D1RunResult above.
   */
  batch<T = Record<string, unknown>>(statements: D1Stmt[]): Promise<D1Result<T>[]>;
}
export interface R2Bucket {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ objects: { key: string; uploaded: Date }[] }>;
}

export type Bindings = {
  DB: D1Db;
  BACKUPS: R2Bucket;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  /**
   * Optional. Your deployment's own URL (e.g. `https://your-worker.your-subdomain.workers.dev`, or a
   * custom domain), used only to build clickable links in the daily digest email. Without it the digest
   * still sends, just without a dashboard link — see `appOrigin()` in digest.ts.
   */
  APP_URL?: string;
  /*
   * Microsoft Graph. All OPTIONAL, and that is the point: a deployment with none of them set must still
   * run, with the Outlook panel on /health saying it is not configured rather than the app failing to
   * boot — every independent deployment of this app should work fine before anyone has registered
   * anything with Microsoft.
   */
  MS_CLIENT_ID?: string;
  MS_TENANT_ID?: string;
  MS_CLIENT_SECRET?: string;
  /** Test-only overrides so the token exchange can run against a local stub. Unset in production. */
  MS_AUTH_BASE?: string;
  MS_GRAPH_BASE?: string;
  /**
   * Timezone to read the calendar in when Graph will not say what the mailbox uses. Optional; defaults
   * to Central Standard Time. A **Windows** zone id, not IANA, because that is what
   * `/me/mailboxSettings` returns and both values feed the same `Prefer: outlook.timezone` header. Set
   * this to your own timezone if you're not in US Central.
   */
  MS_TIMEZONE?: string;
};

/*
 * Stage vocabulary. Entries are [value, label, hint?]. select() renders the hint after an em-dash, so
 * the third element is read by a person choosing a stage — no code reads it (checked across src/
 * 2026-08-03: contactList.ts strips it before rendering the filter, everything else takes [0] or [1]).
 *
 * ADDING A STAGE REQUIRES A MIGRATION. contact.stage carries a CHECK constraint listing every value,
 * and SQLite cannot alter one in place, so the table has to be rebuilt (0005, and 0009 for pray).
 * REL-022 exists because follow_up_action was once added here without that migration and every write
 * of it threw a 500 in production, silently, until someone clicked the button.
 *
 * The spreadsheet's Priority codes are no longer carried here (#29, 2026-08-03). They rode along as
 * hints — "was code 1", "— was GHST" — to make the REL-001 import checkable: confirming the imported
 * contacts landed in the right stage is far easier with the old code on screen. That was a deliberate
 * deferral, not an oversight; the operator has now confirmed the verification pass is done, which is the trigger
 * the issue named, so the reason to keep them has expired.
 *
 * What came out is the code reference, NOT the whole third element — the issue's "drop the third
 * element from each entry" would have deleted seven real explanations along with it. "gave up after no
 * reply" describes the stage; "— was GHST" was the bridge welded onto the description. Only
 * meeting_scheduled and retired held a bare code with nothing else, so only those two lost their hint
 * outright. follow_up_action and not_qualified never had a code and are untouched.
 *
 * The code → stage mapping survives where it is actually used: STAGE_FROM_CODE in importer.ts is the
 * executable copy, and the import preview page states it in prose for the person running an import.
 * The narrative record is docs/definitions.md §2, cited from here and from importer.ts.
 *
 * That citation was dangling when the paragraph above was first written — the definitions draft lived
 * outside the repo, and #29 flagged it rather than silently repairing it. The file was committed and
 * adopted the same day (2026-08-03), in the commit that also resolved the citations from importer.ts,
 * migration 0001 and the decision log. Corrected here 2026-08-04: a comment that tells the next reader
 * a file is missing, when it is sitting in docs/, is worse than no comment at all.
 *
 * pray was added 2026-08-04 by request — "I may not use it much, but I want to have it". It
 * is the one outcome code in the spreadsheet's Priority column (CMPL, GHST, RTRD, Pray, NA) that never
 * got a stage. It is ACTIVE, not terminal, which is the load-bearing part: a stage in neither
 * ACTIVE_STAGES nor TERMINAL_STAGES appears in NO dashboard section, so a Pray contact with no
 * follow-up date would be invisible. Active means Needs Attention catches it instead. The hint was left
 * blank when the stage was added, because every other hint describes what the stage means and that
 * description was the operator's to write rather than the maintainer's to invent. Their own words,
 * 2026-08-04: "keep them in your prayers".
 *
 * follow_up_action has NO spreadsheet ancestor — it was added 2026-07-31 because the vocabulary could
 * not express "they replied, or we met, and the next move is mine". awaiting_response means they owe
 * you; in_conversation was silent on who owed what, which is precisely where a commitment can go quiet
 * without anything looking wrong.
 */
export const STAGES = [
  ["meeting_scheduled", "Meeting Scheduled"],
  ["follow_up_action", "Follow-Up Action", "the next move is yours"],
  ["in_conversation", "In Conversation", "responded, no meeting yet"],
  ["awaiting_response", "Awaiting Response", "reached out, no reply yet"],
  ["reach_out_later", "Reach Out Later", "3–6 weeks out"],
  ["not_contacted", "Not Contacted", "prioritized backlog"],
  ["stay_connected", "Stay Connected", "ongoing relationship"],
  ["pray", "Pray", "keep them in your prayers"],
  ["complete", "Complete", "talked, no follow-up items"],
  ["no_response", "No Response", "gave up after no reply"],
  ["retired", "Retired"],
  ["not_qualified", "Not Qualified", "don't really know them / not in market"],
] as const;

/**
 * Stages that represent a live thread. These SHOULD carry a next-follow-up date, but the app no
 * longer blocks saving without one (feedback 2026-07-30) — gaps surface on the dashboard instead,
 * so a missing date is visible rather than obstructive.
 *
 * follow_up_action is included deliberately: an owed commitment with no date is the most dangerous
 * gap in the system, so it must reach Needs Attention.
 *
 * pray is included for a related reason (2026-08-04): it is a deliberate holding state, not a closed
 * one, and a contact you are praying about is exactly the kind you would not want quietly forgotten.
 */
export const ACTIVE_STAGES = [
  "meeting_scheduled",
  "follow_up_action",
  "in_conversation",
  "awaiting_response",
  "reach_out_later",
  "stay_connected",
  "pray",
] as const;

/**
 * Stages that legitimately have no next step. A contact here is finished with, not neglected.
 *
 * Exported because the dashboard's follow-up lists must exclude them (#14, confirmed
 * 2026-08-01: "I've marked them complete with no follow up, I don't need to be reminded"). Before
 * that filter, 59 imported contacts in Complete and No Response carried a past date in
 * next_follow_up and made up roughly three quarters of the Overdue list, burying the four items that
 * were real. The dates were cleared, but the filter is what stops it recurring — and it will be
 * needed more as Not Qualified gets used.
 *
 * contacts.ts kept its own local copy of this list for the resolution logic until 2026-08-01, when it
 * was folded into this one. Two definitions of the same vocabulary is the drift REL-022 exists to
 * catch, and these two had already started to diverge in intent — this copy gates the follow-up
 * lists, that one gated whether a resolved meeting needs a follow-up date. Same four stages for the
 * same reason, so one definition. Note for anyone importing it: the `as const` means the element type
 * is the four literals, so a check against a free-form string needs a widening cast at the use site.
 */
export const TERMINAL_STAGES = ["complete", "no_response", "retired", "not_qualified"] as const;

export const STRENGTHS = [
  ["strong", "Strong"],
  ["warm", "Warm"],
  ["new", "New"],
  ["cold", "Cold"],
] as const;

export const INTERACTION_TYPES = [
  ["meeting", "Meeting"],
  ["call", "Call"],
  ["email", "Email"],
  ["text", "Text"],
  ["linkedin", "LinkedIn"],
  ["note", "Note"],
] as const;

export const DIRECTIONS = [
  ["outbound", "Outbound"],
  ["inbound", "Inbound"],
  ["two_way", "Two-Way"],
] as const;

/**
 * What a meeting actually was (REL-026, migration 0014).
 *
 * A SEPARATE AXIS FROM `type`. Type is how you reached someone; this is what it was, and a "meeting" can
 * be a meal, a coffee or a Teams call. Deliberately not folded into INTERACTION_TYPES: `attempts.ts`
 * counts an outreach attempt as type email/linkedin/text/call, so a `coffee` type would have been silently
 * uncountable and the stored ladder position would drift from the count on screen.
 *
 * `phone` overlaps `type = 'call'` on purpose — a scheduled meeting held over the phone is a meeting with a
 * phone format, not a cold call.
 *
 * CHANGING THIS LIST MEANS A TABLE REBUILD, because it is enforced by a CHECK constraint — the same rule
 * ACTIVITIES used to state here before migration 0026 moved that vocabulary into a real table instead.
 */
export const MEETING_FORMATS = [
  ["meal", "Meal"],
  ["coffee", "Coffee"],
  ["in_person_other", "In person — other"],
  ["teams", "Teams"],
  ["phone", "Phone"],
  ["video_other", "Video — other"],
  ["other", "Other"],
] as const;

/**
 * Keep-in-touch intervals offered on the contact form (REL-027, migration 0015). Suggestions, not a
 * constraint — the column takes any value from 1 to 1095 days, so a typed 45 is as valid as a listed 30.
 */
export const TOUCH_INTERVALS = [7, 14, 30, 60, 90, 180, 365] as const;
export const MAX_TOUCH_INTERVAL_DAYS = 1095;

/**
 * Departments. Values equal labels because these are stored as written and read back in reports.
 *
 * Sales, Marketing, Supply Chain and Legal/Compliance were added 2026-07-30 by request,
 * after the REL-001 analysis found 10 priority contacts sitting in those functions and about to be
 * flattened into "Other". Operations and Delivery already existed. "Delivery/Consulting" in the
 * source spreadsheet still maps to Delivery — that is a naming variant, not a separate function.
 */
export const DEPARTMENTS = [
  ["HR", "HR"],
  ["Executive", "Executive"],
  ["Finance", "Finance"],
  ["IT", "IT"],
  ["Operations", "Operations"],
  ["Delivery", "Delivery"],
  ["Sales", "Sales"],
  ["Marketing", "Marketing"],
  ["Supply Chain", "Supply Chain"],
  ["Legal/Compliance", "Legal/Compliance"],
  ["Other", "Other"],
  ["Unknown", "Unknown"],
] as const;

export const STATUSES = [
  ["active", "Active"],
  ["inactive", "Inactive"],
] as const;

/**
 * Activity categories for time entry (TIME-001, #90) — DATA, NOT A CONSTANT, since migration 0026.
 *
 * This used to be a hardcoded list here, mirrored by a CHECK constraint on time_entry.activity that
 * needed its own migration every time a category was added. Asked, 2026-09-09: "Can I have the
 * application create a new category when I've added it to Outlook, but ask me how to apply it in the
 * app?" — the honest answer was no, so the vocabulary moved into a real `activity` table instead. See
 * migration 0026 for the full argument and src/activities.ts for the loader (`loadActivities`) and the
 * management page. Nothing is exported from here anymore for it — every caller that used to import
 * ACTIVITIES now calls loadActivities(db) instead, because the list can change without a deploy.
 *
 * PERSONAL WAS THE ONE ACTIVITY THAT IS REAL TIME BUT NOT WORKED TIME, and is now the first of
 * potentially several — `activity.is_work` is a per-row flag rather than a single hardcoded name,
 * precisely because Vacation/Holiday (the request that prompted this) is a second one. See
 * `nonWorkNames()` in activities.ts.
 */

/**
 * The activity that pays the bills, and the reason the import has to be right (2026-08-11:
 * "The BIGGEST thing I will need is the 'Client Delivery' time captured because i will use that for
 * invoicing").
 *
 * DELIBERATELY STILL A FIXED CONSTANT, not a per-row flag read from the database, even after migration
 * 0026 moved the rest of the activity vocabulary into a table. Only one activity has ever been billable,
 * the weekly report is built around exactly one named invoicing column ("Client Delivery, line by
 * line"), and nothing about this request asked to make that flexible — self-service in 0026 is for the
 * ordinary, non-invoicing categories. `activity.is_billable` exists in the table for a future that widens
 * this, but no self-service path sets it; a new billable activity is still a deliberate decision.
 *
 * Exported so the reports can say which line is the billable one rather than leaving it to be recognised
 * by name. Everything else on the list is for looking at how the week went; an error in this one reaches
 * an invoice.
 */
export const BILLABLE_ACTIVITY = "Client Delivery";

/**
 * How an engagement is billed (CUST-001, #91). These values carry a CHECK constraint on
 * engagement.billing_method — from migration 0001, widened by 0022 — so the list cannot be extended
 * without a table rebuild. The column is NOT NULL, which is why the engagement form makes it a required
 * choice rather than offering a blank.
 *
 * Decided 2026-07-29: all the models are in real use in the practice, varying by client, so billing
 * method is a property of the engagement and never a firm-wide setting.
 *
 * `tm_not_to_exceed` added 2026-09-02 — a real engagement was billed that way and the schema rejected it,
 * which is the failure REL-022 exists to catch. `undecided` added in the same migration for a reason worth
 * stating: a pursuit at `identified` has no billing method yet, and forcing the choice on the create form
 * means whatever gets picked to get past the field is then wrong in every pipeline report. "Not decided
 * yet" is a fact about the deal, not a missing value.
 */
export const BILLING_METHODS = [
  ["hourly", "Time & Materials (hourly)"],
  ["tm_not_to_exceed", "Time & Materials, Not to Exceed"],
  ["fixed_fee", "Fixed Fee"],
  ["retainer", "Retainer"],
  ["undecided", "Not Decided Yet"],
] as const;

/** The one method that uses `not_to_exceed_amount`, named so the form and the reports ask once. */
export const NOT_TO_EXCEED = "tm_not_to_exceed";

/**
 * Engagement lifecycle — a pursuit and an engagement are the same row at different ages (PURS-001).
 *
 * Unlike billing_method, `engagement.status` carries NO constraint in the schema, so this list can grow
 * without a migration — stated because the two columns sit side by side on the same form and the cost of
 * changing them is completely different.
 *
 * `prospective` was retired by migration 0022. It was one bucket covering everything from "they
 * mentioned a need" to "verbal yes, waiting on paper", which is the entire distinction a pipeline exists
 * to draw. Nothing in production used it. It is absent here on purpose, and `labelFor` falls back to the
 * raw value, so an old row in a stale database still renders instead of showing blank.
 */
export const ENGAGEMENT_STATUSES = [
  ["identified", "Identified"],
  ["qualifying", "Qualifying"],
  ["proposal", "Proposal in Progress"],
  ["submitted", "Proposal Submitted"],
  ["verbal", "Verbal Yes"],
  ["active", "Active"],
  ["on_hold", "On Hold"],
  ["complete", "Complete"],
  ["lost", "Lost"],
  ["no_decision", "No Decision"],
  ["withdrawn", "Withdrawn"],
] as const;

/**
 * The three ages of a row, because `engagement` now holds things that are not customers and every screen
 * has to know which it is looking at.
 *
 * GROUPED HERE SO THE RULE LIVES IN ONE PLACE rather than as eleven literal strings spread across the
 * pipeline, the dashboard, the digest and the time-entry customer picker. Migration 0005's note describes
 * the failure this avoids: a screen selecting on literal status strings silently and permanently ignores
 * any value added later, which is how a pursuit becomes invisible.
 *
 * The one that matters most is DEAD_STAGES. A lost pursuit is a row in the customer table now, and
 * offering it in the time-entry picker would invite hours onto work that never existed.
 */
export const PURSUIT_STAGES = ["identified", "qualifying", "proposal", "submitted", "verbal"] as const;
export const LIVE_STAGES = ["active", "on_hold"] as const;
export const CLOSED_STAGES = ["complete", "lost", "no_decision", "withdrawn"] as const;
export const DEAD_STAGES = ["lost", "no_decision", "withdrawn"] as const;

export const isPursuit = (s: string) => (PURSUIT_STAGES as readonly string[]).includes(s);
export const isLive = (s: string) => (LIVE_STAGES as readonly string[]).includes(s);
export const isDead = (s: string) => (DEAD_STAGES as readonly string[]).includes(s);

/**
 * What kind of work it is (PURS-001). "I would like to know what type of work it would be…so
 * that I can ultimately track what work is in most demand."
 *
 * A CONTROLLED LIST IS THE WHOLE POINT, and the four rows already in the table prove why. `service_type`
 * was free text, and one client's *Organizational Design* engagement was filed under `Executive Support` —
 * so a demand report run the day before this shipped would have shown zero demand for org design. On four
 * rows that is a curiosity; on forty it is a wrong answer to the question the field exists to answer.
 *
 * Values equal labels, the convention DEPARTMENTS uses (and the activity table now uses via its `name`
 * column, migration 0026), so exports read as English without a lookup table to fall out of date. There
 * is NO CHECK on this column, so adding an entry here is a one-line change with no migration — unlike
 * billing_method directly above it.
 *
 * `Other` is last and exists so an unusual piece of work is recorded honestly rather than forced into the
 * nearest category, which would corrupt exactly the counts the list is for.
 */
export const SERVICE_TYPES = [
  ["Change Management", "Change Management"],
  ["Organizational Design", "Organizational Design"],
  ["Executive/Sponsor Support", "Executive/Sponsor Support"],
  ["HR Service Delivery", "HR Service Delivery"],
  ["HCM & Payroll", "HCM & Payroll"],
  ["ERP", "ERP"],
  ["Operating Model", "Operating Model"],
  ["Transformation Mobilization", "Transformation Mobilization"],
  ["Program Assessment / Independent Review", "Program Assessment / Independent Review"],
  ["Business Integration", "Business Integration"],
  ["Other", "Other"],
] as const;

/**
 * Who a contact is on a pursuit (`engagement_contact.role`). The decision maker and the
 * influencers were the original ask; the rest of this list is the shape those two actually take in a
 * real deal.
 *
 * `economic_buyer` is separate from `decision_maker` because they are frequently different people, and
 * confusing them is the classic reason a pursuit dies late — the sponsor says yes and the person holding
 * the budget was never in the room. `skeptic` earns its place for the same reason: an unnamed objection is
 * the one that cannot be answered.
 */
export const PURSUIT_ROLES = [
  ["decision_maker", "Decision Maker"],
  ["economic_buyer", "Economic Buyer"],
  ["champion", "Champion"],
  ["influencer", "Influencer"],
  ["skeptic", "Skeptic"],
  ["day_to_day", "Day-to-Day Contact"],
  ["procurement", "Procurement / Legal"],
  ["referral_source", "Referral Source"],
] as const;

/**
 * Where the pursuit came from. For a founder-led firm this is the most decision-useful field on the
 * record: it separates the channel that produces PAID work from the channel that produces conversations,
 * and those are not the same list. Pairs with `origin_contact_id` when the answer is a person.
 */
export const PURSUIT_ORIGINS = [
  ["referral", "Referral"],
  ["network", "Own Network"],
  ["inbound", "Inbound / Marketing"],
  ["expansion", "Expansion at Existing Client"],
  ["rfp", "RFP / Formal Process"],
  ["unknown", "Unknown"],
] as const;

/**
 * Why a pursuit ended without becoming work. The half of demand analysis that is easy to skip and
 * worthless to omit: won work says what was SOLD, not what is in demand. Three org-design pursuits lost
 * on budget timing and two change projects won reads as "change management is in demand" — survivorship
 * bias with a chart on top.
 *
 * `internal_team` and `no_action` are on the list because for an independent advisor they are the real
 * competitors far more often than a rival firm is, and a list offering only firms would quietly
 * reclassify them as something else.
 */
export const OUTCOME_REASONS = [
  ["price", "Price"],
  ["no_budget", "No Budget / Budget Cut"],
  ["timing", "Timing — Deferred"],
  ["internal_team", "Client Used Their Own Team"],
  ["another_firm", "Chose Another Firm"],
  ["scope_changed", "Scope Changed or Went Away"],
  ["lost_sponsor", "Sponsor Left or Lost Support"],
  ["no_action", "No Decision Ever Made"],
  ["not_a_fit", "We Declined or Withdrew"],
  ["other", "Other"],
] as const;

/**
 * A pursuit, and later the engagement it became — one row, whole lifecycle (PURS-001, migration 0022).
 *
 * The columns from `id` to `qb_project_id` have existed since migration 0001 and none of them had been
 * read or written by the app until CUST-001, including qb_customer_id, which is the whole point of that
 * issue. Everything below `not_to_exceed_amount` arrived with 0022.
 *
 * A ROW HERE IS NOT NECESSARILY A CUSTOMER. Check `status` against PURSUIT_STAGES / LIVE_STAGES /
 * DEAD_STAGES above rather than assuming the table means "client".
 */
export interface Engagement {
  id: number;
  organization_id: number | null;
  organization_name?: string | null;
  /**
   * Joined in from `organization.calendar_tag` (migration 0018), not a column on this table — the Outlook
   * category that means this client. Editable both here and on the organization screen (ORG-001), but
   * saved on the organization either way, so all its engagements share one value. Null means "match on
   * the organization name", which is what most customers need.
   */
  calendar_tag?: string | null;
  name: string;
  service_type: string | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
  billing_method: string;
  hourly_rate: number | null;
  fixed_fee_amount: number | null;
  retainer_monthly_amount: number | null;
  /**
   * The QuickBooks customer this engagement bills to, pasted by hand (decision 2026-08-11: no Intuit
   * API, no OAuth). UNVERIFIED BY CONSTRUCTION — nothing checks it exists in QuickBooks, so a typo
   * silently fails to reconcile. Mitigated by showing it on every report that groups by customer, where
   * a wrong one is visible in the place it matters.
   */
  qb_customer_id: string | null;
  qb_project_id: string | null;

  /** The cap, when billing_method is NOT_TO_EXCEED. Meaningless otherwise, and not constrained. */
  not_to_exceed_amount: number | null;
  /**
   * What the whole piece of work is worth, whatever the billing method — the number that belongs in a
   * pipeline total. Deliberately not the same as fixed_fee_amount or retainer_monthly_amount: those are
   * contract terms. A retainer at 5,000/month for six months is a 30,000 pursuit and no older column
   * could say so.
   */
  expected_value: number | null;
  /** When the client expects to decide. The field that makes a list into a pipeline. */
  expected_decision_date: string | null;
  submitted_date: string | null;
  decided_at: string | null;
  /** The pursuit's own dated follow-up, mirroring contact.next_follow_up so it cannot quietly rot. */
  next_step: string | null;
  next_step_date: string | null;
  origin: string | null;
  origin_contact_id: number | null;
  origin_contact_name?: string | null;
  /** Only meaningful once closed. See OUTCOME_REASONS for why this is not optional in practice. */
  outcome_reason: string | null;
  outcome_note: string | null;
}

/** One person's role on one pursuit (`engagement_contact`, migration 0022). */
export interface PursuitContact {
  engagement_id: number;
  contact_id: number;
  contact_name?: string | null;
  contact_title?: string | null;
  role: string;
  note: string | null;
}

/**
 * How you stand with a company (ORG-001). `organization.relationship_status` has existed since migration
 * 0001 with no constraint and nothing ever written to it, so this list is the first opinion about what it
 * holds — and it is a property of the COMPANY, not of a person or a deal. A firm you have delivered for
 * is a different prospect from one you have never worked with, whoever you happen to know there.
 *
 * Kept short on purpose. This is not a second pipeline: the relationship pipeline lives on contacts and
 * the sales pipeline lives on pursuits, and a third one here would be a third place to keep in step.
 */
export const ORG_RELATIONSHIP = [
  ["client", "Current Client"],
  ["past_client", "Past Client"],
  ["prospect", "Prospect"],
  ["partner", "Partner / Referrer"],
  ["alumni", "Former Employer / Alumni"],
  ["network", "Network Only"],
] as const;

/**
 * An organization (migration 0001). Editable for the first time in ORG-001 — until 2026-09-02 nothing in
 * the app could write `domain`, `industry`, `address`, `relationship_status` or `notes`, and all five were
 * empty on every organization row. They were not unused because they were unwanted; there was simply
 * no screen. Organizations are still created name-only by adding a contact, by the engagement form and by
 * the importer, which is why the edit screen matters more than the create one.
 */
export interface Organization {
  id: number;
  name: string;
  domain: string | null;
  industry: string | null;
  /** The operator's "physical address" for pursuit and invoicing context. Lives here, not on the pursuit. */
  address: string | null;
  relationship_status: string | null;
  notes: string | null;
  calendar_tag: string | null;
  contact_count?: number;
  engagement_count?: number;
}

/** One logged block of time (migration 0012). */
export interface TimeEntry {
  id: number;
  date: string;
  hours: number;
  activity: string;
  engagement_id: number | null;
  engagement_name?: string | null;
  organization_name?: string | null;
  contact_id: number | null;
  contact_name?: string | null;
  /**
   * The operator's own words — the Comments field. Free text, and NEVER written by the calendar import
   * (see migration 0017). A re-import updates hours, activity and customer on a row it created and leaves
   * this alone, so a sentence typed here survives every subsequent import of the same week.
   */
  note: string | null;
  /**
   * What Outlook called the event. Written only by the import; null on a hand-typed entry. Kept apart from
   * `note` so neither can silently overwrite the other.
   */
  subject: string | null;
  /**
   * 1 when this imported row has been corrected by hand and now contradicts Outlook (migration 0019). The
   * import leaves such a row alone and flags it, so re-importing a week never silently reverts a fix to
   * hours that may be on an invoice. Set only by a change to date/hours/activity/customer — editing the
   * comment does not count, because comments are already safe from re-import. Cleared only when the
   * operator explicitly ticks the flagged row, which hands it back to the calendar.
   */
  hand_edited: number;
  source: string;
  outlook_ref: string | null;
}

/**
 * Provenance of a contact record. Values are stored lowercase/slugged for stable data; these labels
 * are display-only. Unknown values fall back to the raw string via labelFor().
 */
export const SOURCES = [
  ["manual", "Manual"],
  ["import", "Import"],
  ["import-test", "Import (Test)"],
  ["outlook", "Outlook"],
  ["gmail", "Gmail"],
  ["linkedin", "LinkedIn"],
] as const;

/**
 * How a scheduled meeting ended. Resolving a meeting ALWAYS creates an interaction — there is no
 * bare "mark done" checkbox, because a meeting that leaves the dashboard without leaving a record is
 * exactly how history goes missing (feedback 2026-07-30).
 */
export const MEETING_OUTCOMES = [
  ["held", "Held"],
  ["no_show", "No-Show"],
  ["cancelled", "Cancelled"],
] as const;

/** Priority tier: 1 = highest. Scale is 1–5 (feedback 2026-07-30). */
export const MAX_PRIORITY_TIER = 5;

export interface Contact {
  id: number;
  full_name: string;
  title: string | null;
  organization_id: number | null;
  organization_name?: string | null;
  department: string | null;
  email_work: string | null;
  email_personal: string | null;
  phone: string | null;
  linkedin_url: string | null;
  /**
   * "There is no LinkedIn profile to find" — asserted by a person, never inferred (migration 0011,
   * REL-011). 0 means nothing has been asserted, which is the state of every contact nobody has looked
   * for yet; it does NOT mean a profile exists. Only linkedin_url says that.
   *
   * Kept as the number SQLite stores rather than a boolean, so no read has to know whether it went
   * through a converting layer. Truthiness is the test everywhere it is used.
   */
  no_linkedin: number;
  birthday: string | null;
  stage: string;
  strength: string | null;
  priority_tier: number | null;
  escalation_rung: number;
  referral_source_contact_id: number | null;
  last_touch: string | null;
  /**
   * When YOU last reached out (migration 0008, REL-008 Part B). Deliberately separate from last_touch,
   * which is derived from all interactions including inbound ones — reading that as "when I last chased
   * them" would treat their reply as your attempt and reset the ladder exactly when it should stop.
   */
  last_attempt_at: string | null;
  next_follow_up: string | null;
  /**
   * Touch this contact every N days (migration 0015, REL-027). NULL means no cadence, which is the state
   * of every contact until one is chosen — never inferred from relationship strength, because how often
   * you want to reach out is a different fact from how strong the relationship is.
   *
   * A cadence only produces a follow-up date when an interaction is recorded, so a contact with a cadence
   * and no touch yet still has no next step and still belongs in Needs Attention.
   */
  touch_interval_days: number | null;
  /** Scheduled meeting date (migration 0004). Cleared when the meeting is resolved. */
  meeting_date: string | null;
  /** Optional free-text time, e.g. "10:30 am" (migration 0004). */
  meeting_time: string | null;
  notes: string | null;
  source: string | null;
  status: string;
}

export interface Interaction {
  id: number;
  contact_id: number;
  date: string;
  type: string;
  direction: string | null;
  subject: string | null;
  summary: string | null;
  notes_link: string | null;
  outcome: string | null;
  /** What the next follow-up was set to at the time of this interaction (migration 0003). */
  next_follow_up_set: string | null;
  /** Stage this interaction moved the contact to, if any (migration 0003). */
  stage_moved_to: string | null;
  /** What the meeting was — meal, coffee, Teams… (migration 0014). Nullable and never required. */
  format: string | null;
}

export const stageLabel = (value: string | null): string =>
  STAGES.find(([v]) => v === value)?.[1] ?? value ?? "—";

export const labelFor = (
  options: readonly (readonly [string, string])[],
  value: string | null
): string => options.find(([v]) => v === value)?.[1] ?? value ?? "—";
