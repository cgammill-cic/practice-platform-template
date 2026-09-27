// Users and My Account (AUTH-001, #94, built 2026-09-25).
//
// /users is admin-only (the gate is auth.ts ADMIN_ONLY, enforced by the middleware in index.ts); /account
// is every signed-in person's own page. There is no email sender yet (#95, Phase 3), so a new account or
// a reset gets a TEMPORARY PASSWORD that is shown once, on the response to the action, for the admin to
// pass on. It is never stored in clear, never put in a URL or a redirect, and never written to the audit
// trail; the account must replace it at first sign-in (must_change_pw).
//
// Guard rails, both enforced here rather than trusted to the buttons: an admin cannot disable or demote
// their own account, and the last active admin cannot be disabled or demoted. Either would leave the app
// with nobody who can manage users; the owner passphrase would still get in, but that is break-glass,
// not a way of running the app.

import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import { esc, layout } from "./views";
import { appSettings } from "./settings";
import { canSendMail, msConnection, sendMailAsOwner } from "./msgraph";
import type { Bindings, D1Db } from "./types";
import {
  MIN_PASSWORD_LENGTH,
  SESSION_DAYS,
  actor,
  hashPassword,
  makeSessionToken,
  passwordProblem,
  temporaryPassword,
  userById,
  userByEmail,
  verifyPassword,
  whoami,
  type AppUser,
  type Role,
} from "./auth";

const app = new Hono<{ Bindings: Bindings }>();
type C = Context<{ Bindings: Bindings }>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function audit(db: D1Db, id: number, action: string, after: string, before?: string | null) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,'app_user',?,?,?,?,'app',?)"
    )
    .bind(actor(), String(id), action, before ?? null, after, `app-user-${id}`)
    .run();
}

async function listUsers(db: D1Db): Promise<AppUser[]> {
  const { results } = await db
    .prepare("SELECT * FROM app_user ORDER BY status = 'disabled', role = 'member', display_name COLLATE NOCASE")
    .all<AppUser>();
  return results;
}

async function activeAdminCount(db: D1Db): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM app_user WHERE role = 'admin' AND status = 'active'")
    .first<{ n: number }>();
  return r?.n ?? 0;
}

const FLASH: Record<string, [string, "ok" | "warn"]> = {
  disabled: ["Account disabled. Anyone signed in with it is signed out on their next click.", "ok"],
  enabled: ["Account re-enabled. They sign in with their existing password.", "ok"],
  role: ["Role changed.", "ok"],
  self: ["You can't disable or change the role of your own account. Ask another admin.", "warn"],
  lastadmin: ["That is the last active admin. Make someone else an admin first.", "warn"],
  exists: ["An account with that email already exists.", "warn"],
  bademail: ["That doesn't look like an email address.", "warn"],
  noname: ["Add a name for the account.", "warn"],
  missing: ["That account no longer exists.", "warn"],
  stale: ["That temporary password is no longer current, so nothing was emailed. Use Reset Password for a fresh one.", "warn"],
};

/** One row. Controls are omitted on your own row, where the server would refuse them anyway. */
function userRow(u: AppUser, meId: number | null): string {
  const me = u.id === meId;
  const pills = [
    u.role === "admin" ? '<span class="pill green">Admin</span>' : '<span class="pill grey">Member</span>',
    u.status === "disabled" ? '<span class="pill red">Disabled</span>' : "",
    u.must_change_pw && u.status === "active" ? '<span class="pill amber">Temporary password</span>' : "",
    u.locked_until && u.locked_until > new Date().toISOString().slice(0, 19).replace("T", " ")
      ? '<span class="pill red">Locked</span>'
      : "",
  ].join(" ");
  const btn = (path: string, label: string, secondary = true, confirm = "") =>
    `<form method="post" action="/users/${u.id}/${path}" style="display:inline"${
      confirm ? ` data-q="${esc(confirm)}" onsubmit="return confirm(this.dataset.q)"` : ""
    }><button class="tiny${secondary ? " secondary" : ""}" type="submit">${label}</button></form>`;
  const controls = me
    ? '<span class="meta">This is you</span>'
    : [
        btn("reset", "Reset Password", true, `Give ${u.display_name} a new temporary password? Their current password stops working and they are signed out.`),
        u.role === "admin" ? btn("role?to=member", "Make Member") : btn("role?to=admin", "Make Admin"),
        u.status === "active"
          ? btn("disable", "Disable", true, `Disable ${u.display_name}? They are signed out on their next click.`)
          : btn("enable", "Enable", false),
      ].join(" ");
  return `<div class="listrow">
    <div class="listrow-main">
      <div class="listrow-name">${esc(u.display_name)} ${pills}</div>
      <div class="meta">${esc(u.email)} · ${u.last_login_at ? `last signed in ${esc(u.last_login_at.slice(0, 16))} UTC` : "never signed in"}</div>
    </div>
    <div class="listrow-meta"><div>${controls}</div></div>
  </div>`;
}

