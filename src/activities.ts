// The activity vocabulary, as data (migration 0026).
//
// The goal: let the application offer to create a new category when one has been added in Outlook, and
// ask how to apply it, rather than rejecting it outright. See the migration for the full argument; the
// short version is that a value in a real table needs no schema rebuild, so adding one is exactly as safe
// (an unrecognized activity still fails loudly, via a foreign key instead of a CHECK) and costs no
// migration.
//
// "ASK ME HOW TO APPLY IT" is answered by one question: does this count as worked hours? That is the one
// axis every report in this app actually branches on (time.ts's "hours worked" total, the dashboard's
// weekly-hours figure) — whether an activity is BILLABLE is a separate, more consequential decision
// (it feeds an invoice) and is deliberately not offered here; see the migration's note on
// BILLABLE_ACTIVITY, which stays a fixed constant in types.ts.

import { Hono } from "hono";
import { esc, layout } from "./views";
import type { Bindings, D1Db } from "./types";

const app = new Hono<{ Bindings: Bindings }>();
const ACTOR = "operator";

export interface ActivityRow {
  name: string;
  is_work: number;
  is_billable: number;
}

export async function loadActivities(db: D1Db): Promise<ActivityRow[]> {
  const { results } = await db
    .prepare("SELECT name, is_work, is_billable FROM activity ORDER BY name")
    .all<ActivityRow>();
  return results;
}

/** For views.ts's select() — value and label are the same, matching the Outlook category text exactly. */
export function activityOptions(rows: ActivityRow[]): [string, string][] {
  return rows.map((r) => [r.name, r.name]);
}

/** Activities that are real time but not worked time — Personal, and now whatever else joins it. */
export function nonWorkNames(rows: ActivityRow[]): Set<string> {
  return new Set(rows.filter((r) => !r.is_work).map((r) => r.name));
}

export function isKnownActivity(rows: ActivityRow[], name: string): boolean {
  return rows.some((r) => r.name === name);
}

const str = (v: unknown): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? null : t;
};

async function audit(db: D1Db, name: string, action: string, after: string, before?: string | null) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,'activity',?,?,?,?,'app',?)"
    )
    .bind(ACTOR, name, action, before ?? null, after, `activity-${name}`)
    .run();
}

/**
 * Shared by the standalone page below and the inline prompt on /time/import (calimport.ts) when an
 * Outlook category does not match anything known — one creation path, two entry points.
 */
app.post("/activities", async (c) => {
  const f = await c.req.parseBody();
  const name = str(f.name);
  const isWork = str(f.is_work) !== "0"; // defaults to worked hours unless explicitly told otherwise
  const redirect = str(f.redirect);
  const back = redirect && redirect.startsWith("/") ? redirect : "/activities";

  if (!name) return c.redirect(`${back}${back.includes("?") ? "&" : "?"}flash=nochange`);

  const existing = await c.env.DB.prepare("SELECT name FROM activity WHERE name = ?").bind(name).first();
  if (existing) return c.redirect(`${back}${back.includes("?") ? "&" : "?"}flash=exists`);

  await c.env.DB.prepare("INSERT INTO activity (name, is_work) VALUES (?,?)").bind(name, isWork ? 1 : 0).run();
  await audit(c.env.DB, name, "create", `added — ${isWork ? "counts as worked hours" : "not worked hours"}`);
  return c.redirect(`${back}${back.includes("?") ? "&" : "?"}flash=added`);
});

app.post("/activities/:name/delete", async (c) => {
  const name = decodeURIComponent(c.req.param("name"));
  const inUse = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM time_entry WHERE activity = ?")
    .bind(name)
    .first<{ n: number }>();
  if ((inUse?.n ?? 0) > 0) return c.redirect("/activities?flash=inuse");

  const res = await c.env.DB.prepare("DELETE FROM activity WHERE name = ?").bind(name).run();
  if ((res?.meta?.changes ?? 0) > 0) await audit(c.env.DB, name, "delete", "removed, unused");
  return c.redirect("/activities?flash=deleted");
});

app.get("/activities", async (c) => {
  const rows = await loadActivities(c.env.DB);
  const flash = c.req.query("flash");
  const FLASH: Record<string, string> = {
    added: "Activity added.",
    deleted: "Activity removed.",
    inuse: "That activity has time logged against it, so it cannot be removed — the hours would be left pointing at nothing.",
    exists: "That activity already exists.",
    nochange: "Nothing to add — the name field was blank.",
  };
  const flashHtml = flash && FLASH[flash] ? `<div class="flash ${flash === "inuse" ? "warn" : "ok"}">${esc(FLASH[flash])}</div>` : "";

  return c.html(
    layout({
      title: "Activities",
      body: `<main>
  <h1>Activities</h1>
  <p class="sub">The categories time can be logged against — matched literally to the Outlook category on the event.</p>
  ${flashHtml}

  <table><thead><tr><th>Name</th><th>Counts as worked hours</th><th>Billable</th><th></th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr>
      <td>${esc(r.name)}</td>
      <td>${r.is_work ? "Yes" : '<span class="pill grey">No</span>'}</td>
      <td>${r.is_billable ? '<span class="pill green">Client Delivery — feeds invoicing</span>' : "—"}</td>
      <td style="text-align:right">${
        r.is_billable
          ? '<span class="meta">fixed in code</span>'
          : `<form method="post" action="/activities/${encodeURIComponent(r.name)}/delete" style="display:inline"><button class="tiny secondary" type="submit">Delete</button></form>`
      }</td>
    </tr>`
      )
      .join("")}</tbody></table>

  <section>
    <h2>Add a new activity</h2>
    <form method="post" action="/activities" class="card">
      <label>Name <span class="hint">exactly as it will read in Outlook — case matters</span></label>
      <input type="text" name="name" placeholder="e.g. Vacation/Holiday" required>
      <label class="check"><input type="radio" name="is_work" value="1" checked> Counts as worked hours</label>
      <label class="check"><input type="radio" name="is_work" value="0"> Not worked hours — like Personal (vacation, holidays, time off)</label>
      <div class="actions"><button type="submit">Add Activity</button></div>
    </form>
    <p class="meta" style="margin-top:8px">Whether an activity is <b>billable</b> (feeds the Client Delivery invoicing total) is not set here — only one activity has ever been billable, and making a new one billable is a bigger decision than a same-day add. Ask for that one directly if it's ever genuinely needed.</p>
  </section>
</main>`,
    })
  );
});

export default app;
