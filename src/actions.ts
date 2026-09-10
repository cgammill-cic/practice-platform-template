/*
 * REL-007 — meeting action items (#18). REL-024 — the contact picker. REL-025 — reachable from the
 * contact record and the meeting resolution flow (#47).
 *
 * REL-025: until now an action item could only be seen at /actions or on the dashboard, which meant
 * the two moments that matter were both blind to it. You open a contact record before a call and it
 * does not tell you that you owe this person two things; you resolve a held meeting and there is
 * nowhere to put "I said I'd send the overview by Tuesday". REL-037 sharpened that — Held now defaults
 * to Follow-Up Action, so every held meeting lands the contact in "the next move is yours" while the
 * system holds no record of what the move is. The exports below are what the contact record and the
 * resolution handler in contacts.ts use, so the markup and the insert path exist once.
 *
 * The thing this protects: something you promised in a meeting, which otherwise survives only in the
 * interaction summary and in your memory. The Follow-Up Action stage says the next move is yours; this
 * says what the move actually is, and lets three commitments from one meeting have three due dates and
 * be finished on three different days.
 *
 * REL-024: the add form used a <select> listing every contact, which meant scrolling past the entire
 * contact list to reach the Due field once it was rendered. Replaced with a type-ahead input backed by
 * a datalist — the same pattern the contact form already uses for organizations. Names are resolved
 * server-side, and an ambiguous name is refused with the candidates listed rather than guessed at,
 * because attaching a commitment to the wrong person is worse than making you disambiguate.
 *
 * CORRECTION, 2026-08-01. An earlier version of this comment asserted the contact list already had
 * duplicate names in production. Checked against production: it did not. The refusal itself stays —
 * full_name has no unique constraint, so two same-named contacts remain creatable, and refusing beats
 * guessing on the day it happens. But it is a guard against a possible state, not a description of the
 * current one.
 *
 * Other design decisions:
 *   - An item with no due date is NOT hidden. It sorts to the top of the open list, the same inversion
 *     used in dashboard section 2, because an undated commitment is the one nothing else will raise.
 *   - Deleting is separate from completing and audited differently. "I did this" and "this was never
 *     really a commitment" are different facts and the trail should not conflate them.
 */

import { Hono } from "hono";
import { esc, followUpPill, layout } from "./views";
import type { Bindings, D1Db } from "./types";

const app = new Hono<{ Bindings: Bindings }>();
const ACTOR = "operator";
const today = () => new Date().toISOString().slice(0, 10);

export interface ActionRow {
  id: number;
  contact_id: number;
  interaction_id: number | null;
  description: string;
  due_date: string | null;
  done: number;
  done_at: string | null;
  created_at: string;
  full_name: string;
  organization_name: string | null;
  interaction_date: string | null;
  interaction_subject: string | null;
}

const SELECT = `SELECT a.*, c.full_name, o.name AS organization_name,
    i.date AS interaction_date, i.subject AS interaction_subject
  FROM action_item a
  JOIN contact c ON c.id = a.contact_id
  LEFT JOIN organization o ON o.id = c.organization_id
  LEFT JOIN interaction i ON i.id = a.interaction_id`;

/** Open items, undated first, then soonest due. Used by the dashboard and the list page. */
export async function openActions(db: D1Db, limit = 200): Promise<ActionRow[]> {
  const { results } = await db
    .prepare(`${SELECT} WHERE a.done = 0 ORDER BY (a.due_date IS NOT NULL), a.due_date, a.id LIMIT ?`)
    .bind(limit)
    .all<ActionRow>();
  return results;
}

/**
 * Everything on one contact, open first, then completed. Open items keep the undated-first inversion
 * used everywhere else; completed items sort most-recently-finished first, because that is the order
 * you would want if you were checking what you have already dealt with.
 */
