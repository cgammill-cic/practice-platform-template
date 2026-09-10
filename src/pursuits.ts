/*
 * PURS-001 — the pipeline, the people on it, and what the wins and losses add up to.
 *
 * WHAT THIS IS NOT. There is no `pursuit` table. A pursuit and an engagement are the same row at
 * different ages — migration 0022's header carries the full argument, and the short version is that
 * `time_entry.engagement_id` is the only way this app attaches hours to work, so a separate table would
 * mean proposal hours could not be recorded against the proposal. This file is the screens for the early
 * part of that life.
 *
 * THE ONE THING TO BE CAREFUL ABOUT. `engagement` now holds rows that are not customers, so nothing here
 * may assume the table means "client". Status groups live in types.ts (PURSUIT_STAGES / LIVE_STAGES /
 * DEAD_STAGES) precisely so that rule is in one place instead of as literal strings on every screen.
 */

import { Hono } from "hono";
import { esc, layout, select } from "./views";
import {
  CLOSED_STAGES,
  DEAD_STAGES,
  ENGAGEMENT_STATUSES,
  LIVE_STAGES,
  OUTCOME_REASONS,
  PURSUIT_ORIGINS,
  PURSUIT_ROLES,
  PURSUIT_STAGES,
  SERVICE_TYPES,
  labelFor,
  type Bindings,
  type D1Db,
  type Engagement,
  type PursuitContact,
} from "./types";

const app = new Hono<{ Bindings: Bindings }>();
const ACTOR = "operator";

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

/** Whole dollars. Pipeline figures are estimates and cents on an estimate are a false precision. */
export function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

/** Today in the practice's configured time zone. Same reasoning, and the same bug avoided, as digest.ts localToday(). */
export function localToday(now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Resolves a typed person's name to a contact id.
 *
 * This is REL-005's `resolveReferrer` from contacts.ts, exported here so the engagement form's "Referred
 * by" field and the roles editor below share ONE definition rather than three near-copies that drift. The
 * contacts.ts twin is deliberately left where it is: it carries a self-reference check that only makes
 * sense for a contact referring a contact, and error copy about crediting a referral.
 *
 * AN AMBIGUOUS NAME IS REFUSED, NEVER GUESSED. `full_name` has no unique constraint, two same-named
 * contacts are creatable, and naming the wrong person as a decision maker is an error you would act on in
 * a meeting before noticing it on a screen.
 */
export async function resolveContactByName(
  db: D1Db,
  typed: string | null
): Promise<{ id: number | null } | { error: string }> {
  if (!typed) return { id: null };
  const { results } = await db
    .prepare("SELECT id, full_name FROM contact WHERE lower(full_name) = lower(?) AND status='active'")
    .bind(typed)
    .all<{ id: number; full_name: string }>();
  if (results.length === 0)
    return {
      error: `No active contact named “${typed}”. Pick a name from the suggestions, or add that person as a contact first — this field points at a real record rather than storing a name.`,
    };
  if (results.length > 1)
    return {
      error: `More than one active contact is named “${typed}”, so nothing was set. Open the right record to see which organization, then type the name exactly.`,
    };
  return { id: results[0].id };
}

/** Active contacts for the type-aheads, with their organization so a duplicate name is tellable apart. */
export async function peopleOptions(
  db: D1Db
): Promise<{ full_name: string; organization_name: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT c.full_name, o.name AS organization_name FROM contact c
         LEFT JOIN organization o ON o.id = c.organization_id
        WHERE c.status='active' ORDER BY c.full_name LIMIT 600`
    )
    .all<{ full_name: string; organization_name: string | null }>();
  return results;
}

export function peopleDatalist(
  id: string,
  rows: { full_name: string; organization_name: string | null }[]
): string {
  return `<datalist id="${id}">${rows
    .map((p) => `<option value="${esc(p.full_name)}">${esc(p.organization_name ?? "")}</option>`)
    .join("")}</datalist>`;
}

// ---------------------------------------------------------------- people on a pursuit

export async function pursuitPeople(db: D1Db, engagementId: number): Promise<PursuitContact[]> {
  const { results } = await db
    .prepare(
      `SELECT ec.engagement_id, ec.contact_id, ec.role, ec.note,
              c.full_name AS contact_name, c.title AS contact_title
         FROM engagement_contact ec JOIN contact c ON c.id = ec.contact_id
        WHERE ec.engagement_id = ?
        ORDER BY CASE ec.role
                   WHEN 'decision_maker' THEN 0 WHEN 'economic_buyer' THEN 1 WHEN 'champion' THEN 2
                   WHEN 'influencer' THEN 3 WHEN 'skeptic' THEN 4 ELSE 5 END, c.full_name`
    )
    .bind(engagementId)
    .all<PursuitContact>();
  return results;
}

/** The pursuits a contact is named on — for their record, so a role is never buried on one screen. */
export async function pursuitsForContact(
  db: D1Db,
  contactId: number
): Promise<{ id: number; name: string; status: string; role: string; organization_name: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.name, e.status, ec.role, o.name AS organization_name
         FROM engagement_contact ec
         JOIN engagement e ON e.id = ec.engagement_id
         LEFT JOIN organization o ON o.id = e.organization_id
        WHERE ec.contact_id = ?
        ORDER BY e.status, o.name, e.name`
    )
    .bind(contactId)
    .all<{ id: number; name: string; status: string; role: string; organization_name: string | null }>();
  return results;
}

