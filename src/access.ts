// First-run setup and password reset (Phase 3c, 2026-09-25). Public routes: registered ABOVE the auth
// middleware in index.ts, because nobody who needs them is signed in.
//
// FIRST RUN (/setup). A brand-new copy has an empty database and no accounts. The first visit sends you
// here: enter the owner passphrase (APP_PASSWORD, set at deploy), and the app builds its own database
// (migrate.ts, as Health's Apply Updates does) and creates your admin account in one step. The page
// only exists while there are no accounts; after that it redirects to sign-in, forever.
//
// FORGOT PASSWORD (/forgot → email → /reset). Enter your email; if it is an active account and the copy's
// Outlook can send, a one-time link valid for an hour is emailed from the owner's mailbox
// (msgraph.ts sendMailAsOwner, which only ever emails account holders). The page always gives the same
// answer, so it never reveals who has an account. Limits: 5 requests per IP per hour (per isolate, best
// effort) and 3 links per account per hour (in the database). Using a link sets a new password, voids
// every other link for that account, and signs out all its sessions.

import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import { esc, layout, logoV } from "./views";
import type { Bindings, D1Db } from "./types";
import {
  MIN_PASSWORD_LENGTH,
  SESSION_DAYS,
  clearPassphraseFailures,
  hashPassword,
  makeSessionToken,
  notePassphraseFailure,
  passphraseBlocked,
  passwordProblem,
  runAs,
  safeEqual,
  sha256,
  userByEmail,
  OWNER_PASSPHRASE,
} from "./auth";
import { appSettings, loadAppSettings } from "./settings";
import { applyPending, migrationState } from "./migrate";
import { sendMailAsOwner } from "./msgraph";

const app = new Hono<{ Bindings: Bindings }>();
type C = Context<{ Bindings: Bindings }>;

const RESET_MINUTES = 60;
const PER_ACCOUNT_PER_HOUR = 3;
const PER_IP_PER_HOUR = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const clientIp = (c: C) => c.req.header("cf-connecting-ip") ?? "local";

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const tokenHash = async (token: string) => b64url(await sha256(`reset:${token}`));
const sqlTime = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ");

/** Are there any accounts yet? A missing app_user table (a brand-new copy) counts as none. */
export async function hasAccounts(db: D1Db): Promise<boolean> {
  try {
    return !!(await db.prepare("SELECT 1 AS x FROM app_user LIMIT 1").first());
  } catch {
    return false;
  }
}

async function audit(db: D1Db, entityId: string, action: string, after: string, actorName: string) {
  await db
    .prepare("INSERT INTO audit_event (actor, entity, entity_id, action, after_summary, source) VALUES (?,'app_user',?,?,?,'app')")
    .bind(actorName, entityId, action, after.slice(0, 300))
    .run()
    .catch(() => undefined);
}

const shell = (c: C, title: string, inner: string) =>
  layout({
    c,
    title,
    nav: false,
    body: `<div style="max-width:420px;margin:56px auto">
  <img src="/logo.png${logoV()}" alt="" width="105" height="48" style="display:block;margin:0 auto 14px;object-fit:contain">
  <h1 style="text-align:center">${esc(title)}</h1>
  ${inner}
</div>`,
  });

// ---------------------------------------------------------------- first run

const setupForm = (c: C, error = "", v: Record<string, string> = {}) =>
  shell(
    c,
    "Set up this copy",
    `<p class="sub" style="text-align:center">Welcome to ${esc(appSettings().appName)}. This creates the database and your admin account.</p>
  ${error ? `<p class="flash warn">${esc(error)}</p>` : ""}
  <form class="card" method="post" action="/setup">
    <label for="su-pass">Owner passphrase <span class="hint">the APP_PASSWORD set when this copy was deployed</span></label>
    <input type="password" id="su-pass" name="passphrase" autocomplete="off" required>
    <label for="su-name">Your name</label>
    <input type="text" id="su-name" name="display_name" value="${esc(v.display_name ?? "")}" maxlength="80" required>
    <label for="su-email">Your email <span class="hint">what you'll sign in with</span></label>
    <input type="email" id="su-email" name="email" value="${esc(v.email ?? "")}" autocomplete="username" required>
    <label for="su-pw">Password <span class="hint">at least ${MIN_PASSWORD_LENGTH} characters</span></label>
    <input type="password" id="su-pw" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
    <label for="su-pw2">Password again</label>
    <input type="password" id="su-pw2" name="confirm" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
    <div class="actions"><button type="submit" style="width:100%">Set Up</button></div>
  </form>`
  );

