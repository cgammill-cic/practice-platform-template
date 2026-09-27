// AUTH-001 (#94, built 2026-09-25): who is signed in, and who did what.
//
// Two ways in:
//   - a NAMED ACCOUNT (app_user, migration 0031): email + password, role admin or member;
//   - the OWNER PASSPHRASE (APP_PASSWORD), kept as break-glass so a broken account table can never lock
//     the owner out. It signs in with admin rights and is audited as "owner-passphrase".
//
// WHO DID IT, WITHOUT THREADING. Every audit write in the app used a module constant ACTOR (one hardcoded name).
// Rather than add an actor parameter to nineteen modules' private audit helpers (and every function
// between a route and its helper), the auth middleware runs each request inside an AsyncLocalStorage
// scope that carries the signed-in identity, and every audit write calls actor(). Anything outside a
// request — the scheduled jobs — has no scope and reads as "system", which is exactly right: the hourly
// calendar sync and the morning digest are not anybody's edit. Requires the nodejs_als compatibility
// flag (wrangler.jsonc).
import { AsyncLocalStorage } from "node:async_hooks";
import type { D1Db } from "./types";

export type Role = "admin" | "member";

export interface SessionIdentity {
  /** Recorded in audit_event.actor: the user's email, "owner-passphrase", or "system". */
  actor: string;
  role: Role;
  userId: number | null;
  displayName: string;
}

const als = new AsyncLocalStorage<SessionIdentity>();
export const SYSTEM: SessionIdentity = { actor: "system", role: "admin", userId: null, displayName: "System" };

/** Run `fn` as `who`. Used by the auth middleware for requests and by scheduled() for "system". */
export const runAs = <T>(who: SessionIdentity, fn: () => T): T => als.run(who, fn);
/** The identity of the current request, or "system" outside one. */
export const whoami = (): SessionIdentity => als.getStore() ?? SYSTEM;
/** What every audit write records as its actor. */
export const actor = (): string => whoami().actor;
export const isAdmin = (): boolean => whoami().role === "admin";

export const OWNER_PASSPHRASE: SessionIdentity = {
  actor: "owner-passphrase",
  role: "admin",
  userId: null,
  displayName: "Owner (passphrase)",
};

// ---------------------------------------------------------------- crypto primitives

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (ch) => ch.charCodeAt(0));
};

export async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

export async function sha256(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

/** Constant-time comparison of byte arrays. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------- passwords

/**
 * PBKDF2-SHA256 iterations for new hashes. 100,000 is the most Cloudflare Workers' WebCrypto accepts for
 * PBKDF2. Stored per row, so raising it later only affects new or changed passwords.
 */
export const PBKDF2_ITERATIONS = 100_000;
export const MIN_PASSWORD_LENGTH = 12;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  // Cast: TS 5.7 infers Uint8Array<ArrayBufferLike>, which the DOM BufferSource type rejects; same bytes.
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations }, key, 256)
  );
}

export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS
): Promise<{ hash: string; salt: string; iterations: number }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: b64url(await pbkdf2(password, salt, iterations)), salt: b64url(salt), iterations };
}

export async function verifyPassword(password: string, hash: string, salt: string, iterations: number): Promise<boolean> {
  return safeEqual(await pbkdf2(password, fromB64url(salt), iterations), fromB64url(hash));
}

/** A readable temporary password: 16 characters with no look-alikes (0/O, 1/l/I). */
export function temporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

/** Why a new password is not acceptable, or null. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  return null;
}

// ---------------------------------------------------------------- session tokens

export const SESSION_DAYS = 30;

/**
 * v2.{userId}.{sessionVersion}.{expires}.{sig}. userId 0 = the owner passphrase. The HMAC covers
 * everything before the signature, so no field can be altered without invalidating it.
 */
export async function makeSessionToken(secret: string, userId: number, version: number, now = Date.now()): Promise<string> {
  const body = `v2.${userId}.${version}.${now + SESSION_DAYS * 86_400_000}`;
  return `${body}.${await hmac(secret, body)}`;
}

export type ParsedSession = { kind: "user"; userId: number; version: number } | { kind: "passphrase" } | null;

/**
 * Validates a session cookie. Accepts, until they expire, the tokens issued before named accounts
 * existed ({expires}.{sig}), treating them as passphrase sessions — so nobody is signed out by the
 * deploy that introduces accounts.
 */
