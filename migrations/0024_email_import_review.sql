-- 0024 — email import needs "no" as well as "yes" (2026-09-09).
--
-- THE PROBLEM. /email/import (MAIL-001) can log a message as an interaction, or leave it unticked — and
-- unticked is not a decision, it is silence. The preview re-fetches the live mailbox on every visit, so
-- anything never logged reappears every single time that week is reviewed, forever. "if I don't
-- bring them in, they keep showing up on the list."
--
-- Two different problems share that one symptom, so this migration is two small additions, not one:
--
--   1. A single message needs a real "no" that sticks — not just "not yet". Table below.
--   2. A whole PERSON can need "no" — project work with someone like a busy back-and-forth counterpart
--      produces mail every day, and none of it is worth a prompt once that's known. A column on
--      contact, the same shape as 0011's no_linkedin: a flag nobody defaults to a claim about, only ever
--      set by a person clicking a button.
--
-- WHY A SEPARATE TABLE FOR THE EXCLUSION, NOT A ROW IN interaction. interaction is a record of a
-- conversation that actually happened (contactList.ts's own delete-guard rationale: "conversations that
-- actually happened"). An excluded message is the opposite fact — someone looked at it and decided it is
-- NOT part of this contact's history. Writing it into interaction would corrupt the one table every
-- report, chase-list count and attempt-ladder calculation already trusts to mean "a real touch".
--
-- WHY email_import_exclusion CASCADES RATHER THAN BEING HANDLED BY HAND (READ THIS BEFORE ADDING A TABLE
-- THAT REFERENCES contact — see docs/definitions.md §4a, and health.ts's HANDLED set). Unlike every table
-- REL-031 is about, this one carries no history worth preserving: it is pure review-UI state saying
-- "don't ask me about this again", nothing else in the app ever reads it, and no audit concern survives
-- the contact being deleted. So it gets ON DELETE CASCADE deliberately, on purpose, the same reasoning
-- 0022_pursuit.sql used for engagement_contact's cascade on the ENGAGEMENT side.
--
-- IT STILL NEEDS A LINE IN HANDLED, THOUGH — checked by actually adding this table and watching the
-- check turn red before adding that line, the same way REL-031's own note describes verifying it in the
-- failing direction. The health check's query only asks "does some table's CREATE TABLE reference
-- contact(", not whether that reference cascades, so a perfectly-safe cascaded table still has to be
-- named or the check itself goes stale. Nothing goes in contactList.ts for it: SQLite clears the row on
-- its own. See the HANDLED comment in health.ts for the one-line note that says so.
--
-- Composite primary key (message_id, contact_id) rather than a surrogate id: an exclusion means exactly
-- one thing — this message, for this contact, is decided — so the natural key is what a second exclude
-- click should collide with harmlessly (INSERT OR IGNORE), the same idempotence outlook_ref already gives
-- the interaction side.
--
-- Rollback: DROP TABLE email_import_exclusion; ALTER TABLE contact DROP COLUMN email_import_ignore
-- (SQLite 3.35+ and D1). Both losses are recoverable from audit_event, which every set/unset writes to.

CREATE TABLE email_import_exclusion (
  message_id TEXT NOT NULL,
  contact_id INTEGER NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  excluded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, contact_id)
);

ALTER TABLE contact ADD COLUMN email_import_ignore INTEGER NOT NULL DEFAULT 0;
