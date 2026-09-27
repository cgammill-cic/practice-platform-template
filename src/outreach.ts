// Outreach: queue people, draft on demand or on a schedule, log what you send (Phase 2a, migration 0032).
//
// The owner, 2026-09-25: "Instead of automatically drafting messages, I would like to be able to tell it
// to run and draft the messages. I'd like to be able to either give it a list of people, or select the
// people that I want included from the Outreach Batch section... I would also like to be able to run an
// automatic run on a specific date, time, or sequence."
//
// THE LIFECYCLE OF AN ITEM: queued → drafted → logged (or skipped). "error" is a draft that failed; it
// can be retried. One active (queued or drafted) item per contact, enforced by the database.
//
// WHO RUNS A DRAFT, AND WHEN — never implicitly:
//   - "Draft now" on /outreach: the run takes every queued item due today or earlier. The browser then
//     asks for them one at a time (POST /outreach/run/:id/next), so a 20-person run never sits inside a
//     single long request and the page can show progress. If the tab is closed mid-run, the 5-minute
//     cron tick finishes the items that run already took, and nothing else.
//   - A schedule (once, or weekly every N weeks): the cron tick at its time takes the queued items that
//     are due and tops up to the schedule's number from the Outreach Batch, priority contacts first.
//
// NOTHING IS EVER SENT. Email drafts go into the owner's Outlook Drafts folder when that connection
// allows it (Mail.ReadWrite); everything is also on the page to copy. Logging uses the existing
// one-click outreach logging (/escalation/:id/attempt), so the ladder and the stage move exactly as
// they do for outreach logged any other way.
//
// Admin-only (auth.ts ADMIN_ONLY): it uses the owner's mailbox and the owner's API spend.

import { Hono, type Context } from "hono";
import { esc, layout, priorityBadge } from "./views";
import { actor } from "./auth";
import { currentZone, localToday } from "./weeks";
import { zoneLabel } from "./settings";
import { PRIORITY_FIRST_ORDER, type Bindings, type Contact, type D1Db, type Interaction } from "./types";
import {
  DraftError,
  costMicros,
  draftMessage,
  draftingConfigured,
  loadVoice,
  modelFor,
  saveVoice,
  type Voice,
} from "./drafting";
import { canSaveDrafts, createOutlookDraft, msConnection, updateOutlookDraft } from "./msgraph";
import { plusBusinessDays, routesFor, suggestNext } from "./escalation";
import { ATTEMPT_SQL } from "./attempts";

const app = new Hono<{ Bindings: Bindings }>();
type C = Context<{ Bindings: Bindings }>;

export const OUTREACH_CRON = "*/5 * * * *";
const MAX_PER_RUN = 50;
const CLAIM_MINUTES = 5;
const SPEND_CAP_KEY = "outreach_monthly_cap_usd";
const DEFAULT_CAP_USD = 25;

/**
 * THE OUTREACH BATCH RULE, shared with the dashboard's section 5 so "top up from the Outreach Batch"
 * means exactly the people that section shows: backlog contacts (Not Contacted, Reach Out Later) whose
 * deferral date, if any, has arrived; priority contacts first, then tier, then name.
 */
export const BATCH_CONDITION = `c.stage IN ('not_contacted','reach_out_later')
       AND (c.next_follow_up IS NULL OR c.next_follow_up <= date('now'))`;
export const BATCH_ORDER = `${PRIORITY_FIRST_ORDER}, (c.priority_tier IS NULL), c.priority_tier, c.full_name`;

// ---------------------------------------------------------------- small helpers

const sqlNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(micros < 10_000_000 ? 2 : 0)}`;

async function audit(db: D1Db, entityId: string, action: string, after: string, before?: string | null) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,'outreach',?,?,?,?,'app',?)"
    )
    .bind(actor(), entityId, action, before ?? null, after.slice(0, 500), `outreach-${entityId}`)
    .run();
}

// ---------------------------------------------------------------- time zone (schedules are Central)

/** Offset of `zone` from UTC at instant `t`, in ms (Central is -5h or -6h). */
function zoneOffset(t: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** A wall-clock date and time in `zone` → the UTC instant (ms). Two passes settle a DST boundary. */
export function zonedToUtc(date: string, time: string, zone: string = currentZone()): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - zoneOffset(guess, zone);
  t = guess - zoneOffset(t, zone);
  return t;
}

const toSql = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ");
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const sundayOf = (date: string) => addDays(date, -weekday(date));

export interface ScheduleRow {
  id: number;
  name: string;
  kind: "once" | "weekly";
  run_on_local: string | null;
  days_of_week: string | null;
  time_local: string;
  every_n_weeks: number;
  top_up_to: number;
  active: number;
  anchor_date: string | null;
  next_run_utc: string | null;
  last_run_at: string | null;
  last_result: string | null;
}

/**
 * The next time a schedule should fire strictly after `afterMs`, as SQLite UTC text, or null. Weekly
 * schedules count weeks from anchor_date (the Sunday of the week they were created), so "every 2 weeks"
 * keeps its rhythm however late a tick runs.
 */
export function nextRunUtc(s: Pick<ScheduleRow, "kind" | "run_on_local" | "days_of_week" | "time_local" | "every_n_weeks" | "anchor_date">, afterMs: number): string | null {
  if (s.kind === "once") {
    if (!s.run_on_local) return null;
    const t = zonedToUtc(s.run_on_local, s.time_local);
    return t > afterMs ? toSql(t) : null;
  }
  const days = new Set((s.days_of_week ?? "").split(",").filter(Boolean).map(Number));
  if (!days.size) return null;
  const n = Math.max(1, s.every_n_weeks || 1);
  const anchor = s.anchor_date ?? sundayOf(localToday(new Date(afterMs)));
  let d = localToday(new Date(afterMs));
  for (let i = 0; i < 7 * n + 8; i++, d = addDays(d, 1)) {
    if (!days.has(weekday(d))) continue;
    const weeks = Math.round((Date.parse(sundayOf(d)) - Date.parse(anchor)) / (7 * 86_400_000));
    if (weeks < 0 || weeks % n !== 0) continue;
    const t = zonedToUtc(d, s.time_local);
    if (t > afterMs) return toSql(t);
  }
  return null;
}

/** "Mon 29 Sep, 07:15 Central" from SQLite UTC text. */
export function fmtLocal(utc: string | null): string {
  if (!utc) return "—";
  const d = new Date(`${utc.replace(" ", "T")}Z`);
  return `${new Intl.DateTimeFormat("en-US", { timeZone: currentZone(), weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)} ${zoneLabel()}`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function describeSchedule(s: ScheduleRow): string {
  const who = s.top_up_to ? `queued people, topped up to ${s.top_up_to}` : "queued people only";
  if (s.kind === "once") return `Once on ${s.run_on_local} at ${s.time_local} · ${who}`;
  const days = (s.days_of_week ?? "").split(",").filter(Boolean).map((d) => DAY_NAMES[+d]).join(", ");
  return `${s.every_n_weeks > 1 ? `Every ${s.every_n_weeks} weeks` : "Every week"} on ${days} at ${s.time_local} · ${who}`;
}

// ---------------------------------------------------------------- queue

export interface ItemRow {
  id: number;
  contact_id: number;
  for_date: string;
  sequence_step: number;
  parent_item_id: number | null;
  sequence_stopped: number;
  source: string;
  kind: string;
  status: string;
  channel: string | null;
  draft_to: string | null;
  draft_subject: string | null;
  draft_body: string | null;
  instructions: string | null;
  outlook_draft_id: string | null;
  outlook_web_link: string | null;
  outlook_error: string | null;
  error: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  run_id: number | null;
  created_at: string;
  drafted_at: string | null;
  // joined
  full_name: string;
  is_priority: number;
  organization_name: string | null;
  linkedin_url: string | null;
  email_work: string | null;
  email_personal: string | null;
}

const ITEM_SELECT = `SELECT i.*, c.full_name, c.is_priority, c.linkedin_url, c.email_work, c.email_personal, o.name AS organization_name
  FROM outreach_item i JOIN contact c ON c.id = i.contact_id LEFT JOIN organization o ON o.id = c.organization_id`;

/** Contact id → active item status, for the dashboard toggles and the contact header. */
export async function activeOutreach(db: D1Db): Promise<Map<number, string>> {
  try {
    const { results } = await db
      .prepare("SELECT contact_id, status FROM outreach_item WHERE status IN ('queued','drafted')")
      .all<{ contact_id: number; status: string }>();
    return new Map(results.map((r) => [r.contact_id, r.status]));
  } catch {
    return new Map(); // table not migrated yet: no toggles, nothing breaks
  }
}

/** Queue one contact. False when they're already queued or drafted (the partial unique index). */
export async function queueContact(db: D1Db, contactId: number, source: string, forDate: string, runId: number | null = null): Promise<boolean> {
  const res = await db
    .prepare("INSERT OR IGNORE INTO outreach_item (contact_id, for_date, source, created_by, run_id) VALUES (?,?,?,?,?)")
    .bind(contactId, forDate, source, actor(), runId)
    .run();
  const added = (res.meta?.changes ?? 0) > 0;
  if (added) await audit(db, String(contactId), "create", `queued for outreach (${source}) for ${forDate}`);
  return added;
}

async function unqueueContact(db: D1Db, contactId: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE outreach_item SET status = 'skipped' WHERE contact_id = ? AND status = 'queued'")
    .bind(contactId)
    .run();
  const removed = (res.meta?.changes ?? 0) > 0;
  if (removed) await audit(db, String(contactId), "update", "removed from the outreach queue");
  return removed;
}

// ---------------------------------------------------------------- spend

async function capMicros(db: D1Db): Promise<number> {
  const row = await db.prepare("SELECT value FROM app_setting WHERE key = ?").bind(SPEND_CAP_KEY).first<{ value: string }>().catch(() => null);
  const usd = row ? Number(row.value) : DEFAULT_CAP_USD;
  return Math.round((Number.isFinite(usd) && usd >= 0 ? usd : DEFAULT_CAP_USD) * 1_000_000);
}

/** Estimated spend this calendar month (UTC), from the runs' own totals. */
async function monthSpendMicros(db: D1Db): Promise<number> {
  const r = await db
    .prepare("SELECT COALESCE(SUM(cost_micros),0) AS s FROM outreach_run WHERE started_at >= strftime('%Y-%m-01','now')")
    .first<{ s: number }>();
  return r?.s ?? 0;
}

// ---------------------------------------------------------------- drafting one item

async function startRun(db: D1Db, trigger: "manual" | "schedule" | "sequence", scheduleId: number | null): Promise<number> {
  const res = await db
    .prepare("INSERT INTO outreach_run (trigger, schedule_id, started_by) VALUES (?,?,?)")
    .bind(trigger, scheduleId, actor())
    .run();
  return Number(res.meta?.last_row_id ?? 0);
}

/** Give the run every queued item due today or earlier (not already taken by a live run), up to the cap. */
async function assignDue(db: D1Db, runId: number, today: string, limit = MAX_PER_RUN): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE outreach_item SET run_id = ?
       WHERE id IN (SELECT id FROM outreach_item WHERE status = 'queued' AND for_date <= ?
                    AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM outreach_run WHERE status = 'running'))
                    ORDER BY for_date, id LIMIT ?)`
    )
    .bind(runId, today, limit)
    .run();
  return res.meta?.changes ?? 0;
}

