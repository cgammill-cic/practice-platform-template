/*
 * Sales commitments (0035, the owner 2026-09-27) — the accountability half of the sales-advisor
 * skill. Year one is $250K from 2026-06-01 and the target after it is a $500K run rate; the advisor
 * reads this app's data, challenges what it shows, and ends every session with one to three dated
 * commitments. The next session opens by asking what happened to them. This module is where they live.
 *
 * Not action items (actions.ts). An action item is what the owner owes a person, and needs one. A
 * commitment is his own sales discipline — "ask a connector for two introductions", "define the entry
 * offer" — with a person and a pursuit as optional context. The UI calls these "Sales Commitments"
 * wherever they appear beside action items, because the contact page's action-item form already says
 * "Add a commitment" and the two must not be mistaken for each other.
 *
 * Three ways to close, not two: done, missed, dropped. Missed is the one that matters — an honest
 * record of what did not happen is what makes the next conversation useful — and the outcome note
 * holds what actually happened in his words. The hit rate (done ÷ done + missed, last 90 days) is the
 * single number the advisor reports back; dropped is excluded because re-planning is not failing.
 *
 * Admin-only (auth.ts ADMIN_ONLY): it is personal coaching data, like /outreach. The sections on the
 * contact and pursuit pages render only for an admin for the same reason, and because their forms post
 * here.
 */

import { Hono } from "hono";
import { esc, followUpDotClass, followUpPill, layout, priorityBadge, select } from "./views";
import { LIVE_STAGES, PURSUIT_STAGES, type Bindings, type D1Db } from "./types";
import { actor } from "./auth";
import { localToday } from "./weeks";

const app = new Hono<{ Bindings: Bindings }>();
/** "Today" in the copy's timezone (definitions.md §5p), so a commitment due today is not overdue at 7pm Central. */
const today = () => localToday();

export const COMMITMENT_STATUSES = ["open", "done", "missed", "dropped"] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export const COMMITMENT_CATEGORIES = [
  ["activity", "Activity", "BD hours, touches, asks"],
  ["relationship", "Relationship", "a specific person"],
  ["pursuit", "Pursuit", "moving a deal"],
  ["offer", "Offer", "entry offer, packaging, pricing"],
  ["positioning", "Positioning", "message, niche, proof"],
  ["other", "Other"],
] as const;
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(COMMITMENT_CATEGORIES.map(([v, l]) => [v, l]));

export interface CommitmentRow {
  id: number;
  description: string;
  due_date: string | null;
  status: CommitmentStatus;
  outcome_note: string | null;
  category: string | null;
  contact_id: number | null;
  engagement_id: number | null;
  source: "app" | "advisor";
  created_at: string;
  closed_at: string | null;
  full_name: string | null;
  is_priority: number | null;
  engagement_name: string | null;
  organization_name: string | null;
}

const SELECT = `SELECT m.*, c.full_name, c.is_priority, e.name AS engagement_name, o.name AS organization_name
  FROM commitment m
  LEFT JOIN contact c ON c.id = m.contact_id
  LEFT JOIN engagement e ON e.id = m.engagement_id
  LEFT JOIN organization o ON o.id = COALESCE(e.organization_id, c.organization_id)`;

/** Open first; within open, overdue and soonest due first, undated last (they sort after the dated ones
 * here, unlike action items, because a sales commitment is agreed WITH a date — an undated one is the
 * exception and is flagged instead). Closed items most recently closed first. */
const ORDER = `ORDER BY (m.status <> 'open'),
  CASE WHEN m.status = 'open' THEN (m.due_date IS NULL) ELSE 0 END,
  CASE WHEN m.status = 'open' THEN m.due_date ELSE NULL END,
  m.closed_at DESC, m.id DESC`;

