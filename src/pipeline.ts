/*
 * ANLY-002 — pipeline movement: what moved, where it came from, and how long it sat.
 *
 * The first report built on `contact_stage_event` (migration 0020). Before that table existed none of
 * this was computable — `contact.stage` says where a relationship IS and nothing said where it had been.
 *
 * WHY THIS PAGE IS MOSTLY CAVEATS. Two thirds of the data underneath it is RECONSTRUCTED from prose in
 * the audit trail rather than recorded as it happened, and the recovered set is explicitly not guaranteed
 * complete. A movement report that quietly presents reconstructed history as measurement is the failure
 * this codebase keeps refusing — the same class as the Complete contacts that used to sit on the Overdue
 * list, or a combined per-customer total read as an invoice line. So the provenance band at the top is
 * not decoration; it is the part that makes the numbers safe to act on.
 *
 * THREE THINGS THE DATA CANNOT TELL YOU, all stated on the page:
 *
 *   1. NOTHING EXISTS BEFORE THIS TABLE STARTED RECORDING. Not "was quiet" — did not get recorded. Any
 *      month before that reads as zero and it means nothing.
 *   2. CONTACTS BROUGHT IN BY A BULK IMPORT HAVE NO ARRIVAL ROW. Migration 0020 deliberately refused to
 *      invent one: their stage came from a spreadsheet code and `created_at` is when the row was
 *      written, not when the relationship reached that stage. So "entered the pipeline" undercounts,
 *      permanently, and a contact appears here only once it genuinely moves.
 *   3. AN OPEN SPELL IS NOT A SHORT SPELL. Dwell time is computed only between two consecutive events,
 *      so a contact still sitting in a stage contributes nothing. Averaging what has already resolved
 *      biases every figure DOWNWARD — the slow ones are exactly the ones still open. Counts travel
 *      beside every average for that reason.
 *
 * SAME-STAGE SAVES ARE NOT MOVEMENT. The backfill faithfully recovered rows like
 * `stage reach_out_later → reach_out_later`, because the "reach out later in N days" action sets the
 * stage unconditionally and the audit line prints the transition even when nothing changed. Three of
 * those exist. They are real saves and useless as movement, so every count here excludes them. The live
 * trigger cannot produce them (`WHEN old.stage IS NOT new.stage`); this is a backfill artefact only.
 *
 * COUNTS BEFORE RATIOS, per ANLY-001. At these volumes a percentage swings on one contact, so a rate is
 * shown only where the denominator is stated next to it and never below a floor.
 */

import { Hono } from "hono";
import { esc, layout } from "./views";
import { stageLabel as stageName, type Bindings, type D1Db } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

/** Below this many resolved cases, a share is not shown at all — only the counts. */
const MIN_DENOMINATOR = 8;

/*
 * Reuses the shared stageLabel from types.ts rather than a local copy. A second implementation of the
 * stage vocabulary is exactly how two screens end up disagreeing about what a stage is called — the same
 * shape of problem as followUpPill not knowing about terminal stages.
 */

const bar = (n: number, max: number) =>
  `<div class="barwrap"><div class="bar" style="width:${max > 0 ? Math.round((n / max) * 100) : 0}%"></div></div>`;

interface Provenance {
  total: number;
  backfilled: number;
  live: number;
  first: string | null;
  liveFrom: string | null;
}

