/*
 * REL-023 — the health page.
 *
 * /health used to return raw JSON. Two problems: it had no header, so there was no way back to the
 * dashboard except the browser button, and it read like a log line rather than an answer —
 * `{"app":"ok","db":"ok",...}` states without saying what the state implies.
 *
 * So the page now answers three questions per check: what is this, is it fine, and what do I do if it
 * is not. The JSON survives at /health.json for uptime monitors and for scripted checks.
 */

import { Hono } from "hono";
import { loadActivities } from "./activities";
import { attemptDrift } from "./attempts";
import { backupStatus, runBackup, recordBackupFailure } from "./backup";
import { msConfigured, msConnection, msPanel } from "./msgraph";
import { lastDigest, localStamp } from "./digest";
import { DIGEST_ENABLED, isOn } from "./settings";
import { activityStatus, vocabularyStatus } from "./vocabulary";
import { esc, layout } from "./views";
import {
  EXPECTED_INDEXES,
  EXPECTED_TABLES,
  EXPECTED_TRIGGERS,
  MIGRATION_COUNT,
  OBJECT_SOURCE,
} from "./schemaManifest";
import { STAGES, type Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

type State = "ok" | "warn" | "error" | "none";

interface Check {
  name: string;
  /** One line explaining what this check is for, in plain language. */
  what: string;
  state: State;
  detail: string;
  /** Only shown when the state is not ok — what to actually do about it. */
  action?: string;
}

async function gather(env: Bindings): Promise<Check[]> {
  const checks: Check[] = [];

  checks.push({
    name: "Application",
    what: "The app itself is running and responding to requests.",
    state: "ok",
    detail: "Responding normally — you are reading a page it generated.",
  });

  let dbState: State = "error";
  let dbDetail = "Could not reach the database.";
  let counts = "";
  try {
    const row = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM contact) AS contacts, (SELECT COUNT(*) FROM interaction) AS interactions, (SELECT COUNT(*) FROM organization) AS orgs"
    ).first<{ contacts: number; interactions: number; orgs: number }>();
    if (row) {
      dbState = "ok";
      counts = `${row.contacts} contacts · ${row.interactions} interactions · ${row.orgs} organizations`;
      dbDetail = `Reachable and holding ${counts}.`;
    }
  } catch (e) {
    dbDetail = `Could not reach the database: ${String(e)}`;
  }
  checks.push({
    name: "Database",
    what: "Where every contact, interaction and organization is stored.",
    state: dbState,
    detail: dbDetail,
    action: dbState === "ok" ? undefined : "Nothing you can fix from here — this needs looking at directly. Do not enter new data until it clears.",
  });

  const b = await backupStatus(env.DB).catch(() => null);
  checks.push({
    name: "Backups",
    what: "A full copy of everything is written to storage each morning, and kept so any day can be restored.",
    state: (b?.state as State) ?? "error",
    detail: b?.message ?? "Backup status unavailable.",
    action:
      !b || b.state === "ok"
        ? undefined
        : b.state === "none"
          ? "No backup has run yet. Use Run Backup Now below."
          : "The last backup did not succeed. Run one now — if it fails again, stop entering data until it is resolved.",
  });

  const v = await vocabularyStatus(env.DB).catch(() => null);
  checks.push({
    name: "Relationship stages",
    what: `The ${STAGES.length} stages the app offers must match the list the database will accept, and no contact may hold a stage the app does not recognize.`,
    state: (v?.state as State) ?? "error",
    detail: v?.message ?? "Stage check unavailable.",
    action:
      !v || v.state === "ok"
        ? undefined
        : v.unknownInData.length
          ? `Urgent: ${v.unknownInData.join(", ")} ${v.unknownInData.length === 1 ? "is" : "are"} in your data but unknown to the app, so those contacts appear in no dashboard section at all. They are invisible until the value is corrected.`
          : `The app offers ${v.missingFromConstraint.join(", ")} but the database will reject it, so choosing that stage will fail with an error. A database migration is needed.`,
  });

  /*
   * #82. The chase list said "no attempt recorded" for a contact emailed that morning, because the
   * stored ladder columns and the count on the same row came from two different definitions. Both now
   * come from attempts.ts — this check is what notices if they ever separate again, rather than waiting
   * for the operator to spot a row contradicting itself. Same argument as the stage vocabulary check above:
   * silent disagreement between two sources of truth is the failure worth engineering against.
   */
  const a = await attemptDrift(env.DB).catch(() => null);
  checks.push({
    name: "Outreach attempts",
    what: "Every email, LinkedIn message, text or call you record should count on the escalation ladder, whichever form recorded it.",
    state: (a?.state as State) ?? "error",
    detail: a?.message ?? "Attempt check unavailable.",
    action:
      !a || a.state === "ok"
        ? undefined
        : `The chase list is understating contact for ${a.behind.length} ${a.behind.length === 1 ? "person" : "people"}, so someone you have already reached out to can appear as never contacted. Recording another attempt on the affected contact corrects that row; a wider gap means a backfill is needed (see migration 0010).`,
  });

  /*
   * time_entry.activity, since migration 0026 a real table rather than a CHECK constraint — see
   * vocabulary.ts's activityStatus() for why this is now a narrower check than the stage one above. Kept
   * as its own row rather than folded into the stage check: this one has money behind it — Client
   * Delivery hours feed invoicing — even though the drift class it originally caught (0013) can no
   * longer happen by construction.
   */
  const act = await activityStatus(env.DB).catch(() => null);
  const activityCount = await loadActivities(env.DB)
    .then((rows) => rows.length)
    .catch(() => null);
  checks.push({
    name: "Time activity categories",
    what: `The activity categories on /activities must match the Outlook categories on your calendar, because Client Delivery hours become invoices.${activityCount ? ` ${activityCount} exist today.` : ""}`,
    state: (act?.state as State) ?? "error",
    detail: act?.message ?? "Activity check unavailable.",
    action:
      !act || act.state === "ok"
        ? undefined
        : `${act.unknownInData.join(", ")} ${act.unknownInData.length === 1 ? "is" : "are"} in the time data but ${act.unknownInData.length === 1 ? "matches" : "match"} no row in the activity table. Add ${act.unknownInData.length === 1 ? "it" : "them"} back on /activities, or reconcile the data by hand.`,
  });

  /*
   * The Outlook connection as a CHECK, not only as the panel further down the page. The panel is where you
   * act on it; this row is what makes a dead connection count towards the page's overall verdict at the top,
   * the same as a stale backup. A connection that has quietly stopped working is exactly the failure this
   * page exists to surface — and here it costs a weekly import that never mentions being empty.
   *
   * "Not configured" is `none`, not an error: a deployment with no Microsoft credentials is a valid state,
   * and for PKG-001 it is the state every new instance starts in.
   */
  const conn = await msConnection(env.DB).catch(() => null);
  checks.push({
    // Named "connection" rather than "calendar" so it does not read as a duplicate of the Outlook Calendar
    // panel below, which differed from it only by a capital letter. Same split as Backups (the check) and
    // Backup (the section with the button): one reports, the other is where you act.
    name: "Outlook connection",
    what: "A read-only link to your calendar, so a week of events can be turned into time entries.",
    state: !msConfigured(env) ? "none" : !conn ? "none" : conn.last_error ? "error" : "ok",
    detail: !msConfigured(env)
      ? "Not configured on this deployment — the three Microsoft secrets are not set."
      : !conn
        ? "Configured but not connected. Connect it in the panel below."
        : conn.last_error
          ? conn.last_error
          : `Connected as ${conn.account_upn}${conn.last_used_at ? `, last used ${conn.last_used_at}` : ""}.`,
    action:
      !msConfigured(env) || !conn
        ? undefined
        : conn.last_error
          ? "The import cannot read your calendar until this is fixed. Reconnect in the panel below — signing in again is the fix for almost every cause."
          : undefined,
  });

  /*
   * CAN A CONTACT STILL BE DELETED? (REL-031.)
   *
   * This check exists because of a specific self-inflicted outage. Migration 0020 added
   * contact_stage_event with an AFTER INSERT trigger, so every contact gained a child row, and the
   * delete path in contactList.ts was never told about the new table. contact_id is NOT NULL with no
   * ON DELETE CASCADE, so the DELETE aborted on a foreign key violation and the route 500'd —
   * nearly every contact in the database was undeletable, for two days, with nothing anywhere
   * reporting it. Auditing the rest of the schema then turned up time_entry.contact_id in the same
   * state.
   *
   * The lesson is not "remember contact_stage_event", it is that adding a table that references
   * contact(id) silently breaks deletion and no test covered it. So this reads the live schema and
   * compares it against the list the delete path actually handles. A new table shows up here as a
   * warning the day it is created, instead of as a 500 the next time someone removes a bad row.
   *
   * HANDLED must stay in step with the delete path in contactList.ts. Each entry names how:
   *   interaction                        blocks deletion outright
   *   action_item                        open ones block; completed ones are deleted and audited
   *   contact_tag                        deleted
   *   contact (referral_source_...)      set to NULL
   *   contact_stage_event                deleted and audited
   *   time_entry                         contact_id set to NULL, hours kept
   *   engagement (origin_contact_id)     set to NULL
   *   engagement_contact                 deleted and audited
   *   email_import_exclusion             ON DELETE CASCADE — nothing to add to contactList.ts
   *
   * engagement and engagement_contact (0022_pursuit.sql, PURS-001) are the second recurrence of this
   * exact bug: a migration added two more references to contact(id), neither carried ON DELETE CASCADE,
   * and this set was not updated with them. See the matching block in contactList.ts.
   *
   * email_import_exclusion (0024) is the reminder that this query does not read the cascade clause —
   * it only asks "does something reference contact(id)", so a perfectly safe ON DELETE CASCADE table
   * still has to be named here, or this check itself becomes the thing that goes stale. There is
   * nothing to add to contactList.ts for it: SQLite clears the row on its own.
   */
  const HANDLED = new Set([
    "interaction",
    "action_item",
    "contact_tag",
    "contact",
    "contact_stage_event",
    "time_entry",
    "engagement",
    "engagement_contact",
    "email_import_exclusion",
  ]);
  const refs = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table'
       AND (sql LIKE '%REFERENCES contact(%' OR sql LIKE '%REFERENCES "contact"(%')`
  )
    .all<{ name: string }>()
    .catch(() => null);
  const unhandled = (refs?.results ?? []).map((r) => r.name).filter((n) => !HANDLED.has(n));
  checks.push({
    name: "Contact deletion",
    what: "Every table that points at a contact must be handled when a contact is deleted, or the delete fails with a server error.",
    state: !refs ? "error" : unhandled.length ? "error" : "ok",
    detail: !refs
      ? "Could not read the schema, so this could not be checked."
      : unhandled.length
        ? `${unhandled.join(", ")} reference${unhandled.length === 1 ? "s" : ""} contacts but ${unhandled.length === 1 ? "is" : "are"} not handled when a contact is deleted.`
        : `All ${(refs.results ?? []).length} tables referencing a contact are handled.`,
    action: unhandled.length
      ? `Deleting a contact with a row in ${unhandled.join(" or ")} will return a server error. Add the cleanup to the delete path in contactList.ts and to the HANDLED list in health.ts. This is the exact failure of 2026-08-20 (REL-031).`
      : undefined,
  });

  /*
   * SCHEMA DRIFT (2026-08-25). Does this database actually contain what the migrations say it should?
   *
   * WHY IT EARNS A CHECK. On 2026-08-24 the local dev database had neither of migration 0020's
   * stage-history triggers. The migration file was committed and correct — it had simply never been run
   * there, because that database was built up ad hoc rather than from the migrations. Trigger-dependent
   * behaviour then tested as "no stage events", and an absent result reads exactly like a passing one
   * unless something is looking for it. Triggers are the worst case: invisible on every screen, never
   * exercised by reading data, silent when missing.
   *
   * IT GUARDS PRODUCTION TOO, and that is where the risk actually lives. Migrations here are applied BY
   * HAND — the Workers Builds token cannot touch D1, so nothing applies on merge (runbook §migrations).
   * A migration that gets forgotten, or half-applied because one statement failed midway, leaves exactly
   * this signature, and today it would be discovered by whichever feature broke first.
   *
   * The expectation is GENERATED from migrations/*.sql by scripts/schema-manifest.mjs rather than typed
   * here, so it cannot become a second source of truth that drifts from the migrations; a Worker has no
   * filesystem, so it has to be compiled in. Missing is an error. Extra is a warning, not an error — an
   * object created outside a migration is untidy and will be absent from any rebuilt database, but
   * nothing is broken right now.
   */
  const live = await env.DB.prepare(
    `SELECT type, name FROM sqlite_master
      WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_cf%' AND name <> 'd1_migrations'`
  )
    .all<{ type: string; name: string }>()
    .catch(() => null);

  if (!live) {
    checks.push({
      name: "Schema",
      what: "The database contains every table, index and trigger the migrations define.",
      state: "error",
      detail: "Could not read the schema, so this could not be checked.",
    });
  } else {
    const expected: [string, readonly string[]][] = [
      ["table", EXPECTED_TABLES],
      ["index", EXPECTED_INDEXES],
      ["trigger", EXPECTED_TRIGGERS],
    ];
    const have = new Map<string, Set<string>>();
    for (const r of live.results ?? []) {
      if (!have.has(r.type)) have.set(r.type, new Set());
      have.get(r.type)!.add(r.name);
    }
    const missing: string[] = [];
    const extra: string[] = [];
    let counted = 0;
    for (const [kind, names] of expected) {
      const present = have.get(kind) ?? new Set<string>();
      counted += names.length;
      for (const n of names) if (!present.has(n)) missing.push(`${kind} ${n}`);
      for (const n of present) if (!names.includes(n)) extra.push(`${kind} ${n}`);
    }
    const sources = [
      ...new Set(missing.map((m) => OBJECT_SOURCE[m.replace(" ", ":")]).filter(Boolean)),
    ].sort();
    // Missing triggers get named separately in the remedy, because they are the case that fails quietly.
    const missingTriggers = missing.filter((m) => m.startsWith("trigger "));
    checks.push({
      name: "Schema",
      what: "The database holds every table, index and trigger the migrations define. A missing trigger causes no error — it just silently stops recording.",
      state: missing.length ? "error" : extra.length ? "warn" : "ok",
      detail: missing.length
        ? `Missing ${missing.length} object${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`
        : extra.length
          ? `All ${counted} expected objects present. Also present but defined in no migration: ${extra.join(", ")}.`
          : `All ${counted} objects the ${MIGRATION_COUNT} migrations define are present — ${EXPECTED_TABLES.length} tables, ${EXPECTED_INDEXES.length} indexes, ${EXPECTED_TRIGGERS.length} triggers.`,
      action: missing.length
        ? `A migration has not been applied to this database, or failed partway. Apply ${
            sources.length ? sources.join(" and ") : "the migration that defines them"
          }, then add the row to d1_migrations in the same sitting.${
            missingTriggers.length
              ? ` ${missingTriggers.length === 1 ? "One of these is a trigger" : "Some of these are triggers"}, so nothing will throw an error — stage history simply will not be recorded, and /pipeline will quietly under-report.`
              : ""
          }`
        : extra.length
          ? "Something was created outside a migration. Fold it into one so a rebuilt database has it too, or drop it."
          : undefined,
    });
  }

  return checks;
}