/**
 * The roles block on the engagement edit page.
 *
 * A SEPARATE FORM, POSTING SEPARATELY, rather than fields inside the engagement form. Two reasons, and
 * the second is the real one: a variable number of rows inside one form needs either JavaScript or a
 * fixed number of empty slots, and a validation failure anywhere in the engagement form would otherwise
 * discard a half-typed person along with it. One person at a time is also how it actually happens — you
 * learn who the decision maker is in a conversation, not while filling in a fee.
 */
export function peopleBlock(opts: {
  engagementId: number;
  people: PursuitContact[];
  peopleRows: { full_name: string; organization_name: string | null }[];
  error?: string;
}): string {
  const rows = opts.people.length
    ? `<table><thead><tr><th>Person</th><th>Role</th><th></th></tr></thead><tbody>${opts.people
        .map(
          (p) => `<tr>
        <td><a href="/contacts/${p.contact_id}"><b>${esc(p.contact_name)}</b></a>${
          p.contact_title ? `<div class="meta">${esc(p.contact_title)}</div>` : ""
        }${p.note ? `<div class="meta">${esc(p.note)}</div>` : ""}</td>
        <td data-label="Role"><span class="pill ${
          p.role === "decision_maker" || p.role === "economic_buyer" ? "green" : "grey"
        }">${esc(labelFor(PURSUIT_ROLES, p.role))}</span></td>
        <td class="rowacts"><form method="post" action="/engagements/${opts.engagementId}/people/remove">
          <input type="hidden" name="contact_id" value="${p.contact_id}">
          <input type="hidden" name="role" value="${esc(p.role)}">
          <button class="secondary" type="submit">remove</button></form></td>
      </tr>`
        )
        .join("")}</tbody></table>`
    : `<p class="meta">Nobody named yet. <b>The decision maker is the one to add first</b> — a pursuit with no named decision maker is the most common reason one stalls without anybody being able to say who went quiet.</p>`;

  return `<section class="card">
    <h2>People on this pursuit</h2>
    ${opts.error ? `<div class="flash warn">${esc(opts.error)}</div>` : ""}
    ${rows}
    <form method="post" action="/engagements/${opts.engagementId}/people" style="margin-top:12px">
      <div class="row">
        <div><label>Person <span class="hint">must already be a contact</span></label>
          <input type="text" name="contact" list="pursuit_people" placeholder="e.g. Jane Smith">
          ${peopleDatalist("pursuit_people", opts.peopleRows)}</div>
        <div><label>Role</label>${select("role", PURSUIT_ROLES, "decision_maker")}</div>
        <div><label>Note <span class="hint">optional</span></label>
          <input type="text" name="note" placeholder="e.g. wants the phased option"></div>
      </div>
      <div class="actions"><button type="submit">Add Person</button></div>
    </form>
    <p class="meta">One person can hold two roles — the decision maker is often also the champion. <b>Economic buyer</b> is kept separate from <b>decision maker</b> on purpose: they are frequently different people, and a sponsor saying yes while the budget holder was never in the room is the classic way a pursuit dies late.</p>
  </section>`;
}

