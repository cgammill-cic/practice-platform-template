/*
 * Brand assets — the Home Screen icon, the header mark, and the web app manifest.
 *
 * WHY THE IMAGES ARE BASE64 STRINGS IN A SOURCE FILE. A base64 constant is plain text, which means it
 * survives every path a source file might travel (including services that only accept text content) and
 * is decoded by the Worker at request time — no R2 round trip, no build step, nothing to keep in sync.
 *
 * KEEP THIS FILE COMFORTABLY SMALL. A very large base64 constant risks being truncated by whatever tool
 * writes it (some file-writing APIs have practical size ceilings), which produces a file that looks
 * correct and holds a corrupted image. If you replace either image, verify the result actually renders —
 * do not just trust that the write succeeded.
 *
 * THE PLACEHOLDER IMAGES BELOW ARE GENERIC — replace them with your own branding. Each is a small, valid
 * PNG generated with plain Node (see the pattern in this repo's own tooling: raw PNG chunks via
 * `node:zlib`, no image library needed) rather than any real logo, so this template ships with no
 * third-party branding to accidentally carry into your own deployment.
 *
 * TO REPLACE EITHER IMAGE: swap the base64 and change nothing else. Mind the size note above.
 */

/** 320x320, opaque background — iOS requires an opaque icon and composites its own rounded mask. */
export const ICON_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAIAAABC8jL9AAAD/ElEQVR42u3TQQkAMAwEwXiqgoqof+grz0rIpyISGFgFx02sfSQN" +
  "LUwgASwJYEkASwBLAlgSwJIAlgCWBLAkgCWAJQEsCWBJAEsASwJYEsCSAJYAlgSwJIAlgCUBLAlgSQBLAEsCWBLAkgCWAJYEsCSA" +
  "JYAlASwJYEkASwBLAlgSwBLAVpAAlgSwJIAlgCUBLAlgSQBLAEsCWBLAEsCSAJYEsCSAJYAlASwJYEkASwBLAlgSwBLAkgCWBLAk" +
  "gCWAJQEsCWBJAEsASwJYEsASwJIAlgSwJIAlgCUBLAlgCWBJAEsCWBLAEsCSAJYEsCSAJYAlAdysm0/N81KAAQYYYIAFMMAAC2CA" +
  "AQYYYIAJARhggAUwwAALYIABBhhggAUwwAALYIABBlgAAwwwwAALYIABFsAAAwwwwAALYIABFsAAAyyAAQYYYIABFsAAAyyAAQYY" +
  "YICtADDAAAMsgAEGWAADDDDAAAMsgAEGWAADDLAABhhggAEGWAADDLAABhhggAEWwAADDLAABhhgAQwwwAADDLAABhhgAQwwwAA7" +
  "KsAAAwwwwAIYYIAFMMAAAwwwwAIYYIAFMMAAC2CAAQYYYIAFMMAAC2CAAQZYAAMMMMAAC2CAARbAAAMMMMAAC2CAARbAAAMsgAEG" +
  "GGCAARbAAAMsgAEGGGCABTDAAAMsgAEGWAADDDDAAAMsgAEGWAADDLAABhhggAEGWAADDLAABhhggAEWwAADDLAABhhgAQwwwAAD" +
  "DLAABhhgAQwwwAALYIABBhhgAQwwwAIYYIABBhhgAQwwwAIYYIAFMMAAAwwwwAIYYIAFMMAAAyyAAQYYYIAFMMAAC2CAAQYYYIAF" +
  "MMAAC2CAARbAAAMMMMAAC2CAARbAAAMMMMACGGCAARbAAAMsgAEGGGCAARbAAAMsgAEGWAADDDDAAAMsgAEGWAADDDDAAAsPgAEG" +
  "WAADDLAABhhggAEGWAADDLAABhhggAUwwAADDLAABhhgAQwwwAADDLAABhhgAQwwwAIYYIABBhhgAQwwwAIYYIABBtgEAAMMMMAC" +
  "GGCABTDAAAMMMMACGGCABTDAAAtggAEGGGBJAEsCWAJYEsCSAJYEsASwJIAlASwJYAlgSQBLAlgCWBLAkgCWBLAEsCSAJQEsCWAJ" +
  "YEkASwJYAlgSwJIAlgSwBLAkgCUBLAFsBQlgSQBLAlgCWBLAkgCWBLAEsCSAJQEsASwJYEkASwJYAlgSwJIAlgSwBLAkgCUBLAEs" +
  "CWBJAEsCWAJYEsCSAJYEsASwJIAlASwBLAlgSQBLAlgCWBLAkgCWAJYEsCSAJQEsASwJYEkASwJYAlgSwJIAlgCWBLAkgCUBLAEs" +
  "CWBJAEv6FcjizqPixVrxAAAAAElFTkSuQmCC";

/** 160x160, RGBA — displayed small in the header and on the sign-in page. */
export const MARK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAACgCAYAAACLz2ctAAABp0lEQVR42u3SsQkAIAwAwezkBA7h/mBl6QaKvaUghCt+geei1Lak" +
  "X4UJAlAASgAKQAlAASgBKAAlAAWgBKAAlAAUgBKAAlACUABKAApACUABKAEoACUABaAEoACUABSAEoACUAAaIQAFoASgAJQAFIAS" +
  "gAJQAlAASgCe+pi6BCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCA" +
  "AAIIIIAAAggggAACCCCAAAIIIICwAQgggAAKQAABBFAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAII" +
  "IIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIoAAEEEAABSCAAAIoAAEEEEAAAQQQQAABBBBAAHMC" +
  "VJ4AFIACUAJQAEoACkAJQAEoASgAJQAFoASgAJQAFIASgAJQAlAASgAKQAlAASgBKAAlAAWgBKAAlAAUgALQBAEoACUABaAEoACU" +
  "ABSAEoACUHrfBniQVX4GzRLBAAAAAElFTkSuQmCC";

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
 * The manifest. `display: standalone` is the point of the exercise — launched from the Home Screen the
 * app opens without the browser's address bar, which is most of what makes a web app feel like an app.
 *
 * start_url is the dashboard rather than /login: if the session is still valid the app opens on the
 * work, and if it is not, the auth middleware redirects to the passphrase.
 *
 * One image is declared at the sizes that matter; both platforms downscale a larger source cleanly, and
 * one constant to replace beats several when the logo changes.
 *
 * `name`, `short_name` and `description` are placeholders — change them to your own practice's name.
 */
export const MANIFEST = {
  name: "Practice Platform",
  short_name: "Practice",
  description: "Relationships, commitments and follow-ups for your practice.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#f8fafc",
  theme_color: "#1a2332",
  icons: [
    { src: "/icon.png", sizes: "320x320", type: "image/png", purpose: "any" },
    { src: "/icon.png", sizes: "192x192", type: "image/png" },
    { src: "/icon.png", sizes: "180x180", type: "image/png" },
  ],
};
