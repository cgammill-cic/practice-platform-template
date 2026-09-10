#!/usr/bin/env node
/*
 * Generates src/schemaManifest.ts from migrations/*.sql.
 *
 * WHY THIS EXISTS. On 2026-08-24 the local dev database had none of the stage-history triggers that
 * migration 0020 creates. The migration file was correct and committed; it had simply never been run
 * against the local database, which had been built up ad hoc. A test of trigger-dependent behaviour
 * therefore showed zero stage events, and "zero events" reads exactly like "working" if you are not
 * looking for it. That is the failure mode worth engineering against: not a wrong answer, an absent one.
 *
 * WHY GENERATED RATHER THAN HAND-WRITTEN. A hand-maintained list of expected tables and triggers is a
 * second source of truth that drifts from the migrations the moment someone adds one and forgets. This
 * derives the list from the migrations themselves, so the only way to change it is to change a
 * migration. The generated file is committed because a Worker has no filesystem and cannot read
 * migrations/ at runtime — the manifest has to be compiled in.
 *
 * Run it after adding a migration:   npm run schema:manifest
 * Check it in CI or by hand:         npm run schema:check   (fails if the committed file is stale)
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(root, "migrations");
const OUT = join(root, "src", "schemaManifest.ts");

/*
 * Replays the migrations in file order and reports what exists at the end. Three SQLite behaviours have
 * to be modelled or the answer is wrong, and each of them bit this script while it was being written:
 *
 *  1. DROP TABLE TAKES ITS INDEXES AND TRIGGERS WITH IT, implicitly. A scan that only honours explicit
 *     DROP INDEX over-reports. This is not hypothetical: 0002 created indexes on both email columns,
 *     0005 rebuilt `contact` and recreated only `email_work`, so `idx_contact_email_personal` has not
 *     existed since — and the first version of this script wrongly listed it as expected. Attachment is
 *     therefore tracked per object.
 *  2. RENAME KEEPS THEM, re-pointing them at the new name. 0005 and 0009 rebuild via
 *     create-copy-drop-rename, so the drop and the rename must be applied in that order to land right.
 *  3. Indexes are created on the NEW table name (`contact`) after the rename, not on `contact_new`, so
 *     attachment is read from the CREATE INDEX statement's own ON clause rather than guessed.
 */
function collect() {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  /** kind -> Set<name> */
  const live = { table: new Set(), index: new Set(), trigger: new Set() };
  /** "index:name" | "trigger:name" -> the table it hangs off */
  const attachedTo = new Map();
  const provenance = new Map(); // "kind:name" -> migration file that last created it

  const strip = (s) => s.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

  /** Remove a table and everything SQLite would remove with it. */
  const dropTable = (name) => {
    live.table.delete(name);
    provenance.delete(`table:${name}`);
    for (const [key, table] of [...attachedTo]) {
      if (table !== name) continue;
      const [kind, obj] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      live[kind].delete(obj);
      provenance.delete(key);
      attachedTo.delete(key);
    }
  };

  for (const file of files) {
    const sql = strip(readFileSync(join(MIGRATIONS, file), "utf8"));

    /*
     * Statement order matters — a file that drops a table and then recreates an index on its
     * replacement must be replayed in the order written, not grouped by statement type. So the
     * statements are walked once, in position order.
     */
    const events = [];
    const push = (re, fn) => {
      for (const m of sql.matchAll(re)) events.push({ at: m.index, run: () => fn(m) });
    };

    push(
      /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi,
      (m) => {
        live.table.add(m[1]);
        provenance.set(`table:${m[1]}`, file);
      }
    );
    push(
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s+ON\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi,
      (m) => {
        live.index.add(m[1]);
        attachedTo.set(`index:${m[1]}`, m[2]);
        provenance.set(`index:${m[1]}`, file);
      }
    );
    push(
      /\bCREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?[\s\S]{0,200}?\sON\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi,
      (m) => {
        live.trigger.add(m[1]);
        attachedTo.set(`trigger:${m[1]}`, m[2]);
        provenance.set(`trigger:${m[1]}`, file);
      }
    );
    push(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi, (m) =>
      dropTable(m[1])
    );
    push(/\bDROP\s+(INDEX|TRIGGER)\s+(?:IF\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi, (m) => {
      const kind = m[1].toLowerCase();
      live[kind].delete(m[2]);
      provenance.delete(`${kind}:${m[2]}`);
      attachedTo.delete(`${kind}:${m[2]}`);
    });
    push(
      /\bALTER\s+TABLE\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s+RENAME\s+TO\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi,
      (m) => {
        if (!live.table.delete(m[1])) return;
        live.table.add(m[2]);
        provenance.set(`table:${m[2]}`, provenance.get(`table:${m[1]}`) ?? file);
        provenance.delete(`table:${m[1]}`);
        // Indexes and triggers survive a rename, re-pointed at the new name.
        for (const [key, table] of [...attachedTo]) if (table === m[1]) attachedTo.set(key, m[2]);
      }
    );

    for (const e of events.sort((a, b) => a.at - b.at)) e.run();
  }

  return { files, live, provenance };
}

const { files, live, provenance } = collect();

const sorted = (set) => [...set].sort();
const list = (set) => sorted(set).map((n) => `  "${n}",`).join("\n");

const body = `// GENERATED FILE — do not edit by hand. Run \`npm run schema:manifest\` after adding a migration.
//
// The schema objects that migrations/*.sql say should exist, derived from those files in order, with
// drops and renames honoured (0005 and 0013 rebuild tables, so a naive CREATE scan would be wrong).
// /health compares this against the live database's sqlite_master and reports anything missing.
//
// This exists because on 2026-08-24 the local dev database had none of migration 0020's stage-history
// triggers — the file was committed and correct, it had just never been run there. Trigger-dependent
// behaviour then tested as "no events", which is indistinguishable from "working" unless something is
// checking. A Worker cannot read migrations/ at runtime, so the expectation has to be compiled in.
//
// Generated from ${files.length} migration files, ${files[0]} … ${files[files.length - 1]}.

export const EXPECTED_TABLES: readonly string[] = [
${list(live.table)}
];

export const EXPECTED_INDEXES: readonly string[] = [
${list(live.index)}
];

/**
 * Triggers are the reason this file exists. They are invisible in every screen, they are not exercised
 * by reading data, and their absence looks like a quiet success rather than a failure.
 */
export const EXPECTED_TRIGGERS: readonly string[] = [
${list(live.trigger)}
];

/** How many migration files this was generated from, for the health page to quote. */
export const MIGRATION_COUNT = ${files.length};

/** Which migration last created each object, for the health page to name in its remedy. */
export const OBJECT_SOURCE: Readonly<Record<string, string>> = {
${[...provenance.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `  "${k}": "${v}",`)
  .join("\n")}
};
`;

const mode = process.argv[2];
if (mode === "--check") {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    /* missing counts as stale */
  }
  if (current !== body) {
    console.error(
      "src/schemaManifest.ts is stale. A migration was added or changed without regenerating it.\n" +
        "Run: npm run schema:manifest"
    );
    process.exit(1);
  }
  console.log(
    `schemaManifest.ts is current — ${live.table.size} tables, ${live.index.size} indexes, ${live.trigger.size} triggers from ${files.length} migrations.`
  );
} else {
  writeFileSync(OUT, body);
  console.log(
    `Wrote src/schemaManifest.ts — ${live.table.size} tables, ${live.index.size} indexes, ${live.trigger.size} triggers from ${files.length} migrations.`
  );
  console.log(`  triggers: ${sorted(live.trigger).join(", ") || "(none)"}`);
}