/** Take the next item in this run that no other worker holds. Null when the run has nothing left. */
async function claimNext(db: D1Db, runId: number): Promise<number | null> {
  const cutoff = toSql(Date.now() - CLAIM_MINUTES * 60_000);
  const row = await db
    .prepare(
      `UPDATE outreach_item SET claimed_at = ?
       WHERE id = (SELECT id FROM outreach_item WHERE run_id = ? AND status = 'queued'
                   AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY id LIMIT 1)
       RETURNING id`
    )
    .bind(sqlNow(), runId, cutoff)
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function finishRunIfDone(db: D1Db, runId: number) {
  const left = await db
    .prepare("SELECT COUNT(*) AS n FROM outreach_item WHERE run_id = ? AND status = 'queued'")
    .bind(runId)
    .first<{ n: number }>();
  if ((left?.n ?? 0) > 0) return;
  await db
    .prepare(
      `UPDATE outreach_run SET finished_at = datetime('now'),
         status = CASE WHEN status <> 'running' THEN status WHEN errors = 0 THEN 'done' WHEN drafted = 0 THEN 'failed' ELSE 'partial' END
       WHERE id = ? AND finished_at IS NULL`
    )
    .bind(runId)
    .run();
}

function channelFor(c: Pick<Contact, "email_work" | "email_personal" | "linkedin_url">): { channel: "email" | "linkedin"; to: string | null } {
  const email = c.email_work?.trim() || c.email_personal?.trim() || null;
  return email ? { channel: "email", to: email } : { channel: "linkedin", to: c.linkedin_url ?? null };
}

/**
 * Draft one claimed item: build the brief from the record, call Claude, store the text, and for email
 * save it to Outlook Drafts when allowed. Errors land on the item, never on the run as a whole.
 */
export async function draftItem(env: Bindings, itemId: number, voice?: Voice): Promise<"drafted" | "error" | "capped"> {
  const db = env.DB;
  const item = await db.prepare("SELECT * FROM outreach_item WHERE id = ?").bind(itemId).first<ItemRow>();
  if (!item) return "error";
  if ((await monthSpendMicros(db)) >= (await capMicros(db))) {
    await db.prepare("UPDATE outreach_item SET claimed_at = NULL WHERE id = ?").bind(itemId).run();
    if (item.run_id) await db.prepare("UPDATE outreach_run SET status = 'skipped', detail = 'Monthly spend cap reached.' WHERE id = ? AND status = 'running'").bind(item.run_id).run();
    return "capped";
  }
  const contact = await db
    .prepare("SELECT c.*, o.name AS organization_name FROM contact c LEFT JOIN organization o ON o.id = c.organization_id WHERE c.id = ?")
    .bind(item.contact_id)
    .first<Contact & { organization_name: string | null }>();
  if (!contact) return "error";
  const { results: interactions } = await db
    .prepare("SELECT date, type, direction, subject, summary FROM interaction WHERE contact_id = ? ORDER BY date DESC, id DESC LIMIT 5")
    .bind(item.contact_id)
    .all<Pick<Interaction, "date" | "type" | "direction" | "subject" | "summary">>();
  const referredBy = contact.referral_source_contact_id
    ? (await db.prepare("SELECT full_name FROM contact WHERE id = ?").bind(contact.referral_source_contact_id).first<{ full_name: string }>())?.full_name
    : null;
  // A follow-up arrives with its channel already chosen by the ladder (sequenceChannel); honour it
  // when the route exists. Anything else picks email-if-possible as before.
  const email = contact.email_work?.trim() || contact.email_personal?.trim() || null;
  const { channel, to } =
    item.channel === "linkedin" && contact.linkedin_url
      ? { channel: "linkedin" as const, to: contact.linkedin_url }
      : item.channel === "email" && email
        ? { channel: "email" as const, to: email }
        : channelFor(contact);
  // What was already sent in this outreach, so a follow-up doesn't repeat it.
  const previousMessages =
    item.kind === "follow_up" && item.parent_item_id
      ? (
          await db
            .prepare(
              "SELECT draft_body FROM outreach_item WHERE (id = ? OR parent_item_id = ?) AND status = 'logged' AND draft_body IS NOT NULL ORDER BY sequence_step"
            )
            .bind(item.parent_item_id, item.parent_item_id)
            .all<{ draft_body: string }>()
        ).results.map((r) => r.draft_body)
      : [];

  try {
    const r = await draftMessage(env, {
      contact,
      referredBy,
      interactions,
      channel,
      kind: item.kind === "follow_up" ? "follow_up" : "first_touch",
      previousMessages,
      instructions: item.instructions,
      voice: voice ?? (await loadVoice(db)),
      today: localToday(),
    });
    const cost = costMicros(r.model, r.usage);
    await db
      .prepare(
        `UPDATE outreach_item SET status = 'drafted', channel = ?, draft_to = ?, draft_subject = ?, draft_body = ?, error = NULL,
           model = ?, input_tokens = ?, output_tokens = ?, drafted_at = datetime('now'), claimed_at = NULL
         WHERE id = ?`
      )
      .bind(channel, to, r.subject, r.body, r.model, r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens, r.usage.output_tokens, itemId)
      .run();
    if (item.run_id)
      await db
        .prepare("UPDATE outreach_run SET drafted = drafted + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_micros = cost_micros + ? WHERE id = ?")
        .bind(r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens, r.usage.output_tokens, cost, item.run_id)
        .run();
    if (channel === "email" && to) await syncOutlookDraft(env, itemId);
    return "drafted";
  } catch (e) {
    const msg = e instanceof DraftError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
    await db.prepare("UPDATE outreach_item SET status = 'error', error = ?, claimed_at = NULL WHERE id = ?").bind(msg.slice(0, 300), itemId).run();
    if (item.run_id) await db.prepare("UPDATE outreach_run SET errors = errors + 1, detail = ? WHERE id = ?").bind(msg.slice(0, 300), item.run_id).run();
    return "error";
  }
}

/** Create or update the Outlook draft for an email item. Failure is recorded on the item, not thrown. */
async function syncOutlookDraft(env: Bindings, itemId: number): Promise<void> {
  const db = env.DB;
  const it = await db.prepare("SELECT * FROM outreach_item WHERE id = ?").bind(itemId).first<ItemRow>();
  if (!it || it.channel !== "email" || !it.draft_to || !it.draft_body) return;
  const msg = { to: it.draft_to, subject: it.draft_subject ?? "", body: it.draft_body };
  const res = it.outlook_draft_id ? await updateOutlookDraft(env, db, it.outlook_draft_id, msg) : await createOutlookDraft(env, db, msg);
  if ("error" in res) {
    await db.prepare("UPDATE outreach_item SET outlook_error = ? WHERE id = ?").bind(res.error.slice(0, 300), itemId).run();
  } else {
    await db
      .prepare("UPDATE outreach_item SET outlook_draft_id = ?, outlook_web_link = COALESCE(?, outlook_web_link), outlook_error = NULL WHERE id = ?")
      .bind(res.id, res.webLink, itemId)
      .run();
  }
}

/** Work a run to the end, `concurrency` drafts at a time. Used by schedules and the cron's resume. */
async function workRun(env: Bindings, runId: number, concurrency = 4): Promise<void> {
  const voice = await loadVoice(env.DB);
  let capped = false;
  const worker = async () => {
    while (!capped) {
      const id = await claimNext(env.DB, runId);
      if (id === null) return;
      if ((await draftItem(env, id, voice)) === "capped") capped = true;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  await finishRunIfDone(env.DB, runId);
}

// ---------------------------------------------------------------- follow-up sequences (Phase 2b)

/*
 * After a first message is LOGGED AS SENT, a follow-up is drafted N business days later if nothing has
 * come back. Default steps 5 and 12 (business days after the first touch was logged), a setting on the
 * Outreach page; blank turns follow-ups off. Nothing sends: a follow-up is a draft on /outreach (and in
 * Outlook for email) like any other.
 *
 * A SEQUENCE STOPS, without anyone having to remember to stop it, when:
 *   - they reply: an inbound interaction, or a two-way one that isn't a meeting (the analytics.ts reply
 *     rule), dated on or after the day the first touch was logged;
 *   - they leave Awaiting Response (a meeting got booked, the owner moved them, anything);
 *   - the last step has been drafted;
 *   - a follow-up is skipped, or Stop Follow-ups is clicked (sequence_stopped, migration 0033).
 * And it WAITS while a follow-up is drafted but not yet logged: the next step never lands on top of an
 * unsent one.
 */
export const STEPS_KEY = "outreach_followup_steps";
const SEQ_LAST_KEY = "outreach_sequence_last";
const SEQ_TIME_LOCAL = "06:30";
const DEFAULT_STEPS = [5, 12];

export async function followUpSteps(db: D1Db): Promise<number[]> {
  const row = await db.prepare("SELECT value FROM app_setting WHERE key = ?").bind(STEPS_KEY).first<{ value: string }>().catch(() => null);
  return row ? parseSteps(row.value) : DEFAULT_STEPS;
}

/** "5, 12" → [5, 12]. Whole business days 1–60, ascending, unique, at most 4. Anything else is dropped. */
export function parseSteps(s: string): number[] {
  const n = [...new Set(s.split(/[\s,]+/).filter(Boolean).map(Number).filter((x) => Number.isInteger(x) && x >= 1 && x <= 60))];
  return n.sort((a, b) => a - b).slice(0, 4);
}

const REPLY_SQL = `(i.direction = 'inbound' OR (i.direction = 'two_way' AND i.type <> 'meeting'))`;

export interface SequenceRow {
  parent_id: number;
  contact_id: number;
  full_name: string;
  is_priority: number;
  first_channel: string | null;
  logged_on: string;
  last_step: number | null;
  last_status: string | null;
  email_work: string | null;
  email_personal: string | null;
  phone: string | null;
  linkedin_url: string | null;
  no_linkedin: number | null;
  // computed
  next_step: number;
  due: string;
  waiting: boolean;
}

/**
 * Every live sequence and its next step. Live = first touch logged, not stopped, contact still
 * Awaiting Response, no reply since, and steps left. `waiting` = a follow-up is drafted but not sent.
 */
export async function liveSequences(db: D1Db, steps: number[]): Promise<SequenceRow[]> {
  if (!steps.length) return [];
  const { results } = await db
    .prepare(
      `SELECT p.id AS parent_id, p.contact_id, c.full_name, c.is_priority, p.channel AS first_channel, date(p.logged_at) AS logged_on,
         (SELECT MAX(f.sequence_step) FROM outreach_item f WHERE f.parent_item_id = p.id AND f.status <> 'error') AS last_step,
         (SELECT f.status FROM outreach_item f WHERE f.parent_item_id = p.id ORDER BY f.sequence_step DESC, f.id DESC LIMIT 1) AS last_status,
         c.email_work, c.email_personal, c.phone, c.linkedin_url, c.no_linkedin
       FROM outreach_item p JOIN contact c ON c.id = p.contact_id
       WHERE p.kind = 'first_touch' AND p.status = 'logged' AND p.sequence_stopped = 0 AND p.logged_at IS NOT NULL
         AND c.status = 'active' AND c.stage = 'awaiting_response'
         AND NOT EXISTS (SELECT 1 FROM interaction i WHERE i.contact_id = p.contact_id AND i.date >= date(p.logged_at) AND ${REPLY_SQL})
         AND p.id = (SELECT MAX(p2.id) FROM outreach_item p2 WHERE p2.contact_id = p.contact_id AND p2.kind = 'first_touch' AND p2.status = 'logged')
       ORDER BY c.is_priority DESC, p.logged_at`
    )
    .all<Omit<SequenceRow, "next_step" | "due" | "waiting">>();
  const out: SequenceRow[] = [];
  for (const r of results) {
    const next = (r.last_step ?? 0) + 1;
    if (next > steps.length) continue;
    out.push({
      ...r,
      next_step: next,
      due: plusBusinessDays(r.logged_on, steps[next - 1]),
      waiting: r.last_status === "queued" || r.last_status === "drafted" || r.last_status === "error",
    });
  }
  return out;
}

/** The ladder's next channel, limited to what can be drafted (email, LinkedIn). */
async function sequenceChannel(db: D1Db, s: SequenceRow): Promise<"email" | "linkedin"> {
  const a = await db
    .prepare(
      `SELECT COUNT(*) AS attempts, (SELECT group_concat(t, ', ') FROM (SELECT DISTINCT i.type AS t FROM interaction i WHERE i.contact_id = ? AND ${ATTEMPT_SQL} ORDER BY i.type)) AS tried
       FROM interaction i WHERE i.contact_id = ? AND ${ATTEMPT_SQL}`
    )
    .bind(s.contact_id, s.contact_id)
    .first<{ attempts: number; tried: string | null }>();
  const sug = suggestNext(a?.attempts ?? 0, a?.tried ?? null, routesFor(s));
  const ch = sug.kind === "none" ? null : sug.rung.channel;
  if (ch === "email" || ch === "linkedin") return ch;
  return s.first_channel === "linkedin" ? "linkedin" : "email";
}

/**
 * Once a day (6:30 Central, from the tick): create and draft the follow-ups that are due. A skipped
 * follow-up stops its sequence here, so "Skip" means "leave this person alone", not "try again later".
 */
export async function runSequences(env: Bindings, today = localToday()): Promise<number> {
  const db = env.DB;
  const steps = await followUpSteps(db);
  if (!steps.length) return 0;
  await db
    .prepare(
      `UPDATE outreach_item SET sequence_stopped = 1 WHERE kind = 'first_touch' AND sequence_stopped = 0
         AND id IN (SELECT parent_item_id FROM outreach_item WHERE kind = 'follow_up' AND status = 'skipped')`
    )
    .run();
  const due = (await liveSequences(db, steps)).filter((s) => !s.waiting && s.due <= today);
  if (!due.length) return 0;
  const runId = await startRun(db, "sequence", null);
  let created = 0;
  for (const s of due) {
    const channel = await sequenceChannel(db, s);
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO outreach_item (contact_id, for_date, source, kind, sequence_step, parent_item_id, channel, created_by, run_id)
         VALUES (?,?,'sequence','follow_up',?,?,?,?,?)`
      )
      .bind(s.contact_id, today, s.next_step, s.parent_id, channel, actor(), runId)
      .run();
    if ((res.meta?.changes ?? 0) > 0) {
      created++;
      await audit(db, String(s.contact_id), "create", `follow-up ${s.next_step} of ${steps.length} queued (${channel}), no reply since ${s.logged_on}`);
    }
  }
  if (!created) {
    await db.prepare("UPDATE outreach_run SET status = 'done', finished_at = datetime('now'), detail = 'Nothing new to follow up.' WHERE id = ?").bind(runId).run();
    return 0;
  }
  await workRun(env, runId);
  return created;
}

/** Stop follow-ups for a contact: every first touch of theirs, and any follow-up not yet sent. */
async function stopFollowUps(db: D1Db, contactId: number): Promise<number> {
  const res = await db
    .prepare("UPDATE outreach_item SET sequence_stopped = 1 WHERE contact_id = ? AND kind = 'first_touch' AND sequence_stopped = 0")
    .bind(contactId)
    .run();
  await db
    .prepare("UPDATE outreach_item SET status = 'skipped' WHERE contact_id = ? AND kind = 'follow_up' AND status IN ('queued','drafted','error')")
    .bind(contactId)
    .run();
  const n = res.meta?.changes ?? 0;
  if (n) await audit(db, String(contactId), "update", "follow-ups stopped");
  return n;
}

/** For the contact header: is there a live sequence to stop? */
export async function hasLiveSequence(db: D1Db, contactId: number): Promise<boolean> {
  try {
    const steps = await followUpSteps(db);
    return (await liveSequences(db, steps)).some((s) => s.contact_id === contactId);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the cron tick

/**
 * Every 5 minutes (OUTREACH_CRON). Runs as "system" (index.ts scheduled()). Two jobs:
 *   1. Schedules that are due: queued items due today or earlier, topped up to the schedule's number
 *      from the Outreach Batch, drafted; then the schedule's next time is computed (a Once turns off).
 *   2. Manual runs whose browser went away: items a run already took, untouched for 5 minutes, are
 *      finished here. Nothing that wasn't already in a run is ever drafted by this path.
 * Without an API key it does nothing at all.
 */
export async function runOutreachTick(env: Bindings, now = Date.now()): Promise<void> {
  if (!draftingConfigured(env)) return;
  const db = env.DB;
  const nowSql = toSql(now);
  const today = localToday(new Date(now));
  const { results: due } = await db
    .prepare("SELECT * FROM outreach_schedule WHERE active = 1 AND next_run_utc IS NOT NULL AND next_run_utc <= ? ORDER BY next_run_utc")
    .bind(nowSql)
    .all<ScheduleRow>();
  for (const s of due) {
    // Advance first, so a slow or failed run can never fire the same schedule twice.
    // A Once has fired: it's done, whatever the clock says.
    const next = s.kind === "once" ? null : nextRunUtc(s, now);
    await db
      .prepare("UPDATE outreach_schedule SET next_run_utc = ?, active = CASE WHEN ? IS NULL THEN 0 ELSE active END, last_run_at = ? WHERE id = ?")
      .bind(next, next, nowSql, s.id)
      .run();
    const runId = await startRun(db, "schedule", s.id);
    let assigned = await assignDue(db, runId, today);
    let topped = 0;
    if (s.top_up_to > assigned) {
      const { results: extra } = await db
        .prepare(
          `SELECT c.id FROM contact c WHERE c.status = 'active' AND ${BATCH_CONDITION}
             AND c.id NOT IN (SELECT contact_id FROM outreach_item WHERE status IN ('queued','drafted'))
           ORDER BY ${BATCH_ORDER} LIMIT ?`
        )
        .bind(Math.min(s.top_up_to, MAX_PER_RUN) - assigned)
        .all<{ id: number }>();
      for (const r of extra) if (await queueContact(db, r.id, "schedule", today, runId)) topped++;
      assigned += topped;
    }
    if (!assigned) {
      await db.prepare("UPDATE outreach_run SET status = 'done', finished_at = datetime('now'), detail = 'Nobody queued or due.' WHERE id = ?").bind(runId).run();
      await db.prepare("UPDATE outreach_schedule SET last_result = ? WHERE id = ?").bind("Nobody to draft for.", s.id).run();
      continue;
    }
    await workRun(env, runId);
    const r = await db.prepare("SELECT drafted, errors, status, detail FROM outreach_run WHERE id = ?").bind(runId).first<{ drafted: number; errors: number; status: string; detail: string | null }>();
    const result =
      r?.status === "skipped"
        ? "Stopped: monthly spend cap reached."
        : `${r?.drafted ?? 0} drafted${topped ? ` (${topped} added from the Outreach Batch)` : ""}${r?.errors ? `, ${r.errors} failed` : ""}.`;
    await db.prepare("UPDATE outreach_schedule SET last_result = ? WHERE id = ?").bind(result, s.id).run();
  }

  // Follow-up sequences: once a day, from 6:30 Central (before the 6am-ish digest would be too early
  // on DST days, so the digest reports yesterday's follow-ups and the page has today's).
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: currentZone(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(now));
  if (hm >= SEQ_TIME_LOCAL) {
    const last = await db.prepare("SELECT value FROM app_setting WHERE key = ?").bind(SEQ_LAST_KEY).first<{ value: string }>();
    if (last?.value !== today) {
      // Mark first, so a slow run can never start twice in one day.
      await db
        .prepare(
          `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
        )
        .bind(SEQ_LAST_KEY, today)
        .run();
      await runSequences(env, today);
    }
  }

  // Resume manual runs whose browser stopped asking.
  const stale = toSql(now - CLAIM_MINUTES * 60_000);
  const { results: stalled } = await db
    .prepare(
      `SELECT r.id FROM outreach_run r WHERE r.status = 'running' AND r.started_at < ?
         AND EXISTS (SELECT 1 FROM outreach_item i WHERE i.run_id = r.id AND i.status = 'queued')
         AND NOT EXISTS (SELECT 1 FROM outreach_item i WHERE i.run_id = r.id AND i.claimed_at >= ?)`
    )
    .bind(stale, stale)
    .all<{ id: number }>();
  for (const r of stalled) await workRun(env, r.id);
}

// ---------------------------------------------------------------- paste-a-list matching

interface MatchRow {
  id: number;
  full_name: string;
  email_work: string | null;
  email_personal: string | null;
  organization_name: string | null;
  stage: string;
}
export interface LineMatch {
  line: string;
  matches: MatchRow[];
  by: "email" | "name" | "none";
}

const normName = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * One line per person: an email address anywhere in the line matches either email column exactly;
 * otherwise the line (minus anything after a comma, tab or " - ") must equal a contact's full name,
 * ignoring case and spacing. Nothing fuzzier: names are not keys (bulkupdate.ts), and a wrong match
 * here means a message drafted to the wrong person.
 */
export async function matchLines(db: D1Db, text: string): Promise<LineMatch[]> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
  if (!lines.length) return [];
  const { results } = await db
    .prepare(
      `SELECT c.id, c.full_name, c.email_work, c.email_personal, c.stage, o.name AS organization_name
       FROM contact c LEFT JOIN organization o ON o.id = c.organization_id WHERE c.status = 'active'`
    )
    .all<MatchRow>();
  const byEmail = new Map<string, MatchRow[]>();
  const byName = new Map<string, MatchRow[]>();
  const push = (m: Map<string, MatchRow[]>, k: string, r: MatchRow) => m.set(k, [...(m.get(k) ?? []), r]);
  for (const r of results) {
    for (const e of [r.email_work, r.email_personal]) if (e?.trim()) push(byEmail, e.trim().toLowerCase(), r);
    push(byName, normName(r.full_name), r);
  }
  return lines.map((line) => {
    const email = /[^\s<>,;()"']+@[^\s<>,;()"']+\.[^\s<>,;()"']+/.exec(line)?.[0]?.toLowerCase();
    if (email) {
      const m = byEmail.get(email) ?? [];
      return { line, matches: m, by: m.length ? "email" : "none" };
    }
    const name = normName(line.split(/\t|,| - | \| /)[0]);
    const m = byName.get(name) ?? [];
    return { line, matches: m, by: m.length ? "name" : "none" };
  });
}

