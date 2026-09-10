#!/usr/bin/env node
/*
 * Rebuilds the LOCAL dev database from migrations/*.sql, so local dev is the same shape as production.
 *
 * WHY THIS EXISTS. The local database was never built from the migrations. It accumulated whatever
 * schema the work of the day happened to need, which meant it silently lagged prod: on 2026-08-24 it
 * had neither of migration 0020's stage-history triggers, so a test of trigger-dependent behaviour
 * reported "no stage events" — indistinguishable from working. There was no documented way to get a
 * local database that matched, so the fix each time was to hand-apply the missing bit and move on,
 * which is the habit that produced the drift in the first place.
 *
 *   npm run db:local     delete the local database and rebuild it from all migrations
 *
 * IT ALWAYS REBUILDS FROM EMPTY, and that is not laziness — an incremental "apply what is missing" mode
 * was written first and proved actively destructive. Re-running the files over a populated database
 * fails two ways at once: 0002 renames email_primary to email_work, so a second run errors on a column
 * that no longer exists; and 0005 and 0009 rebuild `contact` via create-copy-DROP-rename, so re-running
 * them drops the table and takes 0020's triggers with it, while 0020 itself then aborts on "table
 * already exists" before it can recreate them. The result was a local database with FEWER objects than
 * before the command ran. Without a d1_migrations ledger locally there is no safe way to know what to
 * skip, so the honest options are "rebuild from empty" or "do nothing", and local data is disposable.
 *
 * That destructive mode was caught only by the verification step at the bottom, which is the argument
 * for having it: the 20 files all reported applied, and the triggers were gone.
 *
 * This deliberately does NOT use `wrangler d1 migrations apply --local`. That command tracks state in a
 * d1_migrations table which local has never had, so it would replay 0001 against whatever is there and
 * fail on the first CREATE TABLE. Applying the files directly, in order, is simpler and honest about
 * what it is doing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(root, "migrations");
const STATE = join(root, ".wrangler", "state", "v3", "d1");
const DB_NAME = "practice-platform-prod"; // the binding's database_name in wrangler.jsonc

/*
 * WRANGLER IS INVOKED THROUGH NODE, NOT THROUGH `node_modules/.bin/wrangler`.
 *
 * That shortcut worked everywhere it was tested and failed on the first Windows machine it met, on
 * 2026-09-04, with all 23 migrations reporting:
 *
 *   FAILED 0001_initial_schema.sql
 *   spawnSync C:\Users\...\node_modules\.bin\wrangler ENOENT
 *
 * ENOENT reads as "the file is missing" and the file was present. On Windows, npm writes THREE launchers
 * into `.bin`: `wrangler.cmd` for cmd.exe, `wrangler.ps1` for PowerShell, and an extensionless `wrangler`
 * which is a Bash script for Git Bash. `execFileSync` goes straight to CreateProcess with no shell, and
 * CreateProcess cannot run an extensionless shell script — so it reports the executable as not found.
 *
 * The fix avoids the launcher question entirely by running wrangler's own entrypoint with the Node binary
 * already executing this script. `process.execPath` is the interpreter, `bin/wrangler.js` is what every
 * one of those launchers ends up calling anyway, and neither depends on the platform, the shell, or
 * PATHEXT. Deliberately NOT `shell: true`, which would have worked on Windows and introduced quoting
 * hazards on paths containing spaces — of which `C:\Users\...` has plenty.
 */
const wranglerJs = join(root, "node_modules", "wrangler", "bin", "wrangler.js");