app.get("/setup", async (c) => {
  if (await hasAccounts(c.env.DB)) return c.redirect("/login");
  return c.html(setupForm(c));
});

app.post("/setup", async (c) => {
  const db = c.env.DB;
  if (await hasAccounts(db)) return c.redirect("/login");
  const f = await c.req.parseBody();
  const v = { display_name: str(f.display_name).slice(0, 80), email: str(f.email).toLowerCase() };
  const ip = clientIp(c);
  if (passphraseBlocked(ip)) return c.html(setupForm(c, "Too many attempts. Wait 15 minutes and try again.", v), 429);
  const pass = typeof f.passphrase === "string" ? f.passphrase : "";
  if (!safeEqual(await sha256(pass), await sha256(c.env.APP_PASSWORD))) {
    notePassphraseFailure(ip);
    return c.html(setupForm(c, "That owner passphrase is not correct.", v), 401);
  }
  clearPassphraseFailures(ip);
  if (!v.display_name) return c.html(setupForm(c, "Add your name.", v), 400);
  if (!EMAIL_RE.test(v.email)) return c.html(setupForm(c, "That doesn't look like an email address.", v), 400);
  const pw = typeof f.password === "string" ? f.password : "";
  if (pw !== (typeof f.confirm === "string" ? f.confirm : "")) return c.html(setupForm(c, "The two passwords don't match.", v), 400);
  const problem = passwordProblem(pw);
  if (problem) return c.html(setupForm(c, problem, v), 400);

  // Build (or finish building) the database, as the owner. A brand-new copy has nothing to back up.
  const state = await migrationState(db);
  if (state.outOfStep) return c.html(setupForm(c, "This database was set up another way and can't be updated automatically. It needs a hand from whoever deployed it.", v), 409);
  if (state.pending.length) {
    const r = await runAs(OWNER_PASSPHRASE, () => applyPending(c.env));
    if (r.refused || r.error) return c.html(setupForm(c, `The database couldn't be set up: ${r.refused ?? `${r.error!.name}: ${r.error!.message}`}`, v), 500);
  }
  if (await hasAccounts(db)) return c.redirect("/login"); // someone else finished first

  const h = await hashPassword(pw);
  const res = await db
    .prepare("INSERT INTO app_user (email, display_name, role, pw_hash, pw_salt, pw_iterations, must_change_pw) VALUES (?,?,'admin',?,?,?,0)")
    .bind(v.email, v.display_name, h.hash, h.salt, h.iterations)
    .run();
  const id = Number(res.meta?.last_row_id ?? 0);
  await audit(db, String(id), "create", `first-run setup: ${v.display_name} <${v.email}> created as the first admin`, "owner-passphrase");
  await loadAppSettings(db, true);
  setCookie(c, "pp_session", await makeSessionToken(c.env.SESSION_SECRET, id, 1), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
  return c.redirect("/settings?flash=welcome");
});

// ---------------------------------------------------------------- forgot password

const ipHits = new Map<string, number[]>();
function ipLimited(ip: string, now = Date.now()): boolean {
  const recent = (ipHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  recent.push(now);
  ipHits.set(ip, recent);
  return recent.length > PER_IP_PER_HOUR;
}

const SAME_ANSWER =
  "If that email belongs to an account here, a link to reset the password is on its way. It works once, for the next hour. Nothing arriving? Ask an admin to reset it for you.";

const forgotPage = (c: C, sent = false) =>
  shell(
    c,
    "Forgot password",
    sent
      ? `<div class="card"><p style="margin:0">${esc(SAME_ANSWER)}</p></div><p style="text-align:center"><a href="/login">Back to sign in</a></p>`
      : `<form class="card" method="post" action="/forgot">
    <label for="fg-email">Your email</label>
    <input type="email" id="fg-email" name="email" autocomplete="username" required autofocus>
    <div class="actions"><button type="submit" style="width:100%">Email Me a Reset Link</button></div>
  </form>
  <p style="text-align:center"><a href="/login">Back to sign in</a></p>`
  );

app.get("/forgot", (c) => c.html(forgotPage(c)));

app.post("/forgot", async (c) => {
  const db = c.env.DB;
  const f = await c.req.parseBody();
  const email = str(f.email).toLowerCase();
  const limited = ipLimited(clientIp(c));
  const u = !limited && EMAIL_RE.test(email) ? await userByEmail(db, email).catch(() => null) : null;
  if (u && u.status === "active") {
    const recent = await db
      .prepare("SELECT COUNT(*) AS n FROM password_reset WHERE user_id = ? AND created_at > datetime('now', '-1 hour')")
      .bind(u.id)
      .first<{ n: number }>();
    if ((recent?.n ?? 0) < PER_ACCOUNT_PER_HOUR) {
      const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
      await db
        .prepare("INSERT INTO password_reset (user_id, token_hash, expires_at, requested_ip) VALUES (?,?,?,?)")
        .bind(u.id, await tokenHash(token), sqlTime(Date.now() + RESET_MINUTES * 60_000), clientIp(c))
        .run();
      const link = `${new URL(c.req.url).origin}/reset?token=${token}`;
      const sent = await sendMailAsOwner(c.env, db, {
        to: u.email,
        subject: `Reset your ${appSettings().appName} password`,
        text: `Hi ${u.display_name.split(/\s+/)[0]},\n\nSomeone (hopefully you) asked to reset your ${appSettings().appName} password. This link works once, for the next hour:\n\n${link}\n\nIf you didn't ask, you can ignore this email; your password hasn't changed.`,
      });
      await audit(db, String(u.id), "update", "ok" in sent ? `password reset link emailed to ${u.email}` : `password reset requested for ${u.email}; not emailed: ${sent.error}`, "system");
    }
  }
  // The same page whatever happened: never reveal whether an address has an account.
  return c.html(forgotPage(c, true));
});

// ---------------------------------------------------------------- reset link

async function validToken(db: D1Db, token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  return db
    .prepare(
      `SELECT r.id AS reset_id, u.id AS user_id, u.email, u.display_name, u.session_version
       FROM password_reset r JOIN app_user u ON u.id = r.user_id
       WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > datetime('now') AND u.status = 'active'`
    )
    .bind(await tokenHash(token))
    .first<{ reset_id: number; user_id: number; email: string; display_name: string; session_version: number }>()
    .catch(() => null);
}

const resetForm = (c: C, token: string, email: string, error = "") =>
  shell(
    c,
    "Choose a new password",
    `${error ? `<p class="flash warn">${esc(error)}</p>` : ""}
  <form class="card" method="post" action="/reset">
    <p class="meta" style="margin-top:0">For ${esc(email)}</p>
    <input type="hidden" name="token" value="${esc(token)}">
    <label for="rs-pw">New password <span class="hint">at least ${MIN_PASSWORD_LENGTH} characters</span></label>
    <input type="password" id="rs-pw" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required autofocus>
    <label for="rs-pw2">New password again</label>
    <input type="password" id="rs-pw2" name="confirm" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
    <div class="actions"><button type="submit" style="width:100%">Set Password</button></div>
  </form>`
  );

const deadLink = (c: C) =>
  c.html(
    shell(c, "This link has expired", `<div class="card"><p style="margin:0">Reset links work once, for an hour. <a href="/forgot">Ask for a new one</a>, or ask an admin to reset your password.</p></div>`),
    410
  );

app.get("/reset", async (c) => {
  const token = c.req.query("token") ?? "";
  const t = await validToken(c.env.DB, token);
  if (!t) return deadLink(c);
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  return c.html(resetForm(c, token, t.email));
});

app.post("/reset", async (c) => {
  const db = c.env.DB;
  const f = await c.req.parseBody();
  const token = str(f.token);
  const t = await validToken(db, token);
  if (!t) return deadLink(c);
  const pw = typeof f.password === "string" ? f.password : "";
  if (pw !== (typeof f.confirm === "string" ? f.confirm : "")) return c.html(resetForm(c, token, t.email, "The two passwords don't match."), 400);
  const problem = passwordProblem(pw);
  if (problem) return c.html(resetForm(c, token, t.email, problem), 400);
  const h = await hashPassword(pw);
  await db.batch([
    db
      .prepare(
        `UPDATE app_user SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, must_change_pw = 0, session_version = session_version + 1,
           failed_logins = 0, locked_until = NULL, updated_at = datetime('now') WHERE id = ?`
      )
      .bind(h.hash, h.salt, h.iterations, t.user_id),
    db.prepare("UPDATE password_reset SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").bind(t.user_id),
  ]);
  await audit(db, String(t.user_id), "update", `${t.email} reset their password with an emailed link; all sessions ended`, t.email);
  return c.redirect("/login?flash=reset");
});

export default app;
