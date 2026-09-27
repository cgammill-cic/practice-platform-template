/*
 * M365-001 — connecting to Microsoft Graph (#99).
 *
 * This module is ONLY the connection: sign in, hold a refresh token safely, hand out an access token when
 * something needs one, and say plainly whether it is working. The calendar import that consumes it is a
 * separate piece of work, deliberately — the sign-in round trip is the one part of this that only the owner
 * can verify, so it reaches him before anything is built on top of it.
 *
 * DELEGATED, READ-ONLY, ONE USER
 * ------------------------------
 * The authorization code flow with a confidential client, requesting `Calendars.Read` — the app acts as
 * The owner and can see exactly what he can see. The alternative, app-only client credentials, would have
 * granted access to every mailbox in the tenant by default, narrowable afterwards with a policy. Least
 * privilege was cheaper here than the cleanup.
 *
 * PKCE IS INCLUDED even though a confidential client does not require it. It costs a hash and it removes a
 * whole class of failure — an authorization code intercepted in transit is useless without the verifier,
 * which never leaves this Worker.
 *
 * BOTH ROUTES SIT BEHIND THE APP'S OWN PASSPHRASE, which is a security decision rather than an oversight.
 * The callback is a URL Microsoft redirects a browser to, so it is reachable by anyone who can guess it;
 * behind the session gate, a stranger holding a stolen code cannot complete a connection. The redirect is a
 * top-level GET navigation, so the SameSite=Lax session cookie is sent and the flow still works.
 *
 * WHAT IS NOT STORED
 * ------------------
 * Access tokens. They live about an hour, and caching one would put a second credential at rest to save a
 * round trip on a weekly import. The refresh token is exchanged for a fresh access token on demand.
 */

import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { esc, layout } from "./views";
import type { Bindings, D1Db } from "./types";
import { actor } from "./auth";

const app = new Hono<{ Bindings: Bindings }>();

/** Scopes requested. Read-only on the calendar; nothing here ever writes to Outlook. */
/*
 * Mail.ReadBasic added 2026-09-01 (MAIL-001) and the choice is deliberate: it carries sender,
 * recipients, subject and date — everything an interaction record needs — while excluding message
 * BODIES. The app therefore cannot read what the owner wrote to a client or what they wrote back, which
 * is the right default for a tool whose value to those clients rests on discretion. Widening to
 * Mail.Read is one word here plus a re-consent, if bodies are ever wanted in notes.
 *
 * CHANGING THIS STRING BREAKS THE WHOLE CONNECTION UNTIL SOMEONE SIGNS IN AGAIN. Not just the new
 * capability — everything, calendar included.
 *
 * This paragraph previously predicted the opposite: "an existing connection keeps working with the OLD
 * set and mail calls 403". That was wrong, and it was wrong in production on 2026-09-01. The refresh in
 * msAccessToken sends THIS string, so every refresh after the change asks Microsoft for a permission the
 * stored grant does not carry, and the answer is `invalid_grant` — a dead connection, not a narrower one.
 * The calendar import went down with it.
 *
 * So a scope change is a deploy that requires an immediate reconnect, and should be announced that way.
 * MAIL-002 made that survivable: /health always offers Reconnect, and the invalid_grant message names a
 * scope change as the likeliest cause before the password-change explanations.
 */
/*
 * Mail.Send added 2026-09-02 (DIGEST-001). It is the first capability in this app that can send anything
 * to another human, so the narrowest useful version was chosen at the call site rather than here: the
 * digest addresses `ms_connection.account_upn` and nothing else — not a parameter, not a setting, not
 * anything a contact controls. There is no code path in this app that emails a third party.
 *
 * It also makes issue #95 and open decision O-8 (which transactional email service) unnecessary: the
 * outbound mail that AUTH-002 scoped a whole vendor integration for is one added scope on a connection
 * that already exists.
 */