async function provenance(db: D1Db): Promise<Provenance> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN origin = 'audit-backfill' THEN 1 ELSE 0 END) AS backfilled,
              SUM(CASE WHEN origin = 'trigger' THEN 1 ELSE 0 END) AS live,
              MIN(date(changed_at)) AS first,
              MIN(CASE WHEN origin = 'trigger' THEN date(changed_at) END) AS liveFrom
         FROM contact_stage_event`
    )
    .first<Provenance>();
  return (
    row ?? { total: 0, backfilled: 0, live: 0, first: null, liveFrom: null }
  );
}

/*
 * ORIGINS THAT ARE NOT MOVEMENT.
 *
 * A stage event records that the stage changed. It does not follow that a RELATIONSHIP moved, and this
 * page only ever meant the second thing. Two origins are reclassification rather than movement:
 *
 *   'import-corrected'  stages repaired after an importer had misread priority codes as stages. Those
 *                       contacts were never in conversation; the record was wrong and got fixed.
 *   'bulk-update'       a sweep applied from a file (REL-033). When an operator marks a batch of people
 *                       Retired from a spreadsheet, nothing actually happened between them and those
 *                       people.
 *
 * Both are kept in the history — the record genuinely changed and the trail must say so — and both are
 * excluded here. Counting them would put a wall of arrivals into Retired in one second on a page whose
 * whole job is showing where relationships are going, burying every real signal underneath a data fix.
 *
 * The first time this came up it was cleaned up after the fact, by rewriting rows. Naming the rule here
 * means the next bulk correction does not need that.
 */
const NOT_MOVEMENT = "'import-corrected','bulk-update'";

/** Movement into each stage within the window. Same-stage saves and reclassification excluded. */
async function destinations(db: D1Db, days: number) {
  const { results } = await db
    .prepare(
      `SELECT to_stage, COUNT(*) AS n, COUNT(DISTINCT contact_id) AS contacts
         FROM contact_stage_event
        WHERE from_stage IS NOT NULL AND from_stage <> to_stage
          AND origin NOT IN (${NOT_MOVEMENT})
          AND changed_at >= datetime('now', ?)
        GROUP BY to_stage ORDER BY n DESC`
    )
    .bind(`-${days} days`)
    .all<{ to_stage: string; n: number; contacts: number }>();
  return results;
}

/** Where those moves came from. The funnel, as it actually behaved rather than as designed. */
async function flows(db: D1Db, days: number) {
  const { results } = await db
    .prepare(
      `SELECT from_stage, to_stage, COUNT(*) AS n
         FROM contact_stage_event
        WHERE from_stage IS NOT NULL AND from_stage <> to_stage
          AND origin NOT IN (${NOT_MOVEMENT})
          AND changed_at >= datetime('now', ?)
        GROUP BY from_stage, to_stage ORDER BY n DESC, from_stage`
    )
    .bind(`-${days} days`)
    .all<{ from_stage: string; to_stage: string; n: number }>();
  return results;
}

/*
 * How long a contact sat in a stage before moving on.
 *
 * COMPLETED SPELLS ONLY, and the bias that creates is stated on the page rather than buried here: a
 * contact still sitting somewhere has no end date, so it is excluded, and the ones still sitting are
 * disproportionately the slow ones. Every average here is therefore optimistic. Median would be steadier
 * than mean at this volume, but SQLite has no median and faking one with a window function would add code
 * that is harder to check than the caveat it replaces. The min/max spread does that job honestly.
 *
 * RECLASSIFICATION IS DROPPED FROM THE TIMELINE, not merely from the counts, which is a stronger claim
 * than the exclusion in the movement queries above. A bulk sweep event sitting mid-history would END a
 * real spell on the day of the sweep — reporting that a contact left Awaiting Response on 2026-08-21
 * when nothing happened to them — and open a fake one in the stage they were reclassified into.
 * Removing those rows from the window function lets the spell run on to the next real change, or stay
 * open and be excluded. That is the honest answer: the app does not know when someone actually became
 * Retired, only when it was told.
 */
async function dwell(db: D1Db) {
  const { results } = await db
    .prepare(
      `WITH ordered AS (
         SELECT contact_id, to_stage, changed_at,
                LEAD(changed_at) OVER (PARTITION BY contact_id ORDER BY changed_at) AS next_at
           FROM contact_stage_event
          WHERE origin NOT IN (${NOT_MOVEMENT})
       )
       SELECT to_stage AS stage, COUNT(*) AS spells,
              ROUND(AVG(julianday(next_at) - julianday(changed_at)), 1) AS avg_days,
              CAST(MIN(julianday(next_at) - julianday(changed_at)) AS INTEGER) AS min_days,
              CAST(MAX(julianday(next_at) - julianday(changed_at)) AS INTEGER) AS max_days
         FROM ordered WHERE next_at IS NOT NULL
        GROUP BY to_stage ORDER BY spells DESC`
    )
    .all<{ stage: string; spells: number; avg_days: number; min_days: number; max_days: number }>();
  return results;
}

/*
 * What happened to outreach that got a decision.
 *
 * The closest honest thing to a "response rate", and it is deliberately not called one. It counts what
 * became of contacts who LEFT `awaiting_response` — nothing more. It does not pair a reply to the
 * attempt that provoked it, which is the attribution problem ANLY-001 flagged; it simply reports where
 * they went. Contacts still awaiting a reply are excluded, because they have not resolved yet, and that
 * exclusion is what makes the denominator meaningful.
 */
async function outreachResolution(db: D1Db) {
  const { results } = await db
    .prepare(
      `SELECT to_stage, COUNT(*) AS n FROM contact_stage_event
        WHERE from_stage = 'awaiting_response' AND to_stage <> 'awaiting_response'
          AND origin NOT IN (${NOT_MOVEMENT})
        GROUP BY to_stage ORDER BY n DESC`
    )
    .all<{ to_stage: string; n: number }>();
  return results;
}

const WINDOWS: [number, string][] = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
  [3650, "everything"],
];

app.get("/pipeline", async (c) => {
  const raw = Number(c.req.query("days"));
  const days = WINDOWS.some(([d]) => d === raw) ? raw : 30;
  const [prov, dest, flow, dwellRows, resolution] = await Promise.all([
    provenance(c.env.DB),
    destinations(c.env.DB, days),
    flows(c.env.DB, days),
    dwell(c.env.DB),
    outreachResolution(c.env.DB),
  ]);

  const nav = WINDOWS.map(
    ([d, label]) =>
      `<a class="${d === days ? "btn" : "btn secondary"}" href="/pipeline?days=${d}">${esc(label)}</a>`
  ).join(" ");

  const maxDest = Math.max(0, ...dest.map((r) => r.n));
  const destRows = dest
    .map(
      (r) => `<tr>
      <td><b>${esc(stageName(r.to_stage))}</b>${bar(r.n, maxDest)}</td>
      <td class="num" data-label="Moves"><b>${r.n}</b></td>
      <td class="num" data-label="Contacts">${
        r.contacts === r.n ? '<span class="meta">—</span>' : r.contacts
      }</td>
    </tr>`
    )
    .join("");

  const maxFlow = Math.max(0, ...flow.map((r) => r.n));
  const flowRows = flow
    .map(
      (r) => `<tr>
      <td>${esc(stageName(r.from_stage))} <span class="meta">→</span> <b>${esc(
        stageName(r.to_stage)
      )}</b>${bar(r.n, maxFlow)}</td>
      <td class="num" data-label="Moves"><b>${r.n}</b></td>
    </tr>`
    )
    .join("");

  const dwellRowsHtml = dwellRows
    .map(
      (r) => `<tr>
      <td>${esc(stageName(r.stage))}</td>
      <td class="num" data-label="Resolved">${r.spells}</td>
      <td class="num" data-label="Average">${
        r.spells >= 3 ? `<b>${esc(String(r.avg_days))}d</b>` : '<span class="meta">too few</span>'
      }</td>
      <td class="num" data-label="Range"><span class="meta">${r.min_days}–${r.max_days}d</span></td>
    </tr>`
    )
    .join("");

  const resolved = resolution.reduce((n, r) => n + r.n, 0);
  const progressed = resolution
    .filter((r) => !["no_response", "not_qualified", "retired"].includes(r.to_stage))
    .reduce((n, r) => n + r.n, 0);
  const resolutionRows = resolution
    .map(
      (r) => `<tr>
      <td>${esc(stageName(r.to_stage))}</td>
      <td class="num" data-label="Contacts"><b>${r.n}</b></td>
    </tr>`
    )
    .join("");

  return c.html(
    layout({
      title: "Pipeline Movement",
      body: `<main>
  <h1>Pipeline Movement</h1>
  <p class="sub">What moved between stages, where it came from, and how long it sat · <a href="/">dashboard</a> · <a href="/time/report">weekly hours</a></p>

  ${/* The provenance band. Not decoration — it is what makes every number below safe to read. */ ""}
  <div class="card" style="border-left:3px solid var(--line)">
    <p class="meta" style="margin:0"><b>Where these numbers come from.</b>
    ${prov.total} recorded stage changes, the earliest dated <b>${esc(prov.first ?? "—")}</b>.
    <b>${prov.backfilled}</b> were reconstructed from the audit trail when this was built, and that recovered set
    is <b>not guaranteed complete</b>; <b>${prov.live}</b> have been captured as they happened, from
    <b>${esc(prov.liveFrom ?? "—")}</b> onward. <b>Nothing exists before ${esc(prov.first ?? "—")}</b> — an
    earlier period reads as zero because nothing was recorded, not because nothing happened.</p>
    <p class="meta" style="margin:8px 0 0">The contacts loaded by the original import carry <b>no arrival
    row</b>, deliberately: their stage came from a spreadsheet code, and inventing a movement for each of
    them dated to import day would put a spike in every chart here that never happened. A contact appears
    below only once it genuinely moves, so "entered the pipeline" undercounts and always will.</p>
  </div>

  <div class="actions" style="margin:14px 0">${nav}</div>

  <section>
    <h2>Moved into ${
      days >= 3650
        ? "— all recorded history"
        : `— last ${esc(String(WINDOWS.find(([d]) => d === days)?.[1] ?? days))}`
    }</h2>
    ${
      dest.length
        ? `<table><thead><tr><th>Stage</th><th class="num">Moves</th><th class="num">Contacts</th></tr></thead>
      <tbody>${destRows}</tbody></table>
      <p class="meta" style="margin-top:8px"><b>Moves</b> counts every transition; <b>Contacts</b> is shown only
      where it differs, meaning someone landed in that stage more than once in the window. A save that did not
      change the stage is not a move and is excluded.</p>`
        : '<div class="empty">No stage changes recorded in this window.</div>'
    }
  </section>

  <section>
    <h2>Where they came from</h2>
    ${
      flow.length
        ? `<table><thead><tr><th>Transition</th><th class="num">Moves</th></tr></thead><tbody>${flowRows}</tbody></table>
      <p class="meta" style="margin-top:8px">The funnel as it actually behaved rather than as designed. Read the
      large rows first — they are where your time went, whether or not that was the intent.</p>`
        : '<div class="empty">Nothing to show for this window.</div>'
    }
  </section>

  <section>
    <h2>What became of outreach that got an answer</h2>
    ${
      resolved
        ? `<table><thead><tr><th>Left Awaiting Response for</th><th class="num">Contacts</th></tr></thead>
      <tbody>${resolutionRows}
      <tr><td><b>Resolved in total</b></td><td class="num"><b>${resolved}</b></td></tr></tbody></table>
      <p class="meta" style="margin-top:8px">${
        resolved >= MIN_DENOMINATOR
          ? `<b>${progressed} of ${resolved}</b> resolved contacts moved forward rather than going cold — ${Math.round(
              (progressed / resolved) * 100
            )}%, on a denominator of ${resolved}.`
          : `Only ${resolved} contacts have resolved so far, which is too few to express as a rate. The counts are above.`
      }
      <b>This is not a response rate.</b> It counts where contacts went after they left Awaiting Response; it does
      not pair a reply to the attempt that provoked it, and contacts still waiting are excluded entirely — which is
      what makes the denominator mean anything. All time, not the selected window, because the volumes are small.</p>`
        : '<div class="empty">No contact has left Awaiting Response yet.</div>'
    }
  </section>

  <section>
    <h2>How long a contact sits before moving on</h2>
    ${
      dwellRows.length
        ? `<table><thead><tr><th>Stage</th><th class="num">Resolved</th><th class="num">Average</th><th class="num">Range</th></tr></thead>
      <tbody>${dwellRowsHtml}</tbody></table>
      <p class="meta" style="margin-top:8px"><b>Every figure here is optimistic, and structurally so.</b> A spell is
      only measurable once the contact has moved on, so anyone still sitting in a stage contributes nothing — and the
      ones still sitting are exactly the slow ones. The range is shown because at these volumes an average of three
      cases is a story, not a statistic. Averages are hidden below three resolved spells rather than printed as though
      they meant something. All time, not the selected window.</p>`
        : '<div class="empty">No contact has moved twice yet, so no spell can be measured.</div>'
    }
  </section>
</main>`,
    })
  );
});

export default app;