function d1(args, { quiet = true } = {}) {
  if (!existsSync(wranglerJs)) {
    console.error(
      `Could not find wrangler at:\n  ${wranglerJs}\n\n` +
        "Run `npm install` in the project folder first. If you already did, check that it finished\n" +
        "without errors — npm 11 blocks postinstall scripts by default, and wrangler needs its own."
    );
    process.exit(1);
  }
  return execFileSync(process.execPath, [wranglerJs, "d1", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function query(sql) {
  const out = d1(["execute", DB_NAME, "--local", "--json", `--command=${sql}`]);
  // wrangler prints a banner before the JSON; take from the first bracket.
  const start = out.indexOf("[");
  return JSON.parse(out.slice(start))[0].results;
}

/*
 * Always start from empty. See the header: an incremental mode is not safe here, and a half-applied
 * local database is the exact condition this script exists to eliminate.
 */
if (existsSync(STATE)) {
  rmSync(STATE, { recursive: true, force: true });
  console.log("Deleted the local D1 state directory — rebuilding from empty.");
} else {
  console.log("No local D1 state found — building from empty.");
}

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();

console.log(`Applying ${files.length} migrations to the LOCAL ${DB_NAME}…`);
let applied = 0;
const failures = [];

for (const file of files) {
  try {
    d1(["execute", DB_NAME, "--local", `--file=${join(MIGRATIONS, file)}`]);
    applied++;
    console.log(`  applied  ${file}`);
  } catch (e) {
    /*
     * On a from-empty build there is no benign failure — every file should apply cleanly. Failures are
     * collected rather than thrown so one bad file does not hide the state of the rest, and the schema
     * check at the bottom decides whether the outcome is usable.
     */
    const msg = String(e.stdout ?? "") + String(e.stderr ?? "") + String(e.message ?? "");
    failures.push({ file, msg: msg.split("\n").filter(Boolean).slice(-3).join(" | ") });
    console.log(`  FAILED   ${file}`);
  }
}

console.log(`\n${applied} applied, ${failures.length} failed.`);
for (const f of failures) console.log(`  ${f.file}: ${f.msg}`);

/*
 * Verify against the generated manifest rather than trusting that the commands ran.
 *
 * The first version of this extraction used /NAME[^[]*\[([^\]]*)\]/ and matched NOTHING, because the
 * declaration reads `EXPECTED_TABLES: readonly string[] = [` — the character class cannot cross the `[`
 * in `string[]`. It then compared an empty expectation against reality and cheerfully reported success:
 * "Local schema matches the migrations: 0 tables, 0 indexes, 0 triggers." A checker that passes when it
 * has parsed nothing is worse than no checker, and it is the same shape of bug as the one this whole
 * script exists to prevent, so it is asserted against below rather than just fixed.
 */
const manifest = readFileSync(join(root, "src", "schemaManifest.ts"), "utf8");
const listOf = (name) => {
  const at = manifest.indexOf(`export const ${name}`);
  if (at === -1) return [];
  const open = manifest.indexOf("[", manifest.indexOf("=", at));
  const close = manifest.indexOf("];", open);
  if (open === -1 || close === -1) return [];
  return [...manifest.slice(open, close).matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};
const expected = {
  table: listOf("EXPECTED_TABLES"),
  index: listOf("EXPECTED_INDEXES"),
  trigger: listOf("EXPECTED_TRIGGERS"),
};

// A parse that finds nothing must fail loudly, not verify an empty expectation.
for (const [kind, names] of Object.entries(expected)) {
  if (names.length === 0) {
    console.error(
      `Could not read EXPECTED_${kind.toUpperCase()}S from src/schemaManifest.ts, so nothing could be verified.\n` +
        "Run: npm run schema:manifest"
    );
    process.exit(1);
  }
}

let rows;
try {
  rows = query(
    "SELECT type, name FROM sqlite_master WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name <> 'd1_migrations'"
  );
} catch (e) {
  console.error("\nCould not read the local schema to verify it:", String(e.message ?? e));
  process.exit(1);
}

const have = new Set(rows.map((r) => `${r.type}:${r.name}`));
const missing = [];
for (const [kind, names] of Object.entries(expected))
  for (const n of names) if (!have.has(`${kind}:${n}`)) missing.push(`${kind} ${n}`);

/*
 * BOTH DIRECTIONS, and the second one was missing until 2026-09-02.
 *
 * The check above only ever asked "is everything the manifest expects present?". With a STALE manifest
 * that always passes: migration 0022 added a table and five indexes, the database had all 15 tables and
 * 26 indexes, and this script printed "Local schema matches the migrations: 14 tables, 21 indexes" as a
 * success. Every expected object was indeed there. It just was not all of them.
 *
 * Worse, it printed the EXPECTED counts, so the number on screen was the stale manifest's own opinion of
 * itself rather than anything measured. Two independent ways to look correct while being wrong, in the
 * one script whose entire job is catching that — the third instance of this shape, after the regex that
 * parsed nothing and the digest's UTC date. /health's Schema panel has always checked both directions;
 * this brings the local build in line with it.
 */
const extra = rows
  .filter((r) => !(expected[r.type] ?? []).includes(r.name))
  .map((r) => `${r.type} ${r.name}`);

const total = Object.values(expected).reduce((a, b) => a + b.length, 0);
if (missing.length) {
  console.error(`\nLOCAL SCHEMA IS INCOMPLETE — ${missing.length} of ${total} objects missing:`);
  for (const m of missing) console.error(`  ${m}`);
  console.error("\nThe migrations themselves may be at fault — this was a build from empty, so nothing should have failed.");
  process.exit(1);
}
if (extra.length) {
  console.error(`\nMANIFEST IS STALE — the database has ${extra.length} object(s) it does not list:`);
  for (const e of extra) console.error(`  ${e}`);
  console.error("\nThis was a build from empty, so the migrations are the truth and the manifest is behind.\nRun: npm run schema:manifest");
  process.exit(1);
}

const counted = rows.reduce((acc, r) => ({ ...acc, [r.type]: (acc[r.type] ?? 0) + 1 }), {});
console.log(
  `\nLocal schema matches the migrations: ${counted.table ?? 0} tables, ${counted.index ?? 0} indexes, ${
    counted.trigger ?? 0
  } triggers.`
);