/*
 * 2026-09-21 (MAIL-003, the owner) — WIDENED TO Mail.Read. The paragraph above was the right call until he
 * asked for the opposite: a logged email's plain-text content copied into the interaction's Summary box,
 * so he is not retyping what a message said every time he imports one. That needs the body, which
 * ReadBasic does not carry, so the scope grew. The body is still fetched only for messages he actually
 * ticks to log — see fetchMessageBody() in mailimport.ts — never for the whole week's preview, and only
 * when the mail_body_to_summary setting (src/settings.ts) is on; he asked for an off switch in the same
 * breath he asked for this, in case a future user of this app finds it more than they want pulled in.
 *
 * CHANGING THIS STRING BREAKS THE WHOLE CONNECTION UNTIL SOMEONE SIGNS IN AGAIN — same consequence as the
 * 2026-09-01 change documented above, and the same fix: reconnect once from /health.
 */
/*
 * 2026-09-25 (outreach drafting, Phase 2a) — Mail.ReadWrite added, so an outreach draft can be saved
 * into the Drafts folder (POST /me/messages). It creates DRAFTS only; nothing here sends them, and
 * Mail.Send stays confined to the digest-to-self path described above.
 *
 * AND THE WARNING ABOVE NO LONGER HOLDS. A refresh now asks only for the scopes the stored grant
 * actually carries (refreshScopes below), so adding a scope here no longer kills the connection: the
 * calendar sync, email import and digest keep working on the old grant, and only the new capability
 * waits for a reconnect (hasScope, reported on /outreach and /health).
 */
export const MS_SCOPES = "offline_access User.Read Calendars.Read Mail.Read Mail.ReadWrite Mail.Send";

/** Does a granted scope string (as Microsoft returned it) include `scope`? Bare or URL-prefixed. */
export function grantHas(granted: string | null | undefined, scope: string): boolean {
  const want = scope.toLowerCase();
  return (granted ?? "")
    .toLowerCase()
    .split(/\s+/)
    .some((s) => s === want || s.endsWith(`/${want}`));
}

/**
 * The scopes to send on a refresh: the ones requested that the grant already has, plus offline_access.
 * An unknown grant (a row saved before scopes were recorded) falls back to everything, the old behaviour.
 */
export function refreshScopes(granted: string | null | undefined): string {
  if (!granted) return MS_SCOPES;
  return MS_SCOPES.split(" ")
    .filter((s) => s === "offline_access" || grantHas(granted, s))
    .join(" ");
}

/** Short-lived cookie carrying the PKCE verifier and the CSRF nonce between redirect and callback. */
const FLOW_COOKIE = "pp_ms_flow";
const FLOW_TTL_SECONDS = 600;

/**
 * Where Microsoft's endpoints live. Overridable ONLY so the token exchange can be driven against a local
 * stub in tests — the real OAuth round trip cannot be completed from the build environment (no browser
 * session as the owner, no outbound network to Microsoft), so a stub is the only way to test the exchange,
 * the refresh path and an expired-grant failure at all. Unset in production, where it defaults below.
 * Anyone who can set this variable can already replace the whole Worker, so it adds no attack surface.
 */
const authBase = (env: Bindings) => env.MS_AUTH_BASE ?? "https://login.microsoftonline.com";
const authorizeUrl = (env: Bindings) => `${authBase(env)}/${env.MS_TENANT_ID}/oauth2/v2.0/authorize`;
const tokenUrl = (env: Bindings) => `${authBase(env)}/${env.MS_TENANT_ID}/oauth2/v2.0/token`;
export const graphBase = (env: Bindings) => env.MS_GRAPH_BASE ?? "https://graph.microsoft.com/v1.0";

/** True when all three secrets are set. Reported on /health so a missing one is visible, not mysterious. */
export function msConfigured(env: Bindings): boolean {
  return Boolean(env.MS_CLIENT_ID && env.MS_TENANT_ID && env.MS_CLIENT_SECRET);
}

