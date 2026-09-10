// REL-001 — contact import with preview. REL-018 — idempotent commit.
//
// Nothing is written to the database until the preview is explicitly confirmed. The preview is
// stateless: parsed and normalized rows are round-tripped through a hidden field, so no server-side
// session or temp table is needed.
//
// Every interpretation of the spreadsheet lives here rather than in the CSV, so it is reviewable,
// repeatable for the next import, and visible on the preview screen before it becomes data.
//
// REL-018, after a live failure on 2026-07-30: the commit step re-checks EVERY row against the
// database immediately before inserting it. The preview's duplicate check is a snapshot taken when
// the page rendered; it cannot protect against the same page being submitted twice. An import was
// interrupted partway through, the page was submitted again, and the already-written rows plus an
// earlier test batch were inserted a second time — duplicates that the preview had correctly flagged
// the first time round. Detection has to happen where the write happens.

import { Hono } from "hono";
import { esc, layout } from "./views";
import {
  DEPARTMENTS,
  MAX_PRIORITY_TIER,
  TERMINAL_STAGES,
  stageLabel,
  type Bindings,
  type Contact,
  type D1Db,
  type D1Stmt,
} from "./types";

const app = new Hono<{ Bindings: Bindings }>();
const ACTOR = "operator";
/** The spreadsheet's Comments column carries bare MM/DD dates. The workbook is a 2026 file. */
const COMMENT_DATE_YEAR = 2026;
const TEST_SUBSET = 15;

/**
 * Priority code → stage (definitions.md §2). Codes 5–9 are all prioritized backlog. A code we do not
 * recognize does NOT silently become a stage: it lands in not_contacted and is flagged on the preview,
 * because a silent default is how a contact ends up somewhere nobody meant to put it.
 *
 * NA was added 2026-08-03 (#65). definitions.md §2 had always listed it as not_qualified but hedged —
 * only when confirmed during import preview — because NA in the spreadsheet sometimes means "vetted
 * out" and sometimes just "no data". The hedge was never implemented, so NA fell through to the
 * unrecognized path and landed in not_contacted: the prioritized backlog, which is the one place a
 * vetted-out contact should never be. The rule was settled: NA is not_qualified, no confirmation step.
 * A wrong not_qualified is visible and one edit away; a wrong not_contacted quietly joins the queue.
 *
 * Pray was added 2026-08-04, completing the set: it was the last outcome code in the Priority column
 * (CMPL, GHST, RTRD, Pray, NA) with no stage to map to, so a Pray row imported into not_contacted —
 * flagged on the preview, but still the backlog. Migration 0009 and #81 added the stage; this is the
 * line that lets the importer reach it.
 *
 * It is the one code the spreadsheet writes in mixed case, so both spellings are listed. The lookup
 * tries the value as typed and then its uppercase form, which resolves "cmpl" for the shouted codes but
 * would turn "pray" into "PRAY" and find nothing. Two keys is cheaper than a smarter lookup, and it
 * fails visibly rather than quietly if a third spelling ever appears.
 *
 * SUPERSEDED IN PART ON 2026-08-20 (REL-032) — READ THIS BEFORE THE MAP BELOW.
 *
 * The numeric codes no longer name a stage. What the Priority column MEANS changed after the initial
 * load: it is now an action-priority ranking, not an assertion about the state of a relationship. Once
 * the logic changed from a definition to an action-priority listing, a large batch of contacts started
 * showing as though a conversation was already underway when in fact none had been contacted yet.
 *
 * A later large import made that concrete: hundreds of rows arrived mapped to stages like In
 * Conversation, Awaiting Response and Reach Out Later — contacts the app claimed were mid-dialogue when
 * they had never been spoken to. A wrong not_contacted is a contact waiting in the queue; a wrong
 * in_conversation is the app lying about a relationship, and it also suppresses the chase logic that
 * would otherwise prompt first contact.
 *
 * So a numeric code now sets the TIER and the stage is always not_contacted. `1` no longer means a
 * meeting is booked, which also retires the meeting_scheduled-without-a-date repair below.
 *
 * THE NON-NUMERIC CODES ARE NOT PRIORITIES AT ALL and keep their meaning — but a brand-new row
 * carrying one is a contradiction worth stopping on, because those codes describe a history the
 * contact can only have if they are already in the system: rows carrying one should already have been
 * loaded with the initial load and should not be loaded again. Proven on a real import: a single CMPL
 * row turned out to be a duplicate of an existing contact from an earlier load, missed by the matcher
 * because the name had lost a parenthetical nickname and the new row carried no email. So the code
 * still maps to its stage — a real Complete contact must still be importable — but the row is flagged
 * and left UNTICKED on the preview, the same treatment a detected duplicate gets. Flagged rather than
 * rejected outright: rejecting it would make a genuinely new finished-with contact permanently
 * unimportable, and this is a matcher-miss signal, not a fact.
 */
