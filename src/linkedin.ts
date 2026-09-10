/*
 * REL-011 — the Missing LinkedIn worklist (#26).
 *
 * WHY THIS EXISTS. LinkedIn is rung 3 of the outreach ladder (REL-008, escalation.ts), and the ladder
 * will not suggest a channel the contact has no route for (#58). So a missing linkedin_url does not
 * merely make the LinkedIn step manual — it removes the rung. The contact silently has three ways to be
 * reached instead of four, and nothing on the chase row says why.
 *
 * WHAT WAS ALREADY DONE, so it is not repeated here. The issue listed three options. Option 2 — map URLs
 * straight from the source export — shipped with the importer: a LinkedIn connections export was matched
 * against the priority contacts, and importer.ts carries the result including its own honesty about it,
 * flagging nickname matches and refusing ambiguous ones rather than guessing. Option 3 — scraping, or a
 * paid enrichment vendor — was assessed and rejected in the issue: LinkedIn's terms prohibit the first,
 * and the second adds cost, another data processor and a privacy question, so it is a decision to be
 * taken deliberately rather than a default. This module is option 1, which is all that is left: make the
 * remaining manual work two clicks and a paste.
 *
 * WHAT IS LEFT IS SMALLER BUT HARDER. The contacts still missing a URL after the automatic match are
 * largely the ones where the source data was genuinely absent or genuinely ambiguous — the easy matches
 * are already in. Expect a real share of them to have no profile at all, which is what the "No profile"
 * button and migration 0011 exist for.
 *
 * TERMINAL STAGES ARE EXCLUDED. Complete, No Response, Retired and Not Qualified have no
 * next step by definition (types.ts, TERMINAL_STAGES), so there is no future outreach for a LinkedIn URL
 * to enable. Same rule the dashboard follow-up lists use, for the same reason, and the footer states the
 * count rather than dropping them quietly.
 */

import { Hono } from "hono";
import { esc, layout } from "./views";
import { TERMINAL_STAGES, stageLabel, type Bindings, type Contact, type D1Db } from "./types";

const app = new Hono<{ Bindings: Bindings }>();
const ACTOR = "operator";

/**
 * How many rows the page renders at once. 61 qualify today, so this changes nothing now; it is here so
 * that a future bulk import cannot turn this page into a thousand inline forms. The footer always states
 * shown-of-total, because a cap that does not announce itself reads as "you are finished".
 */
const PAGE_LIMIT = 100;

export interface MissingRow extends Contact {
  organization_name: string | null;
}

const TERMINAL_LIST = TERMINAL_STAGES.map((s) => `'${s}'`).join(",");

/**
 * Who is missing a LinkedIn URL and might still get one.
 *
 * Ordering: contacts currently being chased first, then by priority tier, then by name. The tier order
 * is the issue's requirement; the chase term is ahead of it because a missing URL only costs time at the
 * moment you are trying to reach someone and have run out of channels. That term may reorder nothing at
 * all on a given day — it is written for the state this list will be in once it is being worked alongside
 * section 3, not because live data demonstrated the need on day one.
 *
 * Untiered contacts sort after tiered ones, the same undated-last-style inversion used elsewhere.
 */
export async function missingLinkedIn(db: D1Db, limit = PAGE_LIMIT): Promise<MissingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.*, o.name AS organization_name
         FROM contact c LEFT JOIN organization o ON o.id = c.organization_id
        WHERE c.status='active' AND c.no_linkedin = 0
          AND (c.linkedin_url IS NULL OR TRIM(c.linkedin_url) = '')
          AND c.stage NOT IN (${TERMINAL_LIST})
        ORDER BY (c.stage <> 'awaiting_response'), (c.priority_tier IS NULL), c.priority_tier, c.full_name
        LIMIT ?`
    )
    .bind(limit)
    .all<MissingRow>();
  return results;
}

/** The count for the dashboard link. Same predicate as the list above, deliberately duplicated nowhere else. */
export async function missingLinkedInCount(db: D1Db): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM contact
        WHERE status='active' AND no_linkedin = 0
          AND (linkedin_url IS NULL OR TRIM(linkedin_url) = '')
          AND stage NOT IN (${TERMINAL_LIST})`
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * A LinkedIn people search for this contact, prefilled with what is known.
 *
 * Name plus organization rather than name alone: "Mike Smith" returns thousands of people and the
 * organization is the one fact that makes the right one findable. Where no organization is on file the
 * search is by name, which is worse but still better than typing it.
 */
