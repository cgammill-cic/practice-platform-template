// Settings: the per-copy facts that used to be CiC's hardcoded ones (Phase 3a, 2026-09-25).
//
// Admin-only (auth.ts ADMIN_ONLY). Firm and app name, the Home Screen name, the timezone every "today"
// and schedule uses, the digest's hour, the app's own address (for emailed links), and the two images.
// Values are app_setting rows read through settings.ts appSettings(); images live in this copy's own
// R2 bucket under brand/, next to its backups, and never in the code.

import { Hono } from "hono";
import { esc, layout } from "./views";
import type { Bindings } from "./types";
import { actor } from "./auth";
import { SETTING_KEYS, appSettings, loadAppSettings, saveTextSetting, validZone, zoneLabel } from "./settings";

const app = new Hono<{ Bindings: Bindings }>();

const MAX_IMAGE_BYTES = 200 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The zones offered. Any valid IANA zone is accepted if saved another way; this is the common set. */
export const ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Halifax",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
];

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

async function audit(db: Bindings["DB"], what: string, before: string | null, after: string) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source) VALUES (?,'app_setting',?,'update',?,?,'app')"
    )
    .bind(actor(), what, before, after.slice(0, 300))
    .run();
}

const FLASH: Record<string, [string, "ok" | "warn"]> = {
  saved: ["Settings saved.", "ok"],
  welcome: ["Welcome, your copy is ready. Set your firm name, timezone and logo here, then add people on Users and connect Outlook on Health.", "ok"],
  zone: ["That timezone wasn't recognised, so it wasn't changed.", "warn"],
  origin: ["The app address must start with https://.", "warn"],
  img: ["Image saved. It may take a refresh to appear.", "ok"],
  imgbad: ["That file isn't a PNG. Save the image as PNG and try again.", "warn"],
  imgbig: ["That image is over 200 KB. A 320×320 PNG is plenty.", "warn"],
  imgnone: ["No file was chosen.", "warn"],
  imgoff: ["Image removed. The built-in mark is back.", "ok"],
};

app.get("/settings", async (c) => {
  const s = await loadAppSettings(c.env.DB, true);
  const f = FLASH[c.req.query("flash") ?? ""];
  const zoneOptions = (ZONES.includes(s.zone) ? ZONES : [s.zone, ...ZONES])
    .map((z) => `<option value="${esc(z)}"${z === s.zone ? " selected" : ""}>${esc(z.replace(/_/g, " "))} (${esc(zoneLabel(z))})</option>`)
    .join("");
  const hours = Array.from({ length: 24 }, (_, h) => h)
    .map((h) => `<option value="${h}"${h === s.digestHour ? " selected" : ""}>${String(h).padStart(2, "0")}:00</option>`)
    .join("");
  const image = (key: "logo" | "icon", label: string, hint: string, w: number, h: number) => `
    <div class="card" style="margin-top:10px">
      <h3 style="margin-top:0">${label}</h3>
      <p class="meta" style="margin-top:0">${hint}</p>
      <img src="/${key}.png${s[key] ? `?v=${encodeURIComponent(s[key]!)}` : ""}" alt="" width="${w}" height="${h}" style="object-fit:contain;background:var(--surface-2);border-radius:8px;padding:6px">
      <form method="post" action="/settings/image/${key}" enctype="multipart/form-data" style="margin-top:8px">
        <input type="file" name="file" accept="image/png" aria-label="${esc(label)} file">
        <div class="actions"><button type="submit" class="secondary">Upload</button>${
          s[key] ? ` <button type="submit" class="secondary" formaction="/settings/image-remove/${key}">Use the Built-In Mark</button>` : ""
        }</div>
      </form>
    </div>`;

  const body = `<h1>Settings</h1>
  <p class="sub">How this copy of the app presents itself, and whose clock it runs on.</p>
  ${f ? `<div class="flash ${f[1]}">${esc(f[0])}</div>` : ""}
  <form method="post" action="/settings" class="card">
    <label for="st-firm">Firm name <span class="hint">used in the app's description and the digest</span></label>
    <input type="text" id="st-firm" name="firm" value="${esc(s.firm)}" maxlength="80" required>
    <label for="st-app">App name <span class="hint">the menu, page titles, the sign-in page, the digest</span></label>
    <input type="text" id="st-app" name="app_name" value="${esc(s.appName)}" maxlength="60" required>
    <label for="st-short">Home Screen name <span class="hint">under the icon on a phone; about 12 characters</span></label>
    <input type="text" id="st-short" name="short_name" value="${esc(s.shortName)}" maxlength="20" required>
    <label for="st-zone">Timezone <span class="hint">what "today" means everywhere, and when schedules and the digest run</span></label>
    <select id="st-zone" name="zone">${zoneOptions}</select>
    <label for="st-hour">Daily digest hour <span class="hint">weekdays, in the timezone above</span></label>
    <select id="st-hour" name="digest_hour" style="max-width:140px">${hours}</select>
    <label for="st-origin">App address <span class="hint">for links in emailed digests; recorded automatically the first time someone signs in</span></label>
    <input type="url" id="st-origin" name="origin" value="${esc(s.origin ?? "")}" placeholder="https://your-app.workers.dev" maxlength="200">
    <div class="actions"><button type="submit">Save Settings</button></div>
  </form>
  <section>
    <h2>Images</h2>
    ${image("logo", "Logo", "Shown in the menu and on the sign-in page. A PNG with a transparent background, about 200×90, reads best.", 105, 48)}
    ${image("icon", "App icon", "The Home Screen icon. A square PNG with a solid background, 320×320. Without one, the logo is used. Phones cache icons: re-add the Home Screen shortcut to see a change.", 64, 64)}
  </section>`;
  return c.html(layout({ c, title: "Settings", body }));
});

