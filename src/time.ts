/*
 * TIME-001 — where the week went (#90).
 *
 * The recurring ask this answers: knowing, each week, the hours worked on specific activities — not
 * just that time was spent, but on what.
 *
 * MANUAL ENTRY IS NOT A STOPGAP FOR THE CALENDAR IMPORT, and the distinction matters for how this is
 * built. The Outlook categories are standardised to make a calendar-to-timesheet workflow possible
 * (definitions.md §5a), and that needs Microsoft Graph (M365-001). But a calendar is only ever
 * a claim about where the time went: meetings run over, get cancelled without being deleted, and whole
 * afternoons of deep work never appear on it at all. So typing hours in stays the source of truth you can
 * correct, and the import — when it lands — writes into this same table with source='calendar' beside
 * these rows rather than replacing them.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. No billing, no invoicing, no rate arithmetic. `engagement` carries
 * billing_method and three rate fields, so the join exists the moment it is wanted, but "what should I
 * invoice" is a different question from "where did my week go" and answering both at once would mean
 * deciding what counts as billable before the operator has said so. Hours are recorded against an
 * engagement; money stays in QuickBooks.
 *
 * PERSONAL IS SHOWN BELOW THE LINE, NOT EXCLUDED. It is one of the ten Outlook categories, so it can be
 * logged — but it is not hours worked, and adding it to the worked total would overstate every week. The
 * report puts it under a rule and outside the total. Dropping it instead would make a week that was
 * mostly personal come back short with nothing saying why, which is the failure mode this codebase keeps
 * refusing: a number that is quietly wrong is worse than one that is visibly awkward.
 */

import { Hono } from "hono";
import { activityOptions, isKnownActivity, loadActivities, nonWorkNames, type ActivityRow } from "./activities";
import { pickableEngagements } from "./engagements";
import { esc, layout, select } from "./views";
import { BILLABLE_ACTIVITY, type Bindings, type D1Db, type TimeEntry } from "./types";
import { isPeriod, PERIODS, periodBounds, shiftPeriod, shiftWeek, weekBounds, type Period } from "./weeks";

const app = new Hono<{ Bindings: Bindings }>();
const ACTOR = "operator";
const today = () => new Date().toISOString().slice(0, 10);

/** "Fri" for 2026-08-14. Parsed as UTC so a date string never drifts a day by the server's zone. */
const dayShort = (iso: string) =>
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${iso}T00:00:00Z`).getUTCDay()] ?? "";

/** How many blank rows the entry form offers. Enough for a day's worth of blocks in one submit. */
const ENTRY_ROWS = 6;

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

/**
 * Hours as a person types them. Accepts "1.5", "1,5" is NOT accepted (ambiguous), ":30" is not a format
 * anyone uses in a text box, but "1:30" is — so it is read as an hour and thirty minutes.
 *
 * Bounded 0 < h <= 24 to match the CHECK constraint in migration 0012, so the app refuses with a sentence
 * rather than letting SQLite refuse with a 500. Rounded to two decimals: "1:20" is 1.3333… and storing the
 * full float would make a week's total end in noise.
 */
export function parseHours(raw: string): { hours: number } | { error: string } {
  const s = raw.trim();
  if (!s) return { error: "no hours given" };
  let n: number;
  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(s);
  if (clock) {
    n = Number(clock[1]) + Number(clock[2]) / 60;
  } else {
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return { error: `“${s}” is not a number of hours` };
    n = Number(s);
  }
  n = Math.round(n * 100) / 100;
  if (!(n > 0)) return { error: "hours must be more than zero — a zero-hour entry is a note, not time" };
  if (n > 24) return { error: `${n} hours is more than a day` };
  return { hours: n };
}

async function audit(db: D1Db, id: number, action: string, after: string, before?: string) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,'time_entry',?,?,?,?,'app',?)"
    )
    .bind(ACTOR, String(id), action, before ?? null, after, `time-${id}`)
    .run();
}

export async function entriesForWeek(db: D1Db, start: string, end: string): Promise<TimeEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT t.*, e.name AS engagement_name, o.name AS organization_name, c.full_name AS contact_name
         FROM time_entry t
         LEFT JOIN engagement e ON e.id = t.engagement_id
         LEFT JOIN organization o ON o.id = e.organization_id
         LEFT JOIN contact c ON c.id = t.contact_id
        WHERE t.date >= ? AND t.date <= ?
        ORDER BY t.date, t.id`
    )
    .bind(start, end)
    .all<TimeEntry>();
  return results;
}

/** Totals for a period, grouped however the caller asks. Rounded once, at the edge. */
async function totalsByActivity(db: D1Db, start: string, end: string) {
  const { results } = await db
    .prepare(
      `SELECT activity, ROUND(SUM(hours), 2) AS hours FROM time_entry
        WHERE date >= ? AND date <= ? GROUP BY activity ORDER BY hours DESC`
    )
    .bind(start, end)
    .all<{ activity: string; hours: number }>();
  return results;
}

