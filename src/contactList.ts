/*
 * REL-017 — the contact list and its search.
 * REL-019 — deleting a contact, with guardrails.
 *
 * Replaces the single cramped search box that shipped with REL-002. The reported problem, 2026-07-30:
 * there were two boxes, one very small and the other pulling from the status field, when what was
 * actually wanted was the ability to search by name, title, company, and department.
 *
 * The old bar had an unlabelled text input beside a bare stage dropdown, so there was no way to tell
 * what either did. The free-text box DID already search names — it just did not look like it. That is
 * a labelling failure, and the fix is labels and separate fields, not more clever matching.
 *
 * This is now the only GET /contacts in the app. REL-017 originally shadowed the REL-002 handler in
 * contacts.ts by being registered first; that superseded handler was deleted in #37, so mount order
 * no longer matters here.
 */

import { Hono } from "hono";
import { esc, followUpPill, layout, select } from "./views";
import {
  DEPARTMENTS,
  MAX_PRIORITY_TIER,
  SOURCES,
  STAGES,
  labelFor,
  stageLabel,
  type Bindings,
  type Contact,
} from "./types";

const app = new Hono<{ Bindings: Bindings }>();
const LIMIT = 300;
const ACTOR = "operator";

/** contact.created_at is the import timestamp for imported rows — see the Added column. */
interface Row {
  id: number;
  full_name: string;
  title: string | null;
  organization_name: string | null;
  department: string | null;
  stage: string;
  priority_tier: number | null;
  last_touch: string | null;
  next_follow_up: string | null;
  email_work: string | null;
  email_personal: string | null;
  linkedin_url: string | null;
  source: string | null;
  status: string;
  created_at: string | null;
}

const TIERS = Array.from({ length: MAX_PRIORITY_TIER }, (_, i) => [String(i + 1), `Tier ${i + 1}`] as const);