const STAGE_FROM_CODE: Record<string, string> = {
  // Numeric codes are rankings now, not states — every one of them lands in the backlog. Kept as an
  // explicit map rather than a numeric range check so an unrecognized code still fails visibly.
  "1": "not_contacted",
  "2": "not_contacted",
  "3": "not_contacted",
  "4": "not_contacted",
  "5": "not_contacted",
  "6": "not_contacted",
  "7": "not_contacted",
  "8": "not_contacted",
  "9": "not_contacted",
  "A-FRQ": "stay_connected",
  CMPL: "complete",
  GHST: "no_response",
  RTRD: "retired",
  Pray: "pray",
  PRAY: "pray",
  NA: "not_qualified",
};

/** The codes that assert a history rather than a ranking. A NEW row carrying one is probably a duplicate. */
const ALREADY_LOADED_CODES = new Set(["A-FRQ", "CMPL", "GHST", "RTRD", "PRAY", "NA"]);

/**
 * Priority code → tier (REL-032). The rule: if the priority tier is 1-4, use that priority; 5 and above
 * all show as tier 5.
 *
 * This replaces GPT Priority as the source of the tier. That column drove High → 2 / Medium → 3 and
 * was absent from a later import file entirely, so every imported contact landed on the default of 4 —
 * every tier in the batch was wrong, not just the stages, and nothing said so. The priority code is the
 * column that is actually kept up to date, so the tier now comes from the thing that gets curated.
 *
 * Tier 1 is no longer reserved for manual judgment: a code of 1 is his highest-priority mark and
 * should read as tier 1. Tier 5 stops being reserved for the same reason — it is now where 5-9 land.
 */
function tierFromCode(code: string): number | null {
  if (!/^[1-9]$/.test(code)) return null;
  const n = Number(code);
  return n <= 4 ? n : MAX_PRIORITY_TIER;
}

/**
 * Naming variants only. Sales, Marketing, Supply Chain and Legal/Compliance are real departments as
 * of 2026-07-30 and import as themselves — they are no longer flattened into Other. Anything still
 * outside the vocabulary becomes Other and is flagged on the preview.
 */
const DEPARTMENT_MAP: Record<string, string> = {
  "Delivery/Consulting": "Delivery",
  Legal: "Legal/Compliance",
  Compliance: "Legal/Compliance",
  "Supply chain": "Supply Chain",
};

/** Organization strings that are placeholders, not employers. */
const NOT_AN_ORG = new Set(["tbd", "na", "n/a", "none", "unknown", "retired", "retired partner", "self", "-"]);

/** Near-duplicate organization names that would otherwise split reporting counts. */
const ORG_CANONICAL: Record<string, string> = {
  felix: "Felix Global",
  planet: "The Planet Group",
};

/**
 * GPT Priority → priority tier. Tiers 1 and 5 are deliberately left unused so the extremes stay a
 * matter of manual judgment rather than an artifact of a spreadsheet score. Stated on the preview.
 */
const TIER_FROM_PRIORITY: Record<string, number> = { High: 2, Medium: 3 };
const TIER_DEFAULT = 4;

const clean = (v: string | undefined): string => {
  const t = (v ?? "").trim();
  return t === "" || ["na", "n/a", "none"].includes(t.toLowerCase()) ? "" : t;
};
const email = (v: string | undefined): string => {
  const t = clean(v).toLowerCase();
  return t.includes("@") && !t.includes(" ") ? t : "";
};
const today = () => new Date().toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, "0");

/** RFC 4180 CSV parse — quoted fields may contain commas, newlines, and escaped quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

/**
 * Pulls the leading MM/DD out of a Comments string. The convention is that the comment starts with the
 * date of the next thing to happen: "07/30 - call @ 10:30 am", "08/17 - ping on next steps". Returns
 * the ISO date and, when present, the time as written.
 */
export function parseComment(comment: string): { date: string | null; time: string | null } {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})/.exec(comment);
  if (!m) return { date: null, time: null };
  const mo = Number(m[1]);
  const da = Number(m[2]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return { date: null, time: null };
  const t = /(\d{1,2}(?::\d{2})?)\s*([ap])\.?m\.?/i.exec(comment);
  const time = t ? `${t[1]} ${t[2].toLowerCase()}m` : null;
  return { date: `${COMMENT_DATE_YEAR}-${pad(mo)}-${pad(da)}`, time };
}

export function normalizeOrg(raw: string): string {
  const t = clean(raw).replace(/\s+/g, " ");
  if (!t || NOT_AN_ORG.has(t.toLowerCase())) return "";
  return ORG_CANONICAL[t.toLowerCase()] ?? t;
}

const knownDepartment = (d: string) => DEPARTMENTS.some(([v]) => v === d);