/*
 * Hours per customer, SPLIT INTO BILLABLE AND NOT.
 *
 * The split is the whole point of this query, and it was not in the first version. The billable activity
 * — the one used for invoicing — has to be visible on its own. A single per-customer total silently
 * conflates two different things — the delivery you bill for, and the business development, travel and
 * admin that happen to be attached to the same engagement.
 * Reading a combined total as an invoice line would overbill, which is the one error in this app that
 * reaches somebody else's money.
 *
 * So both numbers travel, ordered by the billable one, and the report labels which is which.
 */
async function totalsByCustomer(db: D1Db, start: string, end: string) {
  const { results } = await db
    .prepare(
      `SELECT e.id AS engagement_id, e.name AS engagement_name, e.qb_customer_id,
              o.name AS organization_name,
              ROUND(SUM(t.hours), 2) AS hours,
              ROUND(SUM(CASE WHEN t.activity = ? THEN t.hours ELSE 0 END), 2) AS billable_hours
         FROM time_entry t
         LEFT JOIN engagement e ON e.id = t.engagement_id
         LEFT JOIN organization o ON o.id = e.organization_id
        WHERE t.date >= ? AND t.date <= ?
        GROUP BY t.engagement_id ORDER BY billable_hours DESC, hours DESC`
    )
    .bind(BILLABLE_ACTIVITY, start, end)
    .all<{
      engagement_id: number | null;
      engagement_name: string | null;
      qb_customer_id: string | null;
      organization_name: string | null;
      hours: number;
      billable_hours: number;
    }>();
  return results;
}

/**
 * Client Delivery hours in the period that are attached to NO engagement.
 *
 * The one number on this page that is unambiguously a problem rather than information: delivery work with
 * no customer on it cannot be invoiced, and unlike a missing QuickBooks id it cannot even be traced to who
 * owes for it. Surfaced separately and loudly for that reason.
 */
async function unattributedBillable(db: D1Db, start: string, end: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT ROUND(SUM(hours), 2) AS hours FROM time_entry
        WHERE date >= ? AND date <= ? AND activity = ? AND engagement_id IS NULL`
    )
    .bind(start, end, BILLABLE_ACTIVITY)
    .first<{ hours: number | null }>();
  return row?.hours ?? 0;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""));
const bar = (hours: number, max: number) =>
  `<div class="barwrap"><div class="bar" style="width:${max > 0 ? Math.round((hours / max) * 100) : 0}%"></div></div>`;

/** The week being looked at, from ?week=, defaulting to the week containing today. */
function requestedWeek(raw: string | undefined): { anchor: string; start: string; end: string } {
  const anchor = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : today();
  const { start, end } = weekBounds(anchor);
  return { anchor, start, end };
}

/*
 * Nav for the hours report, which can now be a week, a month or a quarter (TIME-002).
 *
 * `/time` keeps weekNav below and is untouched — logging time is a weekly act, and widening that screen
 * would invite entering hours against a month, which is not a thing.
 */
const PERIOD_LABEL: Record<Period, string> = { week: "Week", month: "Month", quarter: "Quarter" };

function periodNav(path: string, period: Period, anchor: string, label: string, extra = ""): string {
  const tabs = PERIODS.map(
    (p) =>
      `<a class="${p === period ? "btn" : "btn secondary"}" href="${path}?period=${p}&anchor=${esc(
        anchor
      )}${extra}">${esc(PERIOD_LABEL[p])}</a>`
  ).join(" ");
  const step = (n: number, text: string) =>
    `<a href="${path}?period=${period}&anchor=${esc(shiftPeriod(period, anchor, n))}${extra}">${text}</a>`;
  return `<div class="actions" style="margin:0 0 10px">${tabs}</div>
    <p class="sub">${step(-1, "← previous")} · <b>${esc(label)}</b> · ${step(1, "next →")}</p>`;
}

const weekNav = (path: string, anchor: string, start: string, end: string) =>
  `<p class="sub"><a href="${path}?week=${esc(shiftWeek(anchor, -1))}">← previous week</a> ·
    <b>${esc(start)} to ${esc(end)}</b> ·
    <a href="${path}?week=${esc(shiftWeek(anchor, 1))}">next week →</a>${
      start !== weekBounds(today()).start ? ` · <a href="${path}">this week</a>` : ""
    }</p>`;

// ---------------------------------------------------------------- entry

const FLASH: Record<string, string> = {
  logged: '<div class="flash ok">Time logged.</div>',
  deleted: '<div class="flash ok">Entry deleted.</div>',
  saved: '<div class="flash ok">Entry updated.</div>',
  nothing:
    '<div class="flash warn">No rows had both hours and an activity, so nothing was logged. A row needs at least those two.</div>',
  created: '<div class="flash ok">Imported from Outlook. The entries are below, marked as coming from the calendar.</div>',
  updated:
    '<div class="flash ok">Updated the entries this week\'s import had already created. Nothing was duplicated, and nothing you typed by hand was touched.</div>',
  both: '<div class="flash ok">Imported from Outlook — some entries created, some updated in place.</div>',
};

