/*
 * REL-022 — stage vocabulary drift detection.
 *
 * Why this exists: on 2026-07-31, REL-020 (#40) added follow_up_action to STAGES in types.ts without a
 * migration adding it to the contact.stage CHECK constraint. Every write of the new value was rejected
 * by SQLite and surfaced as an Internal Server Error. Nothing in the system noticed. The operator found
 * it by clicking a button, which is the wrong way to learn that a deploy is broken.
 *
 * Two directions of drift matter, and they fail differently:
 *
 *   1. In code but not in the constraint — the stage appears in every dropdown, and selecting it throws
 *      a 500. Loud, but only once someone tries it.
 *   2. In the data but not in code — far worse and completely silent. Every dashboard section matches
 *      literal stage strings and Needs Attention matches an explicit list, so a contact holding an
 *      unrecognized stage appears in NO section. Invisible, with nothing about the record looking wrong.
 *
 * Both are checked here, on /health and as a dashboard banner, so a mismatch announces itself.
 *
 * GENERALISED to any (table, column) pair carrying a CHECK constraint, and immediately used for a second
 * one: time_entry.activity. That was not a speculative refactor — the day migration 0012 added the
 * activity constraint, a live Outlook calendar was found to be using `Business Development` where the
 * agreed standard said `Business development`, which is this exact class of mismatch in a new column.
 * Migration 0013 fixed the values; this makes the column self-checking, so the next disagreement
 * announces itself here instead of surfacing as a failed save.
 */

import { STAGES, type D1Db } from "./types";

export interface VocabularyStatus {
  state: "ok" | "warn" | "error";
  message: string;
  /** Values the code offers that the database constraint would reject. */
  missingFromConstraint: string[];
  /** Values present in the table's rows that the code does not recognize. */
  unknownInData: string[];
  /** False when the column carries no CHECK constraint at all. */
  constrained: boolean;
}

/** What a particular column's vocabulary is, and what goes wrong when it drifts in each direction. */
interface ColumnSpec {
  table: string;
  column: string;
  /** The values the code offers. */
  values: readonly string[];
  /** Singular noun for messages, e.g. "stage". */
  noun: string;
  /** Plural, given explicitly — appending "s" produced "activitys". */
  plural: string;
  /** What happens when the DATA holds a value the code does not know. Completes "…because ". */
  unknownConsequence: string;
  /** What happens when the CODE offers a value the constraint rejects. Completes "…because ". */
  rejectedConsequence: string;
  /** What an absent constraint costs. */
  unconstrainedConsequence: string;
}

/**
 * Reads the live CHECK constraint out of the schema and compares it to the code's list, then checks the
 * data for values the code cannot render.
 *
 * The constraint is matched as a quoted literal (`'value'`) inside the CHECK clause rather than by parsing
 * SQL properly — deliberately crude, but it cannot produce a false pass: a value genuinely present in the
 * constraint always appears quoted in the DDL. Note the corollary, which is why the clause is isolated per
 * column: matching against the whole DDL would let a value quoted in some OTHER column's constraint mask a
 * real gap.
 */