export interface StagedRow {
  row: number;
  full_name: string;
  title: string;
  organization: string;
  department: string;
  email_work: string;
  email_personal: string;
  phone: string;
  linkedin_url: string;
  linkedin_match: string;
  stage: string;
  priority_tier: number | null;
  /**
   * The normalized priority code (REL-032). Carried on the staged row, not only inside import_meta,
   * because the preview has to decide whether to tick this row and digging it back out of a JSON
   * string to make a rendering decision is the kind of indirection that goes stale silently.
   */
  priority_code: string;
  meeting_date: string | null;
  meeting_time: string | null;
  next_follow_up: string | null;
  notes: string;
  import_meta: string;
  /** Things the reviewer should look at before committing. Never blocks on its own. */
  flags: string[];
  /** Hard problems — the row cannot be imported. */
  errors: string[];
}

/** Turns one CSV record into a staged contact, applying every mapping rule above. */
export function stageRow(rec: Record<string, string>, rowNum: number): StagedRow {
  const flags: string[] = [];
  const errors: string[] = [];
  const full_name = clean(rec.full_name);
  if (!full_name) errors.push("no name");

  /*
   * The Priority column is the one place "NA" is a value rather than a blank, so it cannot go through
   * clean() unexamined. clean() maps na / n/a / none to empty — correct everywhere else, and required
   * by definitions.md §5 rule 3 ("NA and blank → null, never the string 'NA'") — but here it erased the
   * code before it could be looked up. That is the real reason §2's NA row never worked: adding NA to
   * STAGE_FROM_CODE alone would have changed nothing, because "NA" never reached the map. The rows
   * landed in not_contacted flagged as "no priority code", which reads like an empty cell rather than
   * a deliberate mark, so the preview did not make the loss obvious either.
   *
   * "none" is deliberately not treated as the NA code — it is not a documented Priority value, and
   * guessing it means vetting a contact out of the backlog on the strength of a word nobody defined.
   */
  const rawCode = (rec.priority_code ?? "").trim();
  const code = ["na", "n/a"].includes(rawCode.toLowerCase()) ? "NA" : clean(rec.priority_code);
  let stage = STAGE_FROM_CODE[code] ?? STAGE_FROM_CODE[code.toUpperCase()] ?? "";
  if (!stage) {
    stage = "not_contacted";
    flags.push(code ? `unrecognized priority code "${code}" → Not Contacted` : "no priority code → Not Contacted");
  }

  /*
   * REL-032. A numeric code is a ranking, so it says nothing about the relationship: the row is
   * new-to-the-app until a reviewer says otherwise. Flagged only where the OLD logic would have
   * produced a different stage, so the preview explains the change on exactly the 1-4 rows it affects
   * rather than repeating itself on every row in a large import file.
   */
  const tier = tierFromCode(code);
  if (tier !== null && ["1", "2", "3", "4"].includes(code))
    flags.push(`priority ${code} is a ranking, not a stage → Not Contacted, tier ${tier}`);

  /*
   * A code that asserts a history on a row the app has never seen. Left unticked on the preview by the
   * caller, because in practice it means the duplicate matcher missed an existing record — see the
   * ALREADY_LOADED_CODES comment for the real case that proved it.
   */
  if (ALREADY_LOADED_CODES.has(code.toUpperCase()))
    flags.push(
      `priority code "${code}" means ${stageLabel(stage)}, which this contact can only be if they were already loaded — check for an existing record before importing this row`
    );

  const { date, time } = parseComment(clean(rec.comments));
  const meeting_date: string | null = null;
  const meeting_time: string | null = null;
  let next_follow_up: string | null = null;
  if (date) {
    /*
     * A terminal stage never takes a follow-up date from the Comments column (#65, alongside the NA
     * change). These four stages mean the relationship is finished with, not neglected — a date on one
     * is a reminder to chase someone you have decided not to chase.
     *
     * This is the mechanism behind #14: after REL-001, a batch of imported contacts in Complete and No
     * Response carried a past date here and dominated the Overdue list, burying the handful of items
     * that were real. Those dates were cleared by hand and the dashboard now filters terminal stages
     * out, so the damage is hidden — but the import would still write them, and the filter is the
     * second line of defence, not the first. Adding NA → not_qualified makes this reachable again on
     * the next import, and a large import can run into the thousands of rows.
     *
     * Flagged rather than dropped in silence: the date was in the source and the preview should say
     * what happened to it.
     */
    if ((TERMINAL_STAGES as readonly string[]).includes(stage)) {
      flags.push(`${stageLabel(stage)} is a finished stage, so the date ${date} in Comments was not set as a follow-up`);
    } else {
      next_follow_up = date;
    }
  }

  const rawDept = clean(rec.department);
  let department = DEPARTMENT_MAP[rawDept] ?? rawDept;
  if (department && !knownDepartment(department)) {
    flags.push(`department "${rawDept}" is not in the vocabulary → Other`);
    department = "Other";
  } else if (department && department !== rawDept) {
    flags.push(`department "${rawDept}" → ${department}`);
  }

  const rawOrg = clean(rec.organization);
  const organization = normalizeOrg(rawOrg);
  if (rawOrg && !organization) flags.push(`organization "${rawOrg}" is a placeholder → left blank`);
  else if (organization !== rawOrg) flags.push(`organization "${rawOrg}" → ${organization}`);

  const linkedin_match = clean(rec.linkedin_match);
  const linkedin_url = clean(rec.linkedin_url);
  if (linkedin_match === "nickname" && linkedin_url)
    flags.push("LinkedIn matched on a nickname — confirm it is the right person");
  if (linkedin_match === "ambiguous") flags.push("several LinkedIn connections share this name — left blank");

  /*
   * REL-032: the priority code is now the source of the tier, with GPT Priority as the fallback for a
   * row whose code is non-numeric (a disposition code carries no ranking). TIER_DEFAULT remains the
   * last resort. A later import file had no gpt_priority column at all, which is precisely why the
   * primary source had to move to the column that is actually kept up to date.
   */
  const resolvedTier = tier ?? TIER_FROM_PRIORITY[clean(rec.gpt_priority)] ?? TIER_DEFAULT;
  const meta = {
    priority_code: code || null,
    gpt_priority: clean(rec.gpt_priority) || null,
    score: clean(rec.score) || null,
    size: clean(rec.size) || null,
    level: clean(rec.level) || null,
    email_source: clean(rec.email_source) || null,
    phone_source: clean(rec.phone_source) || null,
    linkedin_match: linkedin_match || null,
    source_sheet: clean(rec.source_sheet) || null,
  };

  return {
    row: rowNum,
    full_name,
    title: clean(rec.title),
    organization,
    department,
    email_work: email(rec.email_work),
    email_personal: email(rec.email_personal),
    phone: clean(rec.phone),
    linkedin_url,
    linkedin_match,
    stage,
    priority_tier: resolvedTier,
    priority_code: code,
    meeting_date,
    meeting_time,
    next_follow_up,
    notes: clean(rec.comments),
    import_meta: JSON.stringify(meta),
    flags,
    errors,
  };
}