export async function listCommitments(
  db: D1Db,
  opts: { contactId?: number; engagementId?: number; includeClosed?: boolean; limit?: number } = {}
): Promise<CommitmentRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.contactId) (where.push("m.contact_id = ?"), binds.push(opts.contactId));
  if (opts.engagementId) (where.push("m.engagement_id = ?"), binds.push(opts.engagementId));
  if (!opts.includeClosed) where.push("m.status = 'open'");
  const { results } = await db
    .prepare(`${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ${ORDER} LIMIT ?`)
    .bind(...binds, opts.limit ?? 300)
    .all<CommitmentRow>();
  return results;
}

/** Done ÷ (done + missed) over the last `days` days of closings. Null when nothing has closed yet. */
export async function hitRate(db: D1Db, days = 90): Promise<{ done: number; missed: number; rate: number | null }> {
  const row = await db
    .prepare(
      `SELECT SUM(status = 'done') AS done, SUM(status = 'missed') AS missed FROM commitment
        WHERE status IN ('done','missed') AND closed_at >= date('now', ?)`
    )
    .bind(`-${days} days`)
    .first<{ done: number | null; missed: number | null }>();
  const done = row?.done ?? 0;
  const missed = row?.missed ?? 0;
  return { done, missed, rate: done + missed ? done / (done + missed) : null };
}

async function audit(db: D1Db, id: number, action: string, after: string, before?: string) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,?,?,?,?,?,'app',?)"
    )
    .bind(actor(), "commitment", String(id), action, before ?? null, after, `commitment-${id}`)
    .run();
}

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};
const posInt = (v: unknown): number | null => {
  const n = Number(str(v) ?? "");
  return Number.isInteger(n) && n > 0 ? n : null;
};

function summary(r: { description: string; due_date: string | null; full_name?: string | null; engagement_name?: string | null }) {
  return `${r.description} · due ${r.due_date ?? "not set"}${r.full_name ? ` · ${r.full_name}` : ""}${
    r.engagement_name ? ` · pursuit ${r.engagement_name}` : ""
  }`;
}

// ---------------------------------------------------------------- rendering

const STATUS_PILL: Record<string, string> = {
  done: '<span class="pill green">done</span>',
  missed: '<span class="pill red">missed</span>',
  dropped: '<span class="pill grey">dropped</span>',
};

export function commitmentRow(r: CommitmentRow, opts: { showContact?: boolean; showPursuit?: boolean } = {}): string {
  const open = r.status === "open";
  const overdue = open && r.due_date && r.due_date < today();
  const links: string[] = [];
  if (opts.showContact !== false && r.contact_id && r.full_name)
    links.push(`<a href="/contacts/${r.contact_id}">${esc(r.full_name)}</a> ${priorityBadge({ is_priority: r.is_priority ?? 0 })}`);
  if (opts.showPursuit !== false && r.engagement_id && r.engagement_name)
    links.push(`<a href="/engagements/${r.engagement_id}/edit">${esc(r.engagement_name)}</a>`);
  if (r.organization_name && (links.length || (!r.contact_id && !r.engagement_id))) links.push(esc(r.organization_name));
  if (r.category) links.push(esc(CATEGORY_LABEL[r.category] ?? r.category));
  if (r.source === "advisor") links.push("from the sales advisor");

  const controls = open
    ? `<details class="closeout"><summary class="btn secondary tiny">Close out</summary>
        <form method="post" action="/commitments/${r.id}/status" class="quickset" style="align-items:flex-end;margin-top:6px">
          <div style="flex:1 1 220px"><label>What happened? <span class="hint">optional</span></label>
            <input type="text" name="outcome_note" placeholder="e.g. Asked; he'll intro two CFOs next week"></div>
          <button class="tiny" type="submit" name="status" value="done">Done</button>
          <button class="tiny secondary" type="submit" name="status" value="missed">Missed</button>
          <button class="tiny secondary" type="submit" name="status" value="dropped">Dropped</button>
        </form></details>`
    : `<form method="post" action="/commitments/${r.id}/status" style="display:inline"><input type="hidden" name="status" value="open"><button class="secondary tiny" type="submit">Reopen</button></form>`;

  return `<div class="listrow"${overdue ? ' style="background:var(--red-tint)"' : ""}>
    <span class="dot ${open ? (r.due_date ? followUpDotClass(r.due_date) : "amber") : r.status === "done" ? "green" : "grey"}"></span>
    <div class="listrow-main">
      <div class="listrow-name">${esc(r.description)}</div>
      ${links.length ? `<div class="meta">${links.join(" · ")}</div>` : ""}
      ${r.outcome_note ? `<div class="meta"><b>Outcome:</b> ${esc(r.outcome_note)}</div>` : ""}
      ${open ? controls : ""}
    </div>
    <div class="listrow-meta">
      ${open ? (r.due_date ? followUpPill(r.due_date) : '<span class="pill amber">no due date</span>') : `${STATUS_PILL[r.status] ?? ""}${r.closed_at ? ` <span class="meta">${esc(r.closed_at.slice(0, 10))}</span>` : ""}`}
      <div>
        ${open ? "" : controls}
        <form method="post" action="/commitments/${r.id}/delete" style="display:inline"><button class="secondary tiny" type="submit">Delete</button></form>
      </div>
    </div>
  </div>`;
}

