/*
 * ANLY-001 — practice analytics (#101, requested 2026-08-11, built 2026-09-25).
 *
 * The owner now runs a system: a ~68-person priority circle on tiered touch cadences (30/42/56 days), meetings
 * logged from Outlook, email import and a daily digest. This page answers whether it is WORKING: is the
 * circle being touched on rhythm, is outreach turning into replies and meetings, and where is the time
 * going. Nothing new is captured; every number is a read over tables that already exist.
 *
 * WHAT THE DATA SAID BEFORE THIS WAS BUILT. Weeks 35–38 of 2026 carried 60–90 outbound emails each, far
 * above the "re-engage about 10 a week" rhythm the priority cadences are sized for. So the headline is not
 * volume, it is how much of that volume reaches the circle — hence "share of outreach reaching the circle".
 *
 * RULES INHERITED FROM #101, applied to every number here:
 *   - Every number states what it counts, on screen, next to it.
 *   - Counts before ratios. A percentage is shown only when its denominator is at least RATIO_FLOOR, because
 *     at these volumes a rate swings on one contact.
 *   - Heuristics are named as heuristics. A reply is not linked to the attempt that provoked it, so
 *     "replied" means "any inbound or two-way interaction within 14 days of the first outreach".
 *   - Weeks run Sunday–Saturday in Central time, the same as the dashboard.
 *
 * Deliberately NOT here: stage movement and dwell time (that is /pipeline, ANLY-002) and weekly hours by
 * customer (/time/report). This page links to both rather than repeating them.
 */
import { Hono } from "hono";
import { zoneLabel } from "./settings";
import { ATTEMPT_TYPES } from "./attempts";
import { BILLABLE_ACTIVITY, SALES_ACTIVITY, stageLabel, type Bindings, type D1Db } from "./types";
import { esc, layout } from "./views";
import { localToday, shiftWeek, weekBounds } from "./weeks";

const app = new Hono<{ Bindings: Bindings }>();

export const RATIO_FLOOR = 20;
export const REPLY_WINDOW_DAYS = 14;
const WEEKS_SHOWN = 8;

// ---------------------------------------------------------------- pure helpers (tested)