app.post("/engagements/:id/people", async (c) => {
  const id = Number(c.req.param("id"));
  const f = await c.req.parseBody();
  const role = str(f.role) ?? "";
  if (!PURSUIT_ROLES.some(([v]) => v === role))
    return c.redirect(`/engagements/${id}/edit?people=badrole`);
  const who = await resolveContactByName(c.env.DB, str(f.contact));
  if ("error" in who) return c.redirect(`/engagements/${id}/edit?people=notfound`);
  if (!who.id) return c.redirect(`/engagements/${id}/edit?people=blank`);

  /*
   * INSERT OR IGNORE, not a lookup then an insert. The primary key is (engagement, contact, role), so a
   * double submit is a no-op rather than a 500 — and the audit row below is written either way, which is
   * the honest record of "this was submitted twice".
   */
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO engagement_contact (engagement_id, contact_id, role, note) VALUES (?,?,?,?)"
  )
    .bind(id, who.id, role, str(f.note))
    .run();
  await c.env.DB.prepare(
    "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,'engagement',?,?,?,?,'app',?)"
  )
    .bind(
      ACTOR,
      String(id),
      "person-added",
      null,
      `${str(f.contact)} as ${labelFor(PURSUIT_ROLES, role)}`,
      `engagement-${id}`
    )
    .run();
  return c.redirect(`/engagements/${id}/edit?people=added`);
});

app.post("/engagements/:id/people/remove", async (c) => {
  const id = Number(c.req.param("id"));
  const f = await c.req.parseBody();
  const contactId = Number(str(f.contact_id));
  const role = str(f.role);
  if (!contactId || !role) return c.redirect(`/engagements/${id}/edit`);
  const who = await c.env.DB.prepare("SELECT full_name FROM contact WHERE id = ?")
    .bind(contactId)
    .first<{ full_name: string }>();
  await c.env.DB.prepare(
    "DELETE FROM engagement_contact WHERE engagement_id = ? AND contact_id = ? AND role = ?"
  )
    .bind(id, contactId, role)
    .run();
  await c.env.DB.prepare(
    "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,'engagement',?,?,?,?,'app',?)"
  )
    .bind(
      ACTOR,
      String(id),
      "person-removed",
      `${who?.full_name ?? contactId} as ${labelFor(PURSUIT_ROLES, role)}`,
      null,
      `engagement-${id}`
    )
    .run();
  return c.redirect(`/engagements/${id}/edit?people=removed`);
});

// ---------------------------------------------------------------- the pipeline

type Row = Engagement & { logged_hours: number | null; people: string | null };

async function pipelineRows(db: D1Db): Promise<Row[]> {
  const { results } = await db
    .prepare(
      `SELECT e.*, o.name AS organization_name,
              (SELECT ROUND(SUM(t.hours),2) FROM time_entry t WHERE t.engagement_id = e.id) AS logged_hours,
              (SELECT group_concat(c.full_name, ', ') FROM engagement_contact ec
                 JOIN contact c ON c.id = ec.contact_id
                WHERE ec.engagement_id = e.id AND ec.role IN ('decision_maker','economic_buyer')) AS people
         FROM engagement e LEFT JOIN organization o ON o.id = e.organization_id
        WHERE e.status IN (${PURSUIT_STAGES.map(() => "?").join(",")})
        ORDER BY (e.expected_decision_date IS NULL), e.expected_decision_date, o.name, e.name`
    )
    .bind(...PURSUIT_STAGES)
    .all<Row>();
  return results;
}

/**
 * Pursuits that want attention today — an overdue next step, or a decision date that has arrived.
 *
 * Exported for the dashboard and the digest so all three screens agree on what "needs you" means. The
 * lesson is DIGEST-001's: a summary that disagrees with the screen it summarises leaves neither one
 * trustworthy.
 */
