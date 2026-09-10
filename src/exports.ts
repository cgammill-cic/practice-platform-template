/*
 * REL-006 — CSV export (#17).
 *
 * "So that my data is never captive to the application." That phrasing sets the bar: an export that
 * needs cleaning up before it is usable has not met it. Two things follow from that.
 *
 * 1. NO LIMIT on either query. Every other list in this app is capped — the contact list at 300, the
 *    action list at 300 — because a screen only shows so much. An export is the opposite: a cap would
 *    silently hand back a subset of your data while looking like a complete file, which is precisely
 *    the quiet failure this app exists to avoid. The row count is stated on the export page so a
 *    truncated download would be visible rather than assumed.
 *
 * 2. Raw values AND labels. `stage` exports as `follow_up_action` and `stage_label` as "Follow-Up
 *    Action". The raw value is what a re-import or a script needs; the label is what a human reads.
 *    Exporting only labels would make the file unusable as input; only raw values would make it
 *    unpleasant as output.
 *
 * Inactive contacts are included, per the acceptance criteria, and carry `status` = "inactive". They
 * are NOT filtered the way the contact list filters them: "export all contacts" has to mean all.
 */

import { Hono } from "hono";
import { esc, layout } from "./views";
import { SOURCES, labelFor, stageLabel, type Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

const today = () => new Date().toISOString().slice(0, 10);

/*
 * Excel opens a .csv by parsing it, and two of its behaviours will corrupt an otherwise valid file.
 *
 * FORMULA INTERPRETATION. A cell whose text begins with = + - or @ is treated as a formula, so a phone
 * number stored as "+1 512 555 1234" arrives as an error rather than a phone number. The standard
 * mitigation is a leading apostrophe, which is what this does. The trade-off is real and worth stating:
 * in Excel the guarded cell displays with a visible leading apostrophe. That is ugly on the one row in
 * the current data that needs it, and strictly better than a number that is silently wrong. If you
 * would rather have the raw value and accept the error, narrow the character class below to /^[=@]/.
 *
 * QUOTING. RFC 4180: a field containing a comma, a double quote, or a line break is wrapped in double
 * quotes and its own quotes are doubled. This is not theoretical here — 19 contacts have commas in
 * their notes and one has a quotation mark, so an unquoted export would shift columns on those rows and
 * look like corrupted data.
 *
 * The order matters: the apostrophe goes on before the quoting decision, so a guarded value that also
 * contains a comma ends up correctly quoted with the apostrophe inside.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Joins rows into a CSV document.
 *
 * CRLF line endings because RFC 4180 specifies them and Excel is happiest with them. The leading
 * U+FEFF byte-order mark is what makes Excel read the file as UTF-8 - without it, Excel on Windows
 * falls back to a legacy code page and any non-ASCII character in a name or organization arrives as
 * mojibake. Three bytes, and it is the difference between a correctly spelled name and a mangled one.
 */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvField).join(","), ...rows.map((r) => r.map(csvField).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

function download(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      // An export is a point-in-time snapshot; a cached copy would quietly go stale.
      "cache-control": "no-store",
    },
  });
}

