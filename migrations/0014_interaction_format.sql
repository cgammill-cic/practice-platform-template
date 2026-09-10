-- 0014 — what a meeting actually was (REL-026, issue #92).
--
-- "I want to know if (and be able to report on) a meeting was: meal, coffee, Teams,
-- phone call, or other. I'm not sure how to proceed." (2026-08-11)
--
-- A SEPARATE AXIS FROM `type`, not a new type
-- ------------------------------------------
-- `interaction.type` (meeting / call / email / text / linkedin / note) answers HOW you reached someone.
-- This answers WHAT it was, and they are genuinely independent: a "meeting" can be a meal, a coffee or a
-- Teams call.
--
-- Adding formats to `type` would have broken the escalation ladder. `attempts.ts` defines an outreach
-- attempt as an interaction whose type is email, linkedin, text or call — so a `coffee` type would have
-- been silently uncountable, and the stored ladder position would drift from the count on screen. That is
-- exactly the failure #82 fixed and REL-022 exists to detect.
--
-- WHY ADD COLUMN AND NOT A REBUILD
-- --------------------------------
-- SQLite permits a CHECK constraint on ADD COLUMN, and a nullable column passes it on every existing row
-- because `NULL IN (...)` evaluates to NULL rather than false. Verified against sqlite 3.45.1 before
-- writing this: the column is added, existing rows keep NULL, a valid value is accepted, an invalid one is
-- rejected with "CHECK constraint failed", and NULL can still be written back. So unlike 0005, 0009 and
-- 0013 this needs no table rebuild and cannot disturb the 72+ interaction rows or their ids.
--
-- THE LIST IS WORTH SETTLING NOW, because changing it later DOES mean a rebuild. Seven values, covering
-- what was named above plus the distinction that turned out to matter in a real calendar — an in-person
-- meeting that is neither a meal nor a coffee is common enough to deserve its own value rather than
-- landing in `other` beside a phone call.
--
-- `phone` is included even though `type = 'call'` already exists, and the redundancy is deliberate: a
-- scheduled meeting that happened to be held over the phone is a meeting with a phone format, not a
-- cold call. Keeping both lets the ladder count attempts by type while the report describes the venue.
--
-- NEVER REQUIRED, AND NO BACKFILL
-- -------------------------------
-- Nullable, and no attempt to infer a format for the interactions already recorded. A format guessed from
-- an old subject line would be invented data in a column whose whole purpose is to be counted. The one
-- clue that exists — "Ascension Coffee - Addison" in a calendar location on 2026-08-13 — is a coincidence
-- of one row, not a rule.
--
-- Rollback: ALTER TABLE interaction DROP COLUMN format;  (SQLite 3.35+ and D1 support it.)

ALTER TABLE interaction ADD COLUMN format TEXT CHECK (format IN (
  'meal','coffee','in_person_other','teams','phone','video_other','other'
));

-- Reporting reads "every interaction in a period, grouped by format", so date leads and format follows.
CREATE INDEX idx_interaction_format ON interaction(date, format);