/*
 * The digest panel and its switch (DIGEST-001).
 *
 * IT LIVES ON /health RATHER THAN THE DASHBOARD because it is operational configuration, and because the
 * digest itself links here to turn it off — the footer of every email points at this page, so the control
 * has to be where the email says it is.
 *
 * THE LAST RUN IS REPORTED, ALWAYS. The digest is deliberately silent when nothing is due, which means
 * silence has two possible meanings — nothing was due, or it is broken. Stating the last outcome is what
 * separates them, and without it this feature would be another quiet failure waiting to happen.
 */
async function digestPanel(db: Bindings["DB"], flash: string, outcome: string): Promise<string> {
  const on = await isOn(db, DIGEST_ENABLED).catch(() => false);
  const last = await lastDigest(db);
  const FLASH: Record<string, string> = {
    on: "Daily digest turned on. It arrives on weekdays at about 6am Central, and only when something is due.",
    off: "Daily digest turned off. Nothing will be sent until you turn it back on.",
    test: `Test digest attempted — outcome: ${outcome || "unknown"}.`,
  };
  const OUTCOME_WORD: Record<string, string> = {
    sent: "Sent",
    "nothing-due": "Nothing was due, so nothing was sent",
    off: "Skipped — switched off",
    failed: "Failed",
    skipped: "Skipped",
  };
  return `<section>
    <h2>Daily Digest <span class="pill ${on ? "green" : "grey"}" style="margin-left:6px">${on ? "On" : "Off"}</span></h2>
    ${FLASH[flash] ? `<p class="flash ${flash === "off" ? "warn" : "ok"}">${esc(FLASH[flash])}</p>` : ""}
    <p style="margin:0 0 6px">One email on weekday mornings listing what needs you: meetings today, action items due, overdue follow-ups, and who you are waiting on. Sent from your own Outlook account to yourself.</p>
    <p class="meta" style="margin:0 0 10px"><b>Nothing is sent when nothing is due</b>, so no email means there was nothing — not that it failed. The last run is always reported below, which is how you can tell those apart.</p>
    <dl class="grid2">
      <dt>Last run</dt><dd>${
        last
          ? `${esc(localStamp(last.ts))} — <b>${esc(OUTCOME_WORD[last.outcome] ?? last.outcome)}</b>`
          : '<span class="meta">never run yet</span>'
      }</dd>
      ${last?.detail ? `<dt>Detail</dt><dd class="meta">${esc(last.detail)}</dd>` : ""}
    </dl>
    <div class="actions">
      <form method="post" action="/digest/toggle">
        <input type="hidden" name="on" value="${on ? "0" : "1"}">
        <button class="${on ? "secondary" : ""}" type="submit">${on ? "Turn the digest off" : "Turn the digest on"}</button>
      </form>
      <form method="post" action="/digest/test"><button class="secondary" type="submit">Send one now</button></form>
    </div>
    <p class="meta" style="margin-top:10px">Uses the Outlook connection above and sends only to <b>your own address</b> — there is no path in this app that emails anyone else. Turning it off stops it immediately and the setting survives a reconnect.</p>
  </section>`;
}