interface ContactExportRow {
  id: number;
  full_name: string;
  title: string | null;
  organization: string | null;
  department: string | null;
  stage: string;
  strength: string | null;
  priority_tier: number | null;
  email_work: string | null;
  email_personal: string | null;
  phone: string | null;
  linkedin_url: string | null;
  birthday: string | null;
  last_touch: string | null;
  next_follow_up: string | null;
  meeting_date: string | null;
  meeting_time: string | null;
  escalation_rung: number;
  referred_by: string | null;
  tags: string | null;
  open_action_items: number;
  interactions: number;
  source: string | null;
  status: string;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const CONTACT_SQL = `SELECT
    c.id, c.full_name, c.title, o.name AS organization, c.department, c.stage, c.strength,
    c.priority_tier, c.email_work, c.email_personal, c.phone, c.linkedin_url, c.birthday,
    c.last_touch, c.next_follow_up, c.meeting_date, c.meeting_time, c.escalation_rung,
    (SELECT r.full_name FROM contact r WHERE r.id = c.referral_source_contact_id) AS referred_by,
    (SELECT group_concat(name, '; ') FROM
      (SELECT t.name FROM contact_tag ct JOIN tag t ON t.id = ct.tag_id
       WHERE ct.contact_id = c.id ORDER BY t.name)) AS tags,
    (SELECT COUNT(*) FROM action_item a WHERE a.contact_id = c.id AND a.done = 0) AS open_action_items,
    (SELECT COUNT(*) FROM interaction i WHERE i.contact_id = c.id) AS interactions,
    c.source, c.status, c.notes, c.created_at, c.updated_at
  FROM contact c
  LEFT JOIN organization o ON o.id = c.organization_id
  ORDER BY c.full_name, c.id`;

/*
 * group_concat() does not guarantee ordering, so the tag subquery sorts in an inner SELECT first.
 * Without it the same contact could export "Warm; Executive" one day and "Executive; Warm" the next,
 * which would make two exports diff against each other for no real reason.
 */
async function contactRows(db: Bindings["DB"]): Promise<{ headers: string[]; rows: unknown[][] }> {
  const { results } = await db.prepare(CONTACT_SQL).all<ContactExportRow>();
  const headers = [
    "id",
    "full_name",
    "title",
    "organization",
    "department",
    "stage",
    "stage_label",
    "strength",
    "priority_tier",
    "email_work",
    "email_personal",
    "phone",
    "linkedin_url",
    "birthday",
    "last_touch",
    "next_follow_up",
    "meeting_date",
    "meeting_time",
    "escalation_rung",
    "referred_by",
    "tags",
    "open_action_items",
    "interactions",
    "source",
    "source_label",
    "status",
    "notes",
    "created_at",
    "updated_at",
  ];
  const rows = results.map((r) => [
    r.id,
    r.full_name,
    r.title,
    r.organization,
    r.department,
    r.stage,
    stageLabel(r.stage),
    r.strength,
    r.priority_tier,
    r.email_work,
    r.email_personal,
    r.phone,
    r.linkedin_url,
    r.birthday,
    r.last_touch,
    r.next_follow_up,
    r.meeting_date,
    r.meeting_time,
    r.escalation_rung,
    r.referred_by,
    r.tags,
    r.open_action_items,
    r.interactions,
    r.source,
    labelFor(SOURCES, r.source),
    r.status,
    r.notes,
    r.created_at,
    r.updated_at,
  ]);
  return { headers, rows };
}

interface OrgExportRow {
  id: number;
  name: string;
  domain: string | null;
  industry: string | null;
  address: string | null;
  relationship_status: string | null;
  contacts: number;
  active_contacts: number;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

async function organizationRows(db: Bindings["DB"]): Promise<{ headers: string[]; rows: unknown[][] }> {
  const { results } = await db
    .prepare(
      `SELECT o.id, o.name, o.domain, o.industry, o.address, o.relationship_status,
          (SELECT COUNT(*) FROM contact c WHERE c.organization_id = o.id) AS contacts,
          (SELECT COUNT(*) FROM contact c WHERE c.organization_id = o.id AND c.status='active') AS active_contacts,
          o.notes, o.created_at, o.updated_at
        FROM organization o ORDER BY o.name, o.id`
    )
    .all<OrgExportRow>();
  return {
    headers: [
      "id",
      "name",
      "domain",
      "industry",
      "address",
      "relationship_status",
      "contacts",
      "active_contacts",
      "notes",
      "created_at",
      "updated_at",
    ],
    rows: results.map((r) => [
      r.id,
      r.name,
      r.domain,
      r.industry,
      r.address,
      r.relationship_status,
      r.contacts,
      r.active_contacts,
      r.notes,
      r.created_at,
      r.updated_at,
    ]),
  };
}

// ---------------------------------------------------------------- downloads

app.get("/export/contacts.csv", async (c) => {
  const { headers, rows } = await contactRows(c.env.DB);
  return download(toCsv(headers, rows), `contacts-${today()}.csv`);
});

app.get("/export/organizations.csv", async (c) => {
  const { headers, rows } = await organizationRows(c.env.DB);
  return download(toCsv(headers, rows), `organizations-${today()}.csv`);
});

// ---------------------------------------------------------------- export page

app.get("/export", async (c) => {
  const counts = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM contact) AS contacts,
            (SELECT COUNT(*) FROM contact WHERE status='inactive') AS inactive,
            (SELECT COUNT(*) FROM organization) AS orgs,
            (SELECT COUNT(*) FROM contact_tag) AS tag_links`
  ).first<{ contacts: number; inactive: number; orgs: number; tag_links: number }>();
  const contacts = counts?.contacts ?? 0;
  const inactive = counts?.inactive ?? 0;
  const orgs = counts?.orgs ?? 0;
  const tagLinks = counts?.tag_links ?? 0;

  return c.html(
    layout({
      title: "Export",
      body: `<main>
  <h1>Export</h1>
  <p class="sub">Your data, in a file you own. <a href="/">back to dashboard</a></p>

  <section>
    <h2>Contacts</h2>
    <p>Every contact — all ${contacts}, including ${
      inactive ? `the ${inactive} marked inactive` : "any marked inactive"
    }, with organization, stage, dates, tags, notes, and counts of open action items and recorded interactions.</p>
    <div class="actions" style="margin-top:12px">
      <a class="btn" href="/export/contacts.csv">Download contacts CSV</a>
      <span class="meta">${contacts} row${contacts === 1 ? "" : "s"} plus a header</span>
    </div>
  </section>

  <section>
    <h2>Organizations</h2>
    <p>All ${orgs} organizations with their contact counts.</p>
    <div class="actions" style="margin-top:12px">
      <a class="btn secondary" href="/export/organizations.csv">Download organizations CSV</a>
      <span class="meta">${orgs} row${orgs === 1 ? "" : "s"} plus a header</span>
    </div>
  </section>

  <section>
    <h2>What to expect when you open it</h2>
    <ul class="meta" style="margin:0;padding-left:20px;line-height:1.7">
      <li><b>Nothing is truncated.</b> Unlike the contact list, which caps at 300 rows on screen, these files contain every row. The counts above tell you what the file should hold, so a short download is visible rather than assumed.</li>
      <li><b>Stage appears twice</b> — <code>stage</code> as the stored value (<code>follow_up_action</code>) and <code>stage_label</code> as the readable one (Follow-Up Action). The first is what a re-import needs; the second is what you read. Same for <code>source</code>.</li>
      <li><b>Inactive contacts are included</b>, marked in the <code>status</code> column. Export means everything, so nothing is filtered out.</li>
      <li><b>A few cells may show a leading apostrophe.</b> Excel treats text starting with = + - or @ as a formula, so a phone number like +1 512 555 1234 would arrive as an error. The apostrophe prevents that. It affects only cells that genuinely start with those characters.</li>
      ${
        tagLinks === 0
          ? `<li><b>The <code>tags</code> column will be empty.</b> No contact currently has a tag assigned — the tag list exists and search can match on it, but nothing has been tagged yet, so there is nothing to export.</li>`
          : ""
      }
    </ul>
  </section>

  <p class="meta">This is a snapshot for reading and archiving. The nightly backup to R2 is the complete
  machine-readable copy, including interactions and action items — see <a href="/health">system health</a>.</p>
</main>`,
    })
  );
});

export default app;