export async function parseSessionToken(token: string | undefined, secret: string, now = Date.now()): Promise<ParsedSession> {
  if (!token) return null;
  const last = token.lastIndexOf(".");
  if (last < 1) return null;
  const body = token.slice(0, last);
  const sig = token.slice(last + 1);
  if (!safeEqual(enc.encode(sig), enc.encode(await hmac(secret, body)))) return null;
  if (/^\d+$/.test(body)) return Number(body) >= now ? { kind: "passphrase" } : null; // legacy token
  const m = /^v2\.(\d+)\.(\d+)\.(\d+)$/.exec(body);
  if (!m || Number(m[3]) < now) return null;
  const userId = Number(m[1]);
  return userId === 0 ? { kind: "passphrase" } : { kind: "user", userId, version: Number(m[2]) };
}

// ---------------------------------------------------------------- accounts

export interface AppUser {
  id: number;
  email: string;
  display_name: string;
  role: Role;
  pw_hash: string;
  pw_salt: string;
  pw_iterations: number;
  must_change_pw: number;
  status: "active" | "disabled";
  session_version: number;
  failed_logins: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
}

export const LOCKOUT_AFTER = 5;
export const LOCKOUT_MINUTES = 15;

export const userById = (db: D1Db, id: number) =>
  db.prepare("SELECT * FROM app_user WHERE id = ?").bind(id).first<AppUser>();
export const userByEmail = (db: D1Db, email: string) =>
  db.prepare("SELECT * FROM app_user WHERE email = ? COLLATE NOCASE").bind(email.trim()).first<AppUser>();

/** Is the account locked at `nowIso` (UTC "YYYY-MM-DD HH:MM:SS", SQLite's datetime format)? */
export const isLocked = (u: Pick<AppUser, "locked_until">, nowIso: string) => !!u.locked_until && u.locked_until > nowIso;

export const identityOf = (u: AppUser): SessionIdentity => ({
  actor: u.email,
  role: u.role,
  userId: u.id,
  displayName: u.display_name,
});

// ---------------------------------------------------------------- passphrase rate limit

/**
 * Failed owner-passphrase attempts per client IP, per isolate. Best-effort by design: an isolate can be
 * recycled or a request land on another one, so this slows guessing rather than guaranteeing a count.
 * Before accounts existed there was no limit at all.
 */
const passphraseFailures = new Map<string, { n: number; until: number }>();
export function passphraseBlocked(ip: string, now = Date.now()): boolean {
  const f = passphraseFailures.get(ip);
  return !!f && f.n >= LOCKOUT_AFTER && f.until > now;
}
export function notePassphraseFailure(ip: string, now = Date.now()) {
  const f = passphraseFailures.get(ip);
  const n = f && f.until > now ? f.n + 1 : 1;
  passphraseFailures.set(ip, { n, until: now + LOCKOUT_MINUTES * 60_000 });
}
export const clearPassphraseFailures = (ip: string) => passphraseFailures.delete(ip);
/**
 * Admin-only areas (AUTH-001). A member can do everything else, including every contact, pursuit and
 * time entry: it is one shared dataset. These are the places that decide who can get in, rewrite many
 * records at once, read the owner's own mailbox and calendar, or change the Outlook connection.
 * "Sync now" (POST /admin/meeting-sync) stays open to members: it only runs the hourly job early.
 */
const ADMIN_ONLY: RegExp[] = [
  /^\/users(\/|$)/,
  /^\/update(\/|$)/,
  /^\/import(\/|$)/,
  /^\/email\/import(\/|$)/,
  /^\/time\/import(\/|$)/,
  /^\/digest\//,
  /^\/auth\/microsoft(\/|$)/,
  /^\/admin\/(?!meeting-sync$)/,
  // Outreach drafting (Phase 2a): uses the owner's mailbox and the owner's API spend.
  /^\/outreach(\/|$)/,
  // Per-copy settings (Phase 3a): brand, logo, timezone, digest hour.
  /^\/settings(\/|$)/,
  // Sales commitments (0035): personal coaching data from the sales-advisor sessions.
  /^\/commitments(\/|$)/,
];
export const adminOnlyPath = (path: string) => ADMIN_ONLY.some((re) => re.test(path));