const PILL: Record<State, string> = { ok: "green", warn: "amber", error: "red", none: "grey" };
const WORD: Record<State, string> = { ok: "Healthy", warn: "Needs attention", error: "Problem", none: "Not yet run" };

app.get("/health", async (c) => {
  const checks = await gather(c.env);
  const worst: State = checks.some((k) => k.state === "error")
    ? "error"
    : checks.some((k) => k.state === "warn" || k.state === "none")
      ? "warn"
      : "ok";

  const rows = checks
    .map(
      (k) => `<section>
    <h2>${esc(k.name)} <span class="pill ${PILL[k.state]}" style="margin-left:6px">${esc(WORD[k.state])}</span></h2>
    <p style="margin:0 0 6px">${esc(k.detail)}</p>
    <p class="meta" style="margin:0">${esc(k.what)}</p>
    ${k.action ? `<p class="flash warn" style="margin:10px 0 0">${esc(k.action)}</p>` : ""}
  </section>`
    )
    .join("");

  return c.html(
    layout({
      title: "System Health",
      body: `<main>
  <h1>System Health</h1>
  <p class="sub">${
    worst === "ok"
      ? "Everything is working. Nothing needs your attention on this page."
      : worst === "warn"
        ? "Mostly working, but something below wants a look."
        : "Something is wrong. Read the items marked Problem below."
  } · <a href="/">back to dashboard</a></p>
  ${rows}
  ${msPanel(c.env, await msConnection(c.env.DB).catch(() => null), c.req.query("msflash") ?? "", c.req.query("msdetail") ?? "")}
  ${await digestPanel(c.env.DB, c.req.query("digest") ?? "", c.req.query("outcome") ?? "")}
  <section>
    <h2>Backup</h2>
    <p class="meta" style="margin:0 0 12px">Backups run automatically each morning. Run one by hand before anything risky — a bulk import, or a change to how data is stored.</p>
    <form method="post" action="/admin/backup"><button class="secondary" type="submit">Run Backup Now</button></form>
  </section>
  <p class="meta" style="margin-top:14px">
    <a href="/">← Dashboard</a> ·
    <a href="/health.json">raw JSON</a> — the same information in machine-readable form, for uptime monitoring.
  </p>
</main>`,
    })
  );
});

