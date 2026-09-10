/*
 * REL-005 — referral tracking, the report half (#16).
 *
 * `contact.referral_source_contact_id` has existed since migration 0001 and was maintained correctly by
 * the delete path, but nothing could ever set it: there was no field on either contact form, so in
 * practice the column was always NULL for every contact. The form field lives in contacts.ts; this is
 * the view that makes the data worth entering.
 *
 * WHY A PAGE RATHER THAN A DASHBOARD SECTION. The dashboard already has several sections and answers
 * "what do I do today"; a referral source is something you cultivate over months, and with zero
 * referrals recorded an extra section would have sat empty for weeks teaching you to scroll past it.
 * Worth revisiting as a short "top three" line once there is real data — the decision was about an empty
 * table, not about the idea.
 *
 * NON-CONTACT REFERRERS ARE OUT OF SCOPE, deliberately. The column is a foreign key to another contact,
 * so someone who referred you but is not in the database cannot be recorded without a migration and a
 * second kind of source the report could never deduplicate. The answer is to add them as a contact,
 * which is arguably the right answer anyway: a referral source is a relationship, and one worth tracking
 * is one worth having a record for.
 */

import { Hono } from "hono";
import { esc, layout } from "./views";
import { stageLabel, type Bindings, type D1Db } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

export interface ReferralSource {
  id: number;
  full_name: string;
  organization_name: string | null;
  status: string;
  referred_count: number;
  /** Names of the people they referred, for the detail line. */
  referred_names: string | null;
}

/**
 * Top referral sources by count.
 *
 * Counts referrals regardless of the referred contact's status or stage. A contact who introduced you
 * to four people has done that whether or not any of the four converted — measuring the introducer by
 * the outcome of the introduction would credit them for your follow-through and penalise them for
 * your silence. The stage of each referral is visible on the source's own record if you want to judge
 * quality; the count here is a count of introductions.
 *
 * Inactive SOURCES are included, and marked. Someone you have stopped actively working is still the
 * reason four relationships exist.
 */
export async function topReferralSources(db: D1Db, limit = 50): Promise<ReferralSource[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.full_name, s.status, o.name AS organization_name,
          COUNT(r.id) AS referred_count,
          (SELECT group_concat(r2.full_name, ', ') FROM contact r2
             WHERE r2.referral_source_contact_id = s.id ORDER BY r2.full_name) AS referred_names
        FROM contact s
        JOIN contact r ON r.referral_source_contact_id = s.id
        LEFT JOIN organization o ON o.id = s.organization_id
       GROUP BY s.id
       ORDER BY referred_count DESC, s.full_name
       LIMIT ?`
    )
    .bind(limit)
    .all<ReferralSource>();
  return results;
}

app.get("/referrals", async (c) => {
  const sources = await topReferralSources(c.env.DB);
  const totalReferred = sources.reduce((n, s) => n + s.referred_count, 0);
  const contacts = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM contact").first<{ n: number }>();

  /*
   * The empty state carries the instruction, because today it IS the page. An empty table saying
   * "no data" would leave you with no idea that the field exists or where it is, which is how a feature
   * ships and then goes unused.
   */
  const body = sources.length
    ? `<table><thead><tr><th>Referral source</th><th>Referred</th><th></th></tr></thead><tbody>${sources
        .map(
          (s) => `<tr>
      <td><a href="/contacts/${s.id}"><b>${esc(s.full_name)}</b></a>${
        s.status === "inactive" ? ' <span class="pill">inactive</span>' : ""
      }${s.organization_name ? `<div class="meta">${esc(s.organization_name)}</div>` : ""}</td>
      <td><b>${s.referred_count}</b></td>
      <td class="meta">${esc(s.referred_names ?? "")}</td>
    </tr>`
        )
        .join("")}</tbody></table>
  <p class="meta" style="margin-top:8px">${sources.length} ${
        sources.length === 1 ? "person has" : "people have"
      } introduced you to ${totalReferred} ${totalReferred === 1 ? "contact" : "contacts"}, most prolific first. A count of introductions, not of outcomes — someone who introduced you to four people did that whether or not any of the four went anywhere, and judging the introducer by your follow-through would be measuring the wrong person. Set a referral source in the <b>Referred By</b> field on any contact's record.</p>`
    : `<div class="card empty">
    <p><b>No referrals recorded yet.</b></p>
    <p class="meta">The <b>Referred By</b> field is on every contact's add and edit form — start typing the name of the person who introduced you and pick them from the suggestions. Once a few are set, this page ranks your referral sources by how many introductions each has made, and every contact record shows who referred them and whom they have referred.</p>
    <p class="meta">All ${contacts?.n ?? 0} contacts currently have no referral source on file. It was never possible to set one until now: the column has existed since the first migration, but no form ever offered the field.</p>
    <div class="actions"><a class="btn secondary" href="/contacts">Browse contacts</a></div>
  </div>`;

  return c.html(
    layout({
      title: "Referral Sources",
      body: `<main>
  <h1>Referral Sources</h1>
  <p class="sub">who introduces you to people · <a href="/">back to dashboard</a></p>
  ${body}
</main>`,
    })
  );
});

export default app;
