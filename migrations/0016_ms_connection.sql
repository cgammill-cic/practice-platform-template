-- 0016 — the Microsoft Graph connection (M365-001, issue #99).
--
-- Holds ONE thing: the long-lived refresh token that lets the app read the operator's calendar without
-- signing in again, plus enough context to say on /health whether the connection is alive and whose it is.
--
-- WHY A TABLE AND NOT A SECRET
-- ---------------------------
-- A refresh token is issued at runtime and rotates on use, so it cannot live in a Cloudflare secret — the
-- Worker cannot write its own secrets without an API token, which is the same wall the runbook records for
-- migrations. D1 is the only writable durable store this app has.
--
-- THE TOKEN IS ENCRYPTED AT REST, and the reason is specific rather than reflexive: the nightly backup does
-- `SELECT *` on every table (backup.ts) and writes the result to R2. A plaintext refresh token would
-- therefore sit in thirty days of backup files, each one a standing credential to a live mailbox. Encrypted,
-- a leaked backup yields nothing without the key.
--
-- The key is derived from SESSION_SECRET. That couples two things deliberately: rotating SESSION_SECRET —
-- the documented containment for a lost phone (runbook → Secrets) — also renders this token undecryptable,
-- which disconnects Outlook. That is the correct behaviour rather than a side effect. A lost device should
-- cost the attacker the calendar too, and the recovery is one click on /health. Stated here so nobody
-- "fixes" it later by moving to a static key.
--
-- ONE ROW, ENFORCED
-- -----------------
-- `id INTEGER PRIMARY KEY CHECK (id = 1)` means the table can hold at most one connection, and every read
-- can be `WHERE id = 1` without an ORDER BY that might pick the wrong row. This app has one user; when
-- AUTH-001 gives it several, this becomes per-user and the migration that does it will have to say so.
--
-- account_upn is stored so /health can name whose calendar is connected, and so a DIFFERENT account
-- signing in can be refused rather than silently replacing the first. Reading someone else's calendar into
-- the operator's time sheet by accident is exactly the class of quiet error this codebase keeps refusing.
--
-- last_error holds the reason the most recent refresh failed, or NULL. A connection that has stopped
-- working must say so on /health rather than presenting an import that silently returns no events — the
-- same rule as the backup checks.
--
-- Rollback: DROP TABLE ms_connection;
--   Loses the connection; recovered by clicking Connect and signing in again. Nothing else references it.

CREATE TABLE ms_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Who consented. Display only, plus the guard against a second account replacing the first.
  account_upn TEXT NOT NULL,
  account_id TEXT,
  -- AES-GCM, base64, "iv:ciphertext". Never logged, never returned by any route, never in an audit summary.
  refresh_token_enc TEXT NOT NULL,
  -- The scopes actually granted, as Microsoft reported them — which is not always what was asked for.
  scope TEXT,
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Last time a token was successfully exchanged. Answers "is this still alive" on /health.
  last_used_at TEXT,
  -- Why the last refresh failed, or NULL when healthy.
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- No index: at most one row, always read by primary key.