/**
 * The message an admin passes on, since there is no email sender yet (#95). The URL is taken from the
 * request, so it is right on any copy of the app. Plain text: it is pasted into a text or an email.
 */
function inviteText(r: { name: string; email: string; password: string; reset: boolean }, origin: string): string {
  const first = r.name.split(/\s+/)[0];
  return r.reset
    ? `Hi ${first}, I've reset your ${appSettings().appName} password.

Sign in at: ${origin}/login
Email: ${r.email}
Temporary password: ${r.password}

You'll be asked to choose a new password (at least 12 characters) as soon as you sign in.`
    : `Hi ${first}, I've set you up on ${appSettings().appName}.

Sign in at: ${origin}/login
Email: ${r.email}
Temporary password: ${r.password}

You'll be asked to choose your own password (at least 12 characters) as soon as you sign in. On a phone, you can add it to your Home Screen from the browser's Share menu.`;
}

/**
 * `reveal` is set only on the direct response to creating an account or resetting a password. The
 * response is marked no-store so the one-time password is not kept in the browser cache either.
 */
async function usersPage(
  c: C,
  reveal?: { id?: number; name: string; email: string; password: string; reset: boolean; emailed?: string | null; emailError?: string | null }
) {
  const users = await listUsers(c.env.DB);
  const canEmail = canSendMail(await msConnection(c.env.DB).catch(() => null));
  const flash = c.req.query("flash");
  const f = flash && FLASH[flash];
  const revealHtml = reveal
    ? `<div class="card" style="border-color:var(--accent)">
    <h2 style="margin-top:0">${reveal.reset ? "New temporary password" : "Account created"} for ${esc(reveal.name)}</h2>
    <p>Give ${esc(reveal.name)} this temporary password. <b>It is shown only this once.</b> They sign in with <b>${esc(reveal.email)}</b> and are asked to choose their own password straight away.</p>
    <p style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:20px;letter-spacing:.04em;margin:10px 0"><span id="temp-pw">${esc(reveal.password)}</span></p>
    ${
      reveal.emailed
        ? `<p class="flash ok">Emailed to ${esc(reveal.emailed)} from your Outlook. You can also copy the message below into a text.</p>`
        : `${reveal.emailError ? `<p class="flash warn">${esc(reveal.emailError)}</p>` : ""}<p class="meta">Nothing has been sent to ${esc(reveal.name)} yet. Copy the message below into a text or an email${canEmail && reveal.id ? ", or email it from here" : ""}.</p>${
            canEmail && reveal.id
              ? `<form method="post" action="/users/${reveal.id}/email-invite" style="margin:6px 0"><input type="hidden" name="password" value="${esc(reveal.password)}"><input type="hidden" name="reset" value="${reveal.reset ? "1" : "0"}"><button type="submit" class="secondary">Email It to ${esc(reveal.email)}</button></form>`
              : ""
          }`
    }
    <pre id="invite-text" style="white-space:pre-wrap;background:var(--surface-2);border-radius:8px;padding:10px 12px;margin:10px 0;font-size:14px">${esc(inviteText(reveal, new URL(c.req.url).origin))}</pre>
    <button type="button" class="secondary" id="invite-copy">Copy Message</button> <span class="meta" id="invite-toast" aria-live="polite"></span>
    <script>
    document.getElementById('invite-copy').addEventListener('click', function () {
      var t = document.getElementById('invite-text').textContent, toast = document.getElementById('invite-toast');
      function fallback() {
        var r = document.createRange(); r.selectNodeContents(document.getElementById('invite-text'));
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        toast.textContent = 'Selected. Press Ctrl+C (or Copy) to copy.';
      }
      try { navigator.clipboard.writeText(t).then(function () { toast.textContent = 'Copied.'; }, fallback); } catch (e) { fallback(); }
    });
    </script>
  </div>`
    : "";
  const me = whoami().userId;
  const body = `<h1>Users</h1>
  <p class="sub">Who can sign in. Everyone sees the same contacts, pursuits and time: it is one shared practice. <b>Admins</b> can also manage users, import and bulk update, bring the connected Outlook mail and calendar into the app, and change the Outlook connection. <b>Members</b> can do everything else.</p>
  ${f ? `<div class="flash ${f[1]}">${esc(f[0])}</div>` : ""}
  ${revealHtml}
  <section>
    ${
      users.length
        ? `<div class="list">${users.map((u) => userRow(u, me)).join("")}</div>`
        : `<div class="empty">No accounts yet. You are signed in with the owner passphrase. Add your own admin account first, then sign out and back in with it, so your changes are recorded under your name.</div>`
    }
  </section>
  <section>
    <h2>Add a user</h2>
    <form method="post" action="/users" class="card">
      <label for="u-name">Name</label>
      <input type="text" id="u-name" name="display_name" required>
      <label for="u-email">Email <span class="hint">what they sign in with</span></label>
      <input type="email" id="u-email" name="email" required>
      <label class="check"><input type="radio" name="role" value="member" ${users.length ? "checked" : ""}> Member</label>
      <label class="check"><input type="radio" name="role" value="admin" ${users.length ? "" : "checked"}> Admin</label>
      <label class="check"><input type="checkbox" name="send" value="1" ${canEmail ? "checked" : "disabled"}> Email the invite ${canEmail ? "from your Outlook" : '<span class="hint">(connect Outlook on Health to enable)</span>'}</label>
      <div class="actions"><button type="submit">Add User</button></div>
      <p class="meta" style="margin:8px 0 0">The app makes a temporary password and shows it once, on the next screen.</p>
    </form>
  </section>
  <p class="meta">The owner passphrase still works as a break-glass sign-in with full rights. Changes made with it are recorded as "owner-passphrase" in the Audit trail.</p>`;
  if (reveal) c.header("cache-control", "no-store");
  return c.html(layout({ c, title: "Users", body }));
}

