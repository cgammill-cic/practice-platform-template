/*
 * CUST-001 — customers and engagements, linked to QuickBooks by ID (#91).
 *
 * WHAT WAS ALREADY HERE. The `engagement` table has existed since migration 0001 with every column this
 * screen needs — organization_id, name, service_type, status, start_date, end_date, billing_method,
 * hourly_rate, fixed_fee_amount, retainer_monthly_amount, and crucially `qb_customer_id` and
 * `qb_project_id`. Nothing in the app had ever read or written a single one of them. Checked on prod
 * 2026-08-11: the table was empty. So this is a screen, not a redesign, and the same shape of gap as
 * REL-005, where `referral_source_contact_id` was maintained by the delete path but no form could set it.
 *
 * WHY THERE IS NO SEPARATE "CUSTOMER" RECORD. The request was for a way to create customers in the tool
 * that link back to QuickBooks. A customer here is an ORGANIZATION you have an engagement with —
 * `organization` already exists, is already created automatically when you type a new one on a contact
 * form, and already holds the contacts. Adding a fourth kind of record for the same real-world company
 * would mean two names to keep in step and a reconciliation nobody asked for. The QuickBooks id hangs off
 * the engagement rather than the organization because that is where migration 0001 put it, and because it
 * is the right place: QuickBooks bills projects and engagements, and one organization can be two.
 *
 * NO QUICKBOOKS API. Decided 2026-08-11. A pasted id delivers hours-by-customer that reconciles to QBO
 * with no Intuit app registration, no OAuth, and no third-party data processor. The live integration
 * stays Phase 4 and, when it comes, fills these same columns — so this is a first stage rather than a
 * workaround. The honest cost is stated on the form and repeated on every report that groups by customer:
 * a pasted id is unverified, so a typo simply fails to reconcile, quietly.
 */

import { Hono } from "hono";
import { esc, layout, select } from "./views";
import {
  money,
  peopleBlock,
  peopleDatalist,
  peopleOptions,
  pursuitPeople,
  resolveContactByName,
} from "./pursuits";
import {
  BILLING_METHODS,
  CLOSED_STAGES,
  ENGAGEMENT_STATUSES,
  NOT_TO_EXCEED,
  OUTCOME_REASONS,
  PURSUIT_ORIGINS,
  SERVICE_TYPES,
  isDead,
  labelFor,
  type Bindings,
  type D1Db,
  type Engagement,
} from "./types";

const app = new Hono<{ Bindings: Bindings }>();
const ACTOR = "operator";

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

/** Parses a money/rate field. Returns null for blank, or the string back when it is not a number. */
function num(v: unknown): { value: number | null } | { error: string } {
  const s = str(v);
  if (!s) return { value: null };
  // Tolerate what a person actually types: "$225", "1,500.00".
  const cleaned = s.replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return { error: `“${s}” is not an amount.` };
  return { value: n };
}

async function audit(db: D1Db, id: number, action: string, after: string, before?: string) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,'engagement',?,?,?,?,'app',?)"
    )
    .bind(ACTOR, String(id), action, before ?? null, after, `engagement-${id}`)
    .run();
}

/**
 * Engagements with their organization, and the hours logged against each.
 *
 * The hours subquery is why this list is worth looking at rather than being a lookup table: an engagement
 * with a QuickBooks id and no hours is either not started or not being tracked, and both are worth seeing.
 */
export async function engagementList(db: D1Db): Promise<(Engagement & { logged_hours: number | null })[]> {
  const { results } = await db
    .prepare(
      `SELECT e.*, o.name AS organization_name,
          (SELECT ROUND(SUM(t.hours), 2) FROM time_entry t WHERE t.engagement_id = e.id) AS logged_hours
         FROM engagement e LEFT JOIN organization o ON o.id = e.organization_id
        ORDER BY (e.status <> 'active'), o.name, e.name`
    )
    .all<Engagement & { logged_hours: number | null }>();
  return results;
}

/*
 * Engagements you can pick when logging time — which is NOT the same as engagements that are active.
 *
 * THIS USED TO FILTER `status = 'active'` AND THAT WAS THE BUG. A newly added client was not pulling
 * through to the customer dropdown on the Outlook import at all. That engagement was saved as
 * **prospective**, which is accurate — it is a retainer being pursued, not yet signed — and the picker
 * then refused to offer it at all.
 *
 * That is backwards. Business Development hours are, by definition, spent on work that is not yet active;
 * an engagement being prospective is the reason the time exists, not a reason to be unable to record it.
 * The same holds for `on_hold`: a paused engagement still accrues the odd hour, and refusing to log it
 * loses the hour rather than protecting anything.
 *
 * `complete` IS excluded, because a finished engagement is the one case where offering it invites
 * back-dating time onto work that has already been invoiced and closed. Nothing is lost: change the status
 * back if time genuinely still belongs to it.
 *
 * PURS-001 EXTENDS THAT EXCLUSION AND IT IS THE MOST IMPORTANT LINE IN THIS FILE. `engagement` now holds
 * pursuits, so it holds rows that were LOST — and offering a lost pursuit here would invite hours onto
 * work that never existed, which is worse than the back-dating case because there is no invoice to
 * contradict it. Everything in DEAD_STAGES is excluded alongside `complete`. Open pursuits are offered,
 * for exactly the reason the bug above proves: Pursuit/Proposal hours are the cost of chasing work that
 * is not yet won, and refusing to log them loses the number that makes win rate meaningful.
 *
 * Non-active engagements carry their status in the label, so choosing one is a visible decision rather
 * than an indistinguishable row in a dropdown. Active ones sort first.
 */