// ---------------------------------------------------------------- crypto

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * The AES-GCM key for the refresh token, derived from SESSION_SECRET.
 *
 * See migration 0016 on why this coupling is intentional: rotating SESSION_SECRET disconnects Outlook, and
 * that is the right outcome for a lost device. The suffix is a version marker — if the derivation ever
 * needs to change, bumping it invalidates old ciphertext loudly rather than producing garbage.
 */
async function tokenKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", enc.encode(`${secret}::ms-token-v1`));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptToken(secret: string, plain: string): Promise<string> {
  const key = await tokenKey(secret);
  // A fresh 12-byte IV per encryption. Reusing one with AES-GCM is the classic way to lose everything.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
  return `${b64(iv)}:${b64(new Uint8Array(ct))}`;
}

/** Returns null rather than throwing when the ciphertext will not open — a rotated SESSION_SECRET. */
async function decryptToken(secret: string, stored: string): Promise<string | null> {
  const [ivPart, ctPart] = stored.split(":");
  if (!ivPart || !ctPart) return null;
  try {
    const key = await tokenKey(secret);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(ivPart) },
      key,
      unb64(ctPart)
    );
    return dec.decode(plain);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- connection state

export interface MsConnection {
  account_upn: string;
  account_id: string | null;
  scope: string | null;
  connected_at: string;
  last_used_at: string | null;
  last_error: string | null;
}

/** The stored connection, or null. Never returns the token — no caller outside this module needs it. */
export async function msConnection(db: D1Db): Promise<MsConnection | null> {
  return db
    .prepare(
      "SELECT account_upn, account_id, scope, connected_at, last_used_at, last_error FROM ms_connection WHERE id = 1"
    )
    .first<MsConnection>();
}