export function searchUrl(name: string, org: string | null): string {
  const keywords = org ? `${name} ${org}` : name;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;
}

/**
 * A site-restricted web search as the second route.
 *
 * Not redundant with the LinkedIn search above — it is frequently faster, because LinkedIn's own people
 * search deprioritizes profiles outside your network and a search engine does not care. Two links is the
 * ceiling: a row with five ways to start is a row you have to make a decision on before you can work it.
 */
export function webSearchUrl(name: string, org: string | null): string {
  const q = org ? `site:linkedin.com/in "${name}" ${org}` : `site:linkedin.com/in "${name}"`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

/**
 * Cleans up a pasted profile URL, or refuses it.
 *
 * WHY REFUSE ANYTHING. The whole point of this page is that you arrive holding a URL from one of two
 * search tabs, and the wrong tab is in easy reach. A Google results URL pasted into linkedin_url would
 * be stored as a profile address and rendered as a "Profile ↗" link on the contact record, on the
 * contact list row, and in the CSV export — wrong in three places, and only discoverable by clicking it.
 * That is the same argument that kept a sentinel value out of this column (migration 0011).
 *
 * WHAT IT NORMALIZES, and why each one:
 *   - a missing scheme is added, because copying from an address bar sometimes drops it
 *   - the host is lowercased, and a bare `linkedin.com` gains `www.`, so stored URLs share one shape,
 *     matching the `https://www.linkedin.com/in/...` form already in use
 *   - query string and fragment are dropped: LinkedIn appends tracking parameters
 *     (`?miniProfileUrn=…`, `?trk=…`) that identify the session that copied the link, not the person
 *   - a trailing slash is dropped, so the same profile cannot be stored two ways
 *
 * WHAT IT DOES NOT DO. It does not require the path to be `/in/…`. Legacy `/pub/` profiles exist and are
 * real, and a rule that rejects a URL the operator can see working in their own browser would be the app
 * being confidently wrong. A bare domain with no path IS rejected, because that identifies nobody.
 */
export function normalizeLinkedIn(raw: string): { url: string } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Nothing was pasted, so nothing was saved." };
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { error: `“${trimmed}” is not a web address, so nothing was saved.` };
  }
  const host = u.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com"))
    return {
      error: `That is a ${host} address, not a LinkedIn profile, so nothing was saved. If you meant to store it anyway, the LinkedIn URL field on the contact’s Edit page will take any address.`,
    };
  const path = u.pathname.replace(/\/+$/, "");
  if (!path)
    return { error: "That is the LinkedIn home page rather than a particular profile, so nothing was saved." };
  return { url: `https://${host === "linkedin.com" ? "www.linkedin.com" : host}${path}` };
}

async function audit(db: D1Db, contactId: number, summary: string, before: string) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,'contact',?,'update',?,?,'app',?)"
    )
    .bind(ACTOR, String(contactId), before, summary, `contact-${contactId}`)
    .run();
}

// ---------------------------------------------------------------- the page