// ---------------------------------------------------------------- upload

const EXPECTED = [
  "full_name",
  "title",
  "organization",
  "department",
  "email_work",
  "email_personal",
  "phone",
  "linkedin_url",
  "linkedin_match",
  "priority_code",
  "comments",
  "gpt_priority",
  "score",
  "source_sheet",
];

app.get("/import", (c) =>
  c.html(
    layout({
      title: "Import Contacts",
      body: `<main>
  <h1>Import Contacts</h1>
  <p class="sub">Upload a CSV. Nothing is written until you review the preview and confirm.</p>
  <!--
    Phone note (UX-001, #56). The import WORKS on iOS — the file input opens
    the Files picker and the flow completes — but the preview is a wide table you are meant to read
    carefully before writing hundreds of contacts, and a CSV is rarely on the phone in the first place.
    Rather than hide the page on small screens or pretend the flow is pleasant, it says which machine
    this belongs on and stays fully usable if the answer is "do it here anyway".
  -->
  <p class="phone-only flash warn" style="margin-bottom:14px">Import is desk work. It runs on a phone, but the preview you are meant to check before writing is a wide table — do this one on a computer if you can.</p>
  <form class="card" method="post" action="/import/preview" enctype="multipart/form-data">
    <label>CSV file</label>
    <input type="file" name="file" accept=".csv,text/csv" required>
    <p class="meta" style="margin-top:10px">Expected columns (extra columns are ignored, missing ones are treated as blank):<br>
      <code>${EXPECTED.join(", ")}</code></p>
    <div class="actions"><button type="submit">Read File and Preview</button></div>
  </form>
  <section>
    <h2>Safe to retry</h2>
    <p class="meta" style="margin:0">Every row is checked against the database again at the moment it is written, not just when the preview is drawn. Re-running an import, or re-submitting a page after an interrupted one, cannot create duplicates — already-present contacts are skipped and counted. Uploading the same file twice is a safe way to finish a run that stopped partway.</p>
  </section>
  <section>
    <h2>What the import decides for you</h2>
    <ul class="meta" style="margin:0;padding-left:20px;line-height:1.7">
      <li><b>Stage.</b> A numeric Priority code is a <b>ranking, not a stage</b>, so <b>1–9 all import as Not Contacted</b> — the app should not claim you are mid-conversation with someone you have never contacted. The codes that describe a history keep their meaning: A-FRQ → Stay Connected, CMPL → Complete, GHST → No Response, RTRD → Retired, Pray → Pray, NA → Not Qualified. Anything else is flagged, not guessed. A date in Comments becomes a follow-up date, except on a finished stage — Complete, No Response, Retired and Not Qualified take no follow-up, and the row says so.</li>
      <li><b>A history code on a new contact is left unticked.</b> A row marked A-FRQ, CMPL, GHST, RTRD, Pray or NA describes a relationship you can only have if that person is already in here, so it usually means the duplicate check missed an existing record. The row is flagged and not selected — tick it yourself if it really is somebody new.</li>
      <li><b>Dates</b> are read from the leading <code>MM/DD</code> in Comments, as ${COMMENT_DATE_YEAR}. For code 1 that becomes the meeting date and time; for every other stage it becomes the next follow-up.</li>
      <li><b>Priority tier</b> comes from the Priority code — <b>1–4 keep their number, 5 and above become ${MAX_PRIORITY_TIER}</b>. A non-numeric code carries no ranking, so those fall back to GPT Priority (High → 2, Medium → 3) and then to ${TIER_DEFAULT}.</li>
      <li><b>Departments</b> import as themselves: ${DEPARTMENTS.map(([v]) => v).join(", ")}. Only naming variants are translated (Delivery/Consulting → Delivery); a value outside the list becomes Other and is flagged.</li>
      <li><b>Organizations</b> are normalized, and placeholders like TBD or Retired Partner are treated as no organization rather than becoming fake companies.</li>
      <li><b>The full Comments text</b> is kept in Notes — it holds your earlier touch history.</li>
    </ul>
  </section>
</main>`,
    })
  )
);

