// The app applies its own database updates (Phase 3b, 2026-09-25).
//
// A customer's copy is updated by GitHub "Sync fork": the new code deploys itself, but nothing can reach
// D1 from a merge, and customers don't run Wrangler. So every migration ships inside the Worker
// (migrationsBundle.ts, generated from migrations/ at build time) and an admin applies the pending ones
// from Health → Database updates. The owner's own copy still applies migrations before merging, which is
// the safer order; this is the path for everyone else, and his fallback.
//
// THE LEDGER IS D1'S OWN. d1_migrations (id, name, applied_at) is the table `wrangler d1 migrations
// apply` writes, so the button and Wrangler always agree on what has run. Created here if missing, with
// Wrangler's exact definition.
//
// ONE MIGRATION = ONE D1 BATCH. batch() runs its statements as a single transaction, and the ledger row
// is the batch's last statement, so a migration is either fully applied and recorded or not at all.
// Migrations run in order and stop at the first failure.
//
// A BACKUP FIRST, always, when the database has any tables; refused if the backup fails. A brand-new
// copy (no tables yet) has nothing to back up.
//
// OUT-OF-STEP GUARD. If the ledger says 0001 hasn't run but the contact table exists, the database was
// built some other way and the ledger can't be trusted: nothing is applied, and Health says so.

import { MIGRATIONS } from "./migrationsBundle";
import { runBackup } from "./backup";
import type { Bindings, D1Db } from "./types";

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

export interface MigrationState {
  pending: string[];
  applied: number;
  /** Tables exist but the ledger doesn't account for them: applying would be unsafe. */
  outOfStep: boolean;
  /** No application tables yet: a brand-new copy. */
  empty: boolean;
}

async function tableExists(db: D1Db, name: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first());
}

export async function migrationState(db: D1Db): Promise<MigrationState> {
  const ledger = await tableExists(db, "d1_migrations");
  const done = new Set<string>();
  if (ledger) {
    const { results } = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
    for (const r of results) done.add(r.name);
  }
  const pending = MIGRATIONS.map((m) => m.name).filter((n) => !done.has(n));
  const empty = !(await tableExists(db, "contact"));
  const outOfStep = !empty && pending.includes(MIGRATIONS[0].name);
  return { pending, applied: done.size, outOfStep, empty };
}

// Per-isolate cache for the admin banner, so every page load isn't two extra queries.
let cached: { at: number; count: number } | null = null;
export const pendingCountCached = () => cached?.count ?? 0;
export async function refreshPendingCount(db: D1Db, force = false): Promise<number> {
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.count;
  try {
    const s = await migrationState(db);
    cached = { at: Date.now(), count: s.outOfStep ? 0 : s.pending.length };
  } catch {
    cached = { at: Date.now(), count: 0 };
  }
  return cached.count;
}

export interface ApplyResult {
  applied: string[];
  error?: { name: string; message: string };
  backup?: string;
  refused?: string;
}

export async function applyPending(env: Bindings): Promise<ApplyResult> {
  const db = env.DB;
  const state = await migrationState(db);
  if (state.outOfStep)
    return { applied: [], refused: "The database has tables that the update log doesn't account for, so nothing was applied. Contact whoever set up this copy." };
  if (!state.pending.length) return { applied: [] };
  let backup: string | undefined;
  if (!state.empty) {
    try {
      const r = (await runBackup(env, "manual")) as { status?: string; detail?: string };
      if (r?.status !== "ok") return { applied: [], refused: `The backup didn't succeed (${r?.detail ?? r?.status ?? "unknown"}), so nothing was applied.` };
      backup = r.detail ?? "ok";
    } catch (e) {
      return { applied: [], refused: `The backup failed (${e instanceof Error ? e.message : String(e)}), so nothing was applied.` };
    }
  }
  await db.prepare(LEDGER_DDL).run();
  const applied: string[] = [];
  for (const name of state.pending) {
    const m = MIGRATIONS.find((x) => x.name === name)!;
    try {
      await db.batch([...m.statements.map((s) => db.prepare(s)), db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name)]);
      applied.push(name);
    } catch (e) {
      cached = null;
      return { applied, backup, error: { name, message: (e instanceof Error ? e.message : String(e)).slice(0, 300) } };
    }
  }
  cached = null;
  return { applied, backup };
}

/** A query failed because the schema is behind the code (a copy synced but not yet updated). */
export const isSchemaBehind = (e: unknown) => /no such (table|column)/i.test(e instanceof Error ? e.message : String(e));