app.get("/contacts", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const org = (c.req.query("org") ?? "").trim();
  const dept = c.req.query("dept") ?? "";
  const stage = c.req.query("stage") ?? "";
  const tier = c.req.query("tier") ?? "";
  const src = c.req.query("src") ?? "";
  const showInactive = c.req.query("inactive") === "1";
  const sort = c.req.query("sort") ?? "name";
  const flash = c.req.query("flash");

  const where: string[] = [];
  const params: unknown[] = [];
  if (!showInactive) where.push("c.status = 'active'");
  if (stage) {
    where.push("c.stage = ?");
    params.push(stage);
  }
  if (dept) {
    where.push("c.department = ?");
    params.push(dept);
  }
  if (tier) {
    where.push("c.priority_tier = ?");
    params.push(Number(tier));
  }
  if (src) {
    where.push("c.source = ?");
    params.push(src);
  }
  if (org) {
    where.push("lower(ifnull(o.name,'')) LIKE ?");
    params.push(`%${org.toLowerCase()}%`);
  }
  // Free text spans the fields you would plausibly remember someone by.
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    where.push(
      `(lower(c.full_name) LIKE ? OR lower(ifnull(c.title,'')) LIKE ? OR lower(ifnull(o.name,'')) LIKE ?
        OR lower(ifnull(c.email_work,'')) LIKE ? OR lower(ifnull(c.email_personal,'')) LIKE ?
        OR lower(ifnull(c.notes,'')) LIKE ? OR lower(ifnull(c.department,'')) LIKE ?
        OR EXISTS (SELECT 1 FROM contact_tag ct JOIN tag t ON t.id = ct.tag_id
                   WHERE ct.contact_id = c.id AND lower(t.name) LIKE ?))`
    );
    for (let i = 0; i < 8; i++) params.push(like);
  }

  const ORDER: Record<string, string> = {
    name: "c.full_name",
    org: "(o.name IS NULL), o.name, c.full_name",
    stage: "c.stage, c.full_name",
    tier: "(c.priority_tier IS NULL), c.priority_tier, c.full_name",
    followup: "(c.next_follow_up IS NULL), c.next_follow_up",
    touch: "(c.last_touch IS NULL), c.last_touch DESC",
    added: "c.created_at DESC, c.full_name",
  };
  const orderBy = ORDER[sort] ?? ORDER.name;

  const sql = `SELECT c.id, c.full_name, c.title, o.name AS organization_name, c.department, c.stage,
      c.priority_tier, c.last_touch, c.next_follow_up, c.email_work, c.email_personal, c.linkedin_url,
      c.source, c.status, c.created_at
    FROM contact c LEFT JOIN organization o ON o.id = c.organization_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY ${orderBy} LIMIT ${LIMIT}`;
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<Row>();

  // Total matching count, so "300 shown" never masquerades as "300 found".
  const countSql = `SELECT COUNT(*) AS n FROM contact c LEFT JOIN organization o ON o.id = c.organization_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}`;
  const total = (await c.env.DB.prepare(countSql).bind(...params).first<{ n: number }>())?.n ?? results.length;

  const orgList = await c.env.DB.prepare(
    "SELECT name FROM organization ORDER BY name LIMIT 600"
  ).all<{ name: string }>();

  const filtersActive = Boolean(q || org || dept || stage || tier || src || showInactive);
  const keep = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    const base: Record<string, string> = { q, org, dept, stage, tier, src, ...(showInactive ? { inactive: "1" } : {}) };
    for (const [k, v] of Object.entries({ ...base, ...extra })) if (v) p.set(k, v);
    return `/contacts?${p.toString()}`;
  };
  const sortLink = (key: string, label: string) =>
    sort === key ? `<b>${esc(label)}</b>` : `<a href="${keep({ sort: key })}">${esc(label)}</a>`;

  const flashMap: Record<string, string> = {
    deleted: "Contact deleted. The full record was written to the audit trail first.",
    inactivated: "Contact marked inactive. Tick “Include inactive contacts” to see it again.",
  };
  const flashHtml = flash && flashMap[flash] ? `<div class="flash ok">${esc(flashMap[flash])}</div>` : "";

  const rows = results
    .map((r) => {
      const email = r.email_work || r.email_personal;
      return `<tr>
      <td><a href="/contacts/${r.id}"><b>${esc(r.full_name)}</b></a>
        ${r.title ? `<div class="meta">${esc(r.title)}</div>` : ""}
        ${email ? `<div class="meta"><a href="mailto:${esc(email)}">${esc(email)}</a></div>` : ""}
        ${r.status !== "active" ? '<span class="pill grey">inactive</span>' : ""}</td>
      <td data-label="Organization">${esc(r.organization_name ?? "—")}${r.department ? `<div class="meta">${esc(r.department)}</div>` : ""}</td>
      <td data-label="Stage"><span class="pill grey">${esc(stageLabel(r.stage))}</span>
        ${r.priority_tier ? `<div class="meta">Tier ${r.priority_tier}</div>` : ""}</td>
      <td data-label="Last touch">${esc(r.last_touch ?? "—")}</td>
      <td data-label="Next follow-up">${followUpPill(r.next_follow_up, r.stage)}</td>
      <td class="meta" data-label="Added">${esc((r.created_at ?? "").slice(0, 10) || "—")}<div>${esc(labelFor(SOURCES, r.source))}</div></td>
      <td class="meta rowacts">${r.linkedin_url ? `<a href="${esc(r.linkedin_url)}" target="_blank" rel="noopener">LI ↗</a> · ` : ""}<a href="/contacts/${r.id}/edit">edit</a> · <a href="/contacts/${r.id}/delete">delete</a></td>
    </tr>`;
    })
    .join("");

  const table = results.length
    ? `<table><thead><tr>
        <th>${sortLink("name", "Name")}</th>
        <th>${sortLink("org", "Organization")}</th>
        <th>${sortLink("stage", "Stage")}</th>
        <th>${sortLink("touch", "Last Touch")}</th>
        <th>${sortLink("followup", "Next Follow-Up")}</th>
        <th>${sortLink("added", "Added")}</th>
        <th></th>
      </tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="card empty">${
        filtersActive
          ? 'No contacts match those filters. <a href="/contacts">Clear all</a>'
          : 'No contacts yet. Use <a href="/contacts/new">Add Contact</a> or the <a href="/import">import tool</a>.'
      }</div>`;

  return c.html(
    layout({
      title: "Contacts",
      body: `<main>
  ${flashHtml}
  <h1>Contacts</h1>
  <p class="sub">${total} match${total === 1 ? "" : "es"}${
        total > results.length ? ` · showing the first ${results.length}` : ""
      }${filtersActive ? ` · <a href="/contacts">clear filters</a>` : ""} · <a href="/export/contacts.csv">export all to CSV</a></p>

  <form class="card" method="get" action="/contacts">
    <label>Name, title, organization, department, email, notes or tag</label>
    <input type="text" name="q" value="${esc(q)}" placeholder="e.g. Smith, or CHRO, or Acme Corp" autofocus>
    <div class="row">
      <div><label>Organization</label>
        <input type="text" name="org" list="orglist" value="${esc(org)}" placeholder="any">
        <datalist id="orglist">${orgList.results.map((o) => `<option value="${esc(o.name)}"></option>`).join("")}</datalist></div>
      <div><label>Department</label>${select("dept", DEPARTMENTS, dept, { blank: "Any department" })}</div>
    </div>
    <div class="row">
      <div><label>Stage</label>${select(
        "stage",
        STAGES.map(([v, l]) => [v, l] as const),
        stage,
        { blank: "Any stage" }
      )}</div>
      <div><label>Priority Tier</label>${select("tier", TIERS, tier, { blank: "Any tier" })}</div>
      <div><label>Source</label>${select("src", SOURCES, src, { blank: "Any source" })}</div>
    </div>
    <label class="check"><input type="checkbox" name="inactive" value="1"${showInactive ? " checked" : ""}> Include inactive contacts</label>
    <div class="actions">
      <button type="submit">Search</button>
      <a class="btn secondary" href="/contacts">Reset</a>
    </div>
    <p class="meta" style="margin-top:10px">The top box matches any part of any of those fields, so a surname, a job title, or a company all work. The dropdowns narrow it further — leave them on "Any" to ignore them. Column headers re-sort the results.</p>
  </form>

  ${table}
</main>`,
    })
  );
});

