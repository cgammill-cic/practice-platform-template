/*
 * ORG-001 — organizations you can actually edit (the owner 2026-09-02).
 *
 * "Is there a way I can edit the company set up (currently, I think it's just pulling from when I add a
 * new contact)." He was right about the cause and it was worse than he thought: THERE WAS NO ORGANIZATION
 * SCREEN AT ALL. Organizations were created name-only from three places — the contact form, the engagement
 * form, and the importer — and nothing in the app could ever edit one.
 *
 * Measured on prod before building this: **2,120 organizations, and `domain`, `industry`, `address`,
 * `relationship_status` and `notes` were empty on EVERY SINGLE ROW.** All five columns have existed since
 * migration 0001 in July. Only `calendar_tag` had ever been written, on 3 organizations, and that was
 * edited from the Customers form because there was nowhere else to put it.
 *
 * So this is the fourth instance of the same gap in this codebase — columns the schema has carried for
 * months with no interface to reach them, after `qb_customer_id` (CUST-001), `interaction.outlook_ref`
 * (MAIL-001) and `referral_source_contact_id` (REL-005). The pattern is worth naming: a migration is
 * cheap and a form is not, so the schema runs ahead and the gap is invisible until someone asks for the
 * field. NO MIGRATION HERE — there is nothing to add.
 *
 * WHY IT MATTERS NOW. The pursuit work (PURS-001) needed the physical address the owner asked for, and that
 * address is `organization.address`. It was unreachable, which made a schema question out of an interface
 * problem. The pursuit deliberately does not carry its own address; a company has one, and one copy of it
 * is the point.
 *
 * WHAT IS NOT HERE: merging two organizations. That is ORG-002, and it needs a place to record "these two
 * are not duplicates" so the review queue does not ask twice — which does need a migration. Renaming
 * covers the common case in the meantime, and a rename is not a merge: it leaves the other row alone.
 */

import { Hono } from "hono";
import { esc, layout, select } from "./views";
import { ORG_RELATIONSHIP, labelFor, type Bindings, type D1Db, type Organization } from "./types";
import { actor } from "./auth";

const app = new Hono<{ Bindings: Bindings }>();

/** With 2,120 rows the list is search-first. Same shape and same reason as REL-017's contact list. */
const LIMIT = 200;

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

async function audit(db: D1Db, id: number, action: string, after: string | null, before: string | null) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,'organization',?,?,?,?,'app',?)"
    )
    .bind(actor(), String(id), action, before, after, `organization-${id}`)
    .run();
}

type Row = Organization & { contact_count: number; engagement_count: number; open_pursuits: number };

/**
 * One organization with the counts that say whether it is worth anything to you.
 *
 * The counts are the reason this list is worth reading rather than being an alphabetical dump: an
 * organization with no contacts and no engagements is almost always import residue, and 27 of them exist.
 */