// ---------------------------------------------------------------- page

const FLASH: Record<string, [string, "ok" | "warn"]> = {
  queued: ["Added to the outreach queue.", "ok"],
  unqueued: ["Removed from the queue.", "ok"],
  already: ["Already queued or drafted.", "warn"],
  added: ["Added to the queue.", "ok"],
  none: ["Nobody was selected.", "warn"],
  nodue: ["Nobody is queued for today or earlier.", "warn"],
  drafted: ["Drafting finished. Review the drafts below.", "ok"],
  saved: ["Draft saved.", "ok"],
  redrafted: ["Redrafted.", "ok"],
  skipped: ["Skipped. They're back in the Outreach Batch.", "ok"],
  logged: ["Logged as sent.", "ok"],
  sched: ["Schedule saved.", "ok"],
  schedbad: ["That schedule wasn't valid: check the date, time and days.", "warn"],
  schedpast: ["That date and time has already passed.", "warn"],
  schedoff: ["Schedule turned off.", "ok"],
  schedon: ["Schedule turned on.", "ok"],
  voice: ["Voice, follow-up and spend settings saved.", "ok"],
  stopped: ["Follow-ups stopped for them.", "ok"],
  capped: ["Stopped: this month's spend cap has been reached. Raise it under Voice & limits to continue.", "warn"],
  nokey: ["Drafting isn't set up yet: add the ANTHROPIC_API_KEY secret first.", "warn"],
  outlook: ["Saved to Outlook Drafts.", "ok"],
  outlookfail: ["Outlook didn't accept the draft. The reason is on the card.", "warn"],
};