async function noteError(db: D1Db, message: string) {
  await db
    .prepare("UPDATE ms_connection SET last_error = ?, updated_at = datetime('now') WHERE id = 1")
    .bind(message.slice(0, 300))
    .run();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(env: Bindings, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(tokenUrl(env), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  // Microsoft returns JSON for errors too, with error / error_description. A non-JSON body means something
  // else answered — a proxy, an outage — and is surfaced as an error rather than parsed hopefully.
  const text = await res.text();
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    return { error: "non_json_response", error_description: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
}

/**
 * A usable access token, or an error explaining why not.
 *
 * The refresh token ROTATES: Microsoft may return a new one on every exchange, and the old one stops
 * working. Storing the new one is not optional — miss it once and the connection dies at the following
 * refresh, days later, for no visible reason.
 *
 * A failed refresh is recorded on the row so /health can say so. `invalid_grant` specifically means the
 * grant is gone for good — password changed, consent revoked, sessions signed out — and reconnecting is the
 * only fix, so the message says that rather than inviting a retry that cannot succeed.
 */
/**
 * Does this connection need a fresh sign-in rather than a retry?
 *
 * Matched on the stored error text rather than a stored code, because `ms_connection` has no column for
 * one and adding a migration to carry a boolean the message already implies would be the more expensive
 * of the two wrongs. The marker is the literal Microsoft error name, which is stable and appears in
 * exactly one message this app writes.
 */
export function needsReauth(lastError: string | null | undefined): boolean {
  return (lastError ?? "").includes("invalid_grant");
}

export async function msAccessToken(
  env: Bindings,
  db: D1Db
): Promise<{ token: string } | { error: string }> {
  if (!msConfigured(env)) return { error: "Microsoft credentials are not configured on this deployment." };
  const row = await db
    .prepare("SELECT refresh_token_enc, scope FROM ms_connection WHERE id = 1")
    .first<{ refresh_token_enc: string; scope: string | null }>();
  if (!row) return { error: "Outlook is not connected yet." };

  const refresh = await decryptToken(env.SESSION_SECRET, row.refresh_token_enc);
  if (!refresh) {
    const msg =
      "The stored Outlook token could not be decrypted, which happens when SESSION_SECRET has been rotated. Reconnect Outlook.";
    await noteError(db, msg);
    return { error: msg };
  }

  const res = await postToken(env, {
    grant_type: "refresh_token",
    client_id: env.MS_CLIENT_ID!,
    client_secret: env.MS_CLIENT_SECRET!,
    refresh_token: refresh,
    scope: refreshScopes(row.scope),
  });

  if (res.error || !res.access_token) {
    const permanent = res.error === "invalid_grant";
    /*
     * The cause list used to omit the one that actually happened. Adding Mail.ReadBasic to MS_SCOPES on
     * 2026-09-01 made every refresh ask for a permission the stored grant did not carry, and Microsoft
     * answered invalid_grant — so the connection died for a reason the message did not mention, and the
     * remedy it gave ("Reconnect Outlook") pointed at a panel that had no reconnect button. Both halves
     * are fixed: the cause is named first because a scope change is the likeliest trigger by far, and the
     * remedy names the control rather than the action.
     */
    const msg = permanent
      ? `Microsoft rejected the stored token (${res.error}). This is permanent — reconnecting is the only fix. The usual cause is that the app now asks for a permission your existing sign-in does not cover; it also happens after a password change, a sign-out-everywhere, or consent being revoked. Open Outlook settings on /health and use Reconnect.`
      : `Could not refresh the Outlook token: ${res.error ?? "no access token returned"}${
          res.error_description ? ` — ${res.error_description}` : ""
        }`;
    await noteError(db, msg);
    return { error: msg };
  }

  if (res.refresh_token && res.refresh_token !== refresh) {
    await db
      .prepare(
        "UPDATE ms_connection SET refresh_token_enc = ?, updated_at = datetime('now') WHERE id = 1"
      )
      .bind(await encryptToken(env.SESSION_SECRET, res.refresh_token))
      .run();
  }
  await db
    .prepare(
      "UPDATE ms_connection SET last_used_at = datetime('now'), last_error = NULL, updated_at = datetime('now') WHERE id = 1"
    )
    .run();
  return { token: res.access_token };
}

// ---------------------------------------------------------------- the flow

app.get("/auth/microsoft", async (c) => {
  if (!msConfigured(c.env))
    return c.redirect("/health?msflash=notconfigured");

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)))
  );

  /*
   * The verifier and the CSRF nonce ride in one httpOnly cookie rather than in a table. They are valid for
   * ten minutes and belong to one browser round trip, so a row in D1 would be state to clean up for no
   * gain. httpOnly so no script can read the verifier; Lax so the cookie survives Microsoft's redirect back.
   */
  setCookie(c, FLOW_COOKIE, `${nonce}.${verifier}`, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: FLOW_TTL_SECONDS,
  });

  const url = new URL(authorizeUrl(c.env));
  url.searchParams.set("client_id", c.env.MS_CLIENT_ID!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri(c.req.url));
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", MS_SCOPES);
  url.searchParams.set("state", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Force the account chooser: without it, a signed-in browser reconnects the same account silently, which
  // is unhelpful precisely when you are trying to change which account is connected.
  url.searchParams.set("prompt", "select_account");
  return c.redirect(url.toString());
});

/**
 * The redirect URI, derived from the request rather than configured.
 *
 * It must match the value registered in Entra byte for byte or Microsoft refuses the exchange, so deriving
 * it from the URL the browser actually used removes the chance of a config drifting from the registration.
 * The registered values are the deployed origin and http://localhost:8787 for local work.
 */
function redirectUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/auth/microsoft/callback`;
}

app.get("/auth/microsoft/callback", async (c) => {
  const flow = getCookie(c, FLOW_COOKIE);
  deleteCookie(c, FLOW_COOKIE, { path: "/" });

  const error = c.req.query("error");
  if (error)
    return c.redirect(
      `/health?msflash=denied&msdetail=${encodeURIComponent(
        c.req.query("error_description") ?? error
      )}`
    );

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state || !flow) return c.redirect("/health?msflash=badflow");

  const [nonce, verifier] = flow.split(".");
  /*
   * Constant-time-ish comparison is not needed here — the nonce is single-use, expires in ten minutes, and
   * an attacker who could read the cookie already has the session. What matters is that the comparison
   * happens at all: without it, a link crafted by someone else could complete a connection in this browser.
   */
  if (!nonce || nonce !== state || !verifier) return c.redirect("/health?msflash=badstate");

  const res = await postToken(c.env, {
    grant_type: "authorization_code",
    client_id: c.env.MS_CLIENT_ID!,
    client_secret: c.env.MS_CLIENT_SECRET!,
    code,
    redirect_uri: redirectUri(c.req.url),
    code_verifier: verifier,
    scope: MS_SCOPES,
  });

  if (res.error || !res.access_token || !res.refresh_token) {
    const detail = res.error_description ?? res.error ?? "no tokens returned";
    return c.redirect(`/health?msflash=exchangefailed&msdetail=${encodeURIComponent(detail)}`);
  }

  // Who actually signed in. Read from Graph rather than from the id_token, because the app already needs to
  // prove the access token WORKS — a connection that stores a token it has never used is a connection that
  // fails later, on a Friday, during an import.
  const me = await fetch(`${graphBase(c.env)}/me`, {
    headers: { authorization: `Bearer ${res.access_token}` },
  });
  if (!me.ok)
    return c.redirect(
      `/health?msflash=exchangefailed&msdetail=${encodeURIComponent(
        `the token was issued but Graph refused it (HTTP ${me.status})`
      )}`
    );
  const profile = (await me.json()) as { userPrincipalName?: string; id?: string };
  const upn = profile.userPrincipalName ?? "unknown";

  /*
   * A DIFFERENT ACCOUNT IS REFUSED rather than allowed to replace the first.
   *
   * Reading a second person's calendar into this time sheet would be silent and wrong — the hours would
   * look plausible and belong to somebody else. Disconnecting first is one click, and makes the swap
   * deliberate.
   */
  const existing = await msConnection(c.env.DB);
  if (existing && existing.account_upn.toLowerCase() !== upn.toLowerCase())
    return c.redirect(
      `/health?msflash=wrongaccount&msdetail=${encodeURIComponent(
        `${upn} signed in, but ${existing.account_upn} is already connected`
      )}`
    );

  const encrypted = await encryptToken(c.env.SESSION_SECRET, res.refresh_token);
  await c.env.DB.prepare(
    `INSERT INTO ms_connection (id, account_upn, account_id, refresh_token_enc, scope, last_used_at, last_error)
     VALUES (1, ?, ?, ?, ?, datetime('now'), NULL)
     ON CONFLICT(id) DO UPDATE SET account_upn = excluded.account_upn, account_id = excluded.account_id,
       refresh_token_enc = excluded.refresh_token_enc, scope = excluded.scope,
       connected_at = datetime('now'), last_used_at = datetime('now'), last_error = NULL,
       updated_at = datetime('now')`
  )
    .bind(upn, profile.id ?? null, encrypted, res.scope ?? null)
    .run();

  // The audit event records the connection, the account and the scopes — never the token.
  await c.env.DB.prepare(
    "INSERT INTO audit_event (actor, entity, entity_id, action, after_summary, source) VALUES (?,'ms_connection','1','create',?, 'app')"
  )
    .bind(actor(), `connected Outlook as ${upn} · scopes: ${res.scope ?? MS_SCOPES}`)
    .run();

  return c.redirect("/health?msflash=connected");
});

app.post("/auth/microsoft/disconnect", async (c) => {
  const existing = await msConnection(c.env.DB);
  if (!existing) return c.redirect("/health");
  await c.env.DB.prepare("DELETE FROM ms_connection WHERE id = 1").run();
  await c.env.DB.prepare(
    "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, source) VALUES (?,'ms_connection','1','delete',?,'app')"
  )
    .bind(actor(), `disconnected Outlook (was ${existing.account_upn})`)
    .run();
  /*
   * The token is deleted here but NOT revoked at Microsoft — Graph has no simple revoke-this-token call, and
   * the honest thing is to say so rather than imply more than happened. Deleting the row means this app can
   * no longer use it; the grant itself is withdrawn from myaccount.microsoft.com. The flash says both.
   */
  return c.redirect("/health?msflash=disconnected");
});

/** A one-call proof that the connection works, for the health page button. */
app.post("/auth/microsoft/test", async (c) => {
  const token = await msAccessToken(c.env, c.env.DB);
  if ("error" in token)
    return c.redirect(`/health?msflash=testfailed&msdetail=${encodeURIComponent(token.error)}`);
  const res = await fetch(`${graphBase(c.env)}/me/calendar`, {
    headers: { authorization: `Bearer ${token.token}` },
  });
  if (!res.ok)
    return c.redirect(
      `/health?msflash=testfailed&msdetail=${encodeURIComponent(
        `Graph refused the request (HTTP ${res.status})`
      )}`
    );
  return c.redirect("/health?msflash=testok");
});

/** The connection panel on /health. Rendered there rather than here so the page keeps one layout. */
export function msPanel(env: Bindings, conn: MsConnection | null, flash: string, detail: string): string {
  const FLASH: Record<string, string> = {
    connected: "Outlook connected. The calendar can now be read for the import.",
    disconnected:
      "Outlook disconnected and the stored token deleted. Note this app can no longer use it, but the consent itself still exists in your Microsoft account — remove it at myaccount.microsoft.com if you want it gone entirely.",
    notconfigured:
      "Microsoft credentials are not set on this deployment, so there is nothing to connect to yet.",
    denied: "Sign-in was cancelled or refused at Microsoft, so nothing changed.",
    badflow:
      "That sign-in did not carry the information it started with — usually because it took more than ten minutes or was opened in a different browser. Start again.",
    badstate:
      "The sign-in came back with a value that did not match the one sent, so it was refused. Start again from this page rather than from a link.",
    exchangefailed: "Microsoft issued no usable token, so nothing was stored.",
    wrongaccount: "That is a different account from the one already connected, so nothing changed.",
    testok: "The connection works — Microsoft answered a live request for your calendar just now.",
    testfailed: "The connection did not answer.",
  };
  const isGood = flash === "connected" || flash === "testok";
  const flashHtml = FLASH[flash]
    ? `<p class="flash ${isGood ? "ok" : "warn"}">${esc(FLASH[flash])}${
        detail ? ` <span class="meta">(${esc(detail)})</span>` : ""
      }</p>`
    : "";

  if (!msConfigured(env))
    return `<section>
    <h2>Outlook Calendar <span class="pill grey" style="margin-left:6px">Not set up</span></h2>
    ${flashHtml}
    <p style="margin:0 0 6px">Not configured on this deployment. The calendar import needs three secrets set in Cloudflare — <code>MS_CLIENT_ID</code>, <code>MS_TENANT_ID</code> and <code>MS_CLIENT_SECRET</code>.</p>
    <p class="meta" style="margin:0">Which ones are missing is not shown, deliberately: this page is behind your passphrase but naming absent credentials is still free information. Set all three and this panel will offer to connect.</p>
  </section>`;

  if (!conn)
    return `<section>
    <h2>Outlook Calendar <span class="pill amber" style="margin-left:6px">Not connected</span></h2>
    ${flashHtml}
    <p style="margin:0 0 6px">Configured but not connected. Signing in once lets the app read your calendar for the weekly time import; it never writes to it.</p>
    <p class="meta" style="margin:0 0 12px">Read-only access to your calendar, your email, and your own profile. You stay signed in until you disconnect here, change your password, or sign out everywhere.</p>
    <div class="actions"><a class="btn" href="/auth/microsoft">Connect Outlook</a></div>
  </section>`;

  const state = conn.last_error ? "red" : "green";
  return `<section>
    <h2>Outlook Calendar <span class="pill ${state}" style="margin-left:6px">${
      conn.last_error ? "Needs attention" : "Connected"
    }</span></h2>
    ${flashHtml}
    <dl class="grid2">
      <dt>Account</dt><dd>${esc(conn.account_upn)}</dd>
      <dt>Connected</dt><dd>${esc(conn.connected_at)}</dd>
      <dt>Last used</dt><dd>${esc(conn.last_used_at ?? "never")}</dd>
      <dt>Scopes granted</dt><dd class="meta">${esc(conn.scope ?? "not reported")}</dd>
    </dl>
    ${
      conn.last_error
        ? `<p class="flash warn" style="margin-top:10px">${esc(conn.last_error)}</p>`
        : ""
    }
    ${
      // Outreach drafting (Phase 2a): the one capability that waits on a reconnect. Everything else works.
      !canSaveDrafts(conn)
        ? `<p class="flash warn" style="margin-top:10px">Outreach email drafts can't be saved to Outlook yet: this sign-in predates that permission. Use <b>Reconnect</b> below once; the calendar sync and email import keep working either way.</p>`
        : ""
    }
    ${/*
      RECONNECT IS OFFERED WHENEVER A CONNECTION EXISTS (MAIL-002, 2026-09-01). It is here because its
      absence was a dead end I built and the owner walked straight into.

      Adding Mail.ReadBasic to MS_SCOPES broke the refresh outright. The refresh request sends the CURRENT
      scope string, Microsoft will not issue a token covering a scope the user never consented to, and the
      whole connection failed with `invalid_grant` — calendar included, not merely mail. The error text
      correctly said "Reconnect Outlook". This panel then offered Test and Disconnect and nothing else,
      because the Connect button only rendered when there was NO connection row. The instruction pointed
      at a screen that could not carry it out, and the real path — Disconnect, then Connect — had to be
      guessed.

      SHOWN FOR A HEALTHY CONNECTION TOO, not only a broken one. Re-consenting a working connection is
      harmless: it overwrites the same row. Hiding the control until something breaks means it is missing
      on the one day it is needed, and a scope change makes "something breaks" the ordinary case rather
      than the exception. It is the quieter secondary style until there is an error, then it leads.
    */ ""}
    <div class="actions">
      <a class="btn${conn.last_error ? "" : " secondary"}" href="/auth/microsoft">Reconnect</a>
      <form method="post" action="/auth/microsoft/test"><button class="secondary" type="submit">Test the connection</button></form>
      <form method="post" action="/auth/microsoft/disconnect"><button class="secondary" type="submit">Disconnect</button></form>
    </div>
    ${
      needsReauth(conn.last_error)
        ? `<p class="flash warn" style="margin-top:10px"><b>This needs a reconnect, not a retry.</b> The stored permission no longer covers what the app asks for. That happens when the app gains a new capability — the mail import added one on 2026-09-01 — and also after a password change or a sign-out-everywhere. One sign-in fixes it. Nothing else is affected: your logged time, contacts and history are untouched.</p>`
        : ""
    }
    <p class="meta" style="margin-top:10px">Read-only. Rotating <code>SESSION_SECRET</code> disconnects this as well as signing you out everywhere — deliberately, so a lost phone costs an attacker the calendar too. Reconnecting is one click.</p>
  </section>`;
}

/** Layout wrapper for the rare case something needs its own page. Kept minimal; the panel lives on /health. */
// No caller today (verified: no route in src/ mounts a page through this) — kept compiling here so a
// future caller has it ready, and flagged separately as dead-code worth removing if it stays unused.
export const msPage = (c: Context<{ Bindings: Bindings }>, body: string) =>
  layout({ title: "Outlook Calendar", body: `<main>${body}</main>`, c });

/*
 * Sending to account holders (Phase 3c, 2026-09-25). Mail.Send was confined to "the digest, to the
 * connected account only" (see MS_SCOPES above). It now also carries invites and password-reset links,
 * and it is still narrow on purpose: sendMailAsOwner refuses any address that isn't an account on this
 * copy (app_user), so no contact, and no address a stranger types, can ever be emailed by the app.
 */
export const canSendMail = (conn: MsConnection | null) => !!conn && grantHas(conn.scope, "Mail.Send");

export async function sendMailAsOwner(
  env: Bindings,
  db: D1Db,
  msg: { to: string; subject: string; text: string }
): Promise<{ ok: true } | { error: string }> {
  const account = await db
    .prepare("SELECT 1 AS x FROM app_user WHERE email = ? COLLATE NOCASE")
    .bind(msg.to.trim())
    .first()
    .catch(() => null);
  if (!account) return { error: "That address isn't an account on this copy, so the app won't email it." };
  const conn = await msConnection(db);
  if (!canSendMail(conn)) return { error: "Outlook isn't connected with permission to send, so nothing was emailed." };
  const tok = await msAccessToken(env, db);
  if ("error" in tok) return tok;
  const res = await fetch(`${graphBase(env)}/me/sendMail`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: msg.subject,
        body: { contentType: "Text", content: msg.text },
        toRecipients: [{ emailAddress: { address: msg.to.trim() } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) return { error: `Outlook refused to send (${res.status}).${res.status === 403 ? " Reconnect Outlook on Health." : ""}` };
  return { ok: true };
}

/** Can this connection save Outlook drafts (Mail.ReadWrite granted)? */
export const canSaveDrafts = (conn: MsConnection | null) => !!conn && grantHas(conn.scope, "Mail.ReadWrite");

/**
 * Save an outreach draft into the connected mailbox's Drafts folder (Phase 2a). DRAFT ONLY: this is
 * POST /me/messages, which creates an unsent message; it never calls /send. Plain text body, one
 * recipient. Returns the draft's id and the Outlook web link that opens it for review.
 */
export async function createOutlookDraft(
  env: Bindings,
  db: D1Db,
  msg: { to: string; subject: string; body: string }
): Promise<{ id: string; webLink: string | null } | { error: string }> {
  const conn = await msConnection(db);
  if (!canSaveDrafts(conn)) return { error: "Reconnect Outlook on Health to allow saving drafts." };
  const tok = await msAccessToken(env, db);
  if ("error" in tok) return tok;
  const res = await fetch(`${graphBase(env)}/me/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      subject: msg.subject,
      body: { contentType: "Text", content: msg.body },
      toRecipients: [{ emailAddress: { address: msg.to } }],
    }),
  });
  if (!res.ok) {
    const hint = res.status === 403 ? " Reconnect Outlook on Health to grant draft access." : "";
    return { error: `Outlook refused the draft (${res.status}).${hint}` };
  }
  const j = (await res.json()) as { id?: string; webLink?: string };
  return j.id ? { id: j.id, webLink: j.webLink ?? null } : { error: "Outlook did not return a draft id." };
}