export async function contactActions(db: D1Db, contactId: number): Promise<ActionRow[]> {
  const { results } = await db
    .prepare(
      `${SELECT} WHERE a.contact_id = ?
       ORDER BY a.done,
                CASE WHEN a.done = 0 THEN (a.due_date IS NOT NULL) ELSE 0 END,
                CASE WHEN a.done = 0 THEN a.due_date ELSE NULL END,
                a.done_at DESC,
                a.id`
    )
    .bind(contactId)
    .all<ActionRow>();
  return results;
}

/**
 * Writes one action_item audit event, tagged with the contact it concerns (#31).
 *
 * The `contact-<id>` correlation is the same convention contacts.ts uses, and it is applied here
 * deliberately rather than left for later: the point of the tag is to answer "show me everything that
 * happened to this relationship". A version of that query which silently omitted the commitments you
 * made would be worse than not having it at all, because it would look complete.
 */
async function audit(
  db: D1Db,
  id: number,
  action: string,
  after: string,
  before?: string,
  contactId?: number
) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,?,?,?,?,?,'app',?)"
    )
    .bind(ACTOR, "action_item", String(id), action, before ?? null, after, contactId ? `contact-${contactId}` : null)
    .run();
}

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

/**
 * Creates one action item and audits it. Shared by POST /actions, the inline form on the contact
 * record, and the meeting resolution handler in contacts.ts, so all three write the same row shape and
 * the same trail. Returns the new id.
 *
 * The id comes from last_row_id, not from a follow-up SELECT — see D1RunResult in types.ts and #31.
 */
export async function insertActionItem(
  db: D1Db,
  item: {
    contactId: number;
    interactionId: number | null;
    description: string;
    dueDate: string | null;
    contactName: string;
  }
): Promise<number> {
  const res = await db
    .prepare("INSERT INTO action_item (contact_id, interaction_id, description, due_date) VALUES (?,?,?,?)")
    .bind(item.contactId, item.interactionId, item.description, item.dueDate)
    .run();
  const id = res?.meta?.last_row_id ?? 0;
  await audit(
    db,
    id,
    "create",
    `${item.contactName}: ${item.description} · due ${item.dueDate ?? "not set"}${
      item.interactionId ? ` · from interaction ${item.interactionId}` : ""
    }`,
    undefined,
    item.contactId
  );
  return id;
}

/**
 * One row of the action list, with its provenance and its controls.
 *
 * showContact is false on the contact's own record, where repeating the name on every row is noise —
 * the provenance and the controls are the useful parts there.
 */
export function actionRow(a: ActionRow, opts: { showContact?: boolean } = {}): string {
  const showContact = opts.showContact !== false;
  const overdue = !a.done && a.due_date && a.due_date < today();
  const undated = !a.done && !a.due_date;
  const provenance = a.interaction_date
    ? `from the ${esc(a.interaction_date)} ${esc(a.interaction_subject ?? "interaction")} · <a href="/contacts/${a.contact_id}/history">history</a>`
    : "no linked interaction";
  return `<tr${overdue ? ' style="background:#fef2f2"' : undated ? ' style="background:#fffbeb"' : ""}>
    <td>
      <b>${esc(a.description)}</b>
      <div class="meta">
        ${
          showContact
            ? `<a href="/contacts/${a.contact_id}">${esc(a.full_name)}</a>${a.organization_name ? ` · ${esc(a.organization_name)}` : ""} · ${provenance}`
            : provenance
        }
      </div>
    </td>
    <td data-label="${a.done ? "Completed" : "Due"}">${
      a.done
        ? `<span class="pill green">done${a.done_at ? ` ${esc(a.done_at)}` : ", date unknown"}</span>`
        : a.due_date
          ? followUpPill(a.due_date)
          : '<span class="pill red">no due date</span>'
    }</td>
    <td style="text-align:right">
      ${
        a.done
          ? `<form method="post" action="/actions/${a.id}/reopen" style="display:inline"><button class="secondary tiny" type="submit">Reopen</button></form>`
          : `<form method="post" action="/actions/${a.id}/done" style="display:inline"><button class="tiny" type="submit">Done</button></form>`
      }
      <form method="post" action="/actions/${a.id}/delete" style="display:inline"><button class="secondary tiny" type="submit">Delete</button></form>
    </td>
  </tr>`;
}