/** Unchanged shape from the original /health, kept so monitors and scripts do not break. */
app.get("/health.json", async (c) => {
  let db = "error";
  try {
    db = (await c.env.DB.prepare("select 1 as ok").first()) ? "ok" : "error";
  } catch {
    // db stays "error"
  }
  const backup = await backupStatus(c.env.DB).catch(() => ({ state: "error", message: "backup status unavailable" }));
  const stages = await vocabularyStatus(c.env.DB);
  // Added after the original shape, so nothing that already reads this JSON is affected (#82). Only the
  // state and the count travel — the names belong on the page, not in a monitor payload.
  const attempts = await attemptDrift(c.env.DB)
    .then((a) => ({ state: a.state, behind: a.behind.length }))
    .catch(() => ({ state: "error", behind: null }));
  // Appended, like `attempts` before it, so nothing already reading this payload is affected (0013).
  const activities = await activityStatus(c.env.DB)
    .then((a) => ({ state: a.state, mismatched: a.unknownInData.length }))
    .catch(() => ({ state: "error", mismatched: null }));
  // Appended again (0016). `connected` is a boolean and the account is NOT included — a monitor needs to
  // know whether the link is alive, not whose mailbox it is.
  const outlook = await msConnection(c.env.DB)
    .then((m) => ({ configured: msConfigured(c.env), connected: Boolean(m), error: m?.last_error ?? null }))
    .catch(() => ({ configured: msConfigured(c.env), connected: false, error: "unavailable" }));
  return c.json({ app: "ok", db, backup, stages, attempts, activities, outlook });
});

app.post("/admin/backup", async (c) => {
  try {
    const result = await runBackup(c.env, "manual");
    return c.json(result, result.status === "ok" ? 200 : 500);
  } catch (e) {
    await recordBackupFailure(c.env, e);
    return c.json({ status: "alert", detail: String(e) }, 500);
  }
});

export default app;