app.get("/users", (c) => usersPage(c));

app.post("/users", async (c) => {
  const f = await c.req.parseBody();
  const email = str(f.email).toLowerCase();
  const name = str(f.display_name);
  const role: Role = f.role === "admin" ? "admin" : "member";
  if (!EMAIL_RE.test(email)) return c.redirect("/users?flash=bademail");
  if (!name) return c.redirect("/users?flash=noname");
  if (await userByEmail(c.env.DB, email)) return c.redirect("/users?flash=exists");
  const password = temporaryPassword();
  const h = await hashPassword(password);
  const res = await c.env.DB.prepare(
    "INSERT INTO app_user (email, display_name, role, pw_hash, pw_salt, pw_iterations, must_change_pw) VALUES (?,?,?,?,?,?,1)"
  )
    .bind(email, name, role, h.hash, h.salt, h.iterations)
    .run();
  const id = Number(res.meta?.last_row_id ?? 0);
  await audit(c.env.DB, id, "create", `added ${name} <${email}> as ${role}, with a temporary password`);
  const reveal = { id, name, email, password, reset: false };
  if (f.send === "1") return usersPage(c, { ...reveal, ...(await emailInvite(c, id, reveal)) });
  return usersPage(c, reveal);
});

/** Loads the target, refusing your own account where `notSelf` is set. */
async function target(c: C, notSelf: boolean): Promise<AppUser | Response> {
  const id = Number(c.req.param("id"));
  const u = Number.isInteger(id) ? await userById(c.env.DB, id) : null;
  if (!u) return c.redirect("/users?flash=missing");
  if (notSelf && u.id === whoami().userId) return c.redirect("/users?flash=self");
  return u;
}