export async function pickableEngagements(
  db: D1Db
): Promise<{ id: number; label: string; status: string }[]> {
  const excluded = ["complete", ...CLOSED_STAGES.filter((s) => s !== "complete")];
  const { results } = await db
    .prepare(
      `SELECT e.id, e.name, e.status, o.name AS organization_name FROM engagement e
         LEFT JOIN organization o ON o.id = e.organization_id
        WHERE e.status NOT IN (${excluded.map(() => "?").join(",")})
        ORDER BY (e.status <> 'active'), o.name, e.name`
    )
    .bind(...excluded)
    .all<{ id: number; name: string; status: string; organization_name: string | null }>();
  return results.map((r) => ({
    id: r.id,
    status: r.status,
    label: `${r.organization_name ? `${r.organization_name} — ` : ""}${r.name}${
      r.status === "active" ? "" : ` (${labelFor(ENGAGEMENT_STATUSES, r.status)})`
    }`,
  }));
}

/**
 * Resolves a typed organization name to an id, creating it if it is new.
 *
 * Deliberately the same behaviour as the contact form's organization field rather than a stricter
 * "pick from the list": a new customer usually IS a new organization, and refusing to create one here
 * would mean adding a contact first to get the organization created as a side effect.
 */
async function resolveOrganization(
  db: D1Db,
  name: string | null,
  calendarTag: string | null
): Promise<number | null> {
  if (!name) return null;
  const existing = await db
    .prepare("SELECT id, calendar_tag FROM organization WHERE lower(name) = lower(?)")
    .bind(name)
    .first<{ id: number; calendar_tag: string | null }>();
  if (existing) {
    /*
     * Only written when it CHANGED. Saving an unrelated edit — a rate, a date — should not stamp the same
     * value back over the organization and put a no-op in its updated_at. And a blank box is a real
     * instruction to clear the tag, not an accident: the field is rendered pre-filled, so an empty one was
     * emptied on purpose. That is the opposite of the import's comments box (0017), which is bulk and
     * where a blank is far more likely to be a lost field than a decision.
     */
    if ((existing.calendar_tag ?? null) !== calendarTag)
      await db
        .prepare("UPDATE organization SET calendar_tag = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(calendarTag, existing.id)
        .run();
    return existing.id;
  }
  const inserted = await db
    .prepare("INSERT INTO organization (name, calendar_tag) VALUES (?, ?)")
    .bind(name, calendarTag)
    .run();
  return inserted?.meta?.last_row_id ?? null;
}

async function orgNames(db: D1Db): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM organization ORDER BY name LIMIT 500")
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

// ---------------------------------------------------------------- form

function engagementForm(opts: {
  engagement?: Partial<Engagement>;
  orgNames: string[];
  peopleRows: { full_name: string; organization_name: string | null }[];
  originContactName?: string | null;
  /** Rendered only when editing — a new pursuit has no id to hang a role on yet. */
  peopleSection?: string;
  error?: string;
}): string {
  const e = opts.engagement ?? {};
  const isEdit = Boolean(e.id);
  const action = isEdit ? `/engagements/${e.id}/edit` : "/engagements/new";
  /** Raw for an input box — deliberately NOT pursuits.money(), which formats for reading. */
  const amount = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  return `<main>
  <h1>${isEdit ? `Edit ${esc(e.name)}` : "New Engagement"}</h1>
  <p class="sub">${
    isEdit ? "Changes are recorded in the audit trail." : "A customer is an organization you have an engagement with."
  } · <a href="/engagements">all engagements</a></p>
  ${opts.error ? `<div class="flash warn">${esc(opts.error)}</div>` : ""}
  <form method="post" action="${action}" class="card">
    <div class="row">
      <div><label>Customer <span class="hint">organization — new names are created automatically</span></label>
        <input type="text" name="organization" list="orgs" value="${esc(e.organization_name)}" autofocus>
        <datalist id="orgs">${opts.orgNames.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist></div>
      <div><label>Engagement Name <span class="hint">required</span></label>
        <input type="text" name="name" value="${esc(e.name)}" placeholder="e.g. HCM assessment" required></div>
    </div>
    ${/*
      THE OUTLOOK CATEGORY LIVES ON THE ORGANIZATION, NOT ON THIS ENGAGEMENT — it identifies the company,
      and two engagements for one client share one calendar tag. It is edited from here because there is no
      organization screen in the app at all (organizations are only ever created by name), and this is the
      page someone is on when they think about a customer. The note under the field says where it lands, so
      editing it from a second engagement and seeing the first one change is not a surprise.
    */ ""}
    <div class="row">
      <div><label>Outlook Category <span class="hint">optional — what you type on calendar events for this client</span></label>
        <input type="text" name="calendar_tag" value="${esc(e.calendar_tag)}" placeholder="e.g. Acme">
        <p class="meta" style="margin-top:4px">Leave blank when the category is just the customer name — the import matches on the name by default. Fill it in when they differ: the category <code>Acme</code> against a customer recorded as <code>Acme Engineers, Inc.</code> Saved on the <b>organization</b>, so every engagement for this client uses it${
          e.organization_id ? ` — or edit it, with the address and everything else, on <a href="/organizations/${e.organization_id}/edit">the company record</a>` : ""
        }.</p></div>
    </div>
    ${/*
      SERVICE TYPE IS NOW A CONTROLLED LIST: free-text service types meant an Organizational Design
      engagement could get filed as `Executive Support`, so "what work is in most demand" would have
      reported zero demand for org design. See the note on SERVICE_TYPES.
    */ ""}
    <div class="row">
      <div><label>Service Type <span class="hint">what kind of work this is — drives the demand report</span></label>${select(
        "service_type",
        SERVICE_TYPES,
        e.service_type ?? "",
        { blank: "— not set —" }
      )}</div>
      <div><label>Status <span class="hint">a pursuit and an engagement are one record at different ages</span></label>${select(
        "status",
        ENGAGEMENT_STATUSES,
        e.status ?? "identified"
      )}</div>
    </div>

    <fieldset class="card" style="margin:0 0 14px">
      <legend><b>Pursuit</b></legend>
      <p class="meta" style="margin:0 0 10px">Fill these in while you are chasing the work. They are what the <a href="/pursuits">pipeline</a> is built from, and they stay on the record after it is won — so win rate, cycle time and demand are all history rather than something to reconstruct.</p>
      <div class="row">
        <div><label>Expected Value <span class="hint">the whole piece of work</span></label>
          <input type="text" name="expected_value" value="${esc(amount(e.expected_value))}" placeholder="e.g. 45000">
          <p class="meta" style="margin-top:4px">Not the same as the fee fields below, which are contract terms. A retainer at 5,000 a month for six months is a <b>30,000</b> pursuit — this is the number that belongs in a pipeline total.</p></div>
        <div><label>Expected Decision Date</label><input type="date" name="expected_decision_date" value="${esc(e.expected_decision_date)}">
          <p class="meta" style="margin-top:4px">Without this the pursuit cannot appear in any forecast. It is the field that makes a list into a pipeline.</p></div>
      </div>
      <div class="row">
        <div><label>Next Step</label><input type="text" name="next_step" value="${esc(e.next_step)}" placeholder="e.g. send the phased option to Rachel"></div>
        <div><label>Next Step Due</label><input type="date" name="next_step_date" value="${esc(e.next_step_date)}">
          <p class="meta" style="margin-top:4px">Shows on the dashboard and in the morning digest when it is due. A pursuit with no dated next step is the shape that goes quiet.</p></div>
      </div>
      <div class="row">
        <div><label>Where It Came From</label>${select("origin", PURSUIT_ORIGINS, e.origin ?? "", { blank: "— not set —" })}</div>
        <div><label>Referred By <span class="hint">optional — must be a contact</span></label>
          <input type="text" name="origin_contact" list="origin_people" value="${esc(opts.originContactName)}" placeholder="e.g. Jane Smith">
          ${peopleDatalist("origin_people", opts.peopleRows)}</div>
      </div>
      <div class="row">
        <div><label>Proposal Submitted</label><input type="date" name="submitted_date" value="${esc(e.submitted_date)}"></div>
        <div><label>Decided On</label><input type="date" name="decided_at" value="${esc(e.decided_at)}">
          <p class="meta" style="margin-top:4px">The pair gives cycle time — how long an answer actually takes, which is worth knowing before you promise a start date.</p></div>
      </div>
      <div class="row">
        <div><label>Outcome Reason <span class="hint">when it is lost, withdrawn or ended with no decision</span></label>${select(
          "outcome_reason",
          OUTCOME_REASONS,
          e.outcome_reason ?? "",
          { blank: "— not set —" }
        )}</div>
        <div><label>Outcome Note <span class="hint">who won it, or what happened</span></label>
          <input type="text" name="outcome_note" value="${esc(e.outcome_note)}" placeholder="e.g. went to a Big 4 firm on price"></div>
      </div>
      <p class="meta"><b>Recording losses is not bookkeeping.</b> Won work tells you what you sold; the demand report needs the losses to tell you what is actually wanted. A closed pursuit with no reason shows as <i>not recorded</i> there.</p>
    </fieldset>

    <div class="row">
      <div><label>Start Date <span class="hint">of the work, once it is real</span></label><input type="date" name="start_date" value="${esc(e.start_date)}"></div>
      <div><label>End Date</label><input type="date" name="end_date" value="${esc(e.end_date)}"></div>
    </div>
    ${/*
      billing_method is NOT NULL with a CHECK constraint from migration 0001 (widened by 0022), so there
      is no blank option — but there IS now `undecided`, because a pursuit at Identified genuinely has no
      billing method and forcing the choice means whatever was picked to get past the field is wrong in
      every later report. The rate fields are all shown rather than switched by the chosen method: doing
      that properly needs JavaScript, and an engagement that changes from hourly to retainer mid-flight
      should not lose the rate it used to bill at.
    */ ""}
    <div class="row">
      <div><label>Billing Method <span class="hint">required — “Not Decided Yet” is a real answer on a new pursuit</span></label>${select(
        "billing_method",
        BILLING_METHODS,
        e.billing_method ?? "undecided"
      )}</div>
    </div>
    <div class="row">
      <div><label>Hourly Rate</label><input type="text" name="hourly_rate" value="${esc(amount(e.hourly_rate))}" placeholder="e.g. 350"></div>
      <div><label>Not-to-Exceed Cap <span class="hint">with Time &amp; Materials, Not to Exceed</span></label><input type="text" name="not_to_exceed_amount" value="${esc(
        amount(e.not_to_exceed_amount)
      )}"></div>
    </div>
    <div class="row">
      <div><label>Fixed Fee</label><input type="text" name="fixed_fee_amount" value="${esc(amount(e.fixed_fee_amount))}"></div>
      <div><label>Monthly Retainer</label><input type="text" name="retainer_monthly_amount" value="${esc(amount(e.retainer_monthly_amount))}"></div>
    </div>
    <div class="row">
      <div><label>QuickBooks Customer ID</label><input type="text" name="qb_customer_id" value="${esc(e.qb_customer_id)}"></div>
      <div><label>QuickBooks Project ID <span class="hint">optional</span></label><input type="text" name="qb_project_id" value="${esc(e.qb_project_id)}"></div>
    </div>
    <p class="meta">Paste the id from QuickBooks. <b>Nothing checks it.</b> There is no QuickBooks connection — that is Phase 4 — so a mistyped id will simply never reconcile, and nothing will say so. It is shown on the hours-by-customer report for exactly that reason: a wrong id is visible where it matters rather than buried on this page.</p>
    <div class="actions">
      <button type="submit">${isEdit ? "Save Changes" : "Create Engagement"}</button>
      <a class="btn secondary" href="/engagements">Cancel</a>
    </div>
  </form>
  ${
    opts.peopleSection ??
    '<p class="meta">Save this first, then you can name the decision maker and the influencers on it — a role points at a real contact record, so it needs somewhere to point.</p>'
  }
</main>`;
}

// ---------------------------------------------------------------- pages

const FLASH: Record<string, string> = {
  created:
    '<div class="flash ok">Created. You can log time against it, and name the decision maker and influencers below.</div>',
  saved: '<div class="flash ok">Changes saved.</div>',
  nochange: '<div class="flash warn">Nothing changed, so nothing was saved.</div>',
  added: '<div class="flash ok">Person added to the pursuit.</div>',
  removed: '<div class="flash ok">Person removed from the pursuit.</div>',
};

/** See needsReason() — the save happened; this is the nudge, and it names the cost of skipping it. */
const NO_REASON_FLASH =
  '<div class="flash warn">Saved, but <b>no outcome reason was recorded</b>. A closed pursuit without one shows as <i>not recorded</i> on the demand report — and the losses are the half of that report which says what is actually wanted, as opposed to what you happened to sell.</div>';

app.get("/engagements", async (c) => {
  const rows = await engagementList(c.env.DB);
  const withoutQb = rows.filter((r) => r.status === "active" && !r.qb_customer_id).length;

  const table = rows.length
    ? `<table><thead><tr><th>Customer / engagement</th><th>Billing</th><th>QuickBooks</th><th style="text-align:right">Hours</th><th></th></tr></thead><tbody>${rows
        .map(
          (r) => `<tr>
      <td><b>${esc(r.name)}</b>${r.organization_name ? `<div class="meta">${esc(r.organization_name)}</div>` : '<div class="meta">no customer set</div>'}
        <div class="meta"><span class="pill ${r.status === "active" ? "green" : "grey"}">${esc(
          labelFor(ENGAGEMENT_STATUSES, r.status)
        )}</span>${r.service_type ? ` ${esc(r.service_type)}` : ""}</div></td>
      <td data-label="Billing">${esc(labelFor(BILLING_METHODS, r.billing_method))}${
        r.hourly_rate ? `<div class="meta">${esc(money(r.hourly_rate))}/hr</div>` : ""
      }${r.retainer_monthly_amount ? `<div class="meta">${esc(money(r.retainer_monthly_amount))}/mo</div>` : ""}${
        r.fixed_fee_amount ? `<div class="meta">${esc(money(r.fixed_fee_amount))} fixed</div>` : ""
      }${
        r.not_to_exceed_amount ? `<div class="meta">cap ${esc(money(r.not_to_exceed_amount))}</div>` : ""
      }${
        r.expected_value ? `<div class="meta"><b>${esc(money(r.expected_value))}</b> total</div>` : ""
      }</td>
      <td data-label="QuickBooks">${
        r.qb_customer_id
          ? `<code>${esc(r.qb_customer_id)}</code>${r.qb_project_id ? `<div class="meta">project ${esc(r.qb_project_id)}</div>` : ""}`
          : '<span class="pill amber">not linked</span>'
      }</td>
      <td style="text-align:right" data-label="Hours logged">${
        r.logged_hours ? `<b>${esc(r.logged_hours)}</b>` : '<span class="meta">—</span>'
      }</td>
      <td class="meta rowacts"><a href="/engagements/${r.id}/edit">edit</a></td>
    </tr>`
        )
        .join("")}</tbody></table>
  <p class="meta" style="margin-top:8px">Active engagements first. <b>Hours</b> is everything logged against the engagement, all time, from <a href="/time">time entry</a>.${
    withoutQb
      ? ` <b>${withoutQb} active engagement${withoutQb === 1 ? "" : "s"} ${
          withoutQb === 1 ? "has" : "have"
        } no QuickBooks id</b>, so ${withoutQb === 1 ? "its" : "their"} hours cannot be reconciled to an invoice.`
      : ""
  }</p>`
    : `<div class="card empty">
    <p><b>No engagements yet.</b></p>
    <p class="meta">An engagement is a piece of work for a customer. Creating one gives you somewhere to log hours against, and somewhere to record the QuickBooks customer id so the two systems agree on who the work was for.</p>
    <p class="meta">The <code>engagement</code> table — including its QuickBooks id columns — has existed since the first migration on 29 July 2026. Nothing in the app could read or write it until now, which is why it is empty rather than because the work has not happened.</p>
  </div>`;

  return c.html(
    layout({
      title: "Engagements",
      body: `<main>
  ${FLASH[c.req.query("flash") ?? ""] ?? ""}
  ${c.req.query("noreason") ? NO_REASON_FLASH : ""}
  <h1>Customers &amp; Engagements</h1>
  <p class="sub">${rows.length} engagement${rows.length === 1 ? "" : "s"} · <a href="/pursuits">pipeline</a> · <a href="/time">log time</a> · <a href="/time/report">weekly hours</a> · <a href="/">dashboard</a></p>
  <div class="actions" style="margin:0 0 14px"><a class="btn" href="/engagements/new">New Engagement</a> <a class="btn secondary" href="/engagements/new?status=identified">New Pursuit</a></div>
  ${table}
</main>`,
    })
  );
});

app.get("/engagements/new", async (c) =>
  c.html(
    layout({
      title: "New Engagement",
      body: engagementForm({
        orgNames: await orgNames(c.env.DB),
        peopleRows: await peopleOptions(c.env.DB),
        engagement: { status: c.req.query("status") ?? "identified" },
      }),
    })
  )
);

/** Flash copy for the roles form, which posts to pursuits.ts and comes back here. */
const PEOPLE_FLASH: Record<string, string> = {
  notfound:
    "That person was not added. The name has to match an active contact exactly — a role points at a real record rather than storing a name, so pick from the suggestions or add them as a contact first.",
  blank: "No name was given, so nobody was added.",
  badrole: "That is not a role I recognise, so nobody was added.",
};

app.get("/engagements/:id/edit", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare(
    `SELECT e.*, o.name AS organization_name, o.calendar_tag, p.full_name AS origin_contact_name
       FROM engagement e
       LEFT JOIN organization o ON o.id = e.organization_id
       LEFT JOIN contact p ON p.id = e.origin_contact_id
      WHERE e.id = ?`
  )
    .bind(id)
    .first<Engagement>();
  if (!row) return c.notFound();
  const peopleRows = await peopleOptions(c.env.DB);
  return c.html(
    layout({
      title: `Edit ${row.name}`,
      body: (FLASH[c.req.query("flash") ?? ""] ?? "") +
        (c.req.query("noreason") ? NO_REASON_FLASH : "") +
        (FLASH[c.req.query("people") ?? ""] ?? "") +
        engagementForm({
        engagement: row,
        orgNames: await orgNames(c.env.DB),
        peopleRows,
        originContactName: row.origin_contact_name ?? null,
        peopleSection: peopleBlock({
          engagementId: id,
          people: await pursuitPeople(c.env.DB, id),
          peopleRows,
          error: PEOPLE_FLASH[c.req.query("people") ?? ""],
        }),
      }),
    })
  );
});

