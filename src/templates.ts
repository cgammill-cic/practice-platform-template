/*
 * REL-008 Part A — message templates (#19).
 *
 * The request was for a "message template" link to easily create a message template, copy it, and paste
 * it into Outlook.
 *
 * The whole feature is judged on one moment: you are looking at a person, you want the words, you
 * paste them into Outlook. Everything here serves that. Pick a contact, the placeholders resolve
 * against them, one click puts the finished text on the clipboard.
 *
 * Three design notes worth stating, because each was a choice rather than an inevitability.
 *
 * 1. TEMPLATES ARE A LIBRARY, NOT A LADDER. rung is optional. The escalation ladder (Part B) will
 *    point at rungs 1-3, but the request was to keep adding more communications templates over time,
 *    and most of what gets written — a thank-you, an intro request — belongs to no rung. Requiring one
 *    would make the library refuse the majority of its own use cases.
 *
 * 2. SUBSTITUTION HAPPENS SERVER-SIDE. The resolved text is rendered into the page and the only
 *    client-side JavaScript is the clipboard call itself. Doing the substitution in the browser would
 *    mean shipping the templates and the contact record to the client and reimplementing the same
 *    logic twice, in a codebase that otherwise has no client framework at all.
 *
 * 3. AN UNKNOWN PLACEHOLDER IS LEFT VISIBLE, not blanked. A template that renders "Hi ," because the
 *    contact has no first name is worse than one that renders "Hi {first_name}," — the first looks
 *    finished and gets sent, the second is obviously wrong and gets fixed. Nothing here silently
 *    produces a message you would regret pasting.
 */

import { Hono } from "hono";
import { esc, layout, select } from "./views";
import type { Bindings, D1Db } from "./types";

const app = new Hono<{ Bindings: Bindings }>();
const ACTOR = "operator";

const CHANNELS = [
  ["email", "Email"],
  ["linkedin", "LinkedIn"],
  ["text", "Text"],
  ["other", "Other"],
] as const;

/** Ladder positions, plus the empty option that means "this belongs to no rung". */
const RUNGS = [
  ["1", "Rung 1 — initial email"],
  ["2", "Rung 2 — follow-up email"],
  ["3", "Rung 3 — LinkedIn"],
  ["4", "Rung 4 — text"],
  ["5", "Rung 5 — final"],
] as const;

export interface MessageTemplate {
  id: number;
  name: string;
  channel: string;
  rung: number | null;
  subject: string | null;
  body: string;
  active: number;
  sort_order: number;
}

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

async function audit(db: D1Db, id: number, action: string, after: string, before?: string) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source) VALUES (?,?,?,?,?,?,'app')"
    )
    .bind(ACTOR, "message_template", String(id), action, before ?? null, after)
    .run();
}

/**
 * The fields a template can reference. Kept deliberately small: every placeholder is a promise that
 * the value will be there, and plenty of contacts have nothing but a name. first_name is derived
 * rather than stored, because "Hi Jane" is what you write and "Hi Jane Smith" is what a machine
 * writes.
 */
export const PLACEHOLDERS = ["first_name", "full_name", "organization", "title"] as const;

export interface Fillable {
  full_name: string;
  organization_name?: string | null;
  title?: string | null;
}

/**
 * Resolves {placeholders} against a contact. Unknown or empty values are left as the literal
 * placeholder so the gap is visible in the pasted text rather than showing up as a blank in someone's
 * inbox. An unrecognized name is also left alone — a stray brace in prose should survive untouched.
 */
export function fillTemplate(body: string, contact: Fillable | null): string {
  if (!contact) return body;
  const firstName = contact.full_name.trim().split(/\s+/)[0] ?? "";
  const values: Record<string, string | null | undefined> = {
    first_name: firstName,
    full_name: contact.full_name,
    organization: contact.organization_name,
    title: contact.title,
  };
  return body.replace(/\{(\w+)\}/g, (whole, key: string) => {
    if (!(key in values)) return whole;
    const v = values[key];
    return v && String(v).trim() !== "" ? String(v) : whole;
  });
}