app.post("/settings", async (c) => {
  const f = await c.req.parseBody();
  const db = c.env.DB;
  const before = appSettings();
  const zone = str(f.zone);
  if (zone && !validZone(zone)) return c.redirect("/settings?flash=zone");
  const origin = str(f.origin).replace(/\/+$/, "");
  if (origin && !/^https:\/\/[^\s/]+$/.test(origin)) return c.redirect("/settings?flash=origin");
  const hour = Number(f.digest_hour);
  const changes: [string, string, string | null][] = [
    [SETTING_KEYS.firm, "firm name", str(f.firm).slice(0, 80) || null],
    [SETTING_KEYS.appName, "app name", str(f.app_name).slice(0, 60) || null],
    [SETTING_KEYS.shortName, "Home Screen name", str(f.short_name).slice(0, 20) || null],
    [SETTING_KEYS.zone, "timezone", zone || null],
    [SETTING_KEYS.digestHour, "digest hour", Number.isInteger(hour) && hour >= 0 && hour <= 23 ? String(hour) : null],
    [SETTING_KEYS.origin, "app address", origin || null],
  ];
  const summary: string[] = [];
  for (const [key, label, value] of changes) {
    await saveTextSetting(db, key, value);
    summary.push(`${label}: ${value ?? "(default)"}`);
  }
  await loadAppSettings(db, true);
  await audit(db, "settings", `app ${before.appName}, zone ${before.zone}, digest ${before.digestHour}:00`, summary.join("; "));
  return c.redirect("/settings?flash=saved");
});

app.post("/settings/image/:key{logo|icon}", async (c) => {
  const key = c.req.param("key") as "logo" | "icon";
  const f = await c.req.parseBody();
  const file = f.file;
  if (!(file instanceof File) || file.size === 0) return c.redirect("/settings?flash=imgnone");
  if (file.size > MAX_IMAGE_BYTES) return c.redirect("/settings?flash=imgbig");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return c.redirect("/settings?flash=imgbad");
  await c.env.BACKUPS.put(`brand/${key}.png`, bytes, { httpMetadata: { contentType: "image/png" } });
  const stamp = String(Date.now());
  await saveTextSetting(c.env.DB, SETTING_KEYS[key], stamp);
  await loadAppSettings(c.env.DB, true);
  await audit(c.env.DB, key, null, `${key} uploaded (${Math.round(bytes.length / 1024)} KB)`);
  return c.redirect("/settings?flash=img");
});

app.post("/settings/image-remove/:key{logo|icon}", async (c) => {
  const key = c.req.param("key") as "logo" | "icon";
  // The object stays in the bucket (the app never deletes what an owner uploaded); the setting that
  // points at it is cleared, which is what switches back to the built-in mark.
  await saveTextSetting(c.env.DB, SETTING_KEYS[key], null);
  await loadAppSettings(c.env.DB, true);
  await audit(c.env.DB, key, "custom", "built-in mark");
  return c.redirect("/settings?flash=imgoff");
});

export default app;