function queueRow(i: ItemRow, today: string): string {
  const held = i.for_date > today;
  const ch = channelFor(i);
  return `<div class="listrow">
    <div class="listrow-main">
      <div class="listrow-name"><a href="/contacts/${i.contact_id}">${esc(i.full_name)}</a> ${priorityBadge(i)}</div>
      <div class="meta">${esc(i.organization_name ?? "")}${i.organization_name ? " · " : ""}${ch.channel === "email" ? "email" : ch.to ? "LinkedIn" : "LinkedIn (no profile on file)"} · added from ${esc(i.source)}${
        held ? ` · <b>held for ${esc(i.for_date)}</b>` : ""
      }${i.status === "error" ? ` · <span style="color:var(--red)">${esc(i.error ?? "failed")}</span>` : ""}</div>
    </div>
    <div class="listrow-meta"><form method="post" action="/outreach/unqueue/${i.contact_id}"><input type="hidden" name="return" value="/outreach"><button class="tiny secondary" type="submit">Remove</button></form></div>
  </div>`;
}

function draftCard(i: ItemRow, outlookOk: boolean, totalSteps = 0): string {
  const isEmail = i.channel === "email";
  const cid = i.contact_id;
  const bodyId = `d-body-${i.id}`;
  const subjId = `d-subj-${i.id}`;
  const logSubject = isEmail ? i.draft_subject || "Outreach" : "LinkedIn message";
  return `<div class="card" id="draft-${i.id}" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline">
      <div><b><a href="/contacts/${cid}">${esc(i.full_name)}</a></b> ${priorityBadge(i)} <span class="meta">${esc(i.organization_name ?? "")}</span></div>
      <div class="meta">${isEmail ? `Email to ${esc(i.draft_to ?? "")}` : "LinkedIn message"}${i.kind === "follow_up" ? ` · <b>follow-up ${i.sequence_step}${totalSteps ? ` of ${totalSteps}` : ""}</b>` : ""}</div>
    </div>
    <form method="post" action="/outreach/item/${i.id}/save">
      ${isEmail ? `<label for="${subjId}">Subject</label><input type="text" id="${subjId}" name="subject" value="${esc(i.draft_subject ?? "")}" maxlength="200">` : ""}
      <label for="${bodyId}">Message</label>
      <textarea id="${bodyId}" name="body" rows="${isEmail ? 9 : 6}">${esc(i.draft_body ?? "")}</textarea>
      <div class="actions" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
        <button type="button" class="secondary tiny" data-copy="${bodyId}" data-subj="${isEmail ? subjId : ""}">Copy</button>
        <button type="submit" class="secondary tiny">Save Edits</button>
        ${
          isEmail
            ? i.outlook_web_link
              ? `<a class="btn secondary tiny" href="${esc(i.outlook_web_link)}" target="_blank" rel="noopener">Open in Outlook ↗</a>`
              : outlookOk
                ? `<button type="submit" class="secondary tiny" formaction="/outreach/item/${i.id}/outlook">Save to Outlook</button>`
                : ""
            : i.linkedin_url
              ? `<a class="btn secondary tiny" href="${esc(i.linkedin_url)}" target="_blank" rel="noopener">LinkedIn ↗</a>`
              : ""
        }
        <span class="meta" data-toast="${bodyId}" aria-live="polite"></span>
      </div>
      ${i.outlook_error ? `<p class="meta" style="color:var(--amber);margin:6px 0 0">${esc(i.outlook_error)}</p>` : ""}
    </form>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;align-items:center;border-top:1px solid var(--line);padding-top:10px">
      <form method="post" action="/escalation/${cid}/attempt" style="display:inline">
        <input type="hidden" name="channel" value="${isEmail ? "email" : "linkedin"}">
        <input type="hidden" name="confirm_no_route" value="1">
        <input type="hidden" name="return" value="outreach">
        <input type="hidden" name="outreach_item" value="${i.id}">
        <input type="hidden" name="subject" value="${esc(logSubject)}">
        <input type="hidden" name="summary" value="${esc(i.draft_body ?? "")}">
        <button type="submit" class="tiny">Log as Sent</button>
      </form>
      <form method="post" action="/outreach/item/${i.id}/redraft" style="display:inline-flex;gap:6px;align-items:center;flex:1 1 240px">
        <input type="text" name="instructions" placeholder="Redraft with a note, e.g. shorter, mention our Dallas lunch" maxlength="300" style="flex:1;min-width:0" aria-label="Note for the redraft">
        <button type="submit" class="secondary tiny" data-busy="Redrafting…">Redraft</button>
      </form>
      <form method="post" action="/outreach/item/${i.id}/skip" style="display:inline"><button type="submit" class="secondary tiny">Skip</button></form>
      ${
        i.kind === "follow_up"
          ? `<form method="post" action="/outreach/followups/${cid}/stop" style="display:inline"><input type="hidden" name="return" value="/outreach"><button type="submit" class="secondary tiny">Stop Follow-ups</button></form>`
          : ""
      }
    </div>
    <p class="meta" style="margin:6px 0 0">Log as Sent after you send it. It records the message and moves them along the ladder.${
      isEmail && i.outlook_web_link ? " The Outlook draft reflects edits saved here." : ""
    }</p>
  </div>`;
}