export async function organizationList(
  db: D1Db,
  opts: { q?: string | null; emptyOnly?: boolean } = {}
): Promise<{ rows: Row[]; total: number }> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.q) {
    where.push("(lower(o.name) LIKE ? OR lower(ifnull(o.domain,'')) LIKE ? OR lower(ifnull(o.industry,'')) LIKE ?)");
    const like = `%${opts.q.toLowerCase()}%`;
    params.push(like, like, like);
  }
  if (opts.emptyOnly)
    where.push(
      "NOT EXISTS (SELECT 1 FROM contact c WHERE c.organization_id = o.id) AND NOT EXISTS (SELECT 1 FROM engagement e WHERE e.organization_id = o.id)"
    );
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM organization o ${clause}`)
    .bind(...params)
    .first<{ n: number }>();

  const { results } = await db
    .prepare(
      `SELECT o.*,
              (SELECT COUNT(*) FROM contact c WHERE c.organization_id = o.id) AS contact_count,
              (SELECT COUNT(*) FROM engagement e WHERE e.organization_id = o.id) AS engagement_count,
              (SELECT COUNT(*) FROM engagement e WHERE e.organization_id = o.id
                 AND e.status IN ('identified','qualifying','proposal','submitted','verbal')) AS open_pursuits
         FROM organization o ${clause}
        ORDER BY contact_count DESC, o.name
        LIMIT ${LIMIT}`
    )
    .bind(...params)
    .all<Row>();

  return { rows: results, total: totalRow?.n ?? results.length };
}

export async function organization(db: D1Db, id: number): Promise<Row | null> {
  return await db
    .prepare(
      `SELECT o.*,
              (SELECT COUNT(*) FROM contact c WHERE c.organization_id = o.id) AS contact_count,
              (SELECT COUNT(*) FROM engagement e WHERE e.organization_id = o.id) AS engagement_count,
              (SELECT COUNT(*) FROM engagement e WHERE e.organization_id = o.id
                 AND e.status IN ('identified','qualifying','proposal','submitted','verbal')) AS open_pursuits
         FROM organization o WHERE o.id = ?`
    )
    .bind(id)
    .first<Row>();
}

// ---------------------------------------------------------------- the form

function organizationForm(opts: { org: Partial<Row>; error?: string; saved?: boolean }): string {
  const o = opts.org;
  return `<main>
  <h1>${esc(o.name ?? "Organization")}</h1>
  <p class="meta" style="margin:0 0 4px">${o.contact_count ?? 0} contact${(o.contact_count ?? 0) === 1 ? "" : "s"} · ${
    o.engagement_count ?? 0
  } engagement${(o.engagement_count ?? 0) === 1 ? "" : "s"}${
    o.open_pursuits ? ` (${o.open_pursuits} open pursuit${o.open_pursuits === 1 ? "" : "s"})` : ""
  }</p>
  <div class="linkbar">
    <a class="linkchip" href="/organizations">All Organizations</a>
    <a class="linkchip" href="/contacts?org=${encodeURIComponent(o.name ?? "")}">Its People</a>
  </div>
  ${opts.saved ? '<div class="flash ok">Changes saved.</div>' : ""}
  ${opts.error ? `<div class="flash warn">${esc(opts.error)}</div>` : ""}
  <form method="post" action="/organizations/${o.id}/edit" class="card">
    ${/*
      RENAMING IS ALLOWED, and it is the main thing this screen is for. The names came from a spreadsheet
      import and a lot of them are wrong or abbreviated. A rename moves nothing: every contact and
      engagement points at this row by id, so they all follow automatically — which is exactly why it is
      NOT a merge. Renaming "Harber and Wexley" to "Harbor & Wexley" leaves the other Harbor row
      untouched and now there are two spellings of the same string. Merging is ORG-002.
    */ ""}
    <div class="row">
      <div><label>Name <span class="hint">required — every contact and engagement here follows the change</span></label>
        <input type="text" name="name" value="${esc(o.name)}" required autofocus></div>
      <div><label>Website / Domain <span class="hint">optional</span></label>
        <input type="text" name="domain" value="${esc(o.domain)}" placeholder="e.g. datumengineers.com"></div>
    </div>
    <div class="row">
      <div><label>Industry</label><input type="text" name="industry" value="${esc(o.industry)}" placeholder="e.g. Engineering services"></div>
      <div><label>Relationship</label>${select("relationship_status", ORG_RELATIONSHIP, o.relationship_status ?? "", {
        blank: "— not set —",
      })}</div>
    </div>
    <div class="row">
      <div><label>Physical Address <span class="hint">used for proposals and for invoicing context</span></label>
        <textarea name="address" placeholder="Street, city, state, ZIP">${esc(o.address)}</textarea>
        <p class="meta" style="margin-top:4px">One address per company, held here rather than on each pursuit — a second copy is a second thing to keep right. QuickBooks still owns the invoice itself.</p></div>
    </div>
    <div class="row">
      <div><label>Outlook Category <span class="hint">what you type on calendar events for this client</span></label>
        <input type="text" name="calendar_tag" value="${esc(o.calendar_tag)}" placeholder="e.g. Acme">
        <p class="meta" style="margin-top:4px">Leave blank when the category is simply the company name — the calendar import matches on the name by default. Fill it in when they differ: the category <code>Acme</code> against a company recorded as <code>Acme Engineers, Inc.</code> This is the same field the engagement form offers; it has always been stored here.</p></div>
    </div>
    <div class="row">
      <div><label>Notes</label><textarea name="notes" placeholder="Anything worth knowing about the company rather than about a person">${esc(
        o.notes
      )}</textarea></div>
    </div>
    <div class="actions">
      <button type="submit">Save Changes</button>
      <a class="btn secondary" href="/organizations">Cancel</a>
    </div>
  </form>
  <p class="meta">Everything on this form except the name and the Outlook category had <b>never been writable</b> until today — the columns have existed since July and no screen in the app could reach them. That is why they start out blank on nearly every company: not because the information was unwanted, but because there was nowhere to type it.</p>