// ---------------------------------------------------------------- delete a contact (REL-019)

/**
 * Deleting is deliberately narrower than it looks. Inactive already covers "this relationship ended"
 * and keeps the history; delete exists for records that should never have existed — a bad import row,
 * a typo, a company that is not a company.
 *
 * So a contact carrying interactions cannot be deleted. Those interactions are conversations that
 * actually happened, and destroying them to tidy a list is the wrong trade. The confirmation page says
 * so and offers Inactive instead.
 *
 * Open action items block deletion too (REL-025, #47). Migration 0006 said they would be counted here —
 * "a contact carrying open action items should not vanish either" — but nothing ever counted them, so a
 * contact with no interactions and three outstanding commitments deleted silently and took them with
 * it, leaving action_item rows pointing at a contact_id that no longer existed. Blocking rather than
 * only warning is what that comment describes, and a commitment you have not met is exactly the thing
 * this app exists to stop losing.
 */
interface FullContact extends Contact {
  created_at?: string | null;
  import_meta?: string | null;
}

async function loadForDelete(db: Bindings["DB"], id: number) {
  const contact = await db
    .prepare(
      "SELECT c.*, o.name AS organization_name FROM contact c LEFT JOIN organization o ON o.id = c.organization_id WHERE c.id = ?"
    )
    .bind(id)
    .first<FullContact>();
  if (!contact) return null;
  const counts = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM interaction WHERE contact_id = ?) AS interactions,
              (SELECT COUNT(*) FROM contact_tag WHERE contact_id = ?) AS tags,
              (SELECT COUNT(*) FROM contact WHERE referral_source_contact_id = ?) AS referred,
              (SELECT COUNT(*) FROM action_item WHERE contact_id = ? AND done = 0) AS open_actions,
              (SELECT COUNT(*) FROM action_item WHERE contact_id = ?) AS all_actions`
    )
    .bind(id, id, id, id, id)
    .first<{
      interactions: number;
      tags: number;
      referred: number;
      open_actions: number;
      all_actions: number;
    }>();
  return {
    contact,
    counts: counts ?? { interactions: 0, tags: 0, referred: 0, open_actions: 0, all_actions: 0 },
  };
}

app.get("/contacts/:id/delete", async (c) => {
  const id = Number(c.req.param("id"));
  const loaded = await loadForDelete(c.env.DB, id);
  if (!loaded) return c.notFound();
  const { contact, counts } = loaded;
  const byInteractions = counts.interactions > 0;
  const byActions = counts.open_actions > 0;
  const blocked = byInteractions || byActions;
  const email = contact.email_work || contact.email_personal;
  const plural = (n: number) => (n === 1 ? "" : "s");

  // Each blocker is named separately, because "cannot be deleted" without saying which fact is in the
  // way leaves the operator guessing at what to clear.
  const blockers = [
    byInteractions
      ? `${counts.interactions} recorded interaction${plural(counts.interactions)} — conversations that actually happened`
      : "",
    byActions
      ? `${counts.open_actions} open action item${plural(counts.open_actions)} — commitments to this person that you have not yet met`
      : "",
  ].filter(Boolean);

  return c.html(
    layout({
      title: `Delete ${contact.full_name}`,
      body: `<main>
  <h1>Delete ${esc(contact.full_name)}?</h1>
  <p class="sub">This is permanent. Read the record below before deciding.</p>

  <section>
    <dl class="grid2">
      <dt>Name</dt><dd><b>${esc(contact.full_name)}</b></dd>
      <dt>Title</dt><dd>${esc(contact.title ?? "—")}</dd>
      <dt>Organization</dt><dd>${esc(contact.organization_name ?? "—")}</dd>
      <dt>Email</dt><dd>${esc(email ?? "—")}</dd>
      <dt>Stage</dt><dd>${esc(stageLabel(contact.stage))}</dd>
      <dt>Last Touch</dt><dd>${esc(contact.last_touch ?? "—")}</dd>
      <dt>Added</dt><dd>${esc((contact.created_at ?? "").slice(0, 10) || "—")} · ${esc(labelFor(SOURCES, contact.source))}</dd>
      <dt>Interactions</dt><dd>${counts.interactions}</dd>
      <dt>Action Items</dt><dd>${counts.open_actions} open${
        counts.all_actions > counts.open_actions ? ` · ${counts.all_actions - counts.open_actions} completed` : ""
      }</dd>
      <dt>Tags</dt><dd>${counts.tags}</dd>
      <dt>Referred by them</dt><dd>${counts.referred}</dd>
    </dl>
  </section>

  ${
    blocked
      ? `<div class="flash warn"><b>This contact cannot be deleted.</b> ${esc(contact.full_name)} has
         ${blockers.join(", and ")}. Deleting the contact would destroy that to tidy a list, which is the wrong
         trade. Mark them <b>Inactive</b> instead: they disappear from every dashboard section and from this list,
         and both the history and the commitments survive.</div>
       <section>
         <div class="actions" style="margin-top:0">
           <form method="post" action="/contacts/${contact.id}/inactivate"><button type="submit">Mark Inactive Instead</button></form>
           <a class="btn secondary" href="/contacts/${contact.id}">Back to ${esc(contact.full_name)}</a>
           ${byInteractions ? `<a class="btn secondary" href="/contacts/${contact.id}/history">Review the ${counts.interactions} interaction${plural(counts.interactions)}</a>` : ""}
           ${byActions ? `<a class="btn secondary" href="/contacts/${contact.id}#actions">Review the ${counts.open_actions} open item${plural(counts.open_actions)}</a>` : ""}
         </div>
         <p class="meta" style="margin-top:10px">If you are certain these are junk too, clear them individually first — ${
           byInteractions ? "interactions from the history page" : ""
         }${byInteractions && byActions ? ", " : ""}${
           byActions ? "action items from the contact record or from Action Items" : ""
         }. Each deletion is audited, and this page will then allow the contact to go. Ticking an item <b>done</b> also unblocks the delete: a met commitment is no longer something that would be lost.</p>
       </section>`
      : `<div class="flash warn"><b>No interaction history and no open commitments</b>, so this record can be
         deleted. The complete row is written to the audit trail first, so a mistaken deletion can be reconstructed.
         ${counts.referred ? `<br><b>Note:</b> ${counts.referred} contact${plural(counts.referred)} name${counts.referred === 1 ? "s" : ""} this person as a referral source. That link will be cleared.` : ""}
         ${counts.all_actions ? `<br><b>Note:</b> ${counts.all_actions} completed action item${plural(counts.all_actions)} will be deleted along with the contact. The count is recorded in the audit trail.` : ""}</div>
       <section>
         <!-- The only script in the app (#51 option C). Two identical POSTs in the same second wrote two
              identical delete events; the likeliest source is a double-click on this button. The server
              guard is what makes the trail correct, and it stands alone — this just stops the second
              request being sent at all. Disabled on a timeout rather than inline, so the click that
              disables the button is still the click that submits the form. -->
         <form method="post" action="/contacts/${contact.id}/delete"
               onsubmit="var b=this.querySelector('button[type=submit]');setTimeout(function(){b.disabled=true;b.textContent='Deleting…'},0)">
           <div class="actions" style="margin-top:0">
             <button type="submit" class="danger">Yes, delete ${esc(contact.full_name)}</button>
             <a class="btn secondary" href="/contacts/${contact.id}">Cancel</a>
           </div>
         </form>
         <p class="meta" style="margin-top:10px">Prefer <a href="/contacts/${contact.id}/edit">Inactive</a> if this is a real person you have simply stopped pursuing — delete is for records that should never have existed.</p>
       </section>`
  }