/** Compact block for the dashboard — no controls beyond Done, links through to the full list. */
export function actionBlock(rows: ActionRow[]): string {
  if (!rows.length)
    return '<div class="empty">No open action items. Anything you promised in a meeting belongs here.</div>';
  const overdue = rows.filter((a) => a.due_date && a.due_date < today()).length;
  const undated = rows.filter((a) => !a.due_date).length;
  return `<table><tbody>${rows
    .slice(0, 10)
    .map(
      (a) => `<tr>
      <td><b>${esc(a.description)}</b><div class="meta"><a href="/contacts/${a.contact_id}">${esc(a.full_name)}</a>${
        a.interaction_date ? ` · from ${esc(a.interaction_date)}` : ""
      }</div></td>
      <td style="text-align:right" data-label="Due">${a.due_date ? followUpPill(a.due_date) : '<span class="pill red">no due date</span>'}
        <form method="post" action="/actions/${a.id}/done" style="display:inline;margin-left:6px"><button class="tiny" type="submit">Done</button></form></td>
    </tr>`
    )
    .join("")}</tbody></table>
  <p class="meta" style="margin-top:8px">${rows.length} open${
    rows.length > 10 ? `, showing 10 — <a href="/actions">see all</a>` : ""
  }${overdue ? ` · <b>${overdue} overdue</b>` : ""}${undated ? ` · ${undated} with no due date` : ""}</p>`;
}

/**
 * The action items block on a contact record (REL-025).
 *
 * Placed beside History rather than inside Relationship: this is a list of open loops, not an
 * attribute of the person. Completed items are collapsed behind a <details> so the record does not
 * become a graveyard, while the count stays visible so you can see there is history to look at.
 *
 * The add form posts contact_id directly, so none of the name-resolution or ambiguity handling that
 * /actions needs applies here — you are already looking at the person.
 */
export function contactActionBlock(contactId: number, rows: ActionRow[]): string {
  const open = rows.filter((a) => !a.done);
  const done = rows.filter((a) => a.done);
  const table = (list: ActionRow[]) =>
    `<table><tbody>${list.map((a) => actionRow(a, { showContact: false })).join("")}</tbody></table>`;

  return `${
    open.length
      ? table(open)
      : '<div class="empty">Nothing open. Anything you promise this person belongs here, not in the summary of the last meeting.</div>'
  }
  ${
    done.length
      ? `<details class="hist-more"><summary>${done.length} completed item${done.length === 1 ? "" : "s"}</summary>${table(done)}</details>`
      : ""
  }
  <form method="post" action="/actions" class="quickset" style="align-items:flex-end">
    <input type="hidden" name="contact_id" value="${contactId}">
    <div style="flex:1 1 260px"><label>Add a commitment</label>
      <input type="text" name="description" placeholder="e.g. Send the deployment overview" required></div>
    <div style="flex:0 1 170px"><label>Due <span class="hint">optional</span></label>
      <input type="date" name="due_date"></div>
    <button type="submit">Add</button>
  </form>`;
}

/**
 * Where to return after adding, ticking, reopening, or deleting an item. The controls now appear in
 * three places, and landing somewhere other than where you clicked makes both the dashboard and the
 * contact record useless as worklists. A contact-record referer is matched on its id so the flash
 * lands on the right record; /contacts/12/history and /contacts/new deliberately do not match.
 */