const categorySelect = () => select("category", COMMITMENT_CATEGORIES, null, { blank: "Category (optional)" });

/**
 * The Sales Commitments section on a contact record or a pursuit page. Open items listed, closed ones
 * behind a <details> with their outcomes, and an add form that pre-links to the page you are on.
 */
export function commitmentBlock(link: { contactId?: number; engagementId?: number }, rows: CommitmentRow[]): string {
  const open = rows.filter((r) => r.status === "open");
  const closed = rows.filter((r) => r.status !== "open");
  const rowOpts = { showContact: !link.contactId, showPursuit: !link.engagementId };
  const list = (l: CommitmentRow[]) => `<div class="list">${l.map((r) => commitmentRow(r, rowOpts)).join("")}</div>`;
  return `${open.length ? list(open) : '<div class="empty">No open sales commitments here.</div>'}
  ${closed.length ? `<details class="hist-more"><summary>${closed.length} closed</summary>${list(closed)}</details>` : ""}
  <form method="post" action="/commitments" class="quickset" style="align-items:flex-end">
    ${link.contactId ? `<input type="hidden" name="contact_id" value="${link.contactId}">` : ""}
    ${link.engagementId ? `<input type="hidden" name="engagement_id" value="${link.engagementId}">` : ""}
    <div style="flex:1 1 240px"><label>Add a sales commitment</label>
      <input type="text" name="description" placeholder="e.g. Ask for two introductions" required></div>
    <div style="flex:0 1 160px"><label>Due</label><input type="date" name="due_date"></div>
    <div style="flex:0 1 180px"><label>Category</label>${categorySelect()}</div>
    <button type="submit">Add</button>
  </form>`;
}