</main>`;
}

// ---------------------------------------------------------------- pages

app.get("/organizations", async (c) => {
  const q = str(c.req.query("q"));
  const emptyOnly = c.req.query("empty") === "1";
  const { rows, total } = await organizationList(c.env.DB, { q, emptyOnly });
  const filled = rows.filter((r) => r.domain || r.industry || r.address || r.relationship_status || r.notes).length;

  const table = rows.length
    ? `<table><thead><tr><th>Organization</th><th style="text-align:right">People</th><th>Work</th><th>Filled in</th><th></th></tr></thead><tbody>${rows
        .map(
          (r) => `<tr>
      <td><a href="/organizations/${r.id}/edit"><b>${esc(r.name)}</b></a>${
        r.relationship_status
          ? ` <span class="pill ${r.relationship_status === "client" ? "green" : "grey"}">${esc(
              labelFor(ORG_RELATIONSHIP, r.relationship_status)
            )}</span>`
          : ""
      }${r.domain ? `<div class="meta">${esc(r.domain)}</div>` : ""}${
        r.industry ? `<div class="meta">${esc(r.industry)}</div>` : ""
      }</td>
      <td style="text-align:right" data-label="People">${
        r.contact_count ? `<a href="/contacts?org=${encodeURIComponent(r.name)}">${r.contact_count}</a>` : '<span class="meta">—</span>'
      }</td>
      <td data-label="Work">${
        r.engagement_count
          ? `${r.engagement_count}${r.open_pursuits ? ` <span class="pill">${r.open_pursuits} open</span>` : ""}`
          : '<span class="meta">—</span>'
      }</td>
      <td data-label="Filled in">${
        [r.domain && "domain", r.industry && "industry", r.address && "address", r.relationship_status && "relationship", r.notes && "notes", r.calendar_tag && "category"]
          .filter(Boolean)
          .join(", ") || '<span class="meta">nothing yet</span>'
      }</td>
      <td class="rowacts"><a href="/organizations/${r.id}/edit">edit</a></td>
    </tr>`
        )
        .join("")}</tbody></table>
    <p class="meta" style="margin-top:8px">Most people first. ${
      total > rows.length ? `Showing ${rows.length} of <b>${total}</b> — narrow it with the search box.` : `${total} shown.`
    } ${filled} of ${rows.length === 1 ? "it" : "them"} ${
      filled === 1 ? "has" : "have"
    } anything filled in beyond a name.</p>`
    : `<div class="card empty"><p><b>Nothing matches.</b></p><p class="meta">Organizations are created automatically when you type a new company on a contact or an engagement, so the list is as long as your contact list is varied.</p></div>`;

  return c.html(
    layout({ c,
      title: "Organizations",
      body: `<main>
  ${c.req.query("flash") === "saved" ? '<div class="flash ok">Changes saved.</div>' : ""}
  <h1>Organizations</h1>
  <p class="meta" style="margin:0 0 4px">${total} ${emptyOnly ? "with no people and no work" : "companies"}</p>
  <div class="linkbar">
    <a class="linkchip" href="/organizations/duplicates">Possible Duplicates</a>
    <a class="linkchip" href="/contacts">Contacts</a>
    <a class="linkchip" href="/engagements">Customers</a>
    <a class="linkchip" href="/pursuits">Pursuits</a>
  </div>
  <form method="get" action="/organizations" class="card" style="margin-bottom:14px">
    <div class="row">
      <div><label>Search <span class="hint">name, domain or industry</span></label>
        <input type="text" name="q" value="${esc(q)}" placeholder="e.g. Acme, or engineering" autofocus></div>
    </div>
    <div class="actions">
      <button type="submit">Search</button>
      ${
        emptyOnly
          ? '<a class="btn secondary" href="/organizations">Show all</a>'
          : '<a class="btn secondary" href="/organizations?empty=1">Only those with nobody in them</a>'
      }
    </div>
  </form>
  ${
    emptyOnly
      ? '<p class="meta" style="margin:-6px 0 12px">Organizations with no contacts and no engagements. Almost always import residue — a company typed once on a contact who was later deleted or moved. Harmless, but they clutter every company dropdown.</p>'
      : ""
  }
  ${table}