interface ParsedEngagement {
  organization: string | null;
  name: string | null;
  service_type: string | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
  billing_method: string;
  hourly_rate: number | null;
  fixed_fee_amount: number | null;
  retainer_monthly_amount: number | null;
  qb_customer_id: string | null;
  qb_project_id: string | null;
  /** Lives on the organization, not the engagement — see the note on the form. */
  calendar_tag: string | null;

  // PURS-001
  not_to_exceed_amount: number | null;
  expected_value: number | null;
  expected_decision_date: string | null;
  submitted_date: string | null;
  decided_at: string | null;
  next_step: string | null;
  next_step_date: string | null;
  origin: string | null;
  outcome_reason: string | null;
  outcome_note: string | null;
  /** The typed name; resolved to `origin_contact_id` by the caller, which can fail. */
  origin_contact: string | null;
}

function parseEngagement(f: Record<string, unknown>): ParsedEngagement | { error: string } {
  const name = str(f.name);
  if (!name) return { error: "An engagement name is required." };
  const billing = str(f.billing_method) ?? "hourly";
  if (!BILLING_METHODS.some(([v]) => v === billing))
    return { error: "That is not a billing method I recognise, so nothing was saved." };
  const status = str(f.status) ?? "active";
  if (!ENGAGEMENT_STATUSES.some(([v]) => v === status))
    return { error: "That is not a status I recognise, so nothing was saved." };
  const start = str(f.start_date);
  const end = str(f.end_date);
  // Refused rather than silently swapped or accepted: an end before a start is a typo, and every report
  // that filters a period would read it as a zero-length engagement without saying why.
  if (start && end && end < start)
    return { error: `The end date (${end}) is before the start date (${start}), so nothing was saved.` };

  const rates: [keyof ParsedEngagement, unknown, string][] = [
    ["hourly_rate", f.hourly_rate, "Hourly rate"],
    ["fixed_fee_amount", f.fixed_fee_amount, "Fixed fee"],
    ["retainer_monthly_amount", f.retainer_monthly_amount, "Monthly retainer"],
    ["not_to_exceed_amount", f.not_to_exceed_amount, "Not-to-exceed cap"],
    ["expected_value", f.expected_value, "Expected value"],
  ];
  const parsedRates: Record<string, number | null> = {};
  for (const [key, raw, label] of rates) {
    const r = num(raw);
    if ("error" in r) return { error: `${label}: ${r.error}` };
    parsedRates[key as string] = r.value;
  }

  /*
   * The vocabularies below are validated but NOT required. A pursuit at Identified legitimately has no
   * service type, no origin and no outcome; refusing to save without them would mean inventing values to
   * get past the form, and an invented service type is worse than a blank one in the demand report —
   * blank shows as "not recorded" and can be fixed, whereas a wrong one is indistinguishable from a fact.
   */
  const service_type = str(f.service_type);
  if (service_type && !SERVICE_TYPES.some(([v]) => v === service_type))
    return { error: "That is not a service type I recognise, so nothing was saved." };
  const origin = str(f.origin);
  if (origin && !PURSUIT_ORIGINS.some(([v]) => v === origin))
    return { error: "That is not an origin I recognise, so nothing was saved." };
  const outcome_reason = str(f.outcome_reason);
  if (outcome_reason && !OUTCOME_REASONS.some(([v]) => v === outcome_reason))
    return { error: "That is not an outcome reason I recognise, so nothing was saved." };

  const submitted = str(f.submitted_date);
  const decided = str(f.decided_at);
  // Same reasoning as the start/end check above: an answer before the proposal went out is a typo, and
  // cycle time would read as negative days without anything saying why.
  if (submitted && decided && decided < submitted)
    return {
      error: `The decision date (${decided}) is before the proposal was submitted (${submitted}), so nothing was saved.`,
    };

  /*
   * A cap without the method that uses it is refused, because a number nobody reads is a number that
   * misleads — it would sit on the record looking like a commercial limit while no report consults it.
   * The reverse is allowed: the method with no cap yet is an ordinary state mid-negotiation.
   */
  if (parsedRates.not_to_exceed_amount !== null && billing !== NOT_TO_EXCEED)
    return {
      error: `A not-to-exceed cap only means something with the “${labelFor(
        BILLING_METHODS,
        NOT_TO_EXCEED
      )}” billing method. Change the method, or clear the cap.`,
    };

  return {
    organization: str(f.organization),
    name,
    service_type,
    status,
    start_date: start,
    end_date: end,
    billing_method: billing,
    hourly_rate: parsedRates.hourly_rate,
    fixed_fee_amount: parsedRates.fixed_fee_amount,
    retainer_monthly_amount: parsedRates.retainer_monthly_amount,
    not_to_exceed_amount: parsedRates.not_to_exceed_amount,
    expected_value: parsedRates.expected_value,
    expected_decision_date: str(f.expected_decision_date),
    submitted_date: submitted,
    decided_at: decided,
    next_step: str(f.next_step),
    next_step_date: str(f.next_step_date),
    origin,
    origin_contact: str(f.origin_contact),
    outcome_reason,
    outcome_note: str(f.outcome_note),
    calendar_tag: str(f.calendar_tag),
    qb_customer_id: str(f.qb_customer_id),
    qb_project_id: str(f.qb_project_id),
  };
}

