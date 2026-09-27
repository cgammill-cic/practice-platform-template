#!/usr/bin/env node
/*
 * Generates src/migrationsBundle.ts: every migration, split into its statements, compiled into the Worker
 * (Phase 3b, 2026-09-25).
 *
 * WHY. A copy that is updated by GitHub "Sync fork" gets new code deployed automatically, but a merge or a
 * sync cannot touch D1, and customers aren't expected to run Wrangler. So the Worker carries its own
 * migrations and applies the pending ones itself, from an admin button (src/migrate.ts). A Worker has no
 * filesystem, so, like schemaManifest.ts, the migrations have to be compiled in.
 *
 * WHY SPLIT HERE, NOT AT RUNTIME. D1's batch() takes one statement per entry and runs the batch as one
 * transaction, which is exactly the unit a migration should be. Splitting a SQL file correctly means
 * honouring quoted strings, comments, and CREATE TRIGGER ... BEGIN ... END bodies (whose inner
 * statements end in semicolons too, and may contain CASE ... END). Doing it once, at build time, keeps
 * that code out of production and strips the comments (most of each file) from the shipped bundle.
 *
 *   npm run migrations:bundle     regenerate after adding a migration
 *   npm run migrations:check      fail if the committed bundle is stale (part of npm run check)
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(root, "migrations");
const OUT = join(root, "src", "migrationsBundle.ts");

/** Split a SQL script into statements, without comments. Exported for the tests. */
export function splitSql(sql) {
  const out = [];
  let cur = "";
  let i = 0;
  let word = "";
  let depth = 0; // BEGIN/CASE vs END, only counted inside CREATE TRIGGER
  let inTrigger = false;
  let sawBegin = false;
  const flushWord = () => {
    if (!word) return;
    const w = word.toUpperCase();
    if (!inTrigger && /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER$/i.test(cur.trim())) inTrigger = true;
    if (inTrigger) {
      if (w === "BEGIN") { depth++; sawBegin = true; }
      else if (w === "CASE") depth++;
      else if (w === "END") depth--;
    }
    word = "";
  };
  while (i < sql.length) {
    const ch = sql[i], next = sql[i + 1];
    if (ch === "-" && next === "-") { flushWord(); while (i < sql.length && sql[i] !== "\n") i++; cur += " "; continue; }
    if (ch === "/" && next === "*") { flushWord(); const e = sql.indexOf("*/", i + 2); i = e < 0 ? sql.length : e + 2; cur += " "; continue; }
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      flushWord();
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) { if (close !== "]" && sql[j + 1] === close) { j += 2; continue; } break; }
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z0-9_]/.test(ch)) { word += ch; cur += ch; i++; continue; }
    flushWord();
    if (ch === ";" && (!inTrigger || (sawBegin && depth <= 0))) {
      const s = cur.replace(/\s+/g, " ").trim();
      if (s) out.push(s);
      cur = ""; inTrigger = false; sawBegin = false; depth = 0; i++;
      continue;
    }
    cur += ch;
    i++;
  }
  flushWord();
  const tail = cur.replace(/\s+/g, " ").trim();
  if (tail) out.push(tail);
  return out;
}

function generate() {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const entries = files.map((f) => ({ name: f, statements: splitSql(readFileSync(join(MIGRATIONS, f), "utf8")) }));
  return `// GENERATED FILE — do not edit by hand. Run \`npm run migrations:bundle\` after adding a migration.
//
// Every migration in migrations/, split into statements with comments removed, in file order. The app
// applies pending ones itself (src/migrate.ts) so an updated copy never needs a terminal. The names are
// the migration file names, which is what D1's own d1_migrations ledger records, so Wrangler and the app
// agree on what has been applied.
//
// Generated from ${files.length} migration files, ${files[0]} … ${files[files.length - 1]}.

export interface BundledMigration {
  name: string;
  statements: readonly string[];
}

export const MIGRATIONS: readonly BundledMigration[] = ${JSON.stringify(entries, null, 1)};
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = generate();
  if (process.argv.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== text) {
      console.error("src/migrationsBundle.ts is stale. Run: npm run migrations:bundle");
      process.exit(1);
    }
    console.log("migrationsBundle.ts is current.");
  } else {
    writeFileSync(OUT, text);
    console.log(`Wrote src/migrationsBundle.ts from ${text.match(/"name":/g).length} migrations.`);
  }
}