/** Who's in a follow-up sequence and what happens next. Stop is one click per person. */
function followUpSection(rows: SequenceRow[], steps: number[], today: string): string {
  const rule = steps.length
    ? `Follow-up drafts ${steps.map((n) => `${n}`).join(" and ")} business days after a first message is logged as sent, if there's no reply. Checked each morning at 6:30 ${zoneLabel()}.`
    : "Follow-ups are off. Turn them on under Voice & limits.";
  const row = (s: SequenceRow) => `<div class="listrow">
      <div class="listrow-main">
        <div class="listrow-name"><a href="/contacts/${s.contact_id}">${esc(s.full_name)}</a> ${priorityBadge(s)}</div>
        <div class="meta">First message logged ${esc(s.logged_on)} · ${
          s.waiting ? `follow-up ${s.next_step - 1} drafted, waiting for you to send it` : `follow-up ${s.next_step} of ${steps.length} ${s.due <= today ? "due at the next check" : `on ${esc(s.due)}`}`
        }</div>
      </div>
      <div class="listrow-meta"><form method="post" action="/outreach/followups/${s.contact_id}/stop"><input type="hidden" name="return" value="/outreach"><button class="tiny secondary" type="submit">Stop</button></form></div>
    </div>`;
  return `<section>
    <h2>Follow-ups${rows.length ? ` <span class="meta">(${rows.length})</span>` : ""}</h2>
    <p class="meta">${esc(rule)} A reply, a stage change, or Skip on a follow-up ends it on its own.</p>
    ${rows.length ? `<div class="list">${rows.map(row).join("")}</div>` : steps.length ? `<div class="empty">Nobody in a follow-up sequence. It starts when you Log as Sent on a first message.</div>` : ""}
  </section>`;
}