/*
 * The columns this form writes, in one list used by BOTH the insert and the update.
 *
 * Written this way after PURS-001 took the field count from twelve to twenty-two. The old code spelled
 * the columns out three times — the INSERT, the UPDATE, and the bind order for each — and a list that
 * long, repeated, is a place where a column drifts one position and every value after it lands in the
 * wrong field. Silently, because they are mostly nullable strings and dates.
 */
const WRITABLE = [
  "organization_id",
  "name",
  "service_type",
  "status",
  "start_date",
  "end_date",
  "billing_method",
  "hourly_rate",
  "fixed_fee_amount",
  "retainer_monthly_amount",
  "not_to_exceed_amount",
  "expected_value",
  "expected_decision_date",
  "submitted_date",
  "decided_at",
  "next_step",
  "next_step_date",
  "origin",
  "origin_contact_id",
  "outcome_reason",
  "outcome_note",
  "qb_customer_id",
  "qb_project_id",
] as const;

function values(
  parsed: ParsedEngagement,
  organizationId: number | null,
  originContactId: number | null
): (string | number | null)[] {
  const map: Record<(typeof WRITABLE)[number], string | number | null> = {
    organization_id: organizationId,
    name: parsed.name,
    service_type: parsed.service_type,
    status: parsed.status,
    start_date: parsed.start_date,
    end_date: parsed.end_date,
    billing_method: parsed.billing_method,
    hourly_rate: parsed.hourly_rate,
    fixed_fee_amount: parsed.fixed_fee_amount,
    retainer_monthly_amount: parsed.retainer_monthly_amount,
    not_to_exceed_amount: parsed.not_to_exceed_amount,
    expected_value: parsed.expected_value,
    expected_decision_date: parsed.expected_decision_date,
    submitted_date: parsed.submitted_date,
    decided_at: parsed.decided_at,
    next_step: parsed.next_step,
    next_step_date: parsed.next_step_date,
    origin: parsed.origin,
    origin_contact_id: originContactId,
    outcome_reason: parsed.outcome_reason,
    outcome_note: parsed.outcome_note,
    qb_customer_id: parsed.qb_customer_id,
    qb_project_id: parsed.qb_project_id,
  };
  return WRITABLE.map((k) => map[k]);
}