</main>`,
    })
  );
});

app.get("/organizations/:id/edit", async (c) => {
  const org = await organization(c.env.DB, Number(c.req.param("id")));
  if (!org) return c.notFound();
  return c.html(
    layout({ c,
      title: org.name,
      body: organizationForm({ org, saved: c.req.query("flash") === "saved" }),
    })
  );
});

app.post("/organizations/:id/edit", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await organization(c.env.DB, id);
  if (!before) return c.notFound();
  const f = await c.req.parseBody();

  const name = str(f.name);
  const reshow = (error: string) =>
    c.html(
      layout({ c,
        title: before.name,
        body: organizationForm({ org: { ...before, ...(f as Partial<Row>), id }, error }),
      })
    );
  if (!name) return reshow("A company needs a name, so nothing was saved.");

  const relationship = str(f.relationship_status);
  if (relationship && !ORG_RELATIONSHIP.some(([v]) => v === relationship))
    return reshow("That is not a relationship I recognise, so nothing was saved.");

  /*
   * A rename onto a name that already exists is REFUSED — and this is the one judgement call on the
   * screen worth defending. It is not a uniqueness constraint (there is none on the column, deliberately;
   * see migration 0018's note on calendar_tag), it is a guard against the thing a rename looks like but
   * is not. Typing "Harbor & Wexley" over "Harber and Wexley" FEELS like consolidating them; it
   * actually leaves two rows with identical names, each holding half the contacts, and no screen able to
   * tell them apart afterwards. Merging is ORG-002, and until it exists this refusal is what stops a
   * rename from quietly creating the mess the merge is meant to clean up.
   */
  const clash = await c.env.DB.prepare(
    "SELECT id, name FROM organization WHERE lower(name) = lower(?) AND id <> ?"
  )
    .bind(name, id)
    .first<{ id: number; name: string }>();
  if (clash)
    return reshow(
      `“${clash.name}” already exists (id ${clash.id}), so the rename was not saved. Two companies with the same name cannot be told apart afterwards, and renaming one onto the other does NOT combine them — each would keep its own contacts. Merging two organizations is not built yet; for now, move the contacts across on their own records, or pick a name that distinguishes them.`
    );

  const next = {
    name,
    domain: str(f.domain),
    industry: str(f.industry),
    address: str(f.address),
    relationship_status: relationship,
    notes: str(f.notes),
    calendar_tag: str(f.calendar_tag),
  };

  /*
   * The summary is the audit line AND the no-change comparison, so every editable field appears in it.
   * A field missing here is a field whose edit is reported as "nothing changed" while having been saved —
   * the bug PURS-001's summary() note describes, avoided by construction rather than by remembering.
   */
  const describe = (o: Partial<Row>) =>
    [
      o.name,
      o.domain,
      o.industry,
      o.relationship_status,
      o.calendar_tag && `category ${o.calendar_tag}`,
      o.address && `address ${o.address.replace(/\s+/g, " ")}`,
      o.notes && `notes ${o.notes.replace(/\s+/g, " ")}`,
    ]
      .filter(Boolean)
      .join(" · ");

  const after = describe(next);
  const wasBefore = describe(before);
  if (after === wasBefore) return c.redirect(`/organizations/${id}/edit`);

  await c.env.DB.prepare(
    `UPDATE organization SET name=?, domain=?, industry=?, address=?, relationship_status=?, notes=?,
       calendar_tag=?, updated_at=datetime('now') WHERE id=?`
  )
    .bind(
      next.name,
      next.domain,
      next.industry,
      next.address,
      next.relationship_status,
      next.notes,
      next.calendar_tag,
      id
    )
    .run();
  await audit(c.env.DB, id, before.name === name ? "update" : "rename", after, wasBefore);
  return c.redirect(`/organizations/${id}/edit?flash=saved`);
});

export default app;