function scheduleRow(s: ScheduleRow): string {
  return `<div class="listrow">
    <div class="listrow-main">
      <div class="listrow-name">${esc(s.name)} ${s.active ? '<span class="pill green">On</span>' : '<span class="pill grey">Off</span>'}</div>
      <div class="meta">${esc(describeSchedule(s))}</div>
      <div class="meta">Next: ${s.active ? esc(fmtLocal(s.next_run_utc)) : "—"}${s.last_run_at ? ` · Last: ${esc(fmtLocal(s.last_run_at))}${s.last_result ? `, ${esc(s.last_result)}` : ""}` : ""}</div>
    </div>
    <div class="listrow-meta"><form method="post" action="/outreach/schedule/${s.id}/${s.active ? "off" : "on"}"><button class="tiny secondary" type="submit">${s.active ? "Turn Off" : "Turn On"}</button></form></div>
  </div>`;
}

async function outreachPage(c: C, extra = ""): Promise<string> {
  const db = c.env.DB;
  const today = localToday();
  const keyOk = draftingConfigured(c.env);
  const conn = await msConnection(db).catch(() => null);
  const outlookOk = canSaveDrafts(conn);
  const { results: queued } = await db.prepare(`${ITEM_SELECT} WHERE i.status IN ('queued','error') ORDER BY i.status = 'error' DESC, i.for_date, i.id`).all<ItemRow>();
  const { results: drafts } = await db.prepare(`${ITEM_SELECT} WHERE i.status = 'drafted' ORDER BY c.is_priority DESC, i.drafted_at DESC`).all<ItemRow>();
  const { results: schedules } = await db.prepare("SELECT * FROM outreach_schedule ORDER BY active DESC, id").all<ScheduleRow>();
  const { results: runs } = await db.prepare("SELECT * FROM outreach_run ORDER BY id DESC LIMIT 8").all<Record<string, any>>();
  const voice = await loadVoice(db);
  const steps = await followUpSteps(db);
  const sequences = await liveSequences(db, steps);
  const spent = await monthSpendMicros(db);
  const cap = await capMicros(db);
  const dueCount = queued.filter((i) => i.status === "queued" && i.for_date <= today).length;
  const retryCount = queued.filter((i) => i.status === "error").length;
  const f = FLASH[c.req.query("flash") ?? ""];
  const running = c.req.query("run");

  const notices = [
    !keyOk
      ? `<div class="flash warn"><b>Drafting isn't set up yet.</b> Create an API key at console.anthropic.com, then add it in Cloudflare (Workers &amp; Pages → practice-platform → Settings → Variables and Secrets) as a secret named <code>ANTHROPIC_API_KEY</code>. Queueing works now; the draft buttons appear once the key is there.</div>`
      : "",
    keyOk && conn && !outlookOk
      ? `<div class="flash warn">Email drafts will stay here on the page until Outlook is reconnected with permission to save drafts. <a href="/auth/microsoft">Reconnect Outlook</a> (one sign-in; the calendar and email import keep working either way).</div>`
      : "",
  ].join("");

  const body = `<h1>Outreach</h1>
  <p class="sub">Queue people, draft messages when you say so, and log what you send. Nothing is ever sent for you.</p>
  ${f ? `<div class="flash ${f[1]}">${esc(f[0])}</div>` : ""}
  ${notices}${extra}

  <section>
    <h2>Queue${queued.length ? ` <span class="meta">(${queued.length})</span>` : ""}</h2>
    ${
      queued.length
        ? `<div class="list">${queued.map((i) => queueRow(i, today)).join("")}</div>`
        : `<div class="empty">Nobody queued. Use <b>+ Outreach</b> on the Dashboard's Outreach Batch or a contact's record, or paste a list below.</div>`
    }
    ${
      keyOk && (dueCount || retryCount)
        ? `<form method="post" action="/outreach/run" style="margin-top:10px" id="run-form"><button type="submit">Draft Now (${dueCount + retryCount})</button>
           <span class="meta">Drafts everyone queued for today or earlier${retryCount ? `, and retries ${retryCount} that failed` : ""}. About ${dollars(Math.round((dueCount + retryCount) * 20_000))} at typical length.</span></form>`
        : ""
    }
    <div id="run-progress" class="meta" aria-live="polite" style="margin-top:8px"></div>
  </section>

  <section>
    <h2>Add people</h2>
    <form method="post" action="/outreach/list" class="card">
      <label for="o-list">Names or email addresses <span class="hint">one per line</span></label>
      <textarea id="o-list" name="list" rows="5" placeholder="Jane Smith&#10;jsmith@example.com" required></textarea>
      <label for="o-for">For <span class="hint">hold them for a later run by picking a later date</span></label>
      <input type="date" id="o-for" name="for_date" value="${today}" style="max-width:200px">
      <div class="actions"><button type="submit" class="secondary">Preview Matches</button></div>
    </form>
  </section>

  <section>
    <h2>Drafts${drafts.length ? ` <span class="meta">(${drafts.length})</span>` : ""}</h2>
    ${drafts.length ? drafts.map((d) => draftCard(d, outlookOk, steps.length)).join("") : `<div class="empty">No drafts waiting.</div>`}
  </section>

  ${followUpSection(sequences, steps, today)}

  <section>
    <h2>Schedules</h2>
    ${schedules.length ? `<div class="list">${schedules.map(scheduleRow).join("")}</div>` : `<div class="empty">No schedules. Drafting only happens when you click Draft Now.</div>`}
    <details class="card" style="margin-top:10px">
      <summary style="cursor:pointer"><b>Add a schedule</b></summary>
      <form method="post" action="/outreach/schedule" style="margin-top:8px">
        <label for="s-name">Name</label>
        <input type="text" id="s-name" name="name" placeholder="Monday outreach" maxlength="80" required>
        <label class="check"><input type="radio" name="kind" value="weekly" checked> Weekly</label>
        <label class="check"><input type="radio" name="kind" value="once"> Once</label>
        <label>Days <span class="hint">weekly only</span></label>
        <div style="display:flex;flex-wrap:wrap;gap:10px">${DAY_NAMES.map((d, n) => `<label class="check" style="margin:0"><input type="checkbox" name="days" value="${n}"${n === 1 ? " checked" : ""}> ${d}</label>`).join("")}</div>
        <label for="s-every">Every <span class="hint">weeks, weekly only</span></label>
        <input type="number" id="s-every" name="every_n_weeks" value="1" min="1" max="8" style="max-width:120px">
        <label for="s-date">Date <span class="hint">once only</span></label>
        <input type="date" id="s-date" name="run_on_local" style="max-width:200px">
        <label for="s-time">Time <span class="hint">${esc(zoneLabel())}</span></label>
        <input type="time" id="s-time" name="time_local" value="07:15" style="max-width:160px" required>
        <label for="s-top">Top up to <span class="hint">0 = only people you queued; otherwise fill to this many from the Outreach Batch, priority contacts first</span></label>
        <input type="number" id="s-top" name="top_up_to" value="20" min="0" max="${MAX_PER_RUN}" style="max-width:120px">
        <div class="actions"><button type="submit">Save Schedule</button></div>
      </form>
    </details>
  </section>

  <section>
    <h2>Runs</h2>
    <p class="meta">This month: ${dollars(spent)} of your ${dollars(cap)} cap (estimated from token counts). Model: ${esc(modelFor(c.env))}.</p>
    ${
      runs.length
        ? `<div class="list">${runs
            .map(
              (r) => `<div class="listrow"><div class="listrow-main"><div class="listrow-name">${esc(fmtLocal(r.started_at))} · ${esc(r.trigger)}</div>
            <div class="meta">${r.drafted} drafted${r.errors ? `, ${r.errors} failed` : ""} · ${esc(r.status)} · ${Number(r.input_tokens).toLocaleString()} in / ${Number(r.output_tokens).toLocaleString()} out tokens · ${dollars(r.cost_micros)} · by ${esc(r.started_by)}${r.detail ? ` · ${esc(r.detail)}` : ""}</div></div></div>`
            )
            .join("")}</div>`
        : `<div class="empty">No runs yet.</div>`
    }
  </section>

  <section>
    <details class="card">
      <summary style="cursor:pointer"><b>Voice &amp; limits</b></summary>
      <form method="post" action="/outreach/voice" style="margin-top:8px">
        <label for="v-sender">Sender name</label>
        <input type="text" id="v-sender" name="sender" value="${esc(voice.sender)}" maxlength="80">
        <label for="v-signoff">Sign-off</label>
        <input type="text" id="v-signoff" name="signoff" value="${esc(voice.signoff)}" maxlength="80">
        <label for="v-pos">About you <span class="hint">context for the drafts, never pitched</span></label>
        <textarea id="v-pos" name="positioning" rows="3" maxlength="600">${esc(voice.positioning)}</textarea>
        <label for="v-steps">Follow-ups <span class="hint">business days after a first message is logged as sent, e.g. 5, 12; blank turns follow-ups off</span></label>
        <input type="text" id="v-steps" name="steps" value="${esc(steps.join(", "))}" maxlength="40" style="max-width:200px" inputmode="numeric">
        <label for="v-cap">Monthly spend cap <span class="hint">US dollars; runs stop when it's reached</span></label>
        <input type="number" id="v-cap" name="cap" value="${cap / 1_000_000}" min="0" max="1000" step="1" style="max-width:140px">
        <div class="actions"><button type="submit" class="secondary">Save</button></div>
      </form>
    </details>
  </section>

  <script>
  (function () {
    document.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        var body = document.getElementById(b.dataset.copy).value;
        var s = b.dataset.subj ? document.getElementById(b.dataset.subj).value : '';
        var t = document.querySelector('[data-toast="' + b.dataset.copy + '"]');
        var text = s ? 'Subject: ' + s + '\\n\\n' + body : body;
        try { navigator.clipboard.writeText(text).then(function () { t.textContent = 'Copied.'; }, function () { t.textContent = 'Select the text and copy it.'; }); }
        catch (e) { t.textContent = 'Select the text and copy it.'; }
      });
    });
    document.querySelectorAll('[data-busy]').forEach(function (b) {
      b.form.addEventListener('submit', function () { b.disabled = true; b.textContent = b.dataset.busy; });
    });
    var run = ${running && /^\d+$/.test(running) ? running : "null"};
    var out = document.getElementById('run-progress');
    if (run) {
      var form = document.getElementById('run-form'); if (form) form.style.display = 'none';
      var n = 0;
      (function next() {
        out.textContent = 'Drafting' + (n ? ' (' + n + ' done)' : '') + '… you can leave this page; it finishes on its own.';
        fetch('/outreach/run/' + run + '/next', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (j) {
          if (j.capped) { location.href = '/outreach?flash=capped'; return; }
          if (j.done) { location.href = '/outreach?flash=drafted'; return; }
          n++; next();
        }).catch(function () { out.textContent = 'Lost the connection. The rest will finish within 5 minutes; refresh to see them.'; });
      })();
    }
  })();
  </script>`;
  return layout({ c, title: "Outreach", body });
}