// ---------------------------------------------------------------- duplicate checking

interface DupInfo {
  reason: string;
  existing: { id: number; full_name: string; organization_name: string | null }[];
}

/** Snapshot check used to draw the preview. The authoritative check happens in existingContactId(). */
async function findDupes(db: D1Db, rows: StagedRow[]): Promise<Map<number, DupInfo>> {
  const out = new Map<number, DupInfo>();
  const { results } = await db
    .prepare(
      `SELECT c.id, c.full_name, c.email_work, c.email_personal, o.name AS organization_name
       FROM contact c LEFT JOIN organization o ON o.id = c.organization_id`
    )
    .all<Contact>();
  const byEmail = new Map<string, Contact[]>();
  const byNameOrg = new Map<string, Contact[]>();
  const push = (m: Map<string, Contact[]>, k: string, v: Contact) => {
    if (!k) return;
    const a = m.get(k) ?? [];
    a.push(v);
    m.set(k, a);
  };
  for (const e of results) {
    push(byEmail, (e.email_work ?? "").toLowerCase(), e);
    push(byEmail, (e.email_personal ?? "").toLowerCase(), e);
    push(byNameOrg, `${e.full_name.toLowerCase()}|${(e.organization_name ?? "").toLowerCase()}`, e);
  }
  // Duplicates within the file itself matter as much as collisions with the database.
  const seen = new Map<string, number>();
  for (const r of rows) {
    const hits: Contact[] = [];
    let reason = "";
    for (const e of [r.email_work, r.email_personal]) {
      if (e && byEmail.has(e)) {
        hits.push(...byEmail.get(e)!);
        reason = `email ${e} already exists`;
      }
    }
    const key = `${r.full_name.toLowerCase()}|${r.organization.toLowerCase()}`;
    if (!hits.length && byNameOrg.has(key)) {
      hits.push(...byNameOrg.get(key)!);
      reason = "same name and organization already exist";
    }
    if (hits.length) {
      out.set(r.row, {
        reason,
        existing: hits.map((h) => ({
          id: h.id,
          full_name: h.full_name,
          organization_name: h.organization_name ?? null,
        })),
      });
    } else if (seen.has(key)) {
      out.set(r.row, { reason: `duplicate of row ${seen.get(key)} in this file`, existing: [] });
    } else {
      seen.set(key, r.row);
    }
  }
  return out;
}

/**
 * The authoritative duplicate check (REL-018), rebuilt as a preloaded index (REL-030, 2026-08-20).
 *
 * WHY IT CHANGED. It used to run up to three awaited queries per row, immediately before each insert.
 * On a large file that is many thousands of sequential network round trips, and on one real import the
 * whole run died partway through — the loop was averaging over a second a row, so a big file needed
 * well over an hour. Nothing survives that: Cloudflare cancels a Worker's outstanding work once the
 * client disconnects, and the per-invocation subrequest cap (1,000 to internal services on the free
 * plan) is reached long before the end.
 *
 * WHAT IS PRESERVED, because it is the whole point of REL-018. The index is built at the start of
 * the COMMIT request, not when the preview rendered, so it still sees rows written moments earlier by
 * an interrupted run of this very import — which is the exact failure that created duplicates in an
 * earlier incident. And `add()` is called for every accepted row, so a row that duplicates an earlier
 * row *in the same file* is still caught; the per-row query got that for free by reading the database
 * it had just written to, and dropping it would have quietly reintroduced within-file duplicates.
 *
 * The matching rules are byte-for-byte the old SQL: either email colliding with either email column
 * on any existing contact, or lower(full_name) plus the same organization (NULL org treated as -1).
 */