async function loadTemplates(db: D1Db, includeInactive = false): Promise<MessageTemplate[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM message_template ${includeInactive ? "" : "WHERE active = 1"}
       ORDER BY active DESC, sort_order, name`
    )
    .all<MessageTemplate>();
  return results;
}

const channelLabel = (v: string) => CHANNELS.find(([c]) => c === v)?.[1] ?? v;

/*
 * The only client-side script in the app. Reads the already-resolved text from a data attribute and
 * puts it on the clipboard, with the button confirming rather than staying silent — a copy button
 * that gives no feedback leaves you pasting to find out whether it worked.
 *
 * navigator.clipboard needs a secure context. The app is HTTPS in production and localhost counts as
 * secure, so both cases are covered; the catch still reports failure rather than failing quietly.
 */
const COPY_SCRIPT = `<script>
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-copy]');
  if (!b) return;
  var text = b.getAttribute('data-copy');
  var say = function (msg) { var o = b.textContent; b.textContent = msg; setTimeout(function () { b.textContent = o; }, 1600); };
  if (!navigator.clipboard) { say('Not supported'); return; }
  navigator.clipboard.writeText(text).then(function () { say('Copied'); }, function () { say('Copy failed'); });
});
</script>`;

// ---------------------------------------------------------------- list + copy

app.get("/templates", async (c) => {
  const includeInactive = c.req.query("all") === "1";
  const templates = await loadTemplates(c.env.DB, includeInactive);
  const typed = (c.req.query("contact") ?? "").trim();
  const flash = c.req.query("flash");

  /*
   * Resolving against a real contact is the point, so the picker is the same type-ahead pattern
   * REL-024 settled on: a datalist over however many names rather than a select you have to scroll.
   *
   * TWO WAYS IN, matching what /audit already accepts (AUD-002). A name is what you type; an id is
   * what a link carries. The id path was added because the contact record now links here.
   *
   * CORRECTION. Earlier comments in this file — and the ambiguity message below — asserted that the
   * database had two contacts sharing the same name. Checked against real data: no duplicate of any
   * name actually existed at the time. The claim was never true and had been repeated as if it were. It
   * is recorded here rather than quietly deleted, because a false fact that survived several readings is
   * worth a note.
   *
   * The real reason to key links by id is not duplicates, which are possible but do not currently
   * exist. It is that full_name carries NO unique constraint (see the contact table) and IS editable
   * (REL-009). A name-keyed link therefore breaks silently the moment a contact is renamed — a typo
   * fixed on the record would leave the Message Templates link on that same record pointing at
   * nobody. The duplicate case is the one the ambiguity branch below already had to handle before any
   * of this; the rename case is the one that would actually bite.
   *
   * All-digit input is read as an id. A person named "12345" would be unreachable by typing, which is
   * the same trade /audit makes and is worth it for a link that must survive a rename.
   *
   * The id path does NOT filter on status. The name path does, because it backs a type-ahead over
   * active contacts and offering an inactive name you cannot select would be noise. But arriving by id
   * means someone followed a link from a specific record, and refusing to write to an inactive contact
   * would be the page second-guessing a request it can see is deliberate.
   */
  let contact: Fillable | null = null;
  let pickError = "";
  if (typed) {
    if (/^\d+$/.test(typed)) {
      contact = await c.env.DB.prepare(
        `SELECT c.full_name, o.name AS organization_name, c.title FROM contact c
         LEFT JOIN organization o ON o.id = c.organization_id
         WHERE c.id = ?`
      )
        .bind(Number(typed))
        .first<Fillable>();
      if (!contact) pickError = `No contact has id ${typed}, so nothing was filled in. Type a name instead.`;
    } else {
      const { results } = await c.env.DB.prepare(
        `SELECT c.full_name, o.name AS organization_name, c.title FROM contact c
         LEFT JOIN organization o ON o.id = c.organization_id
         WHERE lower(c.full_name) = lower(?) AND c.status='active'`
      )
        .bind(typed)
        .all<Fillable>();
      if (results.length === 1) contact = results[0];
      else if (results.length === 0) pickError = `No active contact named “${typed}”. Pick a name from the suggestions.`;
      else
        pickError = `More than one active contact is named “${typed}”, so the message was not filled in. Open the right record and use its Message Templates link — that carries the contact id, which is unambiguous.`;
    }
  }

  // What the picker box shows. When arrival was by id, show the resolved NAME rather than the digits:
  // the box is an editable type-ahead, so leaving "3" in it would both read as nonsense and re-submit
  // as a name search that finds nothing.
  const boxValue = contact?.full_name ?? typed;

  const names = await c.env.DB.prepare(
    `SELECT c.full_name, o.name AS organization_name FROM contact c
     LEFT JOIN organization o ON o.id = c.organization_id
     WHERE c.status='active' ORDER BY c.full_name LIMIT 600`
  ).all<{ full_name: string; organization_name: string | null }>();

  const flashMap: Record<string, string> = {
    created: "Template created.",
    saved: "Template saved.",
    deleted: "Template deleted.",
    nobody: "A template needs a name and a body, so nothing was saved.",
  };
  const isWarn = flash === "nobody";

  const card = (t: MessageTemplate) => {
    const body = fillTemplate(t.body, contact);
    const subject = t.subject ? fillTemplate(t.subject, contact) : null;
    // Subject and body copy separately: Outlook takes them in two different boxes, and a single
    // blob with "Subject:" glued on top would need editing out every time.
    return `<section${t.active ? "" : ' style="opacity:.6"'}>
    <h2>${esc(t.name)}${t.active ? "" : " — inactive"}</h2>
    <p class="meta">${esc(channelLabel(t.channel))}${t.rung ? ` · rung ${t.rung}` : ""} · <a href="/templates/${t.id}/edit">edit</a></p>
    ${
      subject
        ? `<p style="margin:6px 0"><b>Subject:</b> ${esc(subject)}
           <button class="secondary" type="button" data-copy="${esc(subject)}" style="padding:3px 9px;font-size:12px;margin-left:6px">Copy subject</button></p>`
        : ""
    }
    <div style="white-space:pre-wrap;background:#f8fafc;border:1px solid var(--line);border-radius:8px;padding:12px;font-size:14px">${esc(body)}</div>
    <div class="actions" style="margin-top:10px">
      <button type="button" data-copy="${esc(body)}">Copy message</button>
      ${contact ? `<span class="meta">filled in for ${esc(contact.full_name)}</span>` : '<span class="meta">pick a contact above to fill in the names</span>'}
    </div>
  </section>`;
  };

  return c.html(
    layout({
      title: "Message Templates",
      body: `<main>
  ${flash && flashMap[flash] ? `<div class="flash ${isWarn ? "warn" : "ok"}">${esc(flashMap[flash])}</div>` : ""}
  <h1>Message Templates</h1>
  <p class="sub">${templates.length} template${templates.length === 1 ? "" : "s"} · <a href="/templates/new">new template</a> · ${
        includeInactive ? '<a href="/templates">active only</a>' : '<a href="/templates?all=1">show inactive too</a>'
      } · <a href="/">back to dashboard</a></p>

  ${pickError ? `<div class="flash warn">${esc(pickError)}</div>` : ""}

  <form class="card" method="get" action="/templates">
    ${includeInactive ? '<input type="hidden" name="all" value="1">' : ""}
    <label>Fill in for <span class="hint">start typing a name — the message below updates</span></label>
    <div class="row">
      <div><input type="text" name="contact" list="tplnames" value="${esc(boxValue)}" placeholder="e.g. Jane Smith" autofocus>
        <datalist id="tplnames">${names.results
          .map((k) => `<option value="${esc(k.full_name)}">${esc(k.organization_name ?? "")}</option>`)
          .join("")}</datalist></div>
      <div style="flex:0 1 160px"><button type="submit" style="width:100%">Fill in</button></div>
      ${typed ? `<div style="flex:0 1 120px"><a class="btn secondary" href="/templates" style="width:100%;text-align:center">Clear</a></div>` : ""}
    </div>
    <p class="meta" style="margin-top:10px">Placeholders: ${PLACEHOLDERS.map((p) => `<code>{${p}}</code>`).join(", ")}. Anything the contact has no value for is left showing as <code>{like_this}</code> rather than blanked, so a gap is obvious in the draft instead of in someone's inbox.</p>
  </form>

  ${
    templates.length
      ? templates.map(card).join("")
      : '<div class="card empty">No templates yet. <a href="/templates/new">Write the first one</a>.</div>'
  }
