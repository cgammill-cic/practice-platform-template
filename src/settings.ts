// Operator preferences — the small choices that belong to the person running this instance rather than
// to the deployment itself.
//
// Backed by `app_setting` (migration 0021). Read by name at the point of use; there is no config object,
// no schema and no types, because a general configuration system for two settings would be more machinery
// than the thing it configures. See the migration header for why this is a table and not a column, an
// environment variable, or a constant.

import type { D1Db } from "./types";

export const DIGEST_ENABLED = "digest_enabled";

/**
 * A setting is ON only when its value is exactly "1".
 *
 * FAILING CLOSED IS THE POINT. A missing row, an empty string, a half-written value, a table that does
 * not exist yet because a migration has not been applied — all of them read as off. The failure mode of
 * this switch is the app going quiet, never the app sending mail on a preference nobody set. That
 * asymmetry is deliberate: an unwanted email arrives in someone's inbox and cannot be recalled, whereas a
 * missing one is visible on /health, which reports when the digest last ran and why it did not.
 */
export async function isOn(db: D1Db, key: string): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT value FROM app_setting WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value === "1";
  } catch {
    return false;
  }
}

/** Upsert, so the first write does not need the row to exist. */
export async function setSetting(db: D1Db, key: string, on: boolean): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .bind(key, on ? "1" : "0")
    .run();
}