function backTo(referer: string | undefined, key: string): string {
  const from = referer ?? "";
  const onContact = /\/contacts\/(\d+)(?:[?#]|$)/.exec(from);
  if (onContact) return `/contacts/${onContact[1]}?flash=action${key}`;
  if (from.includes("/actions")) return `/actions?flash=${key}`;
  return "/";
}

// ---------------------------------------------------------------- list page

app.get("/actions", async (c) => {
  const show = c.req.query("show") ?? "open";
  const flash = c.req.query("flash");
  const prefill = c.req.query("contact") ?? "";
  const rows =
    show === "all"
      ? (
          await c.env.DB.prepare(
            `${SELECT} ORDER BY a.done, (a.due_date IS NOT NULL), a.due_date, a.id DESC LIMIT 300`
          ).all<ActionRow>()
        ).results
      : await openActions(c.env.DB);

  // A datalist keeps the whole list available to type against without rendering 285 visible options.
  const names = await c.env.DB.prepare(
    `SELECT c.full_name, o.name AS organization_name FROM contact c
     LEFT JOIN organization o ON o.id = c.organization_id
     WHERE c.status='active' ORDER BY c.full_name LIMIT 600`
  ).all<{ full_name: string; organization_name: string | null }>();

  const flashMap: Record<string, string> = {
    added: "Action item added.",
    done: "Marked done.",
    reopened: "Reopened.",
    deleted: "Action item deleted.",
    noname: "An action item needs a description and a contact, so nothing was saved.",
    nomatch: "No active contact matched that name, so nothing was saved. Pick a name from the suggestions.",
    ambiguous:
      "More than one contact has that name, so nothing was saved — attaching a commitment to the wrong person is worse than asking again. Open the right contact record and note which organization, then use the full name exactly as it appears in the suggestions.",
  };
  const isWarn = flash === "noname" || flash === "nomatch" || flash === "ambiguous";

  return c.html(
    layout({
      title: "Action Items",
      body: `<main>
  ${flash && flashMap[flash] ? `<div class="flash ${isWarn ? "warn" : "ok"}">${esc(flashMap[flash])}</div>` : ""}
  <h1>Action Items</h1>
  <p class="sub">${rows.length} ${show === "all" ? "total" : "open"} · ${
        show === "all" ? '<a href="/actions">open only</a>' : '<a href="/actions?show=all">show completed too</a>'
      } · <a href="/">back to dashboard</a></p>

  <form class="card" method="post" action="/actions">
    <h2>Add an action item</h2>
    <label>What did you commit to?</label>
    <input type="text" name="description" placeholder="e.g. Send the 10-day agent deployment overview" required ${prefill ? "" : "autofocus"}>
    <div class="row">
      <div><label>For whom <span class="hint">start typing a name</span></label>
        <input type="text" name="contact" list="contactnames" value="${esc(prefill)}" placeholder="e.g. Edgar Huerta" required ${prefill ? "autofocus" : ""}>
        <datalist id="contactnames">${names.results
          .map((k) => `<option value="${esc(k.full_name)}">${esc(k.organization_name ?? "")}</option>`)
          .join("")}</datalist></div>
      <div><label>Due <span class="hint">leave blank if genuinely unknown</span></label><input type="date" name="due_date"></div>
    </div>
    <div class="actions"><button type="submit">Add Action Item</button></div>
    <p class="meta" style="margin-top:10px">An item with no due date is not hidden — it sorts to the top of the list, because an undated commitment is the one nothing else will remind you about.</p>
  </form>

  ${
    rows.length
      ? `<table><thead><tr><th>Commitment</th><th>Due</th><th></th></tr></thead><tbody>${rows.map((a) => actionRow(a)).join("")}</tbody></table>`
      : `<div class="card empty">${
          show === "all" ? "No action items recorded yet." : 'Nothing open. <a href="/actions?show=all">See completed items</a>'
        }</div>`
  }
</main>`,
    })
  );
});

// ---------------------------------------------------------------- writes

/**
 * Resolves the typed contact name. Returns the id, or a reason it could not be resolved. An ambiguous
 * name is never guessed at: full_name has no unique constraint, so two same-named contacts are
 * creatable, and silently picking the lower id would attach a commitment to the wrong relationship.
 *
 * This comment used to assert that the database HAS duplicate first-and-last-name pairs. It does not —
 * see the correction at the top of this file. The guard is correct; the stated reason was not.
 */
async function resolveContact(db: D1Db, typed: string): Promise<{ id: number } | { error: string }> {
  const { results } = await db
    .prepare("SELECT id FROM contact WHERE lower(full_name) = lower(?) AND status='active'")
    .bind(typed)
    .all<{ id: number }>();
  if (results.length === 1) return { id: results[0].id };
  if (results.length === 0) return { error: "nomatch" };
  return { error: "ambiguous" };
}

app.post("/actions", async (c) => {
  const f = await c.req.parseBody();
  const description = str(f.description);
  if (!description) return c.redirect(backTo(c.req.header("referer"), "noname"));

  // contact_id wins when present, so a future form on the contact record can post it directly.
  let contactId = Number(str(f.contact_id) ?? "");
  if (!Number.isInteger(contactId) || contactId < 1) {
    const typed = str(f.contact);
    if (!typed) return c.redirect("/actions?flash=noname");
    const resolved = await resolveContact(c.env.DB, typed);
    if ("error" in resolved) return c.redirect(`/actions?flash=${resolved.error}&contact=${encodeURIComponent(typed)}`);
    contactId = resolved.id;
  }

  const contact = await c.env.DB.prepare("SELECT full_name FROM contact WHERE id = ?")
    .bind(contactId)
    .first<{ full_name: string }>();
  if (!contact) return c.redirect("/actions?flash=nomatch");

  const interactionId = str(f.interaction_id) ? Number(str(f.interaction_id)) : null;
  await insertActionItem(c.env.DB, {
    contactId,
    interactionId,
    description,
    dueDate: str(f.due_date),
    contactName: contact.full_name,
  });
  return c.redirect(backTo(c.req.header("referer"), "added"));
});

app.post("/actions/:id/done", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT description, done, contact_id FROM action_item WHERE id = ?")
    .bind(id)
    .first<{ description: string; done: number; contact_id: number }>();
  if (!before) return c.notFound();
  await c.env.DB.prepare(
    "UPDATE action_item SET done = 1, done_at = date('now'), updated_at = datetime('now') WHERE id = ?"
  )
    .bind(id)
    .run();
  await audit(c.env.DB, id, "update", `done ${today()} — ${before.description}`, "open", before.contact_id);
  // Returning to wherever the tick was clicked keeps the dashboard usable as a worklist.
  return c.redirect(backTo(c.req.header("referer"), "done"));
});

app.post("/actions/:id/reopen", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT description, done_at, contact_id FROM action_item WHERE id = ?")
    .bind(id)
    .first<{ description: string; done_at: string | null; contact_id: number }>();
  if (!before) return c.notFound();
  await c.env.DB.prepare(
    "UPDATE action_item SET done = 0, done_at = NULL, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(id)
    .run();
  await audit(
    c.env.DB,
    id,
    "update",
    `reopened — ${before.description}`,
    `done ${before.done_at ?? "date unknown"}`,
    before.contact_id
  );
  return c.redirect(backTo(c.req.header("referer"), "reopened"));
});

app.post("/actions/:id/delete", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare(
    "SELECT a.description, a.due_date, a.done, a.contact_id, c.full_name FROM action_item a JOIN contact c ON c.id=a.contact_id WHERE a.id = ?"
  )
    .bind(id)
    .first<{ description: string; due_date: string | null; done: number; contact_id: number; full_name: string }>();
  if (!before) return c.notFound();
  // Gated on the row actually being removed (#51), for the same reason as the interaction delete in
  // contacts.ts: this path deletes before it audits, so a duplicated POST would otherwise record a
  // second deletion of something already gone. `?? 1` keeps an unreported count auditing.
  const removed = await c.env.DB.prepare("DELETE FROM action_item WHERE id = ?").bind(id).run();
  if ((removed.meta?.changes ?? 1) === 0) return c.redirect(backTo(c.req.header("referer"), "deleted"));

  // Deleting says "this was never really a commitment", which is a different fact from "I did it".
  await audit(
    c.env.DB,
    id,
    "delete",
    "deleted — not completed, removed as not a real commitment",
    `${before.full_name}: ${before.description} · due ${before.due_date ?? "not set"} · ${before.done ? "was done" : "was open"}`,
    before.contact_id
  );
  return c.redirect(backTo(c.req.header("referer"), "deleted"));
});

export default app;