app.post("/users/:id/reset", async (c) => {
  const u = await target(c, false);
  if (u instanceof Response) return u;
  const password = temporaryPassword();
  const h = await hashPassword(password);
  await c.env.DB.prepare(
    `UPDATE app_user SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, must_change_pw = 1, session_version = session_version + 1,
       failed_logins = 0, locked_until = NULL, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(h.hash, h.salt, h.iterations, u.id)
    .run();
  await audit(c.env.DB, u.id, "update", `password reset for ${u.email}; temporary password issued, sessions ended`);
  return usersPage(c, { id: u.id, name: u.display_name, email: u.email, password, reset: true });
});

/** Send the invite (or reset) text from the owner's Outlook, to the account's own address only. */
async function emailInvite(c: C, id: number, r: { name: string; email: string; password: string; reset: boolean }) {
  const sent = await sendMailAsOwner(c.env, c.env.DB, {
    to: r.email,
    subject: r.reset ? `Your ${appSettings().appName} password was reset` : `You're invited to ${appSettings().appName}`,
    text: inviteText(r, new URL(c.req.url).origin),
  });
  await audit(c.env.DB, id, "update", "ok" in sent ? `${r.reset ? "reset" : "invite"} emailed to ${r.email}` : `${r.reset ? "reset" : "invite"} email to ${r.email} failed: ${sent.error}`);
  return "ok" in sent ? { emailed: r.email } : { emailError: sent.error };
}

/*
 * "Email It" from the one-time screen. The temporary password comes back from that page, so it is
 * checked against the stored hash first: this can only ever email that account its own current
 * temporary password, never arbitrary text, and only while the account still has to change it.
 */
app.post("/users/:id/email-invite", async (c) => {
  const u = await target(c, false);
  if (u instanceof Response) return u;
  const f = await c.req.parseBody();
  const password = typeof f.password === "string" ? f.password : "";
  if (!u.must_change_pw || !(await verifyPassword(password, u.pw_hash, u.pw_salt, u.pw_iterations))) return c.redirect("/users?flash=stale");
  const reveal = { id: u.id, name: u.display_name, email: u.email, password, reset: f.reset === "1" };
  return usersPage(c, { ...reveal, ...(await emailInvite(c, u.id, reveal)) });
});

