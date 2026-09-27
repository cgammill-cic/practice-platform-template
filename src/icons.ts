/*
 * Brand assets (UX-001, #56; neutral since Phase 3a, 2026-09-25) — the built-in Home Screen icon, the
 * built-in header mark, and the web app manifest.
 *
 * THESE ARE THE DEFAULTS ONLY. Each copy uploads its own logo and icon on Settings (settingsPage.ts);
 * they live in that copy's R2 bucket under brand/ and are served in place of these by the routes in
 * index.ts. The CiC mark that used to live here moved into the owner's own bucket the same way, so this
 * repository (and the template built from it) carries no firm's branding at all. The built-ins are a
 * plain ring: recognisably an app icon, and obviously a placeholder.
 *
 * WHY BASE64 IN A SOURCE FILE. This repository is sometimes pushed through the GitHub API, whose file
 * contents are text, so a binary PNG cannot be committed that way; a base64 constant survives intact.
 * KEEP THIS FILE WELL UNDER 30KB: a 49KB version was once silently truncated mid-base64 by that API
 * (2026-08-05). These two images are about 8KB together.
 */

import type { AppSettings } from "./settings";

/** 320x320, opaque — iOS requires an opaque icon and composites its own rounded mask. */
export const ICON_PNG_BASE64 =
  "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";

/** 176x80, transparent, displayed about 44x20 in the header and 105x48 on the sign-in page. */
export const MARK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAALAAAABQCAYAAAC58//cAAAD9UlEQVR42u2dMY7iMBSGodkmh+ACdHRIOcDcgMZSClpzhOmmpBqJio5qimmyHd" +
  "K0I9HBEahyg1QW7Gr1ZovRIJzEJrH9Fb+0ygT7Jf701n5+zxlpZUYIhSpeAgJghAAYIQBGAIwQACelqVam0MqstTKlVuaklam0MrVW5iKq5dpJ" +
  "7lnLb6a8PwB+tH5pZRZamZ1Aee2oStpaSNu8YwD2orlWZive9OpJtfQx530DsCs9/QVq7xHaW9pL34wBALfSTOar155Vii2MCQBb62UA4H7XC+" +
  "MCwDZe9zBAeL90wBsD8C0VEvK6DlwXsZUxA+D/eu4I1VErs9HKLLUyuVZmopXJtDJjUSbXcrlnI7/p0ucz4wbAI9lUaAPQp1ZmJWC27XsibXy2" +
  "tGENwMDbFJo38aSubcmlbSAGYC/Thg9P4P4E8gfTCQC+t2BrAsiqBxtXDW0sADidUNmlweJs1rOtxwbRiRkAxy/bOO9viR70bW8mttjGiQGYHb" +
  "Z/i6mh2f7Gjl3aAM8aeN6hPoOtJ54BcHwqLee82YCfIbOcE5cAHF9KZCyey/Z/kicAjkf7gYbKfIbY9gAcTyWFzSZFaM9ls9kxB+DwtbUY6DzA" +
  "58otnmsLwOEXYNYBhsxchdbq2AtFYwd4Ean3beKFFwAcrnYWKZE+8izetTJnrYwRneWaj3yFe6mYOwAOV9UDIw+FgHrPI54dg7yyOHcCgAM9Me" +
  "ceTBNHfb22yON9ddT3xKKvKQDHlzJ57BFe1xAfU021TLnaYtNDXrEvuDapVm2knPuwdNDH2QHAZwd2LFPNjYgZ4JPn8FnhsFS+8BxOOwFwfBGI" +
  "rgu4d4cAv3teyFUAHJ7u7cBlA5g+uJpGZBY7cgAcmO7VvY07tm8cAmw62jK2qJcDYAAGYABmCsEUAoBZxLGII4xGGA2A2chgIwOA2UpmKxmASe" +
  "YhmYd0StIpAZiEdhLaAZiSIkqKAJiiToo6KaunrB6AOdiEg00AmKOlOFoqWYBHHO4HwKGL41UBOPrcCA64BuAoPBefGADgwYqPvABw8OIzWwAc" +
  "/FSCDx0CcNSplnxqFoAHLz72DcDRV23cWuDlnsB9a2HPOuUxTB3gthB/pWKuOibFT6SNz5Y2rFMfPwBuN534abG3keLKXMDM5MCRsfx7In9byr" +
  "3Hjn0+M24A/H1hd3FYKu9Ll1QXbABsF7Y6DBjeQ4qhMgD2t2P3SL0wLgDc1BuXAwC3xOsCcNdUzH0P4O5TSYkE4MdVdmwtauy6qJY+5rxvAPZZ" +
  "KLqQcvXKAbSVtLWIvQATgId7AlAhmwqlnARZiTe9iGq5dpJ71vKbKe8PgBEAIwTACAEwQgCMABihEPQHanOm9dttCScAAAAASUVORK5CYII=";

/** Decoded once per request. `atob` exists in Workers; this is the standard base64-to-bytes idiom. */
function bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const iconBytes = () => bytes(ICON_PNG_BASE64);
export const markBytes = () => bytes(MARK_PNG_BASE64);

/**
 * The manifest, from the copy's settings (name, short name, firm). `display: standalone` is the point:
 * launched from the Home Screen the app opens without the browser's address bar. start_url is the
 * dashboard; an expired session is redirected to sign-in by the auth middleware. The theme colours are
 * the dark "Command Console" palette's --bg (2026-09-14); a static, unauthenticated response cannot
 * follow a signed-in user's light/dark choice, and iOS fetches it without the session cookie anyway.
 */
export function manifest(s: Pick<AppSettings, "appName" | "shortName" | "firm" | "icon">) {
  const v = s.icon ? `?v=${encodeURIComponent(s.icon)}` : "";
  return {
    name: s.appName,
    short_name: s.shortName,
    description: `Relationships, commitments and follow-ups for ${s.firm}.`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0e1116",
    theme_color: "#0e1116",
    icons: [
      { src: `/icon.png${v}`, sizes: "320x320", type: "image/png", purpose: "any" },
      { src: `/icon.png${v}`, sizes: "192x192", type: "image/png" },
      { src: `/icon.png${v}`, sizes: "180x180", type: "image/png" },
    ],
  };
}
