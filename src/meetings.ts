// Meetings report (the owner, 2026-09-21): "I want to see all of the meetings I have held since
// creating this application." Every meeting is already an interaction row with type='meeting' —
// this page is a read-only cross-contact view over that data, not a new place anything is written.
//
// HELD vs THE OTHER OUTCOMES. Resolving a scheduled meeting writes one of three outcomes: Held,
// No-Show or Cancelled (MEETING_OUTCOMES). "Meetings I have held" means the first of those, so that
// is the default filter — but outcome is a free-text field (interactionForm's comment: "anything
// typed by hand still wins"), so a meeting logged by hand with no outcome typed, or with some other
// note in that field, is bucketed as held rather than silently dropped. Only the two outcomes the
// app itself writes automatically pull a row out of the default view.

import { Hono } from "hono";
import { esc, layout } from "./views";
import { MEETING_FORMATS, labelFor, type Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

interface MeetingRow {
  id: number;
  date: string;
  contact_id: number;
  contact_name: string;
  organization_name: string | null;
  subject: string | null;
  summary: string | null;
  outcome: string | null;
  format: string | null;
}

type Bucket = "held" | "no_show" | "cancelled";

const bucketOf = (outcome: string | null): Bucket =>
  outcome === "No-Show" ? "no_show" : outcome === "Cancelled" ? "cancelled" : "held";

const STATUS_LABEL: Record<Bucket | "all", string> = {
  held: "Held",
  no_show: "No-Show",
  cancelled: "Cancelled",
  all: "Everything",
};

/** Noun phrase for the count line, matching the filter currently shown. */
const SUBTITLE_NOUN: Record<Bucket | "all", string> = {
  held: "meeting",
  no_show: "no-show meeting",
  cancelled: "cancelled meeting",
  all: "meeting interaction",
};

const outcomePill = (outcome: string | null): string => {
  if (outcome === "No-Show") return '<span class="pill red">No-Show</span>';
  if (outcome === "Cancelled") return '<span class="pill grey">Cancelled</span>';
  if (outcome === "Held") return '<span class="pill green">Held</span>';
  return outcome ? `<span class="pill">${esc(outcome)}</span>` : "—";
};

const monthLabel = (ym: string): string => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
};

app.get("/meetings", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.date, i.contact_id, c.full_name AS contact_name, o.name AS organization_name,
            i.subject, i.summary, i.outcome, i.format
       FROM interaction i
       JOIN contact c ON c.id = i.contact_id
       LEFT JOIN organization o ON o.id = c.organization_id
      WHERE i.type = 'meeting'
      ORDER BY i.date DESC, i.id DESC`
  ).all<MeetingRow>();

  const q = c.req.query("status");
  const statusFilter: Bucket | "all" = q === "no_show" || q === "cancelled" || q === "all" ? q : "held";

  const counts: Record<Bucket, number> = { held: 0, no_show: 0, cancelled: 0 };
  for (const r of results) counts[bucketOf(r.outcome)]++;

  const shown = statusFilter === "all" ? results : results.filter((r) => bucketOf(r.outcome) === statusFilter);
  // `shown` is already ordered newest-first, so the last row is the oldest one in view.
  const since = shown.length ? shown[shown.length - 1].date : null;

  const byMonth = new Map<string, MeetingRow[]>();
  for (const r of shown) {
    const key = r.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key)!.push(r);
  }

  /*
   * Each month collapses (the owner, 2026-09-24: "make the months collapsable so that it saves real
   * estate"). The newest month starts open and the rest start folded, so the page opens on what is
   * recent and older months cost one line each. Same <details class="dash"> control and ▸/▾ vocabulary
   * as the dashboard sections, so the two collapsible things in the app look and behave alike. No
   * JavaScript: <details> does the work.
   */
  const groups = [...byMonth.entries()]
    .map(
      ([ym, rows], i) => `
  <details class="dash" style="margin-top:22px"${i === 0 ? " open" : ""}>
  <summary><h2>${esc(monthLabel(ym))} <span class="meta">(${rows.length})</span></h2></summary>
  <table><thead><tr>
      <th>Date</th><th>Contact</th><th>Organization</th><th>Format</th><th>Subject</th><th>Outcome</th><th></th>
    </tr></thead><tbody>${rows
      .map(
        (r) => `<tr>
      <td class="mono" data-label="Date">${esc(r.date)}</td>
      <td data-label="Contact"><a href="/contacts/${r.contact_id}">${esc(r.contact_name)}</a></td>
      <td data-label="Organization">${esc(r.organization_name ?? "—")}</td>
      <td data-label="Format">${r.format ? esc(labelFor(MEETING_FORMATS, r.format)) : "—"}</td>
      <td data-label="Subject">${esc(r.subject ?? (r.summary ? `${r.summary.slice(0, 60)}${r.summary.length > 60 ? "…" : ""}` : "—"))}</td>
      <td data-label="Outcome">${outcomePill(r.outcome)}</td>
      <td class="meta rowacts"><a href="/interactions/${r.id}/edit">edit</a></td>
    </tr>`
      )
      .join("")}</tbody></table>
  </details>`
    )
    .join("");

  const filterLink = (s: Bucket | "all") => `/meetings${s === "held" ? "" : `?status=${s}`}`;

  return c.html(
    layout({
      c,
      title: "Meetings",
      body: `<main>
  <h1>Meetings</h1>
  <p class="sub">${
    shown.length
      ? `${shown.length} ${SUBTITLE_NOUN[statusFilter]}${shown.length === 1 ? "" : "s"}${since ? ` since ${esc(since)}` : ""}`
      : "No meetings recorded yet."
  }</p>

  <p class="meta">Show:
    ${(["held", "no_show", "cancelled", "all"] as const)
      .map((s) =>
        s === statusFilter
          ? `<b>${STATUS_LABEL[s]} (${s === "all" ? results.length : counts[s]})</b>`
          : `<a href="${filterLink(s)}">${STATUS_LABEL[s]} (${s === "all" ? results.length : counts[s]})</a>`
      )
      .join(" · ")}
  </p>

  ${shown.length ? groups : '<div class="card empty">No meetings match this filter.</div>'}
</main>`,
    })
  );
});

export default app;