// ---------------------------------------------------------------- routes

app.get("/outreach", async (c) => c.html(await outreachPage(c)));

/** Dashboard / contact record toggle: queue if not active, unqueue if queued. */
app.post("/outreach/toggle/:contactId", async (c) => {
  const id = Number(c.req.param("contactId"));
  const f = await c.req.parseBody();
  const back = str(f.return).startsWith("/") && !str(f.return).startsWith("//") ? str(f.return) : "/";
  const source = str(f.source) === "contact" ? "contact" : "dashboard";
  const active = await c.env.DB.prepare("SELECT status FROM outreach_item WHERE contact_id = ? AND status IN ('queued','drafted')").bind(id).first<{ status: string }>();
  if (active?.status === "queued") await unqueueContact(c.env.DB, id);
  else if (!active) await queueContact(c.env.DB, id, source, localToday());
  return c.redirect(back);
});

app.post("/outreach/unqueue/:contactId", async (c) => {
  await unqueueContact(c.env.DB, Number(c.req.param("contactId")));
  // An errored item isn't "queued"; Remove on it means skip it.
  await c.env.DB.prepare("UPDATE outreach_item SET status = 'skipped' WHERE contact_id = ? AND status = 'error'").bind(Number(c.req.param("contactId"))).run();
  return c.redirect("/outreach?flash=unqueued");
});

app.post("/outreach/list", async (c) => {
  const f = await c.req.parseBody();
  const forDate = isDate(str(f.for_date)) ? str(f.for_date) : localToday();
  const results = await matchLines(c.env.DB, str(f.list));
  const active = await activeOutreach(c.env.DB);
  const rows = results
    .map((r, n) => {
      if (!r.matches.length)
        return `<div class="listrow"><div class="listrow-main"><div class="listrow-name">${esc(r.line)}</div><div class="meta">No match. <a href="/contacts/new">Add as a contact</a> first, then queue them.</div></div></div>`;
      const opt = (m: MatchRow, type: "checkbox" | "radio", checked: boolean) => {
        const st = active.get(m.id);
        return `<label class="check" style="margin:2px 0"><input type="${type}" name="${type === "radio" ? `pick_${n}` : "ids"}" value="${m.id}"${checked && !st ? " checked" : ""}${st ? " disabled" : ""}> ${esc(m.full_name)}${m.organization_name ? `, ${esc(m.organization_name)}` : ""} <span class="meta">(${esc((m.email_work || m.email_personal) ?? "no email")}${st ? `, already ${st}` : ""})</span></label>`;
      };
      return `<div class="listrow"><div class="listrow-main"><div class="meta">${esc(r.line)} · matched by ${r.by}${r.matches.length > 1 ? `, <b>${r.matches.length} people, choose one</b>` : ""}</div>${
        r.matches.length > 1
          ? r.matches.map((m) => opt(m, "radio", false)).join("") + `<label class="check" style="margin:2px 0"><input type="radio" name="pick_${n}" value="" checked> None of these</label>`
          : opt(r.matches[0], "checkbox", true)
      }</div></div>`;
    })
    .join("");
  const extra = `<section><h2>Preview</h2><form method="post" action="/outreach/list/add" class="card">
      <input type="hidden" name="for_date" value="${esc(forDate)}">
      ${rows ? `<div class="list">${rows}</div>` : `<div class="empty">Nothing to match.</div>`}
      <div class="actions"><button type="submit">Add to Queue for ${esc(forDate)}</button> <a href="/outreach">Cancel</a></div>
    </form></section>`;
  return c.html(await outreachPage(c, extra));
});

app.post("/outreach/list/add", async (c) => {
  const f = await c.req.parseBody({ all: true });
  const forDate = isDate(str(f.for_date)) ? str(f.for_date) : localToday();
  const ids = new Set<number>();
  for (const [k, v] of Object.entries(f)) {
    if (k !== "ids" && !k.startsWith("pick_")) continue;
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && /^\d+$/.test(x)) ids.add(Number(x));
  }
  if (!ids.size) return c.redirect("/outreach?flash=none");
  for (const id of ids) await queueContact(c.env.DB, id, "list", forDate);
  return c.redirect("/outreach?flash=added");
});

/** Draft Now: gather everything due (and failed ones to retry) into a run; the page then works it. */
app.post("/outreach/run", async (c) => {
  if (!draftingConfigured(c.env)) return c.redirect("/outreach?flash=nokey");
  const db = c.env.DB;
  await db.prepare("UPDATE outreach_item SET status = 'queued', error = NULL, run_id = NULL WHERE status = 'error'").run();
  const runId = await startRun(db, "manual", null);
  const n = await assignDue(db, runId, localToday());
  if (!n) {
    await db.prepare("UPDATE outreach_run SET status = 'done', finished_at = datetime('now'), detail = 'Nobody due.' WHERE id = ?").bind(runId).run();
    return c.redirect("/outreach?flash=nodue");
  }
  await audit(db, `run-${runId}`, "create", `Draft Now started for ${n} ${n === 1 ? "person" : "people"}`);
  return c.redirect(`/outreach?run=${runId}`);
});

/** One step of a manual run: claim and draft the next item. JSON for the page's progress loop. */
app.post("/outreach/run/:id/next", async (c) => {
  const runId = Number(c.req.param("id"));
  const id = await claimNext(c.env.DB, runId);
  if (id === null) {
    await finishRunIfDone(c.env.DB, runId);
    return c.json({ done: true });
  }
  const r = await draftItem(c.env, id);
  if (r === "capped") return c.json({ capped: true });
  return c.json({ done: false, result: r });
});

