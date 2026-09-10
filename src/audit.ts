/*
 * AUD-002 — the audit log viewer (#27).
 *
 * AUD-001 delivered the writes and AUD-003 (#31) made them trustworthy: correct entity ids, real
 * field-level diffs, and a `contact-<id>` correlation on every event that concerns a relationship.
 * None of that was readable without a database query. This is the half that makes the trail evidence
 * rather than an assertion that evidence exists.
 *
 * The motivating case is concrete. Questions came up that could only be answered by querying D1
 * directly: did the test contact's audit event record the right id, what exactly did a date cleanup
 * change, and what did a backfill write. Each was a fair question about the operator's own data that
 * they could not answer themselves without direct database access.
 *
 * Design decisions:
 *
 *   - READ ONLY. There are no POST routes in this file, by construction rather than by permission
 *     check. An audit log with an edit path is not an audit log.
 *
 *   - FILTERS ARE BUILT FROM THE DATA, not from a hardcoded list. New entities appear the moment they
 *     write their first event — action_item and message_template will show up without touching this
 *     file. Hardcoding the vocabulary here would create a second source of truth that silently drifts,
 *     which is the failure REL-022 exists to catch.
 *
 *   - THE CONTACT FILTER MATCHES TWO WAYS. Events written since #50 carry `correlation_id =
 *     'contact-<id>'`, but everything older does not. Matching only the correlation would silently hide
 *     the entire pre-#50 history of a relationship — so it also matches entity='contact' with that id.
 *     A filter that quietly returns a subset is worse than no filter.
 *
 *   - SUMMARIES EXPAND rather than truncate. A deleted contact's before_summary is a 623-character JSON
 *     snapshot; that is the row you most need to read in full, since it is the only copy of a destroyed
 *     record. Truncation would hide exactly the thing worth keeping.
 */