/**
 * The one-line record of what this engagement now says, used for the audit trail AND for the
 * "nothing changed" check.
 *
 * EVERY FIELD THAT CAN BE EDITED HAS TO APPEAR HERE. It is the comparison the edit route makes to decide
 * whether anything happened, so a field left out of this string is a field whose change is reported to
 * the user as "nothing changed, so nothing was saved" — while having been saved. PURS-001 added ten
 * editable fields and this is where they earn their place.
 */
const summary = (e: ParsedEngagement, org: string | null) =>
  [
    `${e.name}${org ? ` for ${org}` : ""}`,
    e.status,
    e.service_type ?? "no type",
    e.billing_method,
    e.expected_value === null ? "no value" : `value ${e.expected_value}`,
    e.not_to_exceed_amount === null ? "" : `cap ${e.not_to_exceed_amount}`,
    e.hourly_rate === null ? "" : `${e.hourly_rate}/hr`,
    e.fixed_fee_amount === null ? "" : `${e.fixed_fee_amount} fixed`,
    e.retainer_monthly_amount === null ? "" : `${e.retainer_monthly_amount}/mo`,
    e.expected_decision_date ? `decision ${e.expected_decision_date}` : "no decision date",
    e.submitted_date ? `submitted ${e.submitted_date}` : "",
    e.decided_at ? `decided ${e.decided_at}` : "",
    e.next_step_date ? `next ${e.next_step_date}` : "no next step",
    e.next_step ?? "",
    e.origin ?? "",
    e.origin_contact ? `via ${e.origin_contact}` : "",
    e.outcome_reason ?? "",
    e.outcome_note ?? "",
    e.start_date ? `start ${e.start_date}` : "",
    e.end_date ? `end ${e.end_date}` : "",
    e.qb_customer_id ? `QB ${e.qb_customer_id}` : "no QB id",
    e.qb_project_id ? `QB project ${e.qb_project_id}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * Closed without a reason recorded — a nudge on the redirect, never a refusal.
 *
 * The moment you learn you lost is the moment you will record it, and a form that blocks on a dropdown
 * teaches you to pick any value to get past it. A wrong reason is worse than a blank one: blank shows as
 * "not recorded" in the demand report and can be fixed later, whereas a wrong one is indistinguishable
 * from a fact. So it saves, and then says so.
 */
const needsReason = (p: ParsedEngagement) => isDead(p.status) && !p.outcome_reason;

app.post("/engagements/new", async (c) => {
  const f = await c.req.parseBody();
  const parsed = parseEngagement(f);
  const peopleRows = await peopleOptions(c.env.DB);
  const reshow = async (error: string) =>
    c.html(
      layout({
        title: "New Engagement",
        body: engagementForm({
          orgNames: await orgNames(c.env.DB),
          peopleRows,
          originContactName: str(f.origin_contact),
          error,
          engagement: { ...(f as Partial<Engagement>), organization_name: str(f.organization) },
        }),
      })
    );
  if ("error" in parsed) return reshow(parsed.error);

  // Resolved BEFORE the insert, so a name that matches nobody stops the save rather than the record
  // being created with the referral silently dropped — the rule REL-005 set on the contact form.
  const referrer = await resolveContactByName(c.env.DB, parsed.origin_contact);
  if ("error" in referrer) return reshow(referrer.error);

  const organization_id = await resolveOrganization(c.env.DB, parsed.organization, parsed.calendar_tag);
  const inserted = await c.env.DB.prepare(
    `INSERT INTO engagement (${WRITABLE.join(", ")}) VALUES (${WRITABLE.map(() => "?").join(",")})`
  )
    .bind(...values(parsed, organization_id, referrer.id))
    .run();
  // From last_row_id, not "ORDER BY id DESC LIMIT 1" — the lesson of #31.
  const id = inserted?.meta?.last_row_id ?? 0;
  await audit(c.env.DB, id, "create", summary(parsed, parsed.organization));
  return c.redirect(`/engagements/${id}/edit?flash=created${needsReason(parsed) ? "&noreason=1" : ""}`);
});

app.post("/engagements/:id/edit", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare(
    `SELECT e.*, o.name AS organization_name, o.calendar_tag, p.full_name AS origin_contact_name
       FROM engagement e
       LEFT JOIN organization o ON o.id = e.organization_id
       LEFT JOIN contact p ON p.id = e.origin_contact_id
      WHERE e.id = ?`
  )
    .bind(id)
    .first<Engagement>();
  if (!before) return c.notFound();
  const f = await c.req.parseBody();
  const parsed = parseEngagement(f);
  const peopleRows = await peopleOptions(c.env.DB);
  const reshow = async (error: string) =>
    c.html(
      layout({
        title: "Edit Engagement",
        body: engagementForm({
          orgNames: await orgNames(c.env.DB),
          peopleRows,
          originContactName: str(f.origin_contact),
          error,
          engagement: { ...before, ...(f as Partial<Engagement>), id, organization_name: str(f.organization) },
          peopleSection: peopleBlock({
            engagementId: id,
            people: await pursuitPeople(c.env.DB, id),
            peopleRows,
          }),
        }),
      })
    );
  if ("error" in parsed) return reshow(parsed.error);

  const referrer = await resolveContactByName(c.env.DB, parsed.origin_contact);
  if ("error" in referrer) return reshow(referrer.error);

  const organization_id = await resolveOrganization(c.env.DB, parsed.organization, parsed.calendar_tag);
  await c.env.DB.prepare(
    `UPDATE engagement SET ${WRITABLE.map((k) => `${k}=?`).join(", ")}, updated_at=datetime('now')
      WHERE id=?`
  )
    .bind(...values(parsed, organization_id, referrer.id), id)
    .run();

  const after = summary(parsed, parsed.organization);
  /*
   * The before-string is built from the stored row through the SAME function, which is why `origin_contact`
   * is set from the joined name rather than left undefined: summary() prints "via <name>", and comparing a
   * string that never carries the referrer against one that does would report every save as a change.
   */
  const wasBefore = summary(
    {
      ...before,
      organization: before.organization_name ?? null,
      origin_contact: before.origin_contact_name ?? null,
    } as unknown as ParsedEngagement,
    before.organization_name ?? null
  );
  if (after === wasBefore) return c.redirect(`/engagements?flash=nochange`);
  await audit(c.env.DB, id, "update", after, wasBefore);
  return c.redirect(`/engagements?flash=saved${needsReason(parsed) ? `&noreason=${id}` : ""}`);
});

export default app;
