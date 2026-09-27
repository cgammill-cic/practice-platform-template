// Meetings from the Outlook calendar (the owner, 2026-09-24; migration 0030).
//
// "I don't want to have to remember to log a meeting and right now, I'm having to do that." Whether an
// invite is SENT or RECEIVED, Outlook puts the event on his calendar with the other people as attendees
// or organizer. So the calendar, not the invite email, is the one place that sees both directions — and
// it also carries the start time already in his timezone, reschedules, and cancellation. This module reads
// it every hour (and on the Health page's button) and, for each contact on an upcoming event, sets
// Meeting Scheduled with the meeting's date and time.
//
// THE CORE ASK IS THE FIRST DETECTION. Reschedules are followed, but only for meetings this sync set
// (meeting_event_id). A date the owner typed himself is never overwritten; if it is the same day as a
// calendar event, the two are linked so later reschedules follow.
//
// CANCELLATION IS NOT AUTOMATIC, on purpose. A cancelled event is simply skipped, so the meeting stays on
// the record and — once the date passes — appears in the dashboard's Needs Resolution list, where
// Cancelled is one click. Auto-clearing is the dangerous direction: an event moved to another calendar,
// or a Graph hiccup returning a short list, must never silently wipe a meeting off a record.
//
// Nothing here writes interactions. The meeting is logged when it is resolved (Held / No-Show /
// Cancelled), exactly as before; this only saves him typing the date in the first place.

import { ianaFromWindows, localDay } from "./mailimport";
import { resolveTimeZone } from "./calimport";
import { graphBase, msAccessToken, msConnection, needsReauth } from "./msgraph";
import type { Bindings, D1Db } from "./types";
import { actor } from "./auth";

export const MEETING_SYNC_CRON = "15 * * * *";
const WINDOW_DAYS = 60;
/** Webinars, all-hands and big group calls are not a meeting WITH someone. Resources don't count. */
export const MAX_ATTENDEES = 8;
const MAX_EVENTS = 1000;
const SETTING_KEY = "meeting_sync_last";
const EXCLUDE_KEY = "meeting_sync_exclude";
/**
 * Seeded on first read (2026-09-25). The sync's first run moved two Not Qualified contacts to Meeting
 * Scheduled because they were on "Accountability Lunch", a standing group lunch rather than a sales
 * meeting. The occurrence was dismissed by hand, but a recurring series brings a new event id every time,
 * so the title has to be excluded or the next occurrence brings them straight back.
 */
const DEFAULT_EXCLUDE = ["Accountability Lunch"];

interface GraphPerson {
  emailAddress?: { address?: string; name?: string };
}
interface GraphAttendee extends GraphPerson {
  type?: "required" | "optional" | "resource";
  status?: { response?: string };
}
export interface CalendarEvent {
  id: string;
  subject?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  start?: { dateTime?: string; timeZone?: string };
  organizer?: GraphPerson;
  attendees?: GraphAttendee[];
}

export interface SyncContact {
  id: number;
  full_name: string;
  stage: string;
  meeting_date: string | null;
  meeting_time: string | null;
  meeting_event_id: string | null;
  meeting_event_dismissed: string | null;
}

export interface MeetingChange {
  contactId: number;
  name: string;
  kind: "new" | "rescheduled" | "linked";
  eventId: string;
  date: string;
  time: string | null;
  subject: string;
  before: { stage: string; meeting_date: string | null; meeting_time: string | null };
}

export interface SyncSummary {
  at: string;
  origin: "cron" | "manual";
  state: "ok" | "not-connected" | "error";
  detail: string;
  events: number;
  changes: { id: number; name: string; kind: MeetingChange["kind"]; date: string; time: string | null }[];
  keptHandEntered: number;
  /** Events skipped because their title matched an exclusion phrase (added 2026-09-25). */
  excluded?: number;
}

const addr = (p: GraphPerson | undefined) => (p?.emailAddress?.address ?? "").trim().toLowerCase();