import { Hono } from "hono";
import { esc, layout, select } from "./views";
import type { Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

/** Rows per page. The trail grows monotonically and one import can add hundreds. */
const PAGE_SIZE = 50;

interface AuditRow {
  id: number;
  actor: string;
  ts: string;
  entity: string;
  entity_id: string | null;
  action: string;
  before_summary: string | null;
  after_summary: string | null;
  source: string | null;
  correlation_id: string | null;
}

/**
 * Which entities can be linked back to a page in the app, and how.
 *
 * An interaction's own id is not routable — there is no /interactions/:id view, only an edit form — so
 * the link goes to the contact's history instead, which is where you would actually want to land. That
 * requires knowing the contact, which is exactly what the correlation id provides.
 */
function entityLink(r: AuditRow): string {
  const contactFromCorrelation = /^(?:delete-)?contact-(\d+)$/.exec(r.correlation_id ?? "")?.[1];
  if (r.entity === "contact" && r.entity_id && /^\d+$/.test(r.entity_id)) {
    // A deleted contact has no page left to visit; the snapshot below is all that remains of it.
    if (r.action === "delete") return `contact ${esc(r.entity_id)} <span class="meta">(deleted)</span>`;
    return `<a href="/contacts/${esc(r.entity_id)}">contact ${esc(r.entity_id)}</a>`;
  }
  if (r.entity === "interaction" && contactFromCorrelation)
    return `interaction ${esc(r.entity_id)} <span class="meta">· <a href="/contacts/${contactFromCorrelation}/history">history</a></span>`;
  if (r.entity === "message_template" && r.entity_id && /^\d+$/.test(r.entity_id))
    return `<a href="/templates/${esc(r.entity_id)}/edit">template ${esc(r.entity_id)}</a>`;
  if (r.entity === "action_item" && contactFromCorrelation)
    return `action item ${esc(r.entity_id)} <span class="meta">· <a href="/contacts/${contactFromCorrelation}#actions">contact</a></span>`;
  return `${esc(r.entity)} ${esc(r.entity_id ?? "—")}`;
}

const actionPill = (action: string) => {
  const cls =
    action === "delete" ? "red" : action === "create" ? "green" : action === "import" ? "amber" : "grey";
  return `<span class="pill ${cls}">${esc(action)}</span>`;
};

app.get("/audit", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const entity = c.req.query("entity") ?? "";
  const action = c.req.query("action") ?? "";
  const source = c.req.query("source") ?? "";
  const contactTyped = (c.req.query("contact") ?? "").trim();
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);

  const where: string[] = [];
  const params: unknown[] = [];

  if (entity) {
    where.push("a.entity = ?");
    params.push(entity);
  }
  if (action) {
    where.push("a.action = ?");
    params.push(action);
  }
  if (source) {
    where.push("a.source = ?");
    params.push(source);
  }
  // Dates are stored as 'YYYY-MM-DD HH:MM:SS', so a plain date compares correctly with >= and a
  // day-inclusive upper bound needs the whole day, not the bare date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    where.push("a.ts >= ?");
    params.push(from);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    where.push("a.ts <= ?");
    params.push(`${to} 23:59:59`);
  }
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    where.push(
      `(lower(ifnull(a.before_summary,'')) LIKE ? OR lower(ifnull(a.after_summary,'')) LIKE ?
        OR lower(ifnull(a.correlation_id,'')) LIKE ? OR lower(ifnull(a.entity_id,'')) LIKE ?)`
    );
    params.push(like, like, like, like);
  }

  /*
   * Resolving a contact by name rather than making the operator find an id. Matched two ways on
   * purpose — see the header note. The id is interpolated rather than bound because it has been
   * checked to be an integer, and it appears twice in the clause.
   */
  let contactNote = "";
  if (contactTyped) {
    const digits = /^\d+$/.test(contactTyped);
    const found = digits
      ? await c.env.DB.prepare("SELECT id, full_name FROM contact WHERE id = ?")
          .bind(Number(contactTyped))
          .first<{ id: number; full_name: string }>()
      : await c.env.DB.prepare("SELECT id, full_name FROM contact WHERE lower(full_name) = lower(?)")
          .bind(contactTyped)
          .first<{ id: number; full_name: string }>();
    if (found) {
      const id = Number(found.id);
      where.push(
        `(a.correlation_id IN ('contact-${id}', 'delete-contact-${id}') OR (a.entity = 'contact' AND a.entity_id = '${id}'))`
      );
      contactNote = `Showing everything recorded about <b>${esc(found.full_name)}</b> (contact ${id}). Events written before the correlation tag existed are matched by entity id, so the older history is included.`;
    } else {
      contactNote = `No contact matched “${esc(contactTyped)}”, so the contact filter was ignored. Type a full name exactly, or a contact id.`;
    }
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total =
    (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_event a ${clause}`).bind(...params).first<{ n: number }>())
      ?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const offset = (safePage - 1) * PAGE_SIZE;

  const { results } = await c.env.DB.prepare(
    `SELECT a.* FROM audit_event a ${clause} ORDER BY a.id DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`
  )
    .bind(...params)
    .all<AuditRow>();

  // Filter options come from the data, so a new entity type appears here the first time it writes.
  const [entities, actions, sources] = await Promise.all([
    c.env.DB.prepare("SELECT DISTINCT entity AS v FROM audit_event ORDER BY v").all<{ v: string }>(),
    c.env.DB.prepare("SELECT DISTINCT action AS v FROM audit_event ORDER BY v").all<{ v: string }>(),
    c.env.DB.prepare("SELECT DISTINCT ifnull(source,'') AS v FROM audit_event ORDER BY v").all<{ v: string }>(),
  ]);
  const opts = (rows: { v: string }[]) => rows.filter((r) => r.v !== "").map((r) => [r.v, r.v] as const);

  const filtersActive = Boolean(q || entity || action || source || contactTyped || from || to);
  const keep = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    const base: Record<string, string> = { q, entity, action, source, contact: contactTyped, from, to };
    for (const [k, v] of Object.entries({ ...base, ...extra })) if (v) p.set(k, v);
    return `/audit?${p.toString()}`;
  };

  const rows = results
    .map((r) => {
      const hasDetail = Boolean(r.before_summary || r.after_summary);
      const short = (r.after_summary ?? r.before_summary ?? "").slice(0, 120);
      const needsExpand =
        (r.before_summary?.length ?? 0) + (r.after_summary?.length ?? 0) > 120 || Boolean(r.before_summary);
      return `<tr>
      <td class="meta" style="white-space:nowrap;font-variant-numeric:tabular-nums">${esc(r.ts)}<div>#${r.id}</div></td>
      <td>${entityLink(r)}<div class="meta">${actionPill(r.action)} ${r.source && r.source !== "app" ? `<span class="pill grey">${esc(r.source)}</span>` : ""}</div></td>
      <td>${
        hasDetail
          ? needsExpand
            ? `<details><summary style="cursor:pointer">${esc(short)}${short.length >= 120 ? "…" : ""}</summary>
                 <div style="margin-top:8px">
                   ${r.before_summary ? `<div class="meta"><b>Before</b></div><div style="white-space:pre-wrap;font-size:13px;background:#fef2f2;border-radius:6px;padding:8px;margin-bottom:6px">${esc(r.before_summary)}</div>` : ""}
                   ${r.after_summary ? `<div class="meta"><b>After</b></div><div style="white-space:pre-wrap;font-size:13px;background:#f0fdf4;border-radius:6px;padding:8px">${esc(r.after_summary)}</div>` : ""}
                 </div></details>`
            : esc(r.after_summary ?? "")
          : '<span class="meta">no summary recorded</span>'
      }${
        r.correlation_id
          ? `<div class="meta" style="margin-top:4px">grouped as <a href="${keep({ q: r.correlation_id, contact: "", page: "" })}"><code>${esc(r.correlation_id)}</code></a></div>`
          : ""
      }</td>
    </tr>`;
    })
    .join("");

  return c.html(
    layout({
      title: "Audit Trail",
      body: `<main>
  <h1>Audit Trail</h1>
  <p class="sub">${total} event${total === 1 ? "" : "s"}${filtersActive ? " matching" : ""}${
        pages > 1 ? ` · page ${safePage} of ${pages}` : ""
      }${filtersActive ? ` · <a href="/audit">clear filters</a>` : ""} · <a href="/">back to dashboard</a></p>

  ${contactNote ? `<div class="flash ${contactNote.startsWith("No contact") ? "warn" : "ok"}">${contactNote}</div>` : ""}

  <form class="card" method="get" action="/audit">
    <label>Search the before and after text <span class="hint">also matches a correlation id or an entity id</span></label>
    <input type="text" name="q" value="${esc(q)}" placeholder="e.g. next_follow_up, or backfilled, or Grayson">
    <div class="row">
      <div><label>About this contact <span class="hint">full name or id</span></label><input type="text" name="contact" value="${esc(contactTyped)}" placeholder="e.g. Andrew Flanagan"></div>
      <div><label>Entity</label>${select("entity", opts(entities.results), entity, { blank: "Any entity" })}</div>
      <div><label>Action</label>${select("action", opts(actions.results), action, { blank: "Any action" })}</div>
      <div><label>Source</label>${select("source", opts(sources.results), source, { blank: "Any source" })}</div>
    </div>
    <div class="row">
      <div><label>From</label><input type="date" name="from" value="${esc(from)}"></div>
      <div><label>To</label><input type="date" name="to" value="${esc(to)}"></div>
    </div>
    <div class="actions">
      <button type="submit">Search</button>
      <a class="btn secondary" href="/audit">Reset</a>
    </div>
    <p class="meta" style="margin-top:10px">This page is read-only by construction — there are no write routes for it, so nothing here can be edited or removed from the app. <b>Source</b> distinguishes ordinary app activity from <code>maintenance</code> and <code>repair</code> work done directly against the database, and from an <code>import</code>.</p>
  </form>

  ${
    results.length
      ? `<table><thead><tr><th style="width:150px">When</th><th style="width:210px">What</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table>
         ${
           pages > 1
             ? `<div class="actions" style="justify-content:space-between">
                  ${safePage > 1 ? `<a class="btn secondary" href="${keep({ page: String(safePage - 1) })}">← Newer</a>` : "<span></span>"}
                  <span class="meta">page ${safePage} of ${pages}</span>
                  ${safePage < pages ? `<a class="btn secondary" href="${keep({ page: String(safePage + 1) })}">Older →</a>` : "<span></span>"}
                </div>`
             : ""
         }`
      : `<div class="card empty">${
          filtersActive ? 'No events match those filters. <a href="/audit">Clear all</a>' : "No audit events recorded yet."
        }</div>`
  }
</main>`,
    })
  );
});

export default app;