export async function pursuitsNeedingAttention(
  db: D1Db,
  today: string = localToday()
): Promise<{ id: number; name: string; organization_name: string | null; status: string; why: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.name, e.status, o.name AS organization_name,
              CASE
                WHEN e.next_step_date IS NOT NULL AND e.next_step_date <= ?
                  THEN 'next step due ' || e.next_step_date || coalesce(' — ' || e.next_step, '')
                ELSE 'decision expected ' || e.expected_decision_date
              END AS why
         FROM engagement e LEFT JOIN organization o ON o.id = e.organization_id
        WHERE e.status IN (${PURSUIT_STAGES.map(() => "?").join(",")})
          AND ((e.next_step_date IS NOT NULL AND e.next_step_date <= ?)
            OR (e.expected_decision_date IS NOT NULL AND e.expected_decision_date <= ?))
        ORDER BY coalesce(e.next_step_date, e.expected_decision_date), o.name`
    )
    .bind(today, ...PURSUIT_STAGES, today, today)
    .all<{ id: number; name: string; organization_name: string | null; status: string; why: string }>();
  return results;
}

/**
 * Demand, counted honestly.
 *
 * THE LOSSES ARE THE POINT. The point of tracking demand is to see what work is actually wanted, and won
 * work only says what was SOLD. A handful of pursuits in one service line lost on budget timing beside a
 * couple of pursuits won in another can read as "the winning line is in demand" if you count only the
 * wins — survivorship bias with a chart on top. So
 * every row here shows open, won and lost side by side, and a win rate computed only over DECIDED
 * pursuits, because counting open ones as losses would flatter nothing and understate everything.
 */
async function demandBy(
  db: D1Db,
  column: "service_type" | "origin"
): Promise<
  {
    key: string | null;
    open_n: number;
    open_value: number | null;
    won_n: number;
    won_value: number | null;
    lost_n: number;
    lost_value: number | null;
  }[]
> {
  const live = LIVE_STAGES.map(() => "?").join(",");
  const dead = DEAD_STAGES.map(() => "?").join(",");
  const open = PURSUIT_STAGES.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT ${column} AS key,
         SUM(status IN (${open})) AS open_n,
         SUM(CASE WHEN status IN (${open}) THEN expected_value END) AS open_value,
         SUM(status IN (${live}) OR status='complete') AS won_n,
         SUM(CASE WHEN status IN (${live}) OR status='complete' THEN expected_value END) AS won_value,
         SUM(status IN (${dead})) AS lost_n,
         SUM(CASE WHEN status IN (${dead}) THEN expected_value END) AS lost_value
       FROM engagement GROUP BY ${column}
       ORDER BY won_n DESC, open_n DESC, key`
    )
    .bind(...PURSUIT_STAGES, ...PURSUIT_STAGES, ...LIVE_STAGES, ...LIVE_STAGES, ...DEAD_STAGES, ...DEAD_STAGES)
    .all<{
      key: string | null;
      open_n: number;
      open_value: number | null;
      won_n: number;
      won_value: number | null;
      lost_n: number;
      lost_value: number | null;
    }>();
  return results;
}