app.post("/users/:id/disable", async (c) => {
  const u = await target(c, true);
  if (u instanceof Response) return u;
  if (u.status === "disabled") return c.redirect("/users?flash=disabled");
  if (u.role === "admin" && (await activeAdminCount(c.env.DB)) <= 1) return c.redirect("/users?flash=lastadmin");
  await c.env.DB.prepare(
    "UPDATE app_user SET status = 'disabled', session_version = session_version + 1, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(u.id)
    .run();
  await audit(c.env.DB, u.id, "update", `disabled ${u.email}; sessions ended`, "active");
  return c.redirect("/users?flash=disabled");
});

app.post("/users/:id/enable", async (c) => {
  const u = await target(c, true);
  if (u instanceof Response) return u;
  await c.env.DB.prepare(
    "UPDATE app_user SET status = 'active', failed_logins = 0, locked_until = NULL, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(u.id)
    .run();
  await audit(c.env.DB, u.id, "update", `re-enabled ${u.email}`, u.status);
  return c.redirect("/users?flash=enabled");
});

app.post("/users/:id/role", async (c) => {
  const u = await target(c, true);
  if (u instanceof Response) return u;
  const to: Role = c.req.query("to") === "admin" ? "admin" : "member";
  if (to === u.role) return c.redirect("/users?flash=role");
  if (u.role === "admin" && u.status === "active" && (await activeAdminCount(c.env.DB)) <= 1)
    return c.redirect("/users?flash=lastadmin");
  await c.env.DB.prepare("UPDATE app_user SET role = ?, updated_at = datetime('now') WHERE id = ?").bind(to, u.id).run();
  await audit(c.env.DB, u.id, "update", `${u.email} is now ${to}`, u.role);
  return c.redirect("/users?flash=role");
});

// ---------------------------------------------------------------- My Account

const ACCOUNT_FLASH: Record<string, [string, "ok" | "warn"]> = {
  changed: ["Password changed. Any other device signed in with this account has been signed out.", "ok"],
  wrong: ["Your current password is not correct.", "warn"],
  mismatch: ["The two new passwords don't match.", "warn"],
  short: [`Use at least ${MIN_PASSWORD_LENGTH} characters.`, "warn"],
  same: ["Choose a password different from the temporary one.", "warn"],
};

app.get("/account", async (c) => {
  const me = whoami();
  const u = me.userId ? await userById(c.env.DB, me.userId) : null;
  const flash = c.req.query("flash");
  const f = flash && ACCOUNT_FLASH[flash];
  const body = !u
    ? `<h1>My Account</h1>
  <p class="sub">You are signed in with the owner passphrase, which has no account of its own, so there is no password to change here.</p>
  <p>To have your changes recorded under your name, add an account for yourself in <a href="/users">Users</a>, then sign out and sign back in with it.</p>`
    : `<h1>My Account</h1>
  <p class="sub">${esc(u.display_name)} · ${esc(u.email)} · ${u.role === "admin" ? "Admin" : "Member"}</p>
  ${
    u.must_change_pw
      ? `<div class="flash warn">You signed in with a temporary password. Choose your own password to continue.</div>`
      : ""
  }
  ${f ? `<div class="flash ${f[1]}">${esc(f[0])}</div>` : ""}
  <form method="post" action="/account/password" class="card" style="max-width:420px">
    <h2 style="margin-top:0">Change password</h2>
    <label for="a-current">${u.must_change_pw ? "Temporary password" : "Current password"}</label>
    <input type="password" id="a-current" name="current" autocomplete="current-password" required>
    <label for="a-new">New password <span class="hint">at least ${MIN_PASSWORD_LENGTH} characters; a short phrase works well</span></label>
    <input type="password" id="a-new" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
    <label for="a-confirm">New password again</label>
    <input type="password" id="a-confirm" name="confirm" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
    <div class="actions"><button type="submit">Change Password</button></div>
    <p class="meta" style="margin:8px 0 0">Changing it signs out every other device using this account. This one stays signed in.</p>
  </form>`;
  return c.html(layout({ c, title: "My Account", body }));
});

app.post("/account/password", async (c) => {
  const me = whoami();
  const u = me.userId ? await userById(c.env.DB, me.userId) : null;
  if (!u) return c.redirect("/account");
  const f = await c.req.parseBody();
  const current = typeof f.current === "string" ? f.current : "";
  const pw = typeof f.password === "string" ? f.password : "";
  const confirm = typeof f.confirm === "string" ? f.confirm : "";
  if (!(await verifyPassword(current, u.pw_hash, u.pw_salt, u.pw_iterations))) return c.redirect("/account?flash=wrong");
  if (pw !== confirm) return c.redirect("/account?flash=mismatch");
  if (passwordProblem(pw)) return c.redirect("/account?flash=short");
  if (pw === current) return c.redirect("/account?flash=same");
  const h = await hashPassword(pw);
  const version = u.session_version + 1;
  await c.env.DB.prepare(
    `UPDATE app_user SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, must_change_pw = 0, session_version = ?,
       updated_at = datetime('now') WHERE id = ?`
  )
    .bind(h.hash, h.salt, h.iterations, version, u.id)
    .run();
  await audit(c.env.DB, u.id, "update", `${u.email} changed their password; other sessions ended`);
  // Re-issue THIS device's cookie at the new version, so only the others are signed out.
  setCookie(c, "pp_session", await makeSessionToken(c.env.SESSION_SECRET, u.id, version), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
  return c.redirect(u.must_change_pw ? "/" : "/account?flash=changed");
});

export default app;