async function checkColumn(db: D1Db, spec: ColumnSpec): Promise<VocabularyStatus> {
  const known: string[] = [...spec.values];
  const { table, column, noun } = spec;
  try {
    const row = await db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .bind(table)
      .first<{ sql: string }>();
    const ddl = row?.sql ?? "";
    if (!ddl) {
      return {
        state: "error",
        message: `Could not read the ${table} table definition, so the ${noun} vocabulary is unverified.`,
        missingFromConstraint: [],
        unknownInData: [],
        constrained: false,
      };
    }

    const checkMatch = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, "i").exec(ddl);
    const constrained = checkMatch !== null;
    const clause = checkMatch?.[1] ?? "";
    const missingFromConstraint = constrained ? known.filter((s) => !clause.includes(`'${s}'`)) : [];

    const { results } = await db
      .prepare(`SELECT DISTINCT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`)
      .all<{ v: string }>();
    const unknownInData = results.map((r) => r.v).filter((s) => !known.includes(s));

    if (unknownInData.length)
      return {
        state: "error",
        message: `${unknownInData.length} ${table}.${column} value${unknownInData.length === 1 ? "" : "s"} not recognized by the app (${unknownInData.join(", ")}), ${spec.unknownConsequence}`,
        missingFromConstraint,
        unknownInData,
        constrained,
      };

    if (missingFromConstraint.length)
      return {
        state: "warn",
        message: `${missingFromConstraint.length} ${missingFromConstraint.length === 1 ? noun : spec.plural} offered by the app but rejected by the database (${missingFromConstraint.join(", ")}), ${spec.rejectedConsequence} A migration is needed to add ${missingFromConstraint.length === 1 ? "it" : "them"} to the ${table}.${column} CHECK constraint.`,
        missingFromConstraint,
        unknownInData,
        constrained,
      };

    if (!constrained)
      return {
        state: "warn",
        message: `${table}.${column} has no CHECK constraint, ${spec.unconstrainedConsequence} Validation is app-level only.`,
        missingFromConstraint,
        unknownInData,
        constrained,
      };

    return {
      state: "ok",
      message: `All ${known.length} ${spec.plural} match the database constraint, and no unrecognized values are in the data.`,
      missingFromConstraint,
      unknownInData,
      constrained,
    };
  } catch (e) {
    return {
      state: "error",
      message: `${noun} vocabulary check failed: ${String(e)}`,
      missingFromConstraint: [],
      unknownInData: [],
      constrained: false,
    };
  }
}

/** contact.stage — the original check (REL-022). Signature unchanged, so its callers are untouched. */
export async function vocabularyStatus(db: D1Db): Promise<VocabularyStatus> {
  return checkColumn(db, {
    table: "contact",
    column: "stage",
    values: STAGES.map(([v]) => v),
    noun: "stage",
    plural: "stages",
    unknownConsequence:
      "so contacts holding those appear in no dashboard section — they are invisible. Fix the data or add the value to STAGES.",
    rejectedConsequence: "so selecting one will fail.",
    unconstrainedConsequence:
      "so a bad stage value would be accepted silently and the contact would appear in no dashboard section.",
  });
}

/**
 * time_entry.activity — a real table since migration 0026, not a CHECK constraint (was migration 0013).
 *
 * THIS USED TO BE THE SAME checkColumn() MACHINERY AS THE STAGE CHECK ABOVE, comparing a hardcoded
 * TypeScript list against a CHECK constraint parsed out of the table DDL. That drift — code offers a
 * value the database rejects — is exactly what 0026 made structurally impossible: the `activity` table IS
 * the list of what the app offers, and it is also what the foreign key enforces, so there is no longer a
 * second source of truth that could disagree with the first. There is only one direction of drift left
 * to check: a time_entry row whose activity does not match anything in the activity table at all, which
 * the foreign key should make impossible for anything written through this app, but is worth checking for
 * — a hand-edited database, or a row from before 0026 backfilled it, would not otherwise announce itself.
 */
export interface ActivityStatus {
  state: "ok" | "error";
  message: string;
  /** time_entry.activity values with no matching row in the activity table. Should always be empty. */
  unknownInData: string[];
}

export async function activityStatus(db: D1Db): Promise<ActivityStatus> {
  try {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT t.activity AS v FROM time_entry t
           LEFT JOIN activity a ON a.name = t.activity
          WHERE t.activity IS NOT NULL AND a.name IS NULL`
      )
      .all<{ v: string }>();
    const unknownInData = results.map((r) => r.v);
    if (unknownInData.length)
      return {
        state: "error",
        message: `${unknownInData.length} time_entry.activity value${unknownInData.length === 1 ? "" : "s"} match no row in the activity table (${unknownInData.join(", ")}) — those hours appear on the weekly report under a name the Activities page does not offer, and cannot be picked again on that record without first adding it back.`,
        unknownInData,
      };
    return {
      state: "ok",
      message: "Every logged activity matches a row in the activity table.",
      unknownInData: [],
    };
  } catch (e) {
    return { state: "error", message: `activity vocabulary check failed: ${String(e)}`, unknownInData: [] };
  }
}