async function lossReasons(db: D1Db): Promise<{ reason: string | null; n: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT outcome_reason AS reason, COUNT(*) AS n FROM engagement
        WHERE status IN (${DEAD_STAGES.map(() => "?").join(",")})
        GROUP BY outcome_reason ORDER BY n DESC`
    )
    .bind(...DEAD_STAGES)
    .all<{ reason: string | null; n: number }>();
  return results;
}

const STAGE_BLURB: Record<string, string> = {
  identified: "You have heard there is a need. Nothing has been proposed and nothing is committed.",
  qualifying: "You are deciding whether this is worth chasing, and whether you would want it.",
  proposal: "You are writing it. Hours logged as Pursuit/Proposal against this row are the cost of it.",
  submitted: "It is with the client. The decision date is the only thing that makes this a pipeline.",
  verbal: "Yes, but nothing signed. The most dangerous stage to leave without a dated next step.",
};

app.get("/pursuits", async (c) => {
  const today = localToday();
  const rows = await pipelineRows(c.env.DB);
  const byService = await demandBy(c.env.DB, "service_type");
  const byOrigin = await demandBy(c.env.DB, "origin");
  const losses = await lossReasons(c.env.DB);

  const total = rows.reduce((n, r) => n + (r.expected_value ?? 0), 0);
  const unpriced = rows.filter((r) => r.expected_value === null).length;
  const undated = rows.filter((r) => r.expected_decision_date === null).length;
  const nostep = rows.filter((r) => r.next_step_date === null).length;

  const stageBlock = (stage: string) => {
    const inStage = rows.filter((r) => r.status === stage);
    if (!inStage.length) return "";
    const value = inStage.reduce((n, r) => n + (r.expected_value ?? 0), 0);
    /*
     * "$0" WOULD BE A LIE HERE. A stage holding one unpriced pursuit summed to zero and printed
     * "Identified 1 · $0", which reads as work worth nothing rather than work not yet priced. Caught by
     * looking at the rendered page. When nothing in the stage carries an amount, the heading says so.
     */
    const priced = inStage.some((r) => r.expected_value !== null);
    return `<section>
      <h2>${esc(labelFor(ENGAGEMENT_STATUSES, stage))} <span class="meta" style="font-weight:400">${
        inStage.length
      } · ${priced ? esc(money(value)) : "no amounts yet"}</span></h2>
      <p class="meta" style="margin:0 0 8px">${esc(STAGE_BLURB[stage] ?? "")}</p>
      <table><thead><tr><th>Pursuit</th><th>Type</th><th style="text-align:right">Value</th><th>Decision</th><th>Next step</th></tr></thead><tbody>${inStage
        .map((r) => {
          const stepLate = r.next_step_date !== null && r.next_step_date <= today;
          const decisionHere = r.expected_decision_date !== null && r.expected_decision_date <= today;
          return `<tr>
        <td><a href="/engagements/${r.id}/edit"><b>${esc(r.name)}</b></a>
          <div class="meta">${esc(r.organization_name ?? "no customer set")}</div>
          ${r.people ? `<div class="meta">${esc(r.people)}</div>` : '<div class="meta"><span class="pill amber">no decision maker named</span></div>'}</td>
        <td data-label="Type">${
          r.service_type ? esc(r.service_type) : '<span class="pill amber">not set</span>'
        }<div class="meta">${esc(labelFor(PURSUIT_ORIGINS, r.origin ?? "unknown"))}</div></td>
        <td style="text-align:right" data-label="Value">${
          r.expected_value === null ? '<span class="pill amber">no amount</span>' : `<b>${esc(money(r.expected_value))}</b>`
        }${r.logged_hours ? `<div class="meta">${esc(r.logged_hours)}h spent</div>` : ""}</td>
        <td data-label="Decision">${
          r.expected_decision_date
            ? `${esc(r.expected_decision_date)}${decisionHere ? ' <span class="pill red">due</span>' : ""}`
            : '<span class="pill amber">no date</span>'
        }</td>
        <td data-label="Next step">${
          r.next_step_date
            ? `${esc(r.next_step_date)}${stepLate ? ' <span class="pill red">overdue</span>' : ""}${
                r.next_step ? `<div class="meta">${esc(r.next_step)}</div>` : ""
              }`
            : '<span class="pill amber">none set</span>'
        }</td>
      </tr>`;
        })
        .join("")}</tbody></table>
    </section>`;
  };

  const demandTable = (
    title: string,
    column: string,
    lead: string,
    data: Awaited<ReturnType<typeof demandBy>>,
    vocab: readonly (readonly [string, string])[] | null
  ) => `<section>
    <h2>${esc(title)}</h2>
    <p class="meta" style="margin:0 0 8px">${lead}</p>
    ${
      data.length
        ? `<table><thead><tr><th>${esc(column)}</th><th style="text-align:right">Open</th><th style="text-align:right">Won</th><th style="text-align:right">Lost</th><th style="text-align:right">Win rate</th></tr></thead><tbody>${data
            .map((d) => {
              const decided = d.won_n + d.lost_n;
              return `<tr>
        <td><b>${esc(d.key ? (vocab ? labelFor(vocab, d.key) : d.key) : "not recorded")}</b></td>
        <td style="text-align:right" data-label="Open">${d.open_n || "—"}${
                d.open_value ? `<div class="meta">${esc(money(d.open_value))}</div>` : ""
              }</td>
        <td style="text-align:right" data-label="Won">${d.won_n || "—"}${
                d.won_value ? `<div class="meta">${esc(money(d.won_value))}</div>` : ""
              }</td>
        <td style="text-align:right" data-label="Lost">${d.lost_n || "—"}${
                d.lost_value ? `<div class="meta">${esc(money(d.lost_value))}</div>` : ""
              }</td>
        <td style="text-align:right" data-label="Win rate">${
          decided ? `${Math.round((d.won_n / decided) * 100)}%` : '<span class="meta">no decisions yet</span>'
        }</td>
      </tr>`;
            })
            .join("")}</tbody></table>`
        : '<p class="meta">Nothing recorded yet.</p>'
    }
  </section>`;

  const empty = `<div class="card empty">
    <p><b>Nothing in the pipeline.</b></p>
    <p class="meta">A pursuit is a piece of work you are chasing. It is the same record as an engagement — created at <a href="/engagements/new">New Engagement</a> with a status of Identified, Qualifying, Proposal in Progress, Proposal Submitted or Verbal Yes — so when it is won you change the status rather than retyping it, and the proposal hours you logged against it stay attached.</p>
  </div>`;

  return c.html(
    layout({
      title: "Pursuits",
      body: `<main>
  <h1>Pursuits</h1>
  <p class="sub">${rows.length} open pursuit${rows.length === 1 ? "" : "s"} · ${esc(
    money(total)
  )} · <a href="/engagements">all engagements</a> · <a href="/">dashboard</a></p>
  <div class="actions" style="margin:0 0 14px"><a class="btn" href="/engagements/new">New Pursuit</a></div>
  ${
    rows.length && (unpriced || undated || nostep)
      ? `<div class="flash warn">${[
          unpriced ? `<b>${unpriced}</b> with no amount` : "",
          undated ? `<b>${undated}</b> with no expected decision date` : "",
          nostep ? `<b>${nostep}</b> with no dated next step` : "",
        ]
          .filter(Boolean)
          .join(" · ")}. A pursuit with no decision date cannot appear in a forecast, and one with no dated next step is the shape that goes quiet.</div>`
      : ""
  }
  ${rows.length ? PURSUIT_STAGES.map(stageBlock).join("") : empty}
  ${demandTable(
    "Demand by service type",
    "Service type",
    "Open, won and lost together. <b>Counting only the wins would tell you what you sold, not what is in demand</b> — the losses are half the answer, and the win rate is computed over decided pursuits only, so open ones are not silently treated as failures.",
    byService,
    SERVICE_TYPES
  )}
  ${demandTable(
    "Demand by where it came from",
    "Source",
    "Which channel produces <b>paid work</b>, as opposed to conversations. These are not the same list, and this is the table that says so.",
    byOrigin,
    PURSUIT_ORIGINS
  )}
  ${
    losses.length
      ? `<section>
    <h2>Why pursuits ended</h2>
    <p class="meta" style="margin:0 0 8px">Closed without becoming work. <b>Client used their own team</b> and <b>no decision ever made</b> are on this list because for an independent advisor those are the real competitors far more often than another firm.</p>
    <table><thead><tr><th>Reason</th><th style="text-align:right">Count</th></tr></thead><tbody>${losses
      .map(
        (l) =>
          `<tr><td>${esc(l.reason ? labelFor(OUTCOME_REASONS, l.reason) : "not recorded")}</td><td style="text-align:right"><b>${l.n}</b></td></tr>`
      )
      .join("")}</tbody></table>
  </section>`
      : ""
  }
  <p class="meta" style="margin-top:14px">A pursuit and an engagement are one record at different ages, so winning one is a status change and nothing is retyped. Closed pursuits stay in the demand tables above and are kept out of the time-entry customer picker — logging hours against work that never existed is the one thing this design has to prevent. ${
    CLOSED_STAGES.length
  } closed statuses, ${DEAD_STAGES.length} of them without a win.</p>
</main>`,
    })
  );
});

export default app;