</main>`,
    })
  );
});

app.post("/contacts/:id/inactivate", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT full_name, status FROM contact WHERE id = ?")
    .bind(id)
    .first<{ full_name: string; status: string }>();
  if (!before) return c.notFound();
  await c.env.DB.prepare("UPDATE contact SET status='inactive', updated_at=datetime('now') WHERE id=?")
    .bind(id)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source)
     VALUES (?,?,?,?,?,?, 'app')`
  )
    .bind(ACTOR, "contact", String(id), "update", `status ${before.status}`, `status inactive — ${before.full_name}`)
    .run();
  return c.redirect("/contacts?flash=inactivated");
});

app.post("/contacts/:id/delete", async (c) => {
  const id = Number(c.req.param("id"));
  const loaded = await loadForDelete(c.env.DB, id);
  if (!loaded) return c.notFound();
  const { contact, counts } = loaded;

  // Re-checked at the point of deletion, not just when the page was drawn — the same lesson REL-018
  // taught on the importer. An interaction or a commitment could have been added since this page loaded.
  if (counts.interactions > 0 || counts.open_actions > 0) return c.redirect(`/contacts/${id}/delete`);

  // The whole row goes into the audit trail BEFORE it is destroyed, so the deletion is reversible by
  // hand. Truncated to fit the column, with the fields that identify a person kept first.
  const snapshot = JSON.stringify({
    id: contact.id,
    full_name: contact.full_name,
    title: contact.title,
    organization: contact.organization_name,
    email_work: contact.email_work,
    email_personal: contact.email_personal,
    phone: contact.phone,
    linkedin_url: contact.linkedin_url,
    department: contact.department,
    stage: contact.stage,
    priority_tier: contact.priority_tier,
    last_touch: contact.last_touch,
    next_follow_up: contact.next_follow_up,
    meeting_date: contact.meeting_date,
    birthday: contact.birthday,
    source: contact.source,
    status: contact.status,
    notes: contact.notes,
    import_meta: contact.import_meta,
    completed_action_items: counts.all_actions,
  });
  /*
   * INSERT ... WHERE NOT EXISTS rather than a read, a check, and then an insert (#51). SQLite evaluates
   * the whole statement under a single write lock, so a second copy of the same request cannot slip
   * between the check and the write. A plain read-then-write let exactly that happen: deleting contact
   * 376 on 2026-07-31 recorded two byte-identical delete events in the same second, because both
   * requests passed the guardrail above before either reached the DELETE below.
   *
   * The audit still goes FIRST, on purpose. Deleting first and auditing only the request that actually
   * removed the row (option A on #51) would also close the race, but it trades this bug for a worse
   * one: if the audit write then failed, a contact would be gone with no trail at all. A duplicated
   * event misstates how many times something happened. A missing event loses that it happened. The
   * first is a defect in the record; the second is the absence of one.
   */
  await c.env.DB.prepare(
    `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id)
     SELECT ?,?,?,?,?,?, 'app', ?
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_event
       WHERE correlation_id = ? AND entity = 'contact' AND entity_id = ? AND action = 'delete'
     )`
  )
    .bind(
      ACTOR,
      "contact",
      String(id),
      "delete",
      snapshot.slice(0, 2000),
      `deleted ${contact.full_name}${contact.organization_name ? ` (${contact.organization_name})` : ""}`,
      `delete-contact-${id}`,
      `delete-contact-${id}`,
      String(id)
    )
    .run();

  /*
   * Completed action items go with the contact. Only completed ones can be here — open items block the
   * delete above — but they are still records of things that were promised and met, so they are written
   * out before they are destroyed rather than counted. Before REL-025 these rows were left behind
   * entirely, pointing at a contact_id that no longer existed.
   *
   * Separately audited, and correlated with the contact deletion, for the same reason the organization
   * cleanup below is: removing rows from another table is not obviously part of "delete a contact", and
   * someone reading the trail deserves to see it stated.
   */
  if (counts.all_actions > 0) {
    const { results: doneItems } = await c.env.DB.prepare(
      "SELECT id, description, due_date, done_at FROM action_item WHERE contact_id = ? ORDER BY id"
    )
      .bind(id)
      .all<{ id: number; description: string; due_date: string | null; done_at: string | null }>();
    await c.env.DB.prepare("DELETE FROM action_item WHERE contact_id = ?").bind(id).run();
    // One event per item, keyed to the item's own id, so the trail can be read per commitment rather
    // than as an aggregate that names none of them. Guarded the same way as the contact event above
    // (#51) — two concurrent requests can both read doneItems before either DELETE lands, so the
    // duplicate is possible here too, and the per-item entity_id makes the guard exact.
    for (const a of doneItems) {
      await c.env.DB.prepare(
        `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id)
         SELECT ?,?,?,?,?,?, 'app', ?
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_event
           WHERE correlation_id = ? AND entity = 'action_item' AND entity_id = ? AND action = 'delete'
         )`
      )
        .bind(
          ACTOR,
          "action_item",
          String(a.id),
          "delete",
          `${a.description} · due ${a.due_date ?? "not set"} · done ${a.done_at ?? "date unknown"}`.slice(0, 2000),
          `removed with contact ${contact.full_name}`,
          `delete-contact-${id}`,
          `delete-contact-${id}`,
          String(a.id)
        )
        .run();
    }
  }

  await c.env.DB.prepare("DELETE FROM contact_tag WHERE contact_id = ?").bind(id).run();
  await c.env.DB.prepare("UPDATE contact SET referral_source_contact_id = NULL WHERE referral_source_contact_id = ?")
    .bind(id)
    .run();

  // engagement.origin_contact_id is the referrer of a pursuit — same shape and same treatment as
  // contact.referral_source_contact_id above: the pursuit survives, only the provenance link is cleared.
  await c.env.DB.prepare("UPDATE engagement SET origin_contact_id = NULL WHERE origin_contact_id = ?")
    .bind(id)
    .run();

  /*
   * engagement_contact.contact_id is NOT NULL with no ON DELETE CASCADE on the contact side
   * (0022_pursuit.sql, PURS-001) — deliberately: that migration's own comment says deleting a contact
   * is already a deliberate, enumerated operation and this table joins that list rather than quietly
   * emptying itself. Left off this list, it is the exact REL-031 failure again — the NOT NULL FK aborts
   * the DELETE below and the route 500s for any contact named on a pursuit.
   *
   * Audited as a count, like contact_stage_event: the role a contact held (decision maker, champion,
   * skeptic...) is worth recording as lost, but naming every engagement individually would be noise
   * for what is normally one or two rows.
   */
  const engagementLinks = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM engagement_contact WHERE contact_id = ?"
  )
    .bind(id)
    .first<{ n: number }>();
  await c.env.DB.prepare("DELETE FROM engagement_contact WHERE contact_id = ?").bind(id).run();
  if ((engagementLinks?.n ?? 0) > 0) {
    // Guarded like the others (#51).
    await c.env.DB.prepare(
      `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id)
       SELECT ?,?,?,?,?,?, 'app', ?
       WHERE NOT EXISTS (
         SELECT 1 FROM audit_event
         WHERE correlation_id = ? AND entity = 'engagement_contact' AND entity_id = ? AND action = 'delete'
       )`
    )
      .bind(
        ACTOR,
        "engagement_contact",
        String(id),
        "delete",
        `${engagementLinks?.n ?? 0} pursuit role${(engagementLinks?.n ?? 0) === 1 ? "" : "s"}`,
        `removed with contact ${contact.full_name}; no longer named on any pursuit`,
        `delete-contact-${id}`,
        `delete-contact-${id}`,
        String(id)
      )
      .run();
  }

  /*
   * time_entry.contact_id is DETACHED, never deleted (REL-031). Found while auditing every foreign
   * key into contact(id) after the contact_stage_event outage below — this one was unhandled too, and
   * would have 500'd the same way for any contact with an hour logged against them.
   *
   * Detached rather than deleted because the column is nullable and the row is BILLABLE TIME. Hours
   * are the invoicing record (definitions.md §5c); deleting a bad contact record must never quietly
   * remove hours the operator worked, and of every silent loss in this app that is the one that reaches
   * somebody else's money. The engagement, date, activity and hours all survive; only the optional
   * link to a person is cleared. Zero rows are affected in production today — every time_entry so far
   * came from the calendar import with no contact attached — which is exactly why this had to be
   * found by reading the schema rather than by waiting for it to break.
   */
  const timeLinks = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n, ifnull(SUM(hours),0) AS h FROM time_entry WHERE contact_id = ?"
  )
    .bind(id)
    .first<{ n: number; h: number }>();
  await c.env.DB.prepare("UPDATE time_entry SET contact_id = NULL, updated_at = datetime('now') WHERE contact_id = ?")
    .bind(id)
    .run();
  if ((timeLinks?.n ?? 0) > 0) {
    // Guarded like the others (#51).
    await c.env.DB.prepare(
      `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id)
       SELECT ?,?,?,?,?,?, 'app', ?
       WHERE NOT EXISTS (
         SELECT 1 FROM audit_event
         WHERE correlation_id = ? AND entity = 'time_entry' AND entity_id = ? AND action = 'update'
       )`
    )
      .bind(
        ACTOR,
        "time_entry",
        String(id),
        "update",
        `${timeLinks?.n ?? 0} time entr${(timeLinks?.n ?? 0) === 1 ? "y" : "ies"} totalling ${timeLinks?.h ?? 0}h linked to this contact`,
        `contact link cleared, hours KEPT — the entries remain against their engagement and still count for invoicing; only the link to ${contact.full_name} is gone`,
        `delete-contact-${id}`,
        `delete-contact-${id}`,
        String(id)
      )
      .run();
  }

  /*
   * Stage history has to go before the contact does (REL-031, 2026-08-20).
   *
   * THIS WAS A LIVE OUTAGE. Migration 0020 (2026-08-18) added contact_stage_event plus a
   * contact_stage_initial trigger that fires AFTER INSERT, so from that moment EVERY contact carries at
   * least one stage-history row. contact_stage_event.contact_id is `NOT NULL REFERENCES contact(id)`
   * with no ON DELETE CASCADE, and this delete path was never taught about the new table — so the
   * DELETE below aborted on a foreign key violation and the route returned a 500. The overwhelming
   * majority of contacts were undeletable as a result; only a small number of records that predated the
   * migration and had never changed stage still worked. It surfaced days later when someone tried to
   * remove a duplicate contact. The migration added a table and a trigger without a full audit of what
   * already read or wrote contacts.
   *
   * Ordered with the other child cleanups above rather than relying on the database, because SQLite
   * cannot add ON DELETE CASCADE to an existing constraint without rebuilding the table, and a rebuild
   * of a large table with two triggers hanging off it is a much bigger risk than four lines here. THE
   * TRAP GENERALISES: any future table referencing contact(id) needs a line here or it breaks deletion
   * the same silent way. Stated in definitions.md.
   *
   * Audited as a single count rather than one event per row, unlike the action items above. Those are
   * human commitments and each one deserves naming; these are machine-generated movement records, and
   * a contact with a long history would otherwise bury the trail under dozens of near-identical
   * lines. The count is what a reader needs: it says the /pipeline report just lost this much input.
   */
  const stageEvents = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM contact_stage_event WHERE contact_id = ?"
  )
    .bind(id)
    .first<{ n: number }>();
  await c.env.DB.prepare("DELETE FROM contact_stage_event WHERE contact_id = ?").bind(id).run();
  if ((stageEvents?.n ?? 0) > 0) {
    // Guarded like the other three (#51): two concurrent requests can both read the count before
    // either DELETE lands, and without the guard both would record the removal.
    await c.env.DB.prepare(
      `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id)
       SELECT ?,?,?,?,?,?, 'app', ?
       WHERE NOT EXISTS (
         SELECT 1 FROM audit_event
         WHERE correlation_id = ? AND entity = 'contact_stage_event' AND entity_id = ? AND action = 'delete'
       )`
    )
      .bind(
        ACTOR,
        "contact_stage_event",
        String(id),
        "delete",
        `${stageEvents?.n ?? 0} stage-history event${(stageEvents?.n ?? 0) === 1 ? "" : "s"}`,
        `removed with contact ${contact.full_name}; this contact's movement no longer counts towards the pipeline report`,
        `delete-contact-${id}`,
        `delete-contact-${id}`,
        String(id)
      )
      .run();
  }

  await c.env.DB.prepare("DELETE FROM contact WHERE id = ?").bind(id).run();

  // An organization with nobody left in it is clutter in every dropdown and every report, so it goes
  // too — separately audited, because silently removing a company is not obviously part of "delete a
  // contact" and someone reading the trail deserves to see it stated.
  //
  // "Nobody left in it" has to mean no contacts AND no engagements now (0022_pursuit.sql):
  // engagement.organization_id has no ON DELETE CASCADE either, so an org still holding a pursuit
  // would otherwise abort this DELETE with the same foreign-key violation REL-031 documents — found
  // while testing the engagement/engagement_contact fix above, by an org whose only contact was
  // deleted while a pursuit for it was still open.
  if (contact.organization_id) {
    const left = await c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM contact WHERE organization_id = ?) AS contacts,
              (SELECT COUNT(*) FROM engagement WHERE organization_id = ?) AS engagements`
    )
      .bind(contact.organization_id, contact.organization_id)
      .first<{ contacts: number; engagements: number }>();
    if ((left?.contacts ?? 0) === 0 && (left?.engagements ?? 0) === 0) {
      await c.env.DB.prepare("DELETE FROM organization WHERE id = ?").bind(contact.organization_id).run();
      // Guarded like the two above (#51). This one is the most easily missed: the second request's
      // DELETE removes nothing, so without the guard it would still record a company being removed
      // that it did not remove.
      await c.env.DB.prepare(
        `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id)
         SELECT ?,?,?,?,?,?, 'app', ?
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_event
           WHERE correlation_id = ? AND entity = 'organization' AND entity_id = ? AND action = 'delete'
         )`
      )
        .bind(
          ACTOR,
          "organization",
          String(contact.organization_id),
          "delete",
          contact.organization_name ?? "",
          `removed — no contacts remained after deleting ${contact.full_name}`,
          `delete-contact-${id}`,
          `delete-contact-${id}`,
          String(contact.organization_id)
        )
        .run();
    }
  }

  return c.redirect("/contacts?flash=deleted");
});

export default app;
