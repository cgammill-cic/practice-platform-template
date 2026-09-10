-- 0002_email_split_and_birthday.sql — feedback round 1 (2026-07-30)
-- Applied to practice-platform-dev and practice-platform-prod on 2026-07-30 via Cloudflare API.
--
-- Rationale: "Email / Secondary email" was ambiguous. Contacts frequently have both a
-- corporate address and a personal one, and which is which matters for outreach (personal addresses
-- are far less likely to be filtered as spam — see the escalation ladder in REL-008).
--
-- Rollback:
--   ALTER TABLE contact RENAME COLUMN email_work TO email_primary;
--   ALTER TABLE contact RENAME COLUMN email_personal TO email_secondary;
--   -- birthday column: SQLite cannot DROP COLUMN safely on older versions; leave in place or rebuild table.

ALTER TABLE contact RENAME COLUMN email_primary TO email_work;
ALTER TABLE contact RENAME COLUMN email_secondary TO email_personal;
ALTER TABLE contact ADD COLUMN birthday TEXT;

DROP INDEX IF EXISTS idx_contact_email;
CREATE INDEX idx_contact_email_work ON contact(email_work);
CREATE INDEX idx_contact_email_personal ON contact(email_personal);