/*
 * One row of the entry form.
 *
 * EVERY CELL CARRIES data-label. Without them the phone stylesheet turns this table into unlabelled
 * cards — the <thead> is hidden below 640px, so six identical blocks of date / number / dropdown /
 * dropdown / text appear with nothing saying which is which. Measured on a 390px screen before this was
 * added. The #86 note allowed label-less tables on the grounds that audit, templates and import are "desk
 * work anyway"; time entry is the opposite, and is the case that note said would earn the attribute.
 */
function entryRow(
  i: number,
  engagements: { id: number; label: string }[],
  defaultDate: string,
  activityOpts: readonly (readonly [string, string])[]
): string {
  return `<tr>
      <td data-label="Date"><input type="date" name="date_${i}" value="${
        i === 0 ? esc(defaultDate) : ""
      }" aria-label="Date, row ${i + 1}"></td>
      <td data-label="Hours"><input type="text" name="hours_${i}" placeholder="1.5" inputmode="decimal" aria-label="Hours, row ${
        i + 1
      }" style="max-width:110px"></td>
      <td data-label="Activity">${select(`activity_${i}`, activityOpts, null, { blank: "—" })}</td>
      <td data-label="Customer"><select name="engagement_${i}" aria-label="Customer, row ${
        i + 1
      }"><option value="">— no customer —</option>${engagements
        .map((e) => `<option value="${e.id}">${esc(e.label)}</option>`)
        .join("")}</select></td>
      <td data-label="Comments"><input type="text" name="note_${i}" placeholder="optional" aria-label="Comments, row ${
        i + 1
      }"></td>
    </tr>`;
}

/*
 * ONE ROW IS VISIBLE; THE REST ARE BEHIND A DISCLOSURE.
 *
 * Six open rows measured 2,000px of blank form on a phone before the list of what you actually logged
 * came into view — which inverts the page: the answer to "what have I logged this week" sat below six
 * empty things to fill in. And six rows is desk behaviour. On a phone the real act is logging one block of
 * time straight after it happened, which is the whole reason UX-001 exists.
 *
 * A separate <table> inside the <details> rather than rows inside one tbody, because a <details> is not
 * valid inside <tbody> and browsers recover from that by hoisting it out of the table entirely. Same
 * ▸/▾ vocabulary as the dashboard sections and the interaction history.
 */
function entryForm(
  engagements: { id: number; label: string }[],
  defaultDate: string,
  week: string,
  activityOpts: readonly (readonly [string, string])[]
): string {
  const head = `<thead><tr><th>Date</th><th>Hours</th><th>Activity</th><th>Customer</th><th>Comments</th></tr></thead>`;
  const extra = Array.from({ length: ENTRY_ROWS - 1 }, (_, n) =>
    entryRow(n + 1, engagements, defaultDate, activityOpts)
  ).join("");
  return `<form method="post" action="/time" class="card">
    ${/* So the redirect after saving comes back to the week you were looking at, not to this one. */ ""}
    <input type="hidden" name="week" value="${esc(week)}">
    <h2>Log time</h2>
    <p class="meta">Hours as <code>1.5</code> or <code>1:30</code>. Leave the customer blank for anything that is not client work — Admin, Firm development and Marketing usually are not.</p>
    <table>${head}<tbody>${entryRow(0, engagements, defaultDate, activityOpts)}</tbody></table>
    <details class="hist-more" style="margin-top:10px">
      ${/* No literal ▸ in the summary: unlike .dash and .hist-row, the .hist-more rule does not set
           list-style:none, so the browser draws its own marker and a hardcoded one rendered "▸ ▸". */ ""}
      <summary>Add several at once</summary>
      <table style="margin-top:8px">${head}<tbody>${extra}</tbody></table>
      <p class="meta" style="margin-top:6px">Blank rows are ignored. A row with something in it but no hours or no activity is reported back rather than dropped.</p>
    </details>
    <div class="actions"><button type="submit">Log Time</button>
      ${
        engagements.length
          ? '<a class="btn secondary" href="/engagements">Manage customers</a>'
          : '<a class="btn secondary" href="/engagements/new">Add a customer first</a>'
      }
      <a class="btn secondary" href="/activities">Manage activities</a></div>
  </form>`;
}