/** Where to land after a write: back on the contact or pursuit page it came from, at the section. */
function backTo(referer: string | undefined, key: string): string {
  const from = referer ?? "";
  const onContact = /\/contacts\/(\d+)(?:[?#]|$)/.exec(from);
  if (onContact) return `/contacts/${onContact[1]}#commitments`;
  const onPursuit = /\/engagements\/(\d+)\/edit(?:[?#]|$)/.exec(from);
  if (onPursuit) return `/engagements/${onPursuit[1]}/edit#commitments`;
  return `/commitments?flash=${key}`;
}

// ---------------------------------------------------------------- list page

app.get("/commitments", async (c) => {
  const db = c.env.DB;
  const showAll = c.req.query("show") === "all";
  const flash = c.req.query("flash");
  const rows = await listCommitments(db, { includeClosed: showAll });
  const hr = await hitRate(db);
  const overdue = rows.filter((r) => r.status === "open" && r.due_date && r.due_date < today()).length;

  const names = await db
    .prepare(
      `SELECT c.full_name, o.name AS organization_name FROM contact c LEFT JOIN organization o ON o.id = c.organization_id
        WHERE c.status='active' ORDER BY c.full_name LIMIT 600`
    )
    .all<{ full_name: string; organization_name: string | null }>();
  const stages = [...PURSUIT_STAGES, ...LIVE_STAGES];
  const pursuits = await db
    .prepare(
      `SELECT e.id, e.name, o.name AS organization_name FROM engagement e LEFT JOIN organization o ON o.id = e.organization_id
        WHERE e.status IN (${stages.map(() => "?").join(",")}) ORDER BY o.name, e.name`
    )
    .bind(...stages)
    .all<{ id: number; name: string; organization_name: string | null }>();

  const flashMap: Record<string, string> = {
    added: "Commitment added.",
    updated: "Commitment updated.",
    deleted: "Commitment deleted.",
    noname: "A commitment needs a description, so nothing was saved.",
    nomatch: "No active contact matched that name, so nothing was saved. Pick a name from the suggestions, or leave it blank.",
    ambiguous: "More than one contact has that name, so nothing was saved. Add it from the right contact's record instead.",
  };
  const isWarn = flash === "noname" || flash === "nomatch" || flash === "ambiguous";
  const rateLine =
    hr.rate === null
      ? "No commitments closed in the last 90 days yet."
      : `Hit rate, last 90 days: <b>${Math.round(hr.rate * 100)}%</b> (${hr.done} done, ${hr.missed} missed; dropped not counted).`;

  return c.html(
    layout({
      c,
      title: "Commitments",
      body: `<main>
  ${flash && flashMap[flash] ? `<div class="flash ${isWarn ? "warn" : "ok"}">${esc(flashMap[flash])}</div>` : ""}
  <h1>Sales Commitments</h1>
  <p class="sub">${rows.filter((r) => r.status === "open").length} open${overdue ? ` · <b>${overdue} overdue</b>` : ""} · ${
        showAll ? '<a href="/commitments">open only</a>' : '<a href="/commitments?show=all">show closed too</a>'
      }</p>
  <p class="meta">${rateLine} What you commit to doing to sell better — agreed with the sales advisor or added here. Close each one out as done, missed, or dropped; the next advisor session starts by asking what happened.</p>

  <form class="card" method="post" action="/commitments">
    <h2>Add a commitment</h2>
    <label>What will you do?</label>
    <input type="text" name="description" placeholder="e.g. Ask Jane Smith for two introductions to CFOs" required>
    <div class="row">
      <div><label>Due</label><input type="date" name="due_date"></div>
      <div><label>Category</label>${categorySelect()}</div>
    </div>
    <div class="row">
      <div><label>Person <span class="hint">optional — start typing</span></label>
        <input type="text" name="contact" list="contactnames" placeholder="e.g. Jane Smith">
        <datalist id="contactnames">${names.results
          .map((k) => `<option value="${esc(k.full_name)}">${esc(k.organization_name ?? "")}</option>`)
          .join("")}</datalist></div>
      <div><label>Pursuit <span class="hint">optional</span></label>${select(
        "engagement_id",
        pursuits.results.map((p) => [String(p.id), p.organization_name ? `${p.organization_name} — ${p.name}` : p.name] as const),
        null,
        { blank: "None" }
      )}</div>
    </div>
    <div class="actions"><button type="submit">Add Commitment</button></div>
  </form>

  ${
    rows.length
      ? `<div class="list">${rows.map((r) => commitmentRow(r)).join("")}</div>`
      : `<div class="card empty">${showAll ? "No commitments recorded yet." : 'Nothing open. <a href="/commitments?show=all">See closed ones</a>'}</div>`
  }
</main>`,
    })
  );
});

// ---------------------------------------------------------------- writes

async function resolveContact(db: D1Db, typed: string): Promise<{ id: number } | { error: string }> {
  const { results } = await db
    .prepare("SELECT id FROM contact WHERE lower(full_name) = lower(?) AND status='active'")
    .bind(typed)
    .all<{ id: number }>();
  if (results.length === 1) return { id: results[0].id };
  return { error: results.length ? "ambiguous" : "nomatch" };
}

app.post("/commitments", async (c) => {
  const db = c.env.DB;
  const f = await c.req.parseBody();
  const ref = c.req.header("referer");
  const description = str(f.description);
  if (!description) return c.redirect(backTo(ref, "noname"));

  let contactId = posInt(f.contact_id);
  if (!contactId && str(f.contact)) {
    const resolved = await resolveContact(db, str(f.contact)!);
    if ("error" in resolved) return c.redirect(`/commitments?flash=${resolved.error}`);
    contactId = resolved.id;
  }
  const contact = contactId
    ? await db.prepare("SELECT full_name FROM contact WHERE id = ?").bind(contactId).first<{ full_name: string }>()
    : null;
  if (contactId && !contact) return c.redirect(`/commitments?flash=nomatch`);

  const engagementId = posInt(f.engagement_id);
  const engagement = engagementId
    ? await db.prepare("SELECT name FROM engagement WHERE id = ?").bind(engagementId).first<{ name: string }>()
    : null;

  const category = str(f.category);
  const validCategory = category && CATEGORY_LABEL[category] ? category : null;
  const dueDate = str(f.due_date);

  const res = await db
    .prepare(
      "INSERT INTO commitment (description, due_date, category, contact_id, engagement_id, source) VALUES (?,?,?,?,?,'app')"
    )
    .bind(description, dueDate, validCategory, contact ? contactId : null, engagement ? engagementId : null)
    .run();
  const id = res?.meta?.last_row_id ?? 0;
  await audit(
    db,
    id,
    "create",
    summary({ description, due_date: dueDate, full_name: contact?.full_name, engagement_name: engagement?.name })
  );
  return c.redirect(backTo(ref, "added"));
});

app.post("/commitments/:id/status", async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const f = await c.req.parseBody();
  const status = str(f.status) as CommitmentStatus | null;
  if (!status || !(COMMITMENT_STATUSES as readonly string[]).includes(status)) return c.redirect(backTo(c.req.header("referer"), "updated"));
  const before = await db
    .prepare("SELECT description, due_date, status, outcome_note FROM commitment WHERE id = ?")
    .bind(id)
    .first<{ description: string; due_date: string | null; status: string; outcome_note: string | null }>();
  if (!before) return c.notFound();
  const note = str(f.outcome_note);
  const outcome = note ?? before.outcome_note;
  await db
    .prepare(
      `UPDATE commitment SET status = ?, outcome_note = ?, closed_at = ${status === "open" ? "NULL" : "datetime('now')"},
         updated_at = datetime('now') WHERE id = ?`
    )
    .bind(status, outcome, id)
    .run();
  await audit(
    db,
    id,
    "update",
    `${status === "open" ? "reopened" : status}${note ? ` — ${note}` : ""} · ${before.description}`,
    `${before.status}${before.outcome_note ? ` — ${before.outcome_note}` : ""}`
  );
  return c.redirect(backTo(c.req.header("referer"), "updated"));
});

app.post("/commitments/:id/delete", async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const before = await db
    .prepare(
      `SELECT m.description, m.due_date, m.status, c.full_name, e.name AS engagement_name FROM commitment m
        LEFT JOIN contact c ON c.id = m.contact_id LEFT JOIN engagement e ON e.id = m.engagement_id WHERE m.id = ?`
    )
    .bind(id)
    .first<{ description: string; due_date: string | null; status: string; full_name: string | null; engagement_name: string | null }>();
  if (!before) return c.notFound();
  const removed = await db.prepare("DELETE FROM commitment WHERE id = ?").bind(id).run();
  // Gated on a row actually going, like actions.ts (#51): a repeated POST must not audit twice.
  if ((removed.meta?.changes ?? 1) > 0)
    await audit(db, id, "delete", "deleted — removed, not closed out", `${summary(before)} · was ${before.status}`);
  return c.redirect(backTo(c.req.header("referer"), "deleted"));
});

export default app;