/**
 * Update an outreach draft already in Outlook (after an edit or a redraft), so there is one draft per
 * person rather than a pile. PATCH on a draft only; a message that has since been sent can't be
 * changed, and Graph says so, which comes back as an error on the item.
 */
export async function updateOutlookDraft(
  env: Bindings,
  db: D1Db,
  id: string,
  msg: { to: string; subject: string; body: string }
): Promise<{ id: string; webLink: string | null } | { error: string }> {
  const conn = await msConnection(db);
  if (!canSaveDrafts(conn)) return { error: "Reconnect Outlook on Health to allow saving drafts." };
  const tok = await msAccessToken(env, db);
  if ("error" in tok) return tok;
  const res = await fetch(`${graphBase(env)}/me/messages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      subject: msg.subject,
      body: { contentType: "Text", content: msg.body },
      toRecipients: [{ emailAddress: { address: msg.to } }],
    }),
  });
  if (res.status === 404) return createOutlookDraft(env, db, msg); // deleted in Outlook: make a fresh one
  if (!res.ok) return { error: `Outlook didn't accept the change (${res.status}). If it was already sent, log it as sent.` };
  const j = (await res.json()) as { id?: string; webLink?: string };
  return { id: j.id ?? id, webLink: j.webLink ?? null };
}

export default app;