</main>${COPY_SCRIPT}`,
    })
  );
});

// ---------------------------------------------------------------- new / edit

function templateForm(t: Partial<MessageTemplate>, error?: string): string {
  const isEdit = Boolean(t.id);
  return `<main>
  <h1>${isEdit ? `Edit ${esc(t.name)}` : "New Message Template"}</h1>
  <p class="sub">${isEdit ? "Changes are recorded in the audit trail." : "Write it once, paste it as often as you like."} · <a href="/templates">back to templates</a></p>
  ${error ? `<div class="flash warn">${esc(error)}</div>` : ""}
  <form method="post" action="${isEdit ? `/templates/${t.id}/edit` : "/templates/new"}" class="card">
    <label>Name <span class="hint">how you will recognise it in the list</span></label>
    <input type="text" name="name" value="${esc(t.name)}" placeholder="e.g. Thank you after a first meeting" required autofocus>
    <div class="row">
      <div><label>Channel</label>${select("channel", CHANNELS, t.channel ?? "email")}</div>
      <div><label>Ladder Rung <span class="hint">optional — leave blank for a general template</span></label>${select(
        "rung",
        RUNGS,
        t.rung ? String(t.rung) : null,
        { blank: "Not part of the ladder" }
      )}</div>
      <div><label>Sort Order <span class="hint">lower sorts first</span></label><input type="number" name="sort_order" value="${esc(t.sort_order ?? 100)}"></div>
    </div>
    <label>Subject <span class="hint">email only; leave blank for LinkedIn or text</span></label>
    <input type="text" name="subject" value="${esc(t.subject)}">
    <label>Message</label>
    <textarea name="body" style="min-height:260px" required>${esc(t.body)}</textarea>
    <p class="meta" style="margin-top:8px">Use ${PLACEHOLDERS.map((p) => `<code>{${p}}</code>`).join(", ")} anywhere in the subject or message.</p>
    ${isEdit ? `<label class="check"><input type="checkbox" name="active" value="1"${t.active ? " checked" : ""}> Active — show this template in the list</label>` : ""}
    <div class="actions">
      <button type="submit">${isEdit ? "Save Changes" : "Create Template"}</button>
      <a class="btn secondary" href="/templates">Cancel</a>
    </div>
  </form>
  ${
    isEdit
      ? `<form method="post" action="/templates/${t.id}/delete" class="card">
    <h2>Delete This Template</h2>
    <p class="meta">Removes it permanently. If you might want the wording back later, untick <b>Active</b> above instead — an inactive template stays readable under “show inactive too”. The deletion is written to the audit trail either way.</p>
    <div class="actions"><button type="submit" class="danger">Delete Template</button></div>
  </form>`
      : ""
  }
