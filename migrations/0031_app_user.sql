-- 0031 — named user accounts (AUTH-001, #94; built 2026-09-25).
--
-- Until now the app had one shared passphrase (APP_PASSWORD) and a session token that carried only an
-- expiry, so it could not know WHO was signed in, and every audit write said the same hardcoded name. The moment a
-- second person signs in, that trail would lie. The owner's decision (2026-09-25) is to share the app
-- both ways: named logins on his own copy, and later a packaged copy other advisors run for themselves.
-- This table is the first half, and the packaged copy's first-run owner uses it too.
--
-- The design was recorded 2026-08-11 (docs/decision-log.md, AUTH-001):
--   - email + password per person, two roles only: admin (manages users) and member (everything else);
--   - passwords hashed with PBKDF2-SHA256 via WebCrypto, salt and iteration count stored PER ROW so the
--     count can be raised later without invalidating anyone;
--   - APP_PASSWORD stays as a break-glass owner sign-in, audited as "owner-passphrase", so a broken
--     account table can never lock the owner out;
--   - one shared dataset: a member sees every contact. Per-user data separation is not the design.
--
-- session_version is how sessions are revoked: tokens carry it, and bumping it (password change,
-- disable, reset) makes every older token for that user invalid on its next request.
-- must_change_pw is set for admin-issued temporary passwords, which must be replaced at first sign-in.
-- failed_logins / locked_until implement the lockout (5 failures, 15 minutes).
--
-- Backups (backup.ts) export every table, so password HASHES are included in the nightly R2 export.
-- Accepted: they are salted PBKDF2, the bucket is private, and a restore without them would lose every
-- account.
--
-- Rollback: DROP TABLE app_user;  — everyone signs in with APP_PASSWORD again, as before this migration.

CREATE TABLE app_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_iterations INTEGER NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 1 CHECK (must_change_pw IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  session_version INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