app.post("/outreach/item/:id/save", async (c) => {
  const id = Number(c.req.param("id"));
  const f = await c.req.parseBody();
  await c.env.DB.prepare("UPDATE outreach_item SET draft_subject = ?, draft_body = ? WHERE id = ? AND status = 'drafted'")
    .bind(str(f.subject).slice(0, 200) || null, str(f.body).slice(0, 5000), id)
    .run();
  const it = await c.env.DB.prepare("SELECT channel, outlook_draft_id FROM outreach_item WHERE id = ?").bind(id).first<{ channel: string; outlook_draft_id: string | null }>();
  if (it?.channel === "email" && it.outlook_draft_id) await syncOutlookDraft(c.env, id);
  return c.redirect(`/outreach?flash=saved#draft-${id}`);
});

app.post("/outreach/item/:id/outlook", async (c) => {
  const id = Number(c.req.param("id"));
  const f = await c.req.parseBody();
  if (typeof f.body === "string")
    await c.env.DB.prepare("UPDATE outreach_item SET draft_subject = ?, draft_body = ? WHERE id = ? AND status = 'drafted'")
      .bind(str(f.subject).slice(0, 200) || null, str(f.body).slice(0, 5000), id)
      .run();
  await syncOutlookDraft(c.env, id);
  const it = await c.env.DB.prepare("SELECT outlook_draft_id FROM outreach_item WHERE id = ?").bind(id).first<{ outlook_draft_id: string | null }>();
  return c.redirect(`/outreach?flash=${it?.outlook_draft_id ? "outlook" : "outlookfail"}#draft-${id}`);
});

/** Redraft one, synchronously (one call, ~10 seconds), with an optional note. */
app.post("/outreach/item/:id/redraft", async (c) => {
  if (!draftingConfigured(c.env)) return c.redirect("/outreach?flash=nokey");
  const id = Number(c.req.param("id"));
  const f = await c.req.parseBody();
  const db = c.env.DB;
  const runId = await startRun(db, "manual", null);
  const res = await db
    .prepare("UPDATE outreach_item SET status = 'queued', instructions = ?, run_id = ?, claimed_at = ? WHERE id = ? AND status IN ('drafted','error')")
    .bind(str(f.instructions).slice(0, 300) || null, runId, sqlNow(), id)
    .run();
  if (!(res.meta?.changes ?? 0)) return c.redirect("/outreach");
  const r = await draftItem(c.env, id);
  await finishRunIfDone(db, runId);
  return c.redirect(`/outreach?flash=${r === "capped" ? "capped" : "redrafted"}#draft-${id}`);
});

app.post("/outreach/item/:id/skip", async (c) => {
  const id = Number(c.req.param("id"));
  const it = await c.env.DB.prepare("SELECT contact_id FROM outreach_item WHERE id = ?").bind(id).first<{ contact_id: number }>();
  await c.env.DB.prepare("UPDATE outreach_item SET status = 'skipped' WHERE id = ? AND status IN ('drafted','error','queued')").bind(id).run();
  if (it) await audit(c.env.DB, String(it.contact_id), "update", "outreach draft skipped");
  return c.redirect("/outreach?flash=skipped");
});

app.post("/outreach/schedule", async (c) => {
  const f = await c.req.parseBody({ all: true });
  const kind = f.kind === "once" ? "once" : "weekly";
  const time = str(f.time_local);
  const days = (Array.isArray(f.days) ? f.days : f.days ? [f.days] : []).map(String).filter((d) => /^[0-6]$/.test(d));
  const runOn = str(f.run_on_local);
  const everyN = Math.min(8, Math.max(1, Number(f.every_n_weeks) || 1));
  const topUp = Math.min(MAX_PER_RUN, Math.max(0, Math.floor(Number(f.top_up_to) || 0)));
  const name = str(f.name).slice(0, 80) || (kind === "once" ? "One-time run" : "Weekly run");
  if (!isTime(time) || (kind === "weekly" && !days.length) || (kind === "once" && !isDate(runOn))) return c.redirect("/outreach?flash=schedbad");
  const s = {
    kind: kind as "once" | "weekly",
    run_on_local: kind === "once" ? runOn : null,
    days_of_week: kind === "weekly" ? [...new Set(days)].sort().join(",") : null,
    time_local: time,
    every_n_weeks: everyN,
    anchor_date: sundayOf(localToday()),
  };
  const next = nextRunUtc(s, Date.now());
  if (!next) return c.redirect("/outreach?flash=schedpast");
  const res = await c.env.DB.prepare(
    `INSERT INTO outreach_schedule (name, kind, run_on_local, days_of_week, time_local, every_n_weeks, top_up_to, anchor_date, next_run_utc, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(name, s.kind, s.run_on_local, s.days_of_week, time, everyN, topUp, s.anchor_date, next, actor())
    .run();
  await audit(c.env.DB, `schedule-${res.meta?.last_row_id}`, "create", `schedule "${name}": ${describeSchedule({ ...s, id: 0, name, top_up_to: topUp, active: 1, next_run_utc: next, last_run_at: null, last_result: null })}`);
  return c.redirect("/outreach?flash=sched");
});

app.post("/outreach/schedule/:id/:onoff{on|off}", async (c) => {
  const id = Number(c.req.param("id"));
  const on = c.req.param("onoff") === "on";
  const s = await c.env.DB.prepare("SELECT * FROM outreach_schedule WHERE id = ?").bind(id).first<ScheduleRow>();
  if (!s) return c.redirect("/outreach");
  const next = on ? nextRunUtc(s, Date.now()) : s.next_run_utc;
  if (on && !next) return c.redirect("/outreach?flash=schedpast");
  await c.env.DB.prepare("UPDATE outreach_schedule SET active = ?, next_run_utc = ? WHERE id = ?").bind(on ? 1 : 0, next, id).run();
  await audit(c.env.DB, `schedule-${id}`, "update", `schedule "${s.name}" turned ${on ? "on" : "off"}`);
  return c.redirect(`/outreach?flash=${on ? "schedon" : "schedoff"}`);
});

app.post("/outreach/followups/:contactId/stop", async (c) => {
  const id = Number(c.req.param("contactId"));
  const f = await c.req.parseBody();
  await stopFollowUps(c.env.DB, id);
  const back = str(f.return).startsWith("/") && !str(f.return).startsWith("//") ? str(f.return) : "/outreach";
  return c.redirect(`${back}${back.includes("?") ? "&" : "?"}flash=stopped`);
});

app.post("/outreach/voice", async (c) => {
  const f = await c.req.parseBody();
  if (typeof f.steps === "string")
    await c.env.DB.prepare(
      `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
      .bind(STEPS_KEY, parseSteps(f.steps).join(","))
      .run();
  await saveVoice(c.env.DB, { sender: str(f.sender).slice(0, 80), signoff: str(f.signoff).slice(0, 80), positioning: str(f.positioning).slice(0, 600) });
  const cap = Number(f.cap);
  if (Number.isFinite(cap) && cap >= 0)
    await c.env.DB.prepare(
      `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
      .bind(SPEND_CAP_KEY, String(Math.min(1000, cap)))
      .run();
  await audit(c.env.DB, "voice", "update", `outreach voice/limits updated (cap $${Math.min(1000, cap)})`);
  return c.redirect("/outreach?flash=voice");
});

/** Called by the outreach logging path (escalation.ts) and email import: the draft was sent. */
export async function markLogged(db: D1Db, opts: { itemId?: number; contactId: number; channel?: string }) {
  try {
    if (opts.itemId)
      await db.prepare("UPDATE outreach_item SET status = 'logged', logged_at = datetime('now') WHERE id = ? AND contact_id = ? AND status = 'drafted'").bind(opts.itemId, opts.contactId).run();
    else
      await db
        .prepare("UPDATE outreach_item SET status = 'logged', logged_at = datetime('now') WHERE contact_id = ? AND status = 'drafted' AND (? IS NULL OR channel = ?)")
        .bind(opts.contactId, opts.channel ?? null, opts.channel ?? null)
        .run();
  } catch {
    /* table not migrated yet: logging must never fail because of outreach */
  }
}

/** For the digest: how many drafts are waiting. */
export async function draftsWaiting(db: D1Db): Promise<number> {
  try {
    const r = await db.prepare("SELECT COUNT(*) AS n FROM outreach_item WHERE status = 'drafted'").first<{ n: number }>();
    return r?.n ?? 0;
  } catch {
    return 0;
  }
}

export default app;