/** "2026-10-02T14:30:00.0000000" (already in the mailbox zone via the Prefer header) → "2:30 pm". */
export function eventTime(dateTime: string | undefined): string | null {
  const m = /T(\d{2}):(\d{2})/.exec(dateTime ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${h < 12 ? "am" : "pm"}`;
}

/** True when the invite title contains any exclusion phrase, case-insensitively. */
export function isExcluded(subject: string | undefined, exclude: string[]): boolean {
  const t = (subject ?? "").toLowerCase();
  return exclude.some((p) => p.trim() && t.includes(p.trim().toLowerCase()));
}

/**
 * The decision, kept pure so it can be exercised without Graph or D1.
 *
 * Per contact, the EARLIEST qualifying upcoming event wins — a contact with a meeting next Tuesday and
 * another in three weeks is "meeting scheduled for Tuesday". Events arrive sorted by start.
 */
export function planMeetingChanges(
  events: CalendarEvent[],
  me: string,
  contactIdByEmail: Map<string, number>,
  contacts: Map<number, SyncContact>,
  todayLocal: string,
  exclude: string[] = []
): { changes: MeetingChange[]; keptHandEntered: number; excluded: number } {
  const earliest = new Map<number, { ev: CalendarEvent; date: string; time: string | null }>();
  let excluded = 0;
  for (const ev of events) {
    if (ev.isCancelled || ev.isAllDay || !ev.start?.dateTime) continue;
    if (isExcluded(ev.subject, exclude)) {
      excluded++;
      continue;
    }
    const people = (ev.attendees ?? []).filter((a) => a.type !== "resource");
    if (people.length > MAX_ATTENDEES) continue;
    const date = ev.start.dateTime.slice(0, 10);
    const time = eventTime(ev.start.dateTime);
    const declined = new Set(
      people.filter((a) => (a.status?.response ?? "").toLowerCase() === "declined").map((a) => addr(a))
    );
    const emails = new Set([addr(ev.organizer), ...people.map((a) => addr(a))]);
    for (const e of emails) {
      if (!e || e === me || declined.has(e)) continue;
      const id = contactIdByEmail.get(e);
      if (id === undefined || earliest.has(id)) continue;
      // An event he already resolved or erased is excluded HERE, before "earliest" is decided — skipping
      // it afterwards would hide the contact's next real meeting behind the one he dismissed.
      if (contacts.get(id)?.meeting_event_dismissed === ev.id) continue;
      earliest.set(id, { ev, date, time });
    }
  }

  const changes: MeetingChange[] = [];
  let keptHandEntered = 0;
  for (const [id, { ev, date, time }] of earliest) {
    const c = contacts.get(id);
    if (!c || c.stage === "retired") continue;
    const base = {
      contactId: id,
      name: c.full_name,
      eventId: ev.id,
      date,
      time,
      subject: ev.subject ?? "(no subject)",
      before: { stage: c.stage, meeting_date: c.meeting_date, meeting_time: c.meeting_time },
    };
    const unchanged = c.meeting_date === date && (c.meeting_time ?? null) === time && c.stage === "meeting_scheduled";

    if (c.meeting_event_id) {
      // A meeting this sync set. A date already in the past is awaiting resolution — never replace it,
      // the Needs Resolution list is where he says what happened.
      if (c.meeting_date && c.meeting_date < todayLocal) continue;
      if (c.meeting_event_id === ev.id && unchanged) continue;
      changes.push({ ...base, kind: "rescheduled" });
      continue;
    }
    if (!c.meeting_date) {
      changes.push({ ...base, kind: "new" });
      continue;
    }
    if (c.meeting_date === date) {
      // His own entry for the same day: adopt the event so a later reschedule follows it.
      changes.push({ ...base, kind: "linked" });
      continue;
    }
    keptHandEntered++; // a different date typed by hand wins
  }
  return { changes, keptHandEntered, excluded };
}

// ---------------------------------------------------------------- exclusions (2026-09-25)

/** The exclusion phrases, seeding the default the first time they are read. */
export async function meetingExclusions(db: D1Db): Promise<string[]> {
  const row = await db.prepare("SELECT value FROM app_setting WHERE key = ?").bind(EXCLUDE_KEY).first<{ value: string }>();
  if (!row) {
    await writeExclusions(db, DEFAULT_EXCLUDE);
    return [...DEFAULT_EXCLUDE];
  }
  try {
    const v = JSON.parse(row.value);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function writeExclusions(db: D1Db, list: string[]): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(EXCLUDE_KEY, JSON.stringify(list))
    .run();
}

/** Add or remove one phrase, audited. Returns the new list. Duplicates (any case) are ignored. */
export async function changeExclusion(db: D1Db, phrase: string, add: boolean): Promise<string[]> {
  const p = phrase.trim().slice(0, 100);
  const list = await meetingExclusions(db);
  const has = list.some((x) => x.toLowerCase() === p.toLowerCase());
  if (!p || has === add) return list;
  const next = add ? [...list, p] : list.filter((x) => x.toLowerCase() !== p.toLowerCase());
  await writeExclusions(db, next);
  await db
    .prepare(
      `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id)
       VALUES (?, 'app_setting', ?, 'update', ?, ?, 'app', ?)`
    )
    .bind(actor(), EXCLUDE_KEY, JSON.stringify(list), `${add ? "added" : "removed"} meeting exclusion "${p}"`, `meeting-exclude-${Date.now()}`)
    .run();
  return next;
}

// ---------------------------------------------------------------- what the sync changed recently

export interface CalendarUpdate {
  contactId: number;
  name: string;
  kind: string;
  date: string | null;
  time: string | null;
  at: string;
}

/**
 * Meetings the sync added or changed in the last `hours` THAT ARE STILL ON THE RECORD, newest first, one
 * per contact — for the digest's "Calendar updates" section, the dashboard note and the Health panel.
 *
 * STILL ON THE RECORD is the point (the owner, 2026-09-25). The first version listed every audit row, so a
 * pick-up he had already undone kept appearing: two contacts showed twice for an
 * "Accountability Lunch" both reverted by hand. The list exists to answer "is anything the sync did
 * wrong?", and an undone change has already been answered. So a row is kept only while the contact's
 * current meeting still matches what the sync wrote; once he edits, resolves or clears it, it drops off.
 *
 * The kind, date and time come from correlation_id ("meeting-sync|new|2026-09-28|9:00 am", written since
 * 2026-09-25) rather than by parsing prose. Older rows ("meeting-sync-<timestamp>") carry no date, so for
 * those the test is whether the contact is still linked to a synced event at all.
 */
export async function recentCalendarUpdates(db: D1Db, hours = 24): Promise<CalendarUpdate[]> {
  const { results } = await db
    .prepare(
      `SELECT a.entity_id, a.before_summary, a.correlation_id, a.ts,
              c.full_name, c.meeting_date AS cur_date, c.meeting_event_id AS cur_event
         FROM audit_event a JOIN contact c ON c.id = CAST(a.entity_id AS INTEGER)
        WHERE a.source = 'calendar-sync' AND a.entity = 'contact' AND a.ts >= datetime('now', ?)
          AND c.status = 'active'
        ORDER BY a.id DESC LIMIT 100`
    )
    .bind(`-${hours} hours`)
    .all<{
      entity_id: string;
      before_summary: string | null;
      correlation_id: string | null;
      ts: string;
      full_name: string;
      cur_date: string | null;
      cur_event: string | null;
    }>();
  const seen = new Set<number>();
  const out: CalendarUpdate[] = [];
  for (const r of results) {
    const contactId = Number(r.entity_id);
    if (seen.has(contactId)) continue; // newest row per contact is the one that describes today's state
    seen.add(contactId);
    const parts = (r.correlation_id ?? "").split("|");
    const tagged = parts[0] === "meeting-sync" && parts.length >= 3;
    const date = tagged ? parts[2] || null : null;
    const stillThere = tagged ? r.cur_event !== null && r.cur_date === date : r.cur_event !== null;
    if (!stillThere) continue;
    out.push({
      contactId,
      name: r.full_name ?? r.before_summary ?? "Contact",
      kind: tagged ? parts[1] : "updated",
      date,
      time: tagged ? parts[3] || null : null,
      at: r.ts,
    });
  }
  return out;
}

/** "Mon 9/28" from "2026-09-28". */
export function shortDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** One line describing an update, e.g. "new meeting Mon 9/28, 9:00 am". */
export function describeUpdate(u: CalendarUpdate): string {
  const when = [shortDay(u.date), u.time].filter(Boolean).join(", ");
  if (u.kind === "new") return `new meeting ${when}`;
  if (u.kind === "rescheduled") return `moved to ${when}`;
  if (u.kind === "linked") return `linked your meeting ${when} to the invite`;
  return "meeting updated from Outlook";
}

async function fetchEvents(env: Bindings, token: string, tz: string): Promise<CalendarEvent[] | { error: string }> {
  const now = new Date();
  const end = new Date(now.getTime() + WINDOW_DAYS * 86_400_000);
  const url = new URL(`${graphBase(env)}/me/calendarView`);
  url.searchParams.set("startDateTime", now.toISOString());
  url.searchParams.set("endDateTime", end.toISOString());
  url.searchParams.set("$select", "id,subject,isAllDay,isCancelled,start,organizer,attendees");
  url.searchParams.set("$orderby", "start/dateTime");
  url.searchParams.set("$top", "250");
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (tz) headers.Prefer = `outlook.timezone="${tz}"`;

  const out: CalendarEvent[] = [];
  // Follows @odata.nextLink, unlike the timesheet import: 60 days can exceed one page.
  let next: string | null = url.toString();
  while (next && out.length < MAX_EVENTS) {
    const res: Response = await fetch(next, { headers });
    if (!res.ok)
      return { error: `Microsoft refused the calendar request (HTTP ${res.status}). Check the Outlook connection on this page.` };
    const body = (await res.json()) as { value?: CalendarEvent[]; "@odata.nextLink"?: string };
    out.push(...(body.value ?? []));
    next = body["@odata.nextLink"] ?? null;
  }
  return out;
}

async function saveSummary(db: D1Db, s: SyncSummary): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(SETTING_KEY, JSON.stringify(s))
    .run();
}

export async function lastMeetingSync(db: D1Db): Promise<SyncSummary | null> {
  const row = await db.prepare("SELECT value FROM app_setting WHERE key = ?").bind(SETTING_KEY).first<{ value: string }>();
  try {
    return row ? (JSON.parse(row.value) as SyncSummary) : null;
  } catch {
    return null;
  }
}

/**
 * One run. Always records a summary (so the Health panel can tell "nothing new" from "broken"), but
 * writes audit rows only for contacts it actually changed — an hourly job auditing its own no-ops would
 * bury every real change under 24 empty rows a day.
 */
export async function runMeetingSync(env: Bindings, origin: "cron" | "manual"): Promise<SyncSummary> {
  const db = env.DB;
  const at = new Date().toISOString();
  const base = { at, origin, events: 0, changes: [], keptHandEntered: 0 };
  const finish = async (s: SyncSummary) => {
    await saveSummary(db, s).catch(() => undefined);
    return s;
  };

  const conn = await msConnection(db).catch(() => null);
  if (!conn) return finish({ ...base, state: "not-connected", detail: "Outlook is not connected, so no calendar was read." });
  if (needsReauth(conn.last_error))
    return finish({ ...base, state: "error", detail: "Outlook needs reconnecting (see the Outlook panel above)." });
  const tok = await msAccessToken(env, db);
  if ("error" in tok) return finish({ ...base, state: "error", detail: tok.error });

  const { tz } = await resolveTimeZone(env, tok.token);
  const events = await fetchEvents(env, tok.token, tz);
  if ("error" in events) return finish({ ...base, state: "error", detail: events.error });

  // Same matching as email import: active contacts, not email-import-ignored, work or personal address.
  const { results: rows } = await db
    .prepare(
      `SELECT id, full_name, stage, meeting_date, meeting_time, meeting_event_id, meeting_event_dismissed,
              lower(trim(ifnull(email_work,''))) AS ew, lower(trim(ifnull(email_personal,''))) AS ep
         FROM contact
        WHERE status = 'active' AND email_import_ignore = 0
          AND (ifnull(email_work,'') <> '' OR ifnull(email_personal,'') <> '')`
    )
    .all<SyncContact & { ew: string; ep: string }>();
  const byEmail = new Map<string, number>();
  const contacts = new Map<number, SyncContact>();
  for (const r of rows) {
    contacts.set(r.id, r);
    // First writer wins, as in mailimport's contactsByEmail().
    if (r.ew && !byEmail.has(r.ew)) byEmail.set(r.ew, r.id);
    if (r.ep && !byEmail.has(r.ep)) byEmail.set(r.ep, r.id);
  }

  const todayLocal = localDay(at, ianaFromWindows(tz));
  const me = conn.account_upn.trim().toLowerCase();
  const exclude = await meetingExclusions(db).catch(() => [...DEFAULT_EXCLUDE]);
  const { changes, keptHandEntered, excluded } = planMeetingChanges(events, me, byEmail, contacts, todayLocal, exclude);

  if (changes.length) {
    const watermark =
      (await db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM contact_stage_event").first<{ m: number }>())?.m ?? 0;
    const stmts = [];
    for (const ch of changes) {
      // Guarded on the values just read, so a hand edit landing between the read and this write wins.
      stmts.push(
        db
          .prepare(
            `UPDATE contact SET stage = 'meeting_scheduled', meeting_date = ?, meeting_time = ?, meeting_event_id = ?,
               updated_at = datetime('now')
             WHERE id = ? AND stage = ? AND meeting_date IS ? AND meeting_time IS ?`
          )
          .bind(ch.date, ch.time, ch.eventId, ch.contactId, ch.before.stage, ch.before.meeting_date, ch.before.meeting_time)
      );
      const parts = [
        ch.before.stage !== "meeting_scheduled" ? `stage ${ch.before.stage} → meeting_scheduled` : "",
        ch.before.meeting_date !== ch.date ? `meeting_date ${ch.before.meeting_date ?? "none"} → ${ch.date}` : "",
        (ch.before.meeting_time ?? null) !== ch.time ? `meeting_time ${ch.before.meeting_time ?? "none"} → ${ch.time ?? "none"}` : "",
      ].filter(Boolean);
      const what = ch.kind === "linked" ? "linked your meeting to the Outlook event" : ch.kind === "rescheduled" ? "rescheduled in Outlook" : "invite found in Outlook";
      stmts.push(
        db
          .prepare(
            `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id)
             VALUES (?, 'contact', ?, 'update', ?, ?, 'calendar-sync', ?)`
          )
          .bind(
            actor(),
            String(ch.contactId),
            ch.name,
            `${parts.join("; ") || "meeting linked"} (${what}: "${ch.subject.slice(0, 120)}")`,
            `meeting-sync|${ch.kind}|${ch.date}|${ch.time ?? ""}`
          )
      );
    }
    await db.batch(stmts);
    // Stage history records these as calendar moves, not as hand edits (same pattern as bulkupdate.ts).
    await db
      .prepare("UPDATE contact_stage_event SET origin = 'calendar-sync' WHERE id > ? AND origin = 'trigger'")
      .bind(watermark)
      .run();
  }

  return finish({
    ...base,
    state: "ok",
    events: events.length,
    keptHandEntered,
    excluded,
    detail: changes.length
      ? `${changes.length} contact${changes.length === 1 ? "" : "s"} updated from ${events.length} calendar event${events.length === 1 ? "" : "s"}.`
      : `No new meetings with contacts in the next ${WINDOW_DAYS} days (${events.length} calendar event${events.length === 1 ? "" : "s"} read).`,
    changes: changes.map((c) => ({ id: c.contactId, name: c.name, kind: c.kind, date: c.date, time: c.time })),
  });
}