</main>`;
}

app.get("/templates/new", (c) => c.html(layout({ title: "New Template", body: templateForm({}) })));

app.post("/templates/new", async (c) => {
  const f = await c.req.parseBody();
  const name = str(f.name);
  const body = str(f.body);
  if (!name || !body) return c.redirect("/templates?flash=nobody");
  const rung = str(f.rung) ? Number(str(f.rung)) : null;
  const res = await c.env.DB.prepare(
    "INSERT INTO message_template (name, channel, rung, subject, body, sort_order) VALUES (?,?,?,?,?,?)"
  )
    .bind(name, str(f.channel) ?? "email", rung, str(f.subject), body, Number(str(f.sort_order) ?? "100") || 100)
    .run();
  // last_row_id, not a follow-up SELECT (#31).
  const id = res?.meta?.last_row_id ?? 0;
  await audit(c.env.DB, id, "create", `${name} · ${str(f.channel) ?? "email"}${rung ? ` · rung ${rung}` : ""} · ${body.length} chars`);
  return c.redirect("/templates?flash=created");
});

app.get("/templates/:id/edit", async (c) => {
  const t = await c.env.DB.prepare("SELECT * FROM message_template WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .first<MessageTemplate>();
  if (!t) return c.notFound();
  return c.html(layout({ title: `Edit ${t.name}`, body: templateForm(t) }));
});

app.post("/templates/:id/edit", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM message_template WHERE id = ?")
    .bind(id)
    .first<MessageTemplate>();
  if (!before) return c.notFound();
  const f = await c.req.parseBody();
  const name = str(f.name);
  const body = str(f.body);
  if (!name || !body) return c.html(layout({ title: "Edit Template", body: templateForm({ ...before, id }, "A template needs both a name and a message.") }));

  const rung = str(f.rung) ? Number(str(f.rung)) : null;
  const channel = str(f.channel) ?? "email";
  const subject = str(f.subject);
  const active = f.active === "1" ? 1 : 0;
  const sortOrder = Number(str(f.sort_order) ?? "100") || 100;

  await c.env.DB.prepare(
    `UPDATE message_template SET name=?, channel=?, rung=?, subject=?, body=?, active=?, sort_order=?,
      updated_at=datetime('now') WHERE id=?`
  )
    .bind(name, channel, rung, subject, body, active, sortOrder, id)
    .run();

  // Named-field diff, same principle as AUD-003: recording that something changed without recording
  // what is the appearance of an audit trail rather than one. The body is reported by size, because
  // pasting a whole email into a summary column helps nobody.
  const parts: string[] = [];
  if (before.name !== name) parts.push(`name ${before.name} → ${name}`);
  if (before.channel !== channel) parts.push(`channel ${before.channel} → ${channel}`);
  if ((before.rung ?? null) !== rung) parts.push(`rung ${before.rung ?? "none"} → ${rung ?? "none"}`);
  if ((before.subject ?? null) !== subject) parts.push(`subject ${before.subject ?? "none"} → ${subject ?? "none"}`);
  if (before.body !== body) parts.push(`body rewritten (${before.body.length} → ${body.length} chars)`);
  if (before.active !== active) parts.push(`active ${before.active} → ${active}`);
  if (before.sort_order !== sortOrder) parts.push(`sort_order ${before.sort_order} → ${sortOrder}`);
  if (parts.length) await audit(c.env.DB, id, "update", parts.join("; ").slice(0, 900), before.name);

  return c.redirect(`/templates?flash=${parts.length ? "saved" : "nochange"}`);
});

app.post("/templates/:id/delete", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM message_template WHERE id = ?")
    .bind(id)
    .first<MessageTemplate>();
  if (!before) return c.notFound();
  await c.env.DB.prepare("DELETE FROM message_template WHERE id = ?").bind(id).run();
  // The whole body goes into the trail before it is destroyed, so wording can be recovered by hand.
  await audit(
    c.env.DB,
    id,
    "delete",
    `deleted template “${before.name}”`,
    `${before.channel}${before.rung ? ` rung ${before.rung}` : ""} · ${before.subject ?? "no subject"} · ${before.body}`.slice(0, 2000)
  );
  return c.redirect("/templates?flash=deleted");
});

export default app;
