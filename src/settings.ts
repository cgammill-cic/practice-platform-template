// Operator preferences — the small choices that belong to the owner rather than to the deployment.
//
// Backed by `app_setting` (migration 0021). Read by name at the point of use; there is no config object,
// no schema and no types, because a general configuration system for two settings would be more machinery
// than the thing it configures. See the migration header for why this is a table and not a column, an
// environment variable, or a constant.

import type { D1Db } from "./types";

export const DIGEST_ENABLED = "digest_enabled";

/** Whether the email importer copies a logged message's plain-text content into the interaction's Summary. */
export const MAIL_BODY_TO_SUMMARY = "mail_body_to_summary";

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

// ---------------------------------------------------------------- per-copy settings (Phase 3a)
//
// Packaging (2026-09-25): one codebase serves every copy, so the things that were CiC's hardcoded
// facts (the firm and app name, the logo, the timezone, the digest hour, the app's own URL) live here.
// Read synchronously through appSettings() everywhere, so the dozens of places that format a date or a
// page title need no plumbing; loadAppSettings() fills the per-isolate cache first, at the top of each
// request (index.ts middleware) and each scheduled run (scheduled()). Defaults are neutral; the owner's
// copy has its CiC values stored as rows.

export interface AppSettings {
  firm: string;
  appName: string;
  shortName: string;
  zone: string;
  digestHour: number;
  origin: string | null;
  /** Version stamps of uploaded images (for cache-busting URLs); null = use the built-in mark. */
  logo: string | null;
  icon: string | null;
}

export const SETTING_KEYS = {
  firm: "brand_firm",
  appName: "brand_app",
  shortName: "brand_short",
  zone: "tz",
  digestHour: "digest_hour",
  origin: "app_origin",
  logo: "brand_logo",
  icon: "brand_icon",
} as const;

export const DEFAULT_SETTINGS: AppSettings = {
  firm: "Your Firm",
  appName: "Practice Platform",
  shortName: "Practice",
  zone: "America/Chicago",
  digestHour: 6,
  origin: null,
  logo: null,
  icon: null,
};

const CACHE_MS = 60_000;
let cached: { at: number; s: AppSettings } | null = null;

/** The current settings (defaults until the first load in this isolate). Never throws. */
export const appSettings = (): AppSettings => cached?.s ?? DEFAULT_SETTINGS;

export function validZone(z: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

export async function loadAppSettings(db: D1Db, force = false): Promise<AppSettings> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.s;
  try {
    const { results } = await db
      .prepare(`SELECT key, value FROM app_setting WHERE key IN (${Object.values(SETTING_KEYS).map(() => "?").join(",")})`)
      .bind(...Object.values(SETTING_KEYS))
      .all<{ key: string; value: string }>();
    const v = new Map(results.map((r) => [r.key, r.value]));
    const text = (k: string, d: string) => (v.get(k) ?? "").trim() || d;
    const zone = text(SETTING_KEYS.zone, DEFAULT_SETTINGS.zone);
    const hour = Number(v.get(SETTING_KEYS.digestHour));
    const s: AppSettings = {
      firm: text(SETTING_KEYS.firm, DEFAULT_SETTINGS.firm),
      appName: text(SETTING_KEYS.appName, DEFAULT_SETTINGS.appName),
      shortName: text(SETTING_KEYS.shortName, DEFAULT_SETTINGS.shortName),
      zone: validZone(zone) ? zone : DEFAULT_SETTINGS.zone,
      digestHour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_SETTINGS.digestHour,
      origin: v.get(SETTING_KEYS.origin)?.trim() || null,
      logo: v.get(SETTING_KEYS.logo)?.trim() || null,
      icon: v.get(SETTING_KEYS.icon)?.trim() || null,
    };
    cached = { at: Date.now(), s };
    return s;
  } catch {
    return appSettings(); // table missing (a copy mid-setup): defaults, never a crash
  }
}

export async function saveTextSetting(db: D1Db, key: string, value: string | null): Promise<void> {
  if (value === null) await db.prepare("DELETE FROM app_setting WHERE key = ?").bind(key).run();
  else
    await db
      .prepare(
        `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
      .bind(key, value)
      .run();
  cached = null;
}

/** "Central" for America/Chicago and the other US zones people say by name; otherwise the city. */
export function zoneLabel(zone: string = appSettings().zone): string {
  const US: Record<string, string> = {
    "America/New_York": "Eastern",
    "America/Chicago": "Central",
    "America/Denver": "Mountain",
    "America/Phoenix": "Arizona",
    "America/Los_Angeles": "Pacific",
    "America/Anchorage": "Alaska",
    "Pacific/Honolulu": "Hawaii",
  };
  return US[zone] ?? `${zone.split("/").pop()!.replace(/_/g, " ")} time`;
}