function row(r: MissingRow): string {
  const org = r.organization_name;
  const tier = r.priority_tier ? `<span class="pill grey">Tier ${esc(r.priority_tier)}</span>` : "";
  // Being chased is the case where the gap is costing something right now, so the row says so.
  const chasing =
    r.stage === "awaiting_response" ? ' <span class="pill amber">being chased — no LinkedIn rung</span>' : "";
  return `<tr>
    <td><a href="/contacts/${r.id}"><b>${esc(r.full_name)}</b></a>
      ${org || r.title ? `<div class="meta">${esc([r.title, org].filter(Boolean).join(" · "))}</div>` : ""}
      <div class="meta">${tier} <span class="pill grey">${esc(stageLabel(r.stage))}</span>${chasing}</div></td>
    ${/* nowrap on both links: the trailing ↗ was wrapping onto its own line in this column at desktop
         width, which reads as a stray character rather than part of the link (measured, not guessed —
         it is visible in the 1200px screenshot taken while building this). */ ""}
    <td data-label="Find the profile">
      <a href="${esc(searchUrl(r.full_name, org))}" target="_blank" rel="noopener" style="white-space:nowrap">LinkedIn search ↗</a>
      <div class="meta"><a href="${esc(webSearchUrl(r.full_name, org))}" target="_blank" rel="noopener" style="white-space:nowrap">web search ↗</a>${
        org ? "" : ' · <span title="no organization on file, so the search is by name alone">name only</span>'
      }</div></td>
    <td data-label="Paste the URL">
      <form method="post" action="/linkedin/${r.id}/url" class="searchbar" style="margin:0">
        <input type="text" name="linkedin_url" placeholder="linkedin.com/in/…" aria-label="LinkedIn URL for ${esc(r.full_name)}">
        <button class="tiny" type="submit">Save</button>
      </form>
      <form method="post" action="/linkedin/${r.id}/none" style="margin:6px 0 0">
        <button class="secondary tiny" type="submit" title="Marks this contact as having no LinkedIn profile so they leave this list. Reversible below.">No profile</button>
      </form></td>
  </tr>`;
}

const FLASH: Record<string, string> = {
  saved: '<div class="flash ok">Saved. The LinkedIn rung is open for them now, and the chase list will stop asking for the URL.</div>',
  none: '<div class="flash ok">Marked as having no LinkedIn profile. They have left this list and the chase list will stop suggesting a LinkedIn URL for them. Undo it at the bottom of this page.</div>',
  restored:
    '<div class="flash ok">Unmarked. They are back on the list above, and the chase list will ask for a URL again.</div>',
  nochange: '<div class="flash warn">That URL was already on the record, so nothing changed.</div>',
};

app.get("/linkedin", async (c) => {
  const rows = await missingLinkedIn(c.env.DB);
  const total = await missingLinkedInCount(c.env.DB);
  const counts = await c.env.DB.prepare(
    `SELECT
       SUM(status='active' AND no_linkedin = 1) AS flagged,
       SUM(status='active' AND (linkedin_url IS NULL OR TRIM(linkedin_url) = '')
             AND stage IN (${TERMINAL_LIST})) AS terminal,
       SUM(linkedin_url IS NOT NULL AND TRIM(linkedin_url) <> '') AS have
     FROM contact`
  ).first<{ flagged: number; terminal: number; have: number }>();
  const flagged = counts?.flagged ?? 0;

  const flaggedRows = flagged
    ? (
        await c.env.DB.prepare(
          `SELECT c.id, c.full_name, o.name AS organization_name FROM contact c
             LEFT JOIN organization o ON o.id = c.organization_id
            WHERE c.status='active' AND c.no_linkedin = 1 ORDER BY c.full_name`
        ).all<{ id: number; full_name: string; organization_name: string | null }>()
      ).results
    : [];

  const error = c.req.query("error");

  return c.html(
    layout({
      title: "Missing LinkedIn",
      body: `<main>
  ${FLASH[c.req.query("flash") ?? ""] ?? ""}
  ${error ? `<div class="flash warn">${esc(error)}</div>` : ""}
  <h1>Missing LinkedIn URLs</h1>
  <p class="sub">${total} active contact${total === 1 ? "" : "s"} with no profile URL on file · <a href="/">dashboard</a> · <a href="/contacts">all contacts</a></p>

  <p class="phone-only meta">Two taps and a paste per contact: open a search, copy the profile URL, paste it back. The search links open in a new tab.</p>

  ${
    rows.length
      ? `<table><tbody>${rows.map(row).join("")}</tbody></table>`
      : `<div class="empty">Every active contact who needs a LinkedIn URL has one, or has been marked as having no profile. ${esc(
          String(counts?.have ?? 0)
        )} contacts have a URL on file.</div>`
  }

  <p class="meta" style="margin-top:10px">Highest priority tier first. <b>LinkedIn search</b> is prefilled with the name and organization; <b>web search</b> is a site-restricted search, which often finds a profile faster because it does not rank by how close you already are to someone. Paste the profile URL back into the box — tracking parameters are stripped, so pasting straight from the address bar is fine. <b>No profile</b> is for the ones who genuinely are not on LinkedIn: it removes them from this list permanently and stops the chase list asking for a URL, and it is reversible below.${
    rows.length < total ? ` Showing the first ${rows.length} of ${total}.` : ""
  }${
    counts?.terminal
      ? ` ${counts.terminal} contact${counts.terminal === 1 ? "" : "s"} in Complete, No Response, Retired or Not Qualified also ${counts.terminal === 1 ? "has" : "have"} no URL and ${counts.terminal === 1 ? "is" : "are"} deliberately not listed — there is no further outreach for it to help.`
      : ""
  }</p>

  ${
    flagged
      ? `<section><details class="dash">
    <summary><h2>Marked as having no LinkedIn profile (${flagged})</h2></summary>
    <table><tbody>${flaggedRows
      .map(
        (f) => `<tr>
        <td><a href="/contacts/${f.id}"><b>${esc(f.full_name)}</b></a>${
          f.organization_name ? `<div class="meta">${esc(f.organization_name)}</div>` : ""
        }</td>
        <td style="text-align:right" data-label="Undo"><form method="post" action="/linkedin/${f.id}/restore" style="margin:0">
          <button class="secondary tiny" type="submit">Put back on the list</button>
        </form></td>
      </tr>`
      )
      .join("")}</tbody></table>
    <p class="meta" style="margin-top:8px">Every marking and unmarking is in the <a href="/audit">audit trail</a>. Adding a URL on a contact’s Edit page clears the mark on its own, so the two facts cannot contradict each other.</p>
  </details></section>`
      : ""
  }
</main>`,
    })
  );
});