const DAY = 86_400_000;
const toMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
export const addDays = (iso: string, n: number) => new Date(toMs(iso) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((toMs(to) - toMs(from)) / DAY);

export type CadenceStatus = "on_rhythm" | "due_soon" | "overdue" | "never" | "no_cadence";

/**
 * Where a priority contact stands against its own cadence, as of `today`.
 *   no_cadence — no touch_interval_days set, so there is nothing to be on or off rhythm with.
 *   never      — a cadence, but no touch recorded yet (typically still Not Contacted).
 *   overdue    — last touch + interval is before today.
 *   due_soon   — falls due today or within the next 7 days.
 *   on_rhythm  — due more than 7 days out.
 */
export function cadenceStatus(
  lastTouch: string | null,
  interval: number | null,
  today: string
): { status: CadenceStatus; due: string | null; daysOver: number } {
  if (!interval) return { status: "no_cadence", due: null, daysOver: 0 };
  if (!lastTouch) return { status: "never", due: null, daysOver: 0 };
  const due = addDays(lastTouch, interval);
  const over = daysBetween(due, today);
  if (over > 0) return { status: "overdue", due, daysOver: over };
  if (-over <= 7) return { status: "due_soon", due, daysOver: over };
  return { status: "on_rhythm", due, daysOver: over };
}

/**
 * Did this contact reply to outreach? True when any response date falls on or after the first attempt and
 * no more than REPLY_WINDOW_DAYS after it. Same-day counts (dates carry no time). A response BEFORE the
 * first attempt is an earlier conversation, not a reply to this outreach.
 */
export function repliedWithin(firstAttempt: string, responses: string[], days = REPLY_WINDOW_DAYS): boolean {
  return responses.some((d) => {
    const gap = daysBetween(firstAttempt, d);
    return gap >= 0 && gap <= days;
  });
}

/** "41 of 180" always; "(23%)" only when the denominator clears the floor. */
export function countRatio(n: number, of: number, floor = RATIO_FLOOR): string {
  if (!of) return "none yet";
  return `${n} of ${of}${of >= floor ? ` (${Math.round((n / of) * 100)}%)` : ""}`;
}

export interface Row {
  contact_id: number;
  date: string;
  type: string;
  direction: string | null;
  outcome: string | null;
}

/** Same rule as ATTEMPT_SQL in attempts.ts: an attempt-type interaction that was not inbound. */
export const isAttemptRow = (r: Row) =>
  (ATTEMPT_TYPES as readonly string[]).includes(r.type) && r.direction !== "inbound";
/** A response from them: anything inbound, or a two-way exchange that is not a meeting. */
export const isResponseRow = (r: Row) =>
  r.direction === "inbound" || (r.direction === "two_way" && r.type !== "meeting");
const isHeldMeeting = (r: Row) => r.type === "meeting" && r.outcome !== "No-Show" && r.outcome !== "Cancelled";

export interface WeekRow {
  start: string;
  end: string;
  attempts: Record<string, number>;
  attemptsTotal: number;
  responses: number;
  meetingsHeld: number;
  bookedCalendar: number;
  bookedHand: number;
  commitmentsMade: number;
  commitmentsDone: number;
}

/** Buckets interactions, bookings and commitments into Sunday–Saturday weeks ending with `today`'s week. */
export function weeklyActivity(
  today: string,
  weeks: number,
  rows: Row[],
  bookings: { date: string; origin: string }[],
  commitments: { created: string | null; done: string | null }[]
): WeekRow[] {
  const out: WeekRow[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const { start, end } = weekBounds(shiftWeek(today, -i));
    const inWeek = (d: string | null) => !!d && d.slice(0, 10) >= start && d.slice(0, 10) <= end;
    const attempts: Record<string, number> = Object.fromEntries(ATTEMPT_TYPES.map((t) => [t, 0]));
    let responses = 0,
      meetingsHeld = 0;
    for (const r of rows) {
      if (!inWeek(r.date)) continue;
      if (isAttemptRow(r)) attempts[r.type]++;
      if (isResponseRow(r)) responses++;
      if (isHeldMeeting(r)) meetingsHeld++;
    }
    out.push({
      start,
      end,
      attempts,
      attemptsTotal: Object.values(attempts).reduce((a, b) => a + b, 0),
      responses,
      meetingsHeld,
      bookedCalendar: bookings.filter((b) => inWeek(b.date) && b.origin === "calendar-sync").length,
      bookedHand: bookings.filter((b) => inWeek(b.date) && b.origin !== "calendar-sync").length,
      commitmentsMade: commitments.filter((c) => inWeek(c.created)).length,
      commitmentsDone: commitments.filter((c) => inWeek(c.done)).length,
    });
  }
  return out;
}

/**
 * Responsiveness for contacts whose FIRST outreach fell in [from, to]. The window deliberately ends
 * REPLY_WINDOW_DAYS before today, so every contact counted has had the full 14 days to answer — counting
 * last week's outreach would read as "didn't reply" when it is really "hasn't had time to".
 */
export function responsiveness(
  rows: Row[],
  from: string,
  to: string,
  isPriority: (id: number) => boolean
): { priority: { n: number; of: number }; others: { n: number; of: number } } {
  const first = new Map<number, string>();
  const responses = new Map<number, string[]>();
  for (const r of rows) {
    if (isAttemptRow(r) && r.direction === "outbound") {
      const f = first.get(r.contact_id);
      if (!f || r.date < f) first.set(r.contact_id, r.date);
    }
    if (isResponseRow(r)) (responses.get(r.contact_id) ?? responses.set(r.contact_id, []).get(r.contact_id)!).push(r.date);
  }
  const acc = { priority: { n: 0, of: 0 }, others: { n: 0, of: 0 } };
  for (const [id, f] of first) {
    if (f < from || f > to) continue;
    const g = isPriority(id) ? acc.priority : acc.others;
    g.of++;
    if (repliedWithin(f, responses.get(id) ?? [])) g.n++;
  }
  return acc;
}

// ---------------------------------------------------------------- data

interface PriorityContact {
  id: number;
  full_name: string;
  stage: string;
  last_touch: string | null;
  touch_interval_days: number | null;
  organization_name: string | null;
}

export async function loadAnalytics(db: D1Db, today: string) {
  const since = weekBounds(shiftWeek(today, -(WEEKS_SHOWN - 1))).start;
  // Responsiveness looks back further than the table (first attempts up to 42 days ago), so load from there.
  const respFrom = addDays(today, -42);
  const loadFrom = since < respFrom ? since : respFrom;

  const [priority, rows, bookings, commitments, time] = await Promise.all([
    db
      .prepare(
        `SELECT c.id, c.full_name, c.stage, c.last_touch, c.touch_interval_days, o.name AS organization_name
           FROM contact c LEFT JOIN organization o ON o.id = c.organization_id
          WHERE c.status = 'active' AND c.is_priority = 1`
      )
      .all<PriorityContact>(),
    db
      .prepare(
        `SELECT i.contact_id, i.date, i.type, i.direction, i.outcome
           FROM interaction i JOIN contact c ON c.id = i.contact_id
          WHERE c.status = 'active' AND i.date >= ?`
      )
      .bind(loadFrom)
      .all<Row>(),
    // changed_at is UTC; the date part is close enough for weekly buckets.
    db
      .prepare(
        `SELECT substr(changed_at, 1, 10) AS date, origin FROM contact_stage_event
          WHERE to_stage = 'meeting_scheduled' AND (from_stage IS NULL OR from_stage <> 'meeting_scheduled')
            AND changed_at >= ?`
      )
      .bind(since)
      .all<{ date: string; origin: string }>(),
    db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS created, substr(done_at, 1, 10) AS done FROM action_item
          WHERE created_at >= ? OR done_at >= ?`
      )
      .bind(since, since)
      .all<{ created: string | null; done: string | null }>(),
    db
      .prepare(
        `SELECT substr(t.date, 1, 7) AS month, t.activity, SUM(t.hours) AS hours, ifnull(a.is_work, 1) AS is_work
           FROM time_entry t LEFT JOIN activity a ON a.name = t.activity
          WHERE t.date >= ? GROUP BY month, t.activity`
      )
      .bind(`${addDays(today.slice(0, 7) + "-01", -62).slice(0, 7)}-01`)
      .all<{ month: string; activity: string; hours: number; is_work: number }>(),
  ]);
  return { since, priority: priority.results, rows: rows.results, bookings: bookings.results, commitments: commitments.results, time: time.results };
}

// ---------------------------------------------------------------- Monday scorecard (digest)

export interface ScorecardLine {
  who: string;
  detail: string;
  href: string;
}

/**
 * Three lines for the Monday digest (2026-09-25): the priority circle's pace against plan, who is
 * drifting, and reply rates. The same definitions as the Analytics page, computed by the same helpers,
 * so the email and the page cannot disagree.
 */
export async function weeklyScorecard(db: D1Db, today: string): Promise<ScorecardLine[]> {
  const d = await loadAnalytics(db, today);
  const ids = new Set(d.priority.map((p) => p.id));
  const planned = d.priority.reduce((s, p) => s + (p.touch_interval_days ? 7 / p.touch_interval_days : 0), 0);
  const touched = new Set(
    d.rows.filter((r) => ids.has(r.contact_id) && r.date >= addDays(today, -7) && r.date <= addDays(today, -1)).map((r) => r.contact_id)
  ).size;
  const st = d.priority.map((p) => ({ p, ...cadenceStatus(p.last_touch, p.touch_interval_days, today) }));
  const over = st.filter((x) => x.status === "overdue").sort((a, b) => b.daysOver - a.daysOver);
  const never = st.filter((x) => x.status === "never").length;
  const resp = responsiveness(d.rows, addDays(today, -42), addDays(today, -(REPLY_WINDOW_DAYS + 1)), (id) => ids.has(id));
  return [
    {
      who: "Priority pace",
      detail: `${touched} of your ${d.priority.length} priority contacts touched last week, against a planned ${planned.toFixed(1)} a week`,
      href: "/analytics",
    },
    {
      who: "Drifting",
      detail: over.length
        ? `${over.length} overdue (${over
            .slice(0, 3)
            .map((x) => `${x.p.full_name} ${x.daysOver}d`)
            .join(", ")}${over.length > 3 ? ", …" : ""}); ${never} not touched yet`
        : `nobody overdue; ${never} not touched yet`,
      href: "/analytics",
    },
    {
      who: "Replies",
      detail: `priority contacts ${countRatio(resp.priority.n, resp.priority.of)}, everyone else ${countRatio(resp.others.n, resp.others.of)} (first reached 15–42 days ago, replied within 14 days)`,
      href: "/analytics",
    },
  ];
}

// ---------------------------------------------------------------- page

const STATUS_META: Record<CadenceStatus, { label: string; pill: string; what: string }> = {
  overdue: { label: "Overdue", pill: "red", what: "past their touch cadence" },
  due_soon: { label: "Due this week", pill: "amber", what: "fall due within 7 days" },
  on_rhythm: { label: "On rhythm", pill: "green", what: "touched within their cadence" },
  never: { label: "Not touched yet", pill: "grey", what: "have a cadence but no touch recorded" },
  no_cadence: { label: "No cadence", pill: "grey", what: "have no Touch Every interval set" },
};

const fmtDay = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
const bar = (n: number, max: number) =>
  `<div class="bar" style="width:${max ? Math.max(2, Math.round((n / max) * 100)) : 0}%"></div>`;

app.get("/analytics", async (c) => {
  const today = localToday();
  const d = await loadAnalytics(c.env.DB, today);
  const priorityIds = new Set(d.priority.map((p) => p.id));

  // 1. Priority circle health
  const statuses = d.priority.map((p) => ({ p, ...cadenceStatus(p.last_touch, p.touch_interval_days, today) }));
  const count = (s: CadenceStatus) => statuses.filter((x) => x.status === s).length;
  const drifting = statuses.filter((x) => x.status === "overdue").sort((a, b) => b.daysOver - a.daysOver);
  const planned = d.priority.reduce((sum, p) => sum + (p.touch_interval_days ? 7 / p.touch_interval_days : 0), 0);
  const touchedBetween = (from: string, to: string) =>
    new Set(d.rows.filter((r) => priorityIds.has(r.contact_id) && r.date >= from && r.date <= to).map((r) => r.contact_id)).size;
  const touched7 = touchedBetween(addDays(today, -6), today);
  const touched28 = [0, 1, 2, 3].map((w) => touchedBetween(addDays(today, -6 - 7 * w), addDays(today, -7 * w)));
  const avg28 = touched28.reduce((a, b) => a + b, 0) / 4;
  const last28 = d.rows.filter((r) => r.date >= addDays(today, -27) && isAttemptRow(r));
  const toCircle = last28.filter((r) => priorityIds.has(r.contact_id)).length;

  // 2. Weekly activity
  const weeks = weeklyActivity(today, WEEKS_SHOWN, d.rows, d.bookings, d.commitments);
  const maxAttempts = Math.max(1, ...weeks.map((w) => w.attemptsTotal));

  // 3. Responsiveness: first outreach 15–42 days ago, so each contact has had the full 14 days.
  const respTo = addDays(today, -(REPLY_WINDOW_DAYS + 1));
  const respFrom = addDays(today, -42);
  const resp = responsiveness(d.rows, respFrom, respTo, (id) => priorityIds.has(id));

  // 4. Time mix by month
  const months = [...new Set(d.time.map((t) => t.month))].sort().slice(-3);
  const monthRows = months.map((m) => {
    const rows = d.time.filter((t) => t.month === m);
    const worked = rows.filter((t) => t.is_work).reduce((a, t) => a + t.hours, 0);
    const billable = rows.filter((t) => t.activity === BILLABLE_ACTIVITY).reduce((a, t) => a + t.hours, 0);
    const sales = rows.filter((t) => t.activity === SALES_ACTIVITY).reduce((a, t) => a + t.hours, 0);
    const top = rows
      .filter((t) => t.is_work)
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 3)
      .map((t) => `${t.activity} ${t.hours.toFixed(1)}h`)
      .join(" · ");
    return { m, worked, billable, sales, top };
  });
  const maxWorked = Math.max(1, ...monthRows.map((r) => r.worked));
  const monthName = (ym: string) =>
    new Date(`${ym}-01T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  const stat = (n: string | number, label: string) =>
    `<div class="stat"><div class="stat-num">${n}</div><div class="stat-label">${label}</div></div>`;

  const body = `<main>
  <h1>Analytics</h1>
  <p class="sub">Is the system working? Your priority circle's rhythm, what outreach is turning into, and where the time goes. As of ${esc(today)}, ${esc(zoneLabel())}. Stage movement is on <a href="/pipeline">Pipeline</a>; weekly hours by customer are on <a href="/time/report">Time Report</a>.</p>

  <section>
    <h2>Priority circle</h2>
    <p class="meta" style="margin:0 0 10px">Your ${d.priority.length} ★ priority contacts, each measured against their own Touch Every cadence: last touch plus the interval gives the day they fall due.</p>
    <div class="stat-row">
      ${(["overdue", "due_soon", "on_rhythm", "never", "no_cadence"] as CadenceStatus[])
        .map((s) => stat(count(s), `<span class="pill ${STATUS_META[s].pill}">${STATUS_META[s].label}</span>`))
        .join("")}
    </div>
    <dl class="grid2">
      <dt>This week's pace</dt><dd><b>${touched7}</b> priority contacts touched in the last 7 days, against a planned <b>${planned.toFixed(1)}</b> a week (the sum of 7 ÷ each cadence). Average over the last 4 weeks: ${avg28.toFixed(1)}.</dd>
      <dt>Outreach reaching the circle</dt><dd>${countRatio(toCircle, last28.length)} outreach attempts in the last 28 days went to priority contacts.</dd>
    </dl>
    <h3 style="font-size:14px;margin:16px 0 6px">Drifting: overdue, most overdue first</h3>
    ${
      drifting.length
        ? `<div class="list">${drifting
            .map(
              ({ p, daysOver }) => `<div class="listrow">
        <span class="dot red"></span>
        <div class="listrow-main">
          <div class="listrow-name"><a href="/contacts/${p.id}">${esc(p.full_name)}</a></div>
          <div class="meta">${esc(p.organization_name ?? "")}${p.organization_name ? " · " : ""}${esc(stageLabel(p.stage))}</div>
        </div>
        <div class="listrow-meta"><span class="pill red">${daysOver} day${daysOver === 1 ? "" : "s"} over</span>
          <div class="meta">last touch ${esc(p.last_touch ?? "")}, every ${p.touch_interval_days} days</div></div>
      </div>`
            )
            .join("")}</div>`
        : '<p class="empty">Nobody in the circle is past their cadence.</p>'
    }
  </section>

  <section>
    <h2>Weekly activity</h2>
    <p class="meta" style="margin:0 0 10px">The last ${WEEKS_SHOWN} weeks, Sunday to Saturday. <b>Outreach</b> counts emails, LinkedIn messages, texts and calls you sent (the same rule as the chase list). <b>Replies</b> counts anything inbound, or a two-way exchange that isn't a meeting. <b>Meetings booked</b> counts contacts moving into Meeting Scheduled, from your calendar or set by hand.</p>
    <div style="overflow-x:auto">
    <table>
      <thead><tr><th>Week</th><th>Outreach</th><th></th><th>Replies</th><th>Meetings held</th><th>Booked (calendar / hand)</th><th>Commitments (made / done)</th></tr></thead>
      <tbody>${weeks
        .map(
          (w) => `<tr>
        <td class="mono" data-label="Week">${fmtDay(w.start)}–${fmtDay(w.end)}</td>
        <td class="mono" data-label="Outreach"><b>${w.attemptsTotal}</b><div class="meta">${ATTEMPT_TYPES.filter((t) => w.attempts[t])
            .map((t) => `${w.attempts[t]} ${t}`)
            .join(" · ")}</div></td>
        <td style="min-width:90px">${bar(w.attemptsTotal, maxAttempts)}</td>
        <td class="mono" data-label="Replies">${w.responses}</td>
        <td class="mono" data-label="Meetings held">${w.meetingsHeld}</td>
        <td class="mono" data-label="Booked">${w.bookedCalendar} / ${w.bookedHand}</td>
        <td class="mono" data-label="Commitments">${w.commitmentsMade} / ${w.commitmentsDone}</td>
      </tr>`
        )
        .join("")}</tbody>
    </table>
    </div>
  </section>

  <section>
    <h2>Responsiveness</h2>
    <p class="meta" style="margin:0 0 10px">Of the contacts you first reached out to between ${esc(respFrom)} and ${esc(respTo)}, how many replied within ${REPLY_WINDOW_DAYS} days. The window stops ${REPLY_WINDOW_DAYS + 1} days ago so everyone counted has had the full ${REPLY_WINDOW_DAYS} days. A reply isn't linked to the email that prompted it, so this counts <em>any</em> inbound or two-way contact in that window, which is a heuristic. Percentages appear only from ${RATIO_FLOOR} contacts up.</p>
    <dl class="grid2">
      <dt>★ Priority contacts</dt><dd><b>${countRatio(resp.priority.n, resp.priority.of)}</b> replied</dd>
      <dt>Everyone else</dt><dd><b>${countRatio(resp.others.n, resp.others.of)}</b> replied</dd>
    </dl>
  </section>

  <section>
    <h2>Time mix by month</h2>
    <p class="meta" style="margin:0 0 10px">Worked hours (activities marked as work), with billable Client Delivery and Pursuit/Proposal (selling) hours broken out. The current month is partial.</p>
    ${
      monthRows.length
        ? `<div style="overflow-x:auto"><table>
      <thead><tr><th>Month</th><th>Worked</th><th></th><th>Billable</th><th>Selling</th><th>Largest activities</th></tr></thead>
      <tbody>${monthRows
        .map(
          (r) => `<tr>
        <td data-label="Month">${esc(monthName(r.m))}</td>
        <td class="mono" data-label="Worked"><b>${r.worked.toFixed(1)}h</b></td>
        <td style="min-width:90px">${bar(r.worked, maxWorked)}</td>
        <td class="mono" data-label="Billable">${r.billable.toFixed(1)}h${r.worked ? ` <span class="meta">(${Math.round((r.billable / r.worked) * 100)}%)</span>` : ""}</td>
        <td class="mono" data-label="Selling">${r.sales.toFixed(1)}h</td>
        <td class="meta" data-label="Largest">${esc(r.top)}</td>
      </tr>`
        )
        .join("")}</tbody></table></div>`
        : '<p class="empty">No time logged in the last three months.</p>'
    }
  </section>
</main>`;

  return c.html(layout({ c, title: "Analytics", body }));
});

export default app;