interface DupIndex {
  has(r: StagedRow, orgId: number | null): boolean;
  add(r: StagedRow, orgId: number | null): void;
  size: number;
}

async function loadDupIndex(db: D1Db): Promise<DupIndex> {
  const emails = new Set<string>();
  const nameOrg = new Set<string>();
  const { results } = await db
    .prepare(
      `SELECT lower(ifnull(email_work,'')) AS e1, lower(ifnull(email_personal,'')) AS e2,
              lower(full_name) AS n, ifnull(organization_id,-1) AS o FROM contact`
    )
    .all<{ e1: string; e2: string; n: string; o: number }>();
  for (const row of results) {
    if (row.e1) emails.add(row.e1);
    if (row.e2) emails.add(row.e2);
    nameOrg.add(`${row.n}|${row.o}`);
  }
  const key = (r: StagedRow, orgId: number | null) =>
    `${r.full_name.toLowerCase()}|${orgId ?? -1}`;
  return {
    has(r, orgId) {
      for (const e of [r.email_work, r.email_personal])
        if (e && emails.has(e.toLowerCase())) return true;
      return nameOrg.has(key(r, orgId));
    },
    add(r, orgId) {
      for (const e of [r.email_work, r.email_personal]) if (e) emails.add(e.toLowerCase());
      nameOrg.add(key(r, orgId));
    },
    size: results.length,
  };
}

/**
 * Organization name → id for every organization, loaded in one query (REL-030). Replaces the three
 * queries per previously-unseen organization the commit loop used to run — a file with hundreds of new
 * organizations meant that many round trips on their own.
 */
async function loadOrgIndex(db: D1Db): Promise<Map<string, number>> {
  const { results } = await db
    .prepare("SELECT id, lower(name) AS k FROM organization")
    .all<{ id: number; k: string }>();
  return new Map(results.map((r) => [r.k, r.id]));
}

/**
 * How many statements go into one D1 batch. A batch is a single subrequest AND a single SQLite
 * transaction, so this trades round trips against blast radius: if one statement fails, D1 rolls the
 * whole batch back. 50 keeps even a large file to well under a hundred batches — well inside any cap
 * and a few seconds of wall clock — while keeping the fallback below cheap when a batch does fail.
 */
const INSERT_BATCH = 50;

/**
 * Runs a batch, and on failure retries its statements one at a time so a single bad row costs only
 * itself rather than the 49 good rows sharing its transaction. Returns how many statements succeeded.
 *
 * Without this fallback, batching would be a regression on partial-failure behaviour: the old loop
 * inserted row by row and lost exactly the offending row.
 */
export async function runBatch(db: D1Db, stmts: D1Stmt[]): Promise<{ ok: number; failed: number }> {
  if (!stmts.length) return { ok: 0, failed: 0 };
  try {
    await db.batch(stmts);
    return { ok: stmts.length, failed: 0 };
  } catch {
    let ok = 0;
    let failed = 0;
    for (const s of stmts) {
      try {
        await s.run();
        ok++;
      } catch {
        failed++;
      }
    }
    return { ok, failed };
  }
}

// ---------------------------------------------------------------- preview

const badge = (n: number, label: string, cls = "grey") =>
  `<span class="pill ${cls}" style="margin-right:6px">${n} ${esc(label)}</span>`;

