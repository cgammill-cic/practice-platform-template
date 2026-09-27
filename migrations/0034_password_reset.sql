-- 0034 — password reset links (Phase 3c, 2026-09-25).
--
-- "Forgot password?" on the sign-in page emails a one-time link, from the copy owner's connected Outlook,
-- to an address that already has an account. This table is the link's other half.
--
-- token_hash — SHA-256 of the random token in the emailed link, never the token itself, so a copy of the
--   database (a backup, say) can't be used to reset anyone's password. The token is 32 random bytes.
-- expires_at — one hour after it was issued (UTC, SQLite datetime format).
-- used_at — set when the link is used; a used link never works again, and using one also voids every
--   other unused link for that account.
-- requested_ip — for the per-IP rate limit and the audit trail.
--
-- Rollback: DROP TABLE password_reset;  (outstanding links stop working; nothing else is affected)

CREATE TABLE password_reset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES app_user(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  requested_ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_password_reset_user ON password_reset(user_id, created_at);
