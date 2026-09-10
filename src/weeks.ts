// Week boundaries for the dashboard.
//
// Definition: weeks run Sunday–Saturday, matching how the operator thinks about a calendar — not a
// rolling 7 days. "This Week" is today through the coming Saturday, so it shrinks as the week progresses;
// "Next Week" is the following Sunday–Saturday, which needs to be visible by Friday.
//
// SQLite modifiers do the work: date('now','weekday 6') = the coming Saturday (today if it IS Saturday).
// Next week therefore starts the day after that, which stays correct on every day including Sunday.
export const THIS_WEEK_END = "date('now','weekday 6')";
export const NEXT_WEEK_START = "date('now','weekday 6','+1 day')";
export const NEXT_WEEK_END = "date('now','weekday 6','+7 days')";

/**
 * The Sunday–Saturday week CONTAINING a given date (TIME-001, #90). Same definition as the constants
 * above; different job, so it is computed differently and worth saying why.
 *
 * Those constants are relative to `now` and are interpolated into dashboard queries. The time report
 * navigates to arbitrary past weeks, which `now`-relative SQL cannot express — and the obvious
 * `date(d,'weekday 0','-7 days')` is wrong on Sundays, because `weekday 0` returns the date itself when
 * it is already a Sunday, so a Sunday would be pushed into the previous week.
 *
 * Subtracting the day-of-week index is correct on all seven days. Done in TypeScript rather than SQL so
 * the boundaries can be shown in the page heading and used as bind parameters, instead of the query
 * being the only thing that knows which week it read. UTC throughout, matching every other date here.
 */
export function weekBounds(anchor: string): { start: string; end: string } {
  const d = new Date(`${anchor}T00:00:00Z`);
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - d.getUTCDay());
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** The same week shifted by n whole weeks. Negative goes back. */
export function shiftWeek(anchor: string, n: number): string {
  const d = new Date(`${anchor}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n * 7);
  return d.toISOString().slice(0, 10);
}

/*
 * PERIODS WIDER THAN A WEEK, for the hours report (TIME-002).
 *
 * The billable ("Client Delivery") time captured here feeds invoicing, and invoices are not weekly. The
 * report had only ever been able to answer a week, so a month or a quarter meant adding up four or
 * thirteen screens by hand — which is exactly the arithmetic the app exists to save the operator from.
 *
 * MONTHS AND QUARTERS ARE CALENDAR-ALIGNED, weeks stay Sunday–Saturday. That means a month and the weeks
 * inside it do NOT sum to the same number, and they should not: a week straddling the 1st belongs to two
 * months. Invoices follow the calendar, so the calendar wins for months and quarters; the weekly view is
 * for "where did my week go" and keeps the dashboard's Sunday start.
 *
 * `prior` is the SAME LENGTH of period immediately before, so the change column compares like with like —
 * month against month, quarter against quarter. Comparing a month to the week before it would produce a
 * "down 75%" that means nothing.
 */
export type Period = "week" | "month" | "quarter";

export const PERIODS: readonly Period[] = ["week", "month", "quarter"];

export const isPeriod = (v: string | undefined): v is Period =>
  v === "week" || v === "month" || v === "quarter";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

export function periodBounds(
  period: Period,
  anchor: string
): { start: string; end: string; label: string; prior: { start: string; end: string } } {
  if (period === "week") {
    const { start, end } = weekBounds(anchor);
    const p = weekBounds(shiftWeek(anchor, -1));
    return { start, end, label: `${start} to ${end}`, prior: p };
  }
  const d = new Date(`${anchor}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();

  if (period === "month") {
    const start = utc(y, m, 1);
    const end = utc(y, m + 1, 0); // day 0 of the next month is the last day of this one
    const pStart = utc(y, m - 1, 1);
    const pEnd = utc(y, m, 0);
    const label = start.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    return { start: iso(start), end: iso(end), label, prior: { start: iso(pStart), end: iso(pEnd) } };
  }

  // quarter: month 0-2 → Q1, 3-5 → Q2, and so on.
  const q = Math.floor(m / 3);
  const start = utc(y, q * 3, 1);
  const end = utc(y, q * 3 + 3, 0);
  const pStart = utc(y, q * 3 - 3, 1);
  const pEnd = utc(y, q * 3, 0);
  return {
    start: iso(start),
    end: iso(end),
    label: `Q${q + 1} ${y}`,
    prior: { start: iso(pStart), end: iso(pEnd) },
  };
}

/** The same period shifted by n whole periods. Returns an anchor date inside the target period. */
export function shiftPeriod(period: Period, anchor: string, n: number): string {
  if (period === "week") return shiftWeek(anchor, n);
  const d = new Date(`${anchor}T00:00:00Z`);
  const step = period === "month" ? n : n * 3;
  return iso(utc(d.getUTCFullYear(), d.getUTCMonth() + step, 1));
}