app.post("/import/preview", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.redirect("/import");
  const text = await file.text();
  const grid = parseCsv(text);
  if (grid.length < 2)
    return c.html(
      layout({
        title: "Import Contacts",
        body: `<main><div class="flash warn">That file has no data rows.</div><p><a href="/import">Try another file</a></p></main>`,
      })
    );

  const header = grid[0].map((h) => h.trim().toLowerCase());
  const missing = EXPECTED.filter((e) => !header.includes(e));
  const rows = grid.slice(1).map((line, i) => {
    const rec: Record<string, string> = {};
    header.forEach((h, j) => (rec[h] = line[j] ?? ""));
    return stageRow(rec, i + 2);
  });
  const dupes = await findDupes(c.env.DB, rows);

  const importable = rows.filter((r) => !r.errors.length);
  const flagged = importable.filter((r) => r.flags.length);
  const stageCounts = new Map<string, number>();
  for (const r of importable) stageCounts.set(r.stage, (stageCounts.get(r.stage) ?? 0) + 1);

  const rowHtml = rows
    .map((r) => {
      const dup = dupes.get(r.row);
      const blocked = r.errors.length > 0;
      /*
       * REL-032: a disposition code on a new row is treated like a detected duplicate — unticked and
       * tinted, not disabled. The row is importable if the reviewer ticks it, because a genuinely new
       * finished-with contact must not be permanently unimportable; it just should not slip in by
       * default. The reason is already in r.flags and prints in the Notes column.
       */
      const alreadyLoaded = ALREADY_LOADED_CODES.has(
        String(r.priority_code ?? "").toUpperCase()
      );
      const checked = !blocked && !dup && !alreadyLoaded ? " checked" : "";
      return `<tr${blocked ? ' style="background:#fef2f2"' : dup || alreadyLoaded ? ' style="background:#fffbeb"' : ""}>
      <td><input type="checkbox" name="take" value="${r.row}"${checked}${blocked ? " disabled" : ""}></td>
      <td>${r.row}</td>
      <td><b>${esc(r.full_name || "(no name)")}</b>${r.title ? `<div class="meta">${esc(r.title)}</div>` : ""}</td>
      <td>${esc(r.organization || "—")}${r.department ? `<div class="meta">${esc(r.department)}</div>` : ""}</td>
      <td><span class="pill grey">${esc(stageLabel(r.stage))}</span>${
        r.meeting_date
          ? `<div class="meta">meets ${esc(r.meeting_date)}${r.meeting_time ? ` ${esc(r.meeting_time)}` : ""}</div>`
          : ""
      }${r.next_follow_up ? `<div class="meta">follow up ${esc(r.next_follow_up)}</div>` : ""}</td>
      <td>${esc(r.email_work || r.email_personal || "—")}</td>
      <td>${
        r.linkedin_url
          ? `<a href="${esc(r.linkedin_url)}" target="_blank" rel="noopener">profile</a> <span class="meta">${esc(r.linkedin_match)}</span>`
          : '<span class="meta">—</span>'
      }</td>
      <td>${
        blocked
          ? `<span class="pill red">${esc(r.errors.join("; "))}</span>`
          : `${
              dup
                ? `<span class="pill amber">${esc(dup.reason)}</span>${dup.existing
                    .map((e) => ` <a href="/contacts/${e.id}">${esc(e.full_name)}</a>`)
                    .join("")}<br>`
                : ""
            }${r.flags.map((f) => `<div class="meta">${esc(f)}</div>`).join("")}`
      }</td>
    </tr>`;
    })
    .join("");

  return c.html(
    layout({
      title: "Import Preview",
      body: `<main>
  <h1>Import Preview</h1>
  <p class="sub">${esc(file.name)} · nothing has been written yet</p>
  ${
    missing.length
      ? `<div class="flash warn">Missing expected column${missing.length > 1 ? "s" : ""}: <code>${esc(missing.join(", "))}</code>. Those fields will be blank.</div>`
      : ""
  }
  <section>
    <h2>Summary</h2>
    <p>${badge(rows.length, "rows read")}${badge(importable.length - dupes.size, "new contacts", "green")}${badge(
        dupes.size,
        "already present",
        "amber"
      )}${badge(rows.length - importable.length, "errors", rows.length - importable.length ? "red" : "grey")}${badge(
        flagged.length,
        "with notes to review"
      )}</p>
    <p class="meta">Stages: ${[...stageCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${esc(stageLabel(s))} ${n}`)
      .join(" · ")}</p>
    <p class="meta">Rows already in the database and error rows are unticked. Even if you tick one, it will be skipped at write time unless it is genuinely new — the check runs again per row as it is inserted.</p>
  </section>
  <form method="post" action="/import/commit">
    <input type="hidden" name="payload" value="${esc(JSON.stringify(rows))}">
    <input type="hidden" name="filename" value="${esc(file.name)}">
    <section>
      <div class="actions" style="margin-top:0">
        <button type="submit" name="mode" value="test">Import first ${TEST_SUBSET} ticked rows as a test</button>
        <button type="submit" name="mode" value="all" class="secondary">Import all ticked rows</button>
        <a class="btn secondary" href="/import">Cancel</a>
      </div>
      <p class="meta" style="margin-top:10px">Stay on this page until it finishes. If it is interrupted, simply upload the same file again — anything already written is detected and skipped.</p>
    </section>
    <table>
      <thead><tr><th>Import</th><th>Row</th><th>Name</th><th>Organization</th><th>Stage</th><th>Email</th><th>LinkedIn</th><th>Notes</th></tr></thead>
      <tbody>${rowHtml}</tbody>
    </table>
  </form>
</main>`,
    })
  );
});

// ---------------------------------------------------------------- commit

app.post("/import/commit", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const payload = typeof body.payload === "string" ? body.payload : "[]";
  const filename = typeof body.filename === "string" ? body.filename : "unknown.csv";
  const mode = body.mode === "test" ? "test" : "all";
  const takeRaw = body.take;
  const take = new Set(
    (Array.isArray(takeRaw) ? takeRaw : takeRaw === undefined ? [] : [takeRaw]).map((v) => Number(v))
  );

  let rows: StagedRow[] = [];
  try {
    rows = JSON.parse(payload) as StagedRow[];
  } catch {
    return c.redirect("/import");
  }
  let chosen = rows.filter((r) => take.has(r.row) && !r.errors?.length && r.full_name);
  if (mode === "test") chosen = chosen.slice(0, TEST_SUBSET);

  const source = mode === "test" ? "import-test" : "import";
  const correlation = `import-${Date.now()}`;
  let created = 0;
  let skipped = 0;
  let failed = 0;

  /*
   * REL-030, 2026-08-20. Three phases, each costing a handful of round trips instead of a few per
   * row. A large file that used to fail goes from many thousands of sequential queries and well over
   * an hour to well under a hundred queries and a few seconds. See loadDupIndex() for what this had
   * to preserve.
   */

  // Phase 1 — every organization, in one query. New ones inserted in batches, then re-read once so
  // the ids come from the database rather than from assuming AUTOINCREMENT ran contiguously.
  const orgIndex = await loadOrgIndex(c.env.DB);
  const wantedOrgs = new Map<string, string>();
  for (const r of chosen) {
    if (!r.organization) continue;
    const key = r.organization.toLowerCase();
    if (!orgIndex.has(key) && !wantedOrgs.has(key)) wantedOrgs.set(key, r.organization);
  }
  if (wantedOrgs.size) {
    const insertOrg = c.env.DB.prepare("INSERT INTO organization (name) VALUES (?)");
    const names = [...wantedOrgs.values()];
    for (let i = 0; i < names.length; i += INSERT_BATCH)
      await runBatch(
        c.env.DB,
        names.slice(i, i + INSERT_BATCH).map((n) => insertOrg.bind(n))
      );
    for (const [k, v] of await loadOrgIndex(c.env.DB)) orgIndex.set(k, v);
  }

  // Phase 2 — the duplicate index, read once, then kept current in memory as rows are accepted.
  const dupes = await loadDupIndex(c.env.DB);

  // Phase 3 — build every insert, then send them in batches.
  const insertContact = c.env.DB.prepare(
    `INSERT INTO contact (full_name, title, organization_id, department, email_work, email_personal, phone,
      linkedin_url, stage, priority_tier, next_follow_up, meeting_date, meeting_time, notes, import_meta,
      source, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active')`
  );
  const pending: D1Stmt[] = [];
  for (const r of chosen) {
    const orgId = r.organization ? (orgIndex.get(r.organization.toLowerCase()) ?? null) : null;

    // The check that actually protects the data (REL-018) — now against the preloaded index, which
    // was read at the start of THIS request and is updated for every row accepted below.
    if (dupes.has(r, orgId)) {
      skipped++;
      continue;
    }
    dupes.add(r, orgId);

    pending.push(
      insertContact.bind(
        r.full_name,
        r.title || null,
        orgId,
        r.department || null,
        r.email_work || null,
        r.email_personal || null,
        r.phone || null,
        r.linkedin_url || null,
        r.stage,
        r.priority_tier,
        r.next_follow_up,
        r.meeting_date,
        r.meeting_time,
        r.notes || null,
        r.import_meta || null,
        source
      )
    );
  }
  for (let i = 0; i < pending.length; i += INSERT_BATCH) {
    const res = await runBatch(c.env.DB, pending.slice(i, i + INSERT_BATCH));
    created += res.ok;
    failed += res.failed;
  }

  await c.env.DB.prepare(
    `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id)
     VALUES (?,?,?,?,?,?,?,?)`
  )
    .bind(
      ACTOR,
      "contact",
      "batch",
      "import",
      `${rows.length} rows read from ${filename}; ${chosen.length} selected`,
      `${created} created, ${skipped} skipped as already present${
        failed ? `, ${failed} FAILED to insert` : ""
      } (${mode === "test" ? `test subset, limit ${TEST_SUBSET}` : "full import"}; ${
        wantedOrgs.size
      } organizations created; ${dupes.size} existing contacts indexed)`,
      source,
      correlation
    )
    .run();

  return c.html(
    layout({
      title: "Import Complete",
      body: `<main>
  <div class="flash ok"><b>${created} contact${created === 1 ? "" : "s"} imported</b> from ${esc(filename)}${
        skipped ? `, and ${skipped} skipped because they were already in the database` : ""
      }${mode === "test" ? ` — test subset, capped at ${TEST_SUBSET}` : ""}.</div>
  <h1>Import Complete</h1>
  <p class="sub">Audit reference <code>${esc(correlation)}</code></p>
  <section>
    <p>Next: check the <a href="/">dashboard</a> — meetings read from the Comments dates should appear in section 1, and everything else should be distributed across sections 2 to 6 by stage.</p>
    <p class="meta">If fewer contacts arrived than you expected, the run may have been interrupted. Upload the same file again — already-imported contacts are skipped, so it is safe to repeat until the created count reaches zero.</p>
    <div class="actions">
      <a class="btn" href="/">Dashboard</a>
      <a class="btn secondary" href="/contacts">Browse contacts</a>
      <a class="btn secondary" href="/import">Import again</a>
    </div>
  </section>
</main>`,
    })
  );
});

export default app;
