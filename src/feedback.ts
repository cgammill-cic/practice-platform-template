// Enhancement requests (migration 0025).
//
// The idea: somewhere to recommend enhancements that the operator can incorporate into the application
// later if it's deemed worthwhile. A running backlog, reviewed by hand — not a voting board, not a
// roadmap, just somewhere an idea goes so it survives past the conversation that produced it.
//
// PER-INSTANCE, DELIBERATELY. This page ships in the same codebase every PKG-001 deployment runs, so a
// friend's own copy gets its own local backlog — for their own use, on their own data. It does not phone
// anything back to the operator's own instance; getting a request from a friend's instance back to the
// original operator is a conversation between them, not a network call this app makes. See migration
// 0025 for the fuller argument, which is the same one PKG-001 (#96) already settled: no shared backend
// between instances, full stop.

import { Hono } from "hono";
import { esc, layout, select } from "./views";
import type { Bindings, D1Db } from "./types";

const app = new Hono<{ Bindings: Bindings }>();
const ACTOR = "operator";

const STATUSES = [
  ["new", "New"],
  ["considering", "Considering"],
  ["planned", "Planned"],
  ["done", "Done"],
  ["declined", "Declined"],
] as const;
type Status = (typeof STATUSES)[number][0];
const STATUS_VALUES = new Set<string>(STATUSES.map(([v]) => v));
const STATUS_LABEL: Record<string, string> = Object.fromEntries(STATUSES);
/** Which pill color reads right for each status — new and considering are still open questions. */
const STATUS_PILL: Record<string, string> = {
  new: "grey",
  considering: "amber",
  planned: "",
  done: "green",
  declined: "red",
};
/** Requests in these statuses are the open backlog; the rest are settled and collapsed by default. */
const OPEN_STATUSES = new Set(["new", "considering", "planned"]);

interface Request {
  id: number;
  submitted_by: string | null;
  summary: string;
  detail: string | null;
  status: Status;
  created_at: string;
  updated_at: string;
}

const str = (v: unknown): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? null : t;
};

async function audit(
  db: D1Db,
  entityId: string,
  action: string,
  after: string,
  before?: string | null
) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,'feature_request',?,?,?,?,'app',?)"
    )
    .bind(ACTOR, entityId, action, before ?? null, after, `feature-request-${entityId}`)
    .run();
}

const row = (r: Request): string => `<tr>
  <td>
    <b>${esc(r.summary)}</b>
    ${r.detail ? `<div class="meta" style="margin-top:4px;white-space:pre-wrap">${esc(r.detail)}</div>` : ""}
    <div class="meta" style="margin-top:4px">${esc((r.created_at ?? "").slice(0, 10))}${r.submitted_by ? ` · ${esc(r.submitted_by)}` : ""}</div>
  </td>
  <td data-label="Status" style="white-space:nowrap">
    <span class="pill ${STATUS_PILL[r.status]}" style="margin-bottom:6px;display:inline-block">${esc(STATUS_LABEL[r.status])}</span>
    <form method="post" action="/feedback/${r.id}/status" class="quickset" style="align-items:center;gap:6px">
      ${select("status", STATUSES, r.status)}
      <button class="tiny secondary" type="submit">Update</button>
    </form>
  </td>
  <td style="text-align:right">
    <form method="post" action="/feedback/${r.id}/delete" style="display:inline">
      <button class="secondary tiny" type="submit">Delete</button>
    </form>
  </td>
</tr>`;

app.get("/feedback", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM feature_request ORDER BY (status IN ('done','declined')), created_at"
  ).all<Request>();
  const open = results.filter((r) => OPEN_STATUSES.has(r.status));
  const settled = results.filter((r) => !OPEN_STATUSES.has(r.status));

  const flash = c.req.query("flash");
  const FLASH: Record<string, string> = {
    added: "Request added.",
    updated: "Status updated.",
    deleted: "Request deleted.",
    nochange: "Nothing to add — the summary field was blank.",
  };
  const flashHtml = flash && FLASH[flash] ? `<div class="flash ok">${esc(FLASH[flash])}</div>` : "";

  const table = (list: Request[], emptyText: string) =>
    list.length
      ? `<table><thead><tr><th>Request</th><th>Status</th><th></th></tr></thead><tbody>${list.map(row).join("")}</tbody></table>`
      : `<div class="empty">${esc(emptyText)}</div>`;

  return c.html(
    layout({
      title: "Enhancement Requests",
      body: `<main>
  <h1>Enhancement Requests</h1>
  <p class="sub">Somewhere an idea goes so it survives past the conversation that produced it.</p>
  ${flashHtml}

  <form class="card" method="post" action="/feedback">
    <label>What would help</label>
    <input type="text" name="summary" placeholder="e.g. Let me filter the pipeline by department" required>
    <label>More detail <span class="hint">optional</span></label>
    <textarea name="detail" placeholder="What made you want this — the situation it would have helped with"></textarea>
    <div class="actions"><button type="submit">Add Request</button></div>
  </form>

  <section>
    <h2>Open (${open.length})</h2>
    ${table(open, "Nothing open. Add one above.")}
  </section>

  <section>
    <h2>Settled (${settled.length})</h2>
    <details class="hist-more"${settled.length && settled.length <= 5 ? " open" : ""}>
      <summary>${settled.length} done or declined</summary>
      ${table(settled, "None yet.")}
    </details>
  </section>
</main>`,
    })
  );
});

app.post("/feedback", async (c) => {
  const f = await c.req.parseBody();
  const summary = str(f.summary);
  const detail = str(f.detail);
  if (!summary) return c.redirect("/feedback?flash=nochange");

  const res = await c.env.DB.prepare(
    "INSERT INTO feature_request (submitted_by, summary, detail) VALUES (?,?,?)"
  )
    .bind(ACTOR, summary, detail)
    .run();
  const id = res?.meta?.last_row_id ?? 0;
  await audit(c.env.DB, String(id), "create", `${summary}${detail ? ` — ${detail}` : ""}`);
  return c.redirect("/feedback?flash=added");
});

app.post("/feedback/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const f = await c.req.parseBody();
  const status = str(f.status);
  if (!status || !STATUS_VALUES.has(status)) return c.redirect("/feedback");

  const before = await c.env.DB.prepare("SELECT summary, status FROM feature_request WHERE id = ?")
    .bind(id)
    .first<{ summary: string; status: string }>();
  if (!before) return c.notFound();
  if (before.status === status) return c.redirect("/feedback");

  await c.env.DB.prepare(
    "UPDATE feature_request SET status = ?, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(status, id)
    .run();
  await audit(
    c.env.DB,
    String(id),
    "update",
    `${before.summary}: ${STATUS_LABEL[status]}`,
    `${before.summary}: ${STATUS_LABEL[before.status]}`
  );
  return c.redirect("/feedback?flash=updated");
});

app.post("/feedback/:id/delete", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT summary, detail, status FROM feature_request WHERE id = ?")
    .bind(id)
    .first<{ summary: string; detail: string | null; status: string }>();
  if (!before) return c.notFound();

  await c.env.DB.prepare("DELETE FROM feature_request WHERE id = ?").bind(id).run();
  await audit(
    c.env.DB,
    String(id),
    "delete",
    "removed",
    `${before.summary}${before.detail ? ` — ${before.detail}` : ""} (${STATUS_LABEL[before.status]})`
  );
  return c.redirect("/feedback?flash=deleted");
});

export default app;