app.get("/time", async (c) => {
  const { anchor, start, end } = requestedWeek(c.req.query("week"));
  const entries = await entriesForWeek(c.env.DB, start, end);
  const engagements = await pickableEngagements(c.env.DB);
  const activityRows = await loadActivities(c.env.DB);
  const nonWork = nonWorkNames(activityRows);
  const worked = entries.filter((e) => !nonWork.has(e.activity)).reduce((n, e) => n + e.hours, 0);
  const personal = entries.filter((e) => nonWork.has(e.activity)).reduce((n, e) => n + e.hours, 0);

  /*
   * Grouped by day rather than listed flat. A flat list of eleven rows makes you count to answer "did I
   * log anything on Wednesday", which is the question you actually have when filling this in — and an
   * empty day is worth seeing as an empty day rather than as an absence you have to notice.
   */
  const days: { date: string; rows: TimeEntry[] }[] = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(`${start}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + i);
    const iso = day.toISOString().slice(0, 10);
    days.push({ date: iso, rows: entries.filter((e) => e.date === iso) });
  }
  const dayName = (iso: string) =>
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
      new Date(`${iso}T00:00:00Z`).getUTCDay()
    ];

  const list = days
    .map((d) => {
      const total = d.rows.reduce((n, r) => n + r.hours, 0);
      return `<tr${d.rows.length ? "" : ' class="meta"'}>
      <td><b>${esc(dayName(d.date))}</b><div class="meta">${esc(d.date)}${
        d.date === today() ? " · today" : ""
      }</div></td>
      <td data-label="Logged">${
        d.rows.length
          ? d.rows
              .map(
                (r) => `<div style="margin-bottom:6px"><b>${esc(fmt(r.hours))}h</b> ${esc(r.activity)}${
                  r.engagement_name
                    ? ` <span class="pill">${esc(r.organization_name ?? r.engagement_name)}</span>`
                    : ""
                }${
                  /* Subject first — it says what the block WAS. The comment sits under it in the same
                     grey, prefixed, so on an imported row it is visible which line came from Outlook and
                     which line is the operator's own. On a hand-typed row there is no subject and the
                     comment is the only line, so the prefix would be noise; it is dropped in that case. */ ""
                }${
                  r.hand_edited
                    ? ' <span class="pill grey">corrected — import will not overwrite</span>'
                    : ""
                }${r.subject ? `<div class="meta">${esc(r.subject)}</div>` : ""}${
                  r.note
                    ? `<div class="meta">${r.subject ? "— " : ""}${esc(r.note)}</div>`
                    : ""
                }
                  <span class="meta"><a href="/time/${r.id}/edit">edit</a></span></div>`
              )
              .join("")
          : "nothing logged"
      }</td>
      <td class="num" data-label="Total">${total ? `<b>${esc(fmt(total))}</b>` : ""}</td>
    </tr>`;
    })
    .join("");

  return c.html(
    layout({
      title: "Time",
      body: `<main>
  ${FLASH[c.req.query("flash") ?? ""] ?? ""}
  ${
    /*
     * A partial save reports BOTH halves in one message — how many rows landed and exactly which ones did
     * not, with the reason per row. Six rows submitted with one bad number should not lose the other five,
     * and it must not claim to have saved all six either.
     */
    c.req.query("error") ? `<div class="flash warn">${esc(c.req.query("error"))}</div>` : ""
  }
  <h1>Time</h1>
  ${weekNav("/time", anchor, start, end)}
  <p class="sub"><b>${esc(fmt(worked))} hours worked</b>${
        personal ? ` · ${esc(fmt(personal))} not worked (personal, vacation, etc.), not counted` : ""
      } · <a href="/time/report?week=${esc(anchor)}">weekly report</a> · <a href="/time/import?week=${esc(anchor)}">import from Outlook</a> · <a href="/engagements">customers</a> · <a href="/">dashboard</a></p>
  ${entryForm(engagements, today() >= start && today() <= end ? today() : start, anchor, activityOptions(activityRows))}
  <table><tbody>${list}</tbody></table>
  <p class="meta" style="margin-top:8px">Weeks run Sunday–Saturday, the same as the dashboard. Non-work time (Personal, Vacation/Holiday, and any other activity marked that way) is logged if you log it, and is never included in hours worked.${
    engagements.length
      ? ""
      : ' No customers exist yet, so every entry will be unassigned — <a href="/engagements/new">add one</a> to break hours down by customer.'
  }</p>
</main>`,
    })
  );
});

app.post("/time", async (c) => {
  const f = await c.req.parseBody();
  const errors: string[] = [];
  let logged = 0;
  const activityRows = await loadActivities(c.env.DB);

  for (let i = 0; i < ENTRY_ROWS; i++) {
    const rawHours = str(f[`hours_${i}`]);
    const activity = str(f[`activity_${i}`]);
    const date = str(f[`date_${i}`]);
    const note = str(f[`note_${i}`]);
    const engagementRaw = str(f[`engagement_${i}`]);

    // A wholly blank row is an unused row, not an error.
    if (!rawHours && !activity && !note) continue;

    /*
     * A row with something in it but not enough is reported, never silently dropped. The same rule
     * parseActionItems follows on the meeting resolution form: a half-filled row means someone meant to
     * type something, and discarding it would look exactly like success.
     */
    if (!rawHours || !activity) {
      errors.push(`row ${i + 1} needs both hours and an activity`);
      continue;
    }
    if (!isKnownActivity(activityRows, activity)) {
      errors.push(`row ${i + 1}: “${activity}” is not an activity I recognise`);
      continue;
    }
    const parsed = parseHours(rawHours);
    if ("error" in parsed) {
      errors.push(`row ${i + 1}: ${parsed.error}`);
      continue;
    }
    if (!date) {
      errors.push(`row ${i + 1} needs a date`);
      continue;
    }

    const engagementId = engagementRaw ? Number(engagementRaw) : null;
    const inserted = await c.env.DB.prepare(
      `INSERT INTO time_entry (date, hours, activity, engagement_id, note, source)
       VALUES (?,?,?,?,?,'manual')`
    )
      .bind(date, parsed.hours, activity, Number.isFinite(engagementId) ? engagementId : null, note)
      .run();
    const id = inserted?.meta?.last_row_id ?? 0;
    await audit(c.env.DB, id, "create", `${parsed.hours}h ${activity} on ${date}${note ? ` — ${note}` : ""}`);
    logged++;
  }

  const week = str(f.week) ?? today();
  if (!logged && !errors.length) return c.redirect(`/time?week=${encodeURIComponent(week)}&flash=nothing`);
  if (errors.length)
    return c.redirect(
      `/time?week=${encodeURIComponent(week)}&error=${encodeURIComponent(
        `${
          logged === 0
            ? "Nothing was logged"
            : `${logged} row${logged === 1 ? "" : "s"} logged, the rest not`
        }: ${errors.join("; ")}.`
      )}`
    );
  return c.redirect(`/time?week=${encodeURIComponent(week)}&flash=logged`);
});

// ---------------------------------------------------------------- edit / delete one entry

app.get("/time/:id/edit", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM time_entry WHERE id = ?")
    .bind(c.req.param("id"))
    .first<TimeEntry>();
  if (!row) return c.notFound();
  const engagements = await pickableEngagements(c.env.DB);
  const activityRows = await loadActivities(c.env.DB);
  return c.html(
    layout({
      title: "Edit Time Entry",
      body: `<main>
  <h1>Edit Time Entry</h1>
  <p class="sub">${esc(fmt(row.hours))}h of ${esc(row.activity)} on ${esc(row.date)}${
        row.source === "calendar" ? " · imported from the calendar" : ""
      }</p>
  <form method="post" action="/time/${row.id}/edit" class="card">
    <div class="row">
      <div><label>Date</label><input type="date" name="date" value="${esc(row.date)}" required></div>
      <div><label>Hours <span class="hint">1.5 or 1:30</span></label><input type="text" name="hours" value="${esc(fmt(row.hours))}" required></div>
    </div>
    <div class="row">
      <div><label>Activity</label>${select("activity", activityOptions(activityRows), row.activity)}</div>
      <div><label>Customer</label><select name="engagement_id"><option value="">— no customer —</option>${engagements
        .map((e) => `<option value="${e.id}"${e.id === row.engagement_id ? " selected" : ""}>${esc(e.label)}</option>`)
        .join("")}</select></div>
    </div>
    ${
      /* The Outlook subject is shown, not edited. It is a record of what the calendar said, and letting it
         be rewritten here would make it a second comments box that the next import silently reverts. */ ""
    }${
      row.subject
        ? `<label>From the calendar</label>
    <p class="meta" style="margin-top:0">${esc(row.subject)} — Outlook's words. Re-importing this week refreshes it; it is not editable here.</p>`
        : ""
    }
    <label>Comments <span class="hint">yours — the import never overwrites this</span></label>
    <textarea name="note" rows="4" placeholder="What happened, what it was for, anything you'd want to remember when you invoice it.">${esc(
      row.note
    )}</textarea>
    <div class="actions"><button type="submit">Save Changes</button>
      <a class="btn secondary" href="/time?week=${esc(row.date)}">Cancel</a></div>
  </form>
  <form method="post" action="/time/${row.id}/delete" class="card">
    <h2>Delete This Entry</h2>
    <p class="meta">Removes it permanently. The deletion is written to the audit trail.</p>
    <div class="actions"><button type="submit" class="danger">Delete Entry</button></div>
  </form>
</main>`,
    })
  );
});

app.post("/time/:id/edit", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM time_entry WHERE id = ?").bind(id).first<TimeEntry>();
  if (!before) return c.notFound();
  const f = await c.req.parseBody();
  const date = str(f.date) ?? before.date;
  const activity = str(f.activity) ?? before.activity;
  const activityRows = await loadActivities(c.env.DB);
  if (!isKnownActivity(activityRows, activity))
    return c.redirect(`/time/${id}/edit?error=${encodeURIComponent("Unrecognised activity.")}`);
  const parsed = parseHours(str(f.hours) ?? String(before.hours));
  if ("error" in parsed) return c.redirect(`/time/${id}/edit?error=${encodeURIComponent(parsed.error)}`);
  const engagementRaw = str(f.engagement_id);
  const engagementId = engagementRaw ? Number(engagementRaw) : null;
  const note = str(f.note);

  const newEngagement = Number.isFinite(engagementId) ? engagementId : null;

  /*
   * CORRECTING AN IMPORTED ROW MARKS IT, SO THE NEXT IMPORT LEAVES IT ALONE (migration 0019).
   *
   * Only the facts Outlook also claims count: date, hours, activity, customer. Editing the Comments field
   * does NOT set the flag — comments are already safe from re-import (0017), and locking a row because
   * someone annotated it would block legitimate refreshes for nothing. The flag means "a human and Outlook
   * disagree about this row", not "a human touched this row".
   *
   * Only ever set, never cleared here, and only on rows the import created. A hand-typed row was never at
   * risk. Clearing is the import's job, and only when the operator explicitly ticks the flagged row.
   */
  const contradictsCalendar =
    before.source === "calendar" &&
    (date !== before.date ||
      parsed.hours !== before.hours ||
      activity !== before.activity ||
      newEngagement !== (before.engagement_id ?? null));

  await c.env.DB.prepare(
    `UPDATE time_entry SET date=?, hours=?, activity=?, engagement_id=?, note=?,
       hand_edited = CASE WHEN ? = 1 THEN 1 ELSE hand_edited END, updated_at=datetime('now')
      WHERE id=?`
  )
    .bind(date, parsed.hours, activity, newEngagement, note, contradictsCalendar ? 1 : 0, id)
    .run();
  const describe = (e: { hours: number; activity: string; date: string; note: string | null }) =>
    `${e.hours}h ${e.activity} on ${e.date}${e.note ? ` — ${e.note}` : ""}`;
  const after = describe({ hours: parsed.hours, activity, date, note });
  const wasBefore = describe(before);
  if (after === wasBefore && (before.engagement_id ?? null) === newEngagement)
    return c.redirect(`/time?week=${encodeURIComponent(date)}`);
  await audit(
    c.env.DB,
    id,
    "update",
    `${after}${
      contradictsCalendar && !before.hand_edited
        ? " — now differs from Outlook, so the import will no longer overwrite it"
        : ""
    }`,
    wasBefore
  );
  return c.redirect(`/time?week=${encodeURIComponent(date)}&flash=saved`);
});

app.post("/time/:id/delete", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM time_entry WHERE id = ?").bind(id).first<TimeEntry>();
  if (!before) return c.notFound();
  const removed = await c.env.DB.prepare("DELETE FROM time_entry WHERE id = ?").bind(id).run();
  // changes === 0 means something else already deleted it — a duplicated submit, not a real deletion, so
  // no audit event is written for it (#51).
  if ((removed.meta?.changes ?? 1) > 0)
    await audit(c.env.DB, id, "delete", `deleted ${before.hours}h ${before.activity} on ${before.date}`);
  return c.redirect(`/time?week=${encodeURIComponent(before.date)}&flash=deleted`);
});

// ---------------------------------------------------------------- the weekly report

app.get("/time/report", async (c) => {
  /*
   * PERIOD SELECTION, and backwards compatibility matters here. Every existing link into this page uses
   * `?week=YYYY-MM-DD` — the dashboard, the time screen, the import. Those must keep working untouched, so
   * `week` is still read as the anchor when `anchor` is absent, and the period defaults to week.
   */
  const period: Period = isPeriod(c.req.query("period")) ? (c.req.query("period") as Period) : "week";
  const rawAnchor = c.req.query("anchor") ?? c.req.query("week");
  const anchor = rawAnchor && /^\d{4}-\d{2}-\d{2}$/.test(rawAnchor) ? rawAnchor : today();
  const { start, end, label, prior } = periodBounds(period, anchor);

  /* Filter the billable detail to one customer — this is what makes it an invoice line rather than a report. */
  const customerRaw = c.req.query("customer");
  const customerId = customerRaw && /^\d+$/.test(customerRaw) ? Number(customerRaw) : null;

  const [byActivity, byActivityPrior, byCustomer, orphanBillable, weekEntries, activityDefs] = await Promise.all([
    totalsByActivity(c.env.DB, start, end),
    totalsByActivity(c.env.DB, prior.start, prior.end),
    totalsByCustomer(c.env.DB, start, end),
    unattributedBillable(c.env.DB, start, end),
    entriesForWeek(c.env.DB, start, end),
    loadActivities(c.env.DB),
  ]);

  // More than one activity can be non-work now (Personal, plus whatever else has joined it since 0026),
  // so this is every non-work row, not a single found one.
  const nonWork = nonWorkNames(activityDefs);
  const priorMap = new Map(byActivityPrior.map((r) => [r.activity, r.hours]));
  const work = byActivity.filter((r) => !nonWork.has(r.activity));
  const nonWorkRows = byActivity.filter((r) => nonWork.has(r.activity));
  const worked = work.reduce((n, r) => n + r.hours, 0);
  const workedPrior = byActivityPrior
    .filter((r) => !nonWork.has(r.activity))
    .reduce((n, r) => n + r.hours, 0);
  const maxActivity = Math.max(0, ...work.map((r) => r.hours));
  const maxCustomer = Math.max(0, ...byCustomer.map((r) => r.hours));

  /*
   * The change column compares like with like: the same weekday span, one week earlier. Shown as a signed
   * difference rather than a percentage — at these volumes a percentage swings wildly on small numbers
   * ("Admin up 400%" for two hours instead of half of one) and reads as a finding when it is noise.
   */
  const delta = (nowH: number, thenH: number | undefined) => {
    if (thenH === undefined) return '<span class="pill grey">new</span>';
    const d = Math.round((nowH - thenH) * 100) / 100;
    if (d === 0) return '<span class="meta">same</span>';
    return `<span class="pill ${d > 0 ? "green" : "grey"}">${d > 0 ? "+" : ""}${esc(fmt(d))}</span>`;
  };

  const activityRows = work.length
    ? work
        .map(
          (r) => `<tr>
      <td>${esc(r.activity)}${
        r.activity === BILLABLE_ACTIVITY
          ? ' <span class="pill green">billable — feeds invoicing</span>'
          : ""
      }${bar(r.hours, maxActivity)}</td>
      <td class="num" data-label="Hours"><b>${esc(fmt(r.hours))}</b></td>
      <td class="num" data-label="Share">${worked ? `${Math.round((r.hours / worked) * 100)}%` : ""}</td>
      <td class="num" data-label="vs last week">${delta(r.hours, priorMap.get(r.activity))}</td>
    </tr>`
        )
        .join("")
    : "";

  const maxBillable = Math.max(0, ...byCustomer.map((r) => r.billable_hours));
  const customerRows = byCustomer
    .map(
      (r) => `<tr>
      <td>${
        r.engagement_id
          ? `<b><a href="/time/report?period=${period}&anchor=${esc(anchor)}&customer=${
              r.engagement_id
            }">${esc(r.organization_name ?? "no customer name")}</a></b><div class="meta">${esc(r.engagement_name ?? "")}${
              r.qb_customer_id ? ` · QuickBooks <code>${esc(r.qb_customer_id)}</code>` : ""
            }</div>${
              r.qb_customer_id
                ? ""
                : ' <span class="pill amber">no QuickBooks id — cannot be reconciled</span>'
            }`
          : `<b>Not assigned to a customer</b><div class="meta">internal or unassigned time</div>`
      }${bar(r.billable_hours, maxBillable)}</td>
      ${/* The bar tracks the BILLABLE figure, not the total — it is the number being compared. */ ""}
      <td class="num" data-label="Client Delivery">${
        r.billable_hours ? `<b>${esc(fmt(r.billable_hours))}</b>` : '<span class="meta">—</span>'
      }</td>
      <td class="num" data-label="All hours"><span class="meta">${esc(fmt(r.hours))}</span></td>
    </tr>`
    )
    .join("");
  const billableTotal = byCustomer.reduce((n, r) => n + r.billable_hours, 0);

  /*
   * LINE BY LINE, FOR THE INVOICE.
   *
   * The by-customer table answers "how much"; this answers "for what", which is the question a client asks
   * when they read the invoice and the one a total cannot answer. It exists because the Comments field
   * (migration 0017) has nowhere else to surface — a sentence you write on a delivery hour and then never
   * see again is a sentence you stop writing.
   *
   * Billable rows only. Every activity listed here would be a wall, and the rest of the week is already
   * summarised above; this section is doing one job.
   */
  const billableRows = weekEntries
    .filter((e) => e.activity === BILLABLE_ACTIVITY)
    .filter((e) => customerId === null || e.engagement_id === customerId);
  const customerName =
    customerId === null
      ? null
      : byCustomer.find((r) => r.engagement_id === customerId)?.organization_name ??
        weekEntries.find((e) => e.engagement_id === customerId)?.organization_name ??
        null;
  const billableDetail = billableRows
    .map(
      (r) => `<tr>
      <td data-label="Date">${esc(r.date)}<div class="meta">${esc(dayShort(r.date))}</div></td>
      <td data-label="Customer">${
        r.engagement_id
          ? esc(r.organization_name ?? r.engagement_name ?? "")
          : '<span class="pill amber">no customer</span>'
      }</td>
      <td data-label="What">${
        r.subject || r.note
          ? `${r.subject ? `<b>${esc(r.subject)}</b>` : ""}${
              r.note ? `<div class="meta">${esc(r.note)}</div>` : ""
            }`
          : `<span class="meta">nothing recorded — <a href="/time/${r.id}/edit">add a comment</a></span>`
      }</td>
      <td class="num" data-label="Hours"><b>${esc(fmt(r.hours))}</b></td>
    </tr>`
    )
    .join("");

  return c.html(
    layout({
      title: "Weekly Hours",
      body: `<main>
  <h1>Weekly Hours</h1>
  ${periodNav("/time/report", period, anchor, label, customerId ? `&customer=${customerId}` : "")}
  <p class="sub"><a href="/time?week=${esc(anchor)}">log or edit time</a> · <a href="/engagements">customers</a> · <a href="/">dashboard</a></p>

  <section>
    <h2>Hours worked${worked ? ` — ${esc(fmt(worked))}` : ""}</h2>
    ${
      work.length
        ? `<table><thead><tr><th>Activity</th><th class="num">Hours</th><th class="num">Share</th><th class="num">vs prior</th></tr></thead><tbody>${activityRows}
      <tr><td><b>Total worked</b></td><td class="num"><b>${esc(fmt(worked))}</b></td><td></td>
        <td class="num">${delta(worked, workedPrior || undefined)}</td></tr></tbody></table>`
        : '<div class="empty">No hours logged for this week yet.</div>'
    }
    ${
      nonWorkRows.length
        ? `<p class="meta" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)"><b>${nonWorkRows
            .map((r) => `${esc(fmt(r.hours))} ${esc(r.activity)}`)
            .join(", ")}</b>, deliberately outside the total above — real time, logged if you log it, but not work.</p>`
        : ""
    }
    <p class="meta" style="margin-top:8px">Change is measured against the ${esc(
      period === "week" ? "same seven days a week earlier" : `preceding ${period}`
    )} (${esc(prior.start)} to ${esc(prior.end)}) and shown as a difference in hours rather than a percentage — at these volumes a percentage turns two hours of Admin into a dramatic swing that means nothing.</p>
  </section>

  <section>
    <h2>By customer — ${esc(fmt(billableTotal))} billable</h2>
    ${
      orphanBillable
        ? `<p class="flash warn"><b>${esc(fmt(orphanBillable))} hours of ${esc(
            BILLABLE_ACTIVITY
          )} have no customer on them.</b> That work cannot be invoiced, and unlike a missing QuickBooks id there is nothing on the record saying who it was for. Open <a href="/time?week=${esc(
            anchor
          )}">this week's entries</a> and set the customer while you still remember.</p>`
        : ""
    }
    ${
      byCustomer.length
        ? `<table><thead><tr><th>Customer</th><th class="num">${esc(
            BILLABLE_ACTIVITY
          )}</th><th class="num">All hours</th></tr></thead><tbody>${customerRows}</tbody></table>
    <p class="meta" style="margin-top:8px"><b>The ${esc(
      BILLABLE_ACTIVITY
    )} column is the invoicing number</b>; "All hours" is everything logged against that customer including business development, travel and admin. They are deliberately separate — reading a combined total as an invoice line would overbill, which is the one error here that reaches somebody else's money. The QuickBooks id is shown so a wrong one is visible where it matters, and <b>nothing verifies it</b>: there is no QuickBooks connection, so a mistyped id simply never reconciles and nothing else would tell you. Time with no customer is not hidden — internal work genuinely has none.</p>`
        : '<div class="empty">No hours logged for this week, so there is nothing to attribute.</div>'
    }
  </section>

  ${
    billableRows.length
      ? `<section>
    <h2>${esc(BILLABLE_ACTIVITY)}, line by line${
      customerId !== null ? ` — ${esc(customerName ?? "selected customer")}` : ""
    }</h2>
    <p class="sub">Every billable hour ${esc(
      period === "week" ? "this week" : `in ${label}`
    )}${customerId !== null ? " for this customer" : ""} and what it was for${
      customerId !== null
        ? ` · <a href="/time/report?period=${period}&anchor=${esc(anchor)}">show every customer</a>`
        : " — the detail behind the invoicing number above"
    }.</p>
    <table><thead><tr><th>Date</th><th>Customer</th><th>What</th><th class="num">Hours</th></tr></thead>
      <tbody>${billableDetail}
      <tr><td colspan="3"><b>Total</b></td><td class="num"><b>${esc(
        fmt(billableRows.reduce((n, r) => n + r.hours, 0))
      )}</b></td></tr></tbody></table>
    <p class="meta" style="margin-top:8px">Bold is what Outlook called the meeting; the line under it is your comment. A row with neither is billable time with no record of what it was — fine on the day, awkward a month later when the client queries the invoice.</p>
  </section>`
      : ""
  }

  <p class="meta">Activity categories map to Outlook one for one, with no translation table to fall out of date — <a href="/activities">manage the list</a>.</p>
</main>`,
    })
  );
});

export default app;