// ---------------------------------------------------------------- writes

/** Reads the contact, or null. Shared by the three write routes below. */
async function load(db: D1Db, id: number) {
  return db
    .prepare("SELECT full_name, linkedin_url, no_linkedin FROM contact WHERE id = ?")
    .bind(id)
    .first<{ full_name: string; linkedin_url: string | null; no_linkedin: number }>();
}

app.post("/linkedin/:id/url", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await load(c.env.DB, id);
  if (!before) return c.notFound();
  const f = await c.req.parseBody();
  const parsed = normalizeLinkedIn(typeof f.linkedin_url === "string" ? f.linkedin_url : "");
  if ("error" in parsed)
    return c.redirect(`/linkedin?error=${encodeURIComponent(`${before.full_name}: ${parsed.error}`)}`);
  if (parsed.url === before.linkedin_url) return c.redirect("/linkedin?flash=nochange");

  /*
   * Saving a URL also clears no_linkedin. A record asserting both "here is their profile" and "they have
   * no profile" is a contradiction, and the flag is the half that is now known to be wrong — it was a
   * statement about the absence of the thing that just arrived.
   */
  await c.env.DB.prepare(
    "UPDATE contact SET linkedin_url = ?, no_linkedin = 0, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(parsed.url, id)
    .run();
  await audit(
    c.env.DB,
    id,
    `linkedin_url ${before.linkedin_url ?? "none"} → ${parsed.url}${
      before.no_linkedin ? "; no_linkedin 1 → 0 (a profile was found after all)" : ""
    }`,
    before.full_name
  );
  return c.redirect("/linkedin?flash=saved");
});

/**
 * "There is no profile to find." An assertion by a person, never inferred — see migration 0011 on why
 * nothing was backfilled.
 */
app.post("/linkedin/:id/none", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await load(c.env.DB, id);
  if (!before) return c.notFound();
  if (before.no_linkedin) return c.redirect("/linkedin?flash=none");
  await c.env.DB.prepare("UPDATE contact SET no_linkedin = 1, updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
  await audit(c.env.DB, id, "no_linkedin none → 1 (marked as having no LinkedIn profile)", before.full_name);
  return c.redirect("/linkedin?flash=none");
});

app.post("/linkedin/:id/restore", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await load(c.env.DB, id);
  if (!before) return c.notFound();
  if (!before.no_linkedin) return c.redirect("/linkedin");
  await c.env.DB.prepare("UPDATE contact SET no_linkedin = 0, updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
  await audit(c.env.DB, id, "no_linkedin 1 → 0 (put back on the missing-LinkedIn list)", before.full_name);
  return c.redirect("/linkedin?flash=restored");
});

export default app;
