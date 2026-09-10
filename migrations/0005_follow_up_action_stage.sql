-- 0005 — add 'follow_up_action' to the contact.stage CHECK constraint.
--
-- Why this exists
-- ---------------
-- REL-020 (#40) added the follow_up_action stage to STAGES in src/types.ts but not to the database.
-- contact.stage carries a CHECK constraint listing the ten original stages, so every attempt to write
-- the new value was rejected by SQLite and surfaced as an Internal Server Error. Found in production
-- on 2026-07-31 when resolving Edgar Huerta's meeting and ticking "also apply this stage to the
-- contact": the interaction saved, the write-through to the contact threw, and the stage was unusable
-- everywhere until this ran.
--
-- The constraint is deliberately kept rather than dropped. Every dashboard section selects on literal
-- stage strings, and Needs Attention matches an explicit list, so a contact holding an unrecognized
-- stage appears in NO section — invisible, with nothing about the record looking wrong. The constraint
-- turns that silent, permanent failure into a loud, immediate one. The cost is this file: adding a
-- stage now requires a migration alongside the code change.
--
-- SQLite cannot ALTER a CHECK constraint, so the table must be rebuilt.
--
-- Sequence notes (learned the hard way)
-- -------------------------------------
-- 1. The replacement table's self-reference must point at ITSELF (contact_new), not at `contact`.
--    Pointing at `contact` leaves a dangling reference the moment the old table is dropped, and D1
--    rolls the whole batch back.
-- 2. `PRAGMA defer_foreign_keys` did not save the drop: interaction.contact_id REFERENCES contact(id)
--    with foreign_keys=1, so DROP TABLE contact fails while any interaction row exists. The rows are
--    parked in a temporary table and restored after the rename, which keeps every id intact.
-- 3. ALTER TABLE ... RENAME rewrites the renamed table's own FK text, so contact_new's self-reference
--    becomes `REFERENCES contact(id)` automatically.
--
-- Applied to practice-platform-prod manually on 2026-07-31 (285 contacts, 9 interactions, verified by
-- row count and SUM(id) before and after). Audit trail: correlation_id 'migration-0005'.
-- Run this against practice-platform-dev to bring it into line.

CREATE TABLE contact_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  title TEXT,
  organization_id INTEGER REFERENCES organization(id),
  department TEXT,
  email_work TEXT,
  email_personal TEXT,
  phone TEXT,
  linkedin_url TEXT,
  stage TEXT NOT NULL DEFAULT 'not_contacted' CHECK (stage IN ('meeting_scheduled','follow_up_action','in_conversation','awaiting_response','reach_out_later','not_contacted','stay_connected','complete','no_response','retired','not_qualified')),
  strength TEXT CHECK (strength IN ('strong','warm','new','cold')),
  priority_tier INTEGER,
  escalation_rung INTEGER NOT NULL DEFAULT 0,
  referral_source_contact_id INTEGER REFERENCES contact_new(id),
  last_touch TEXT,
  next_follow_up TEXT,
  notes TEXT,
  source TEXT,
  import_meta TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  birthday TEXT,
  meeting_date TEXT,
  meeting_time TEXT
);

INSERT INTO contact_new (id, full_name, title, organization_id, department, email_work, email_personal,
  phone, linkedin_url, stage, strength, priority_tier, escalation_rung, referral_source_contact_id,
  last_touch, next_follow_up, notes, source, import_meta, status, created_at, updated_at, birthday,
  meeting_date, meeting_time)
SELECT id, full_name, title, organization_id, department, email_work, email_personal,
  phone, linkedin_url, stage, strength, priority_tier, escalation_rung, referral_source_contact_id,
  last_touch, next_follow_up, notes, source, import_meta, status, created_at, updated_at, birthday,
  meeting_date, meeting_time
FROM contact;

-- Park the child rows so the parent can be dropped, preserving ids exactly.
CREATE TABLE interaction_backup AS SELECT * FROM interaction;
DELETE FROM interaction;

DROP TABLE contact;
ALTER TABLE contact_new RENAME TO contact;

CREATE INDEX idx_contact_stage ON contact(stage);
CREATE INDEX idx_contact_next_follow_up ON contact(next_follow_up);
CREATE INDEX idx_contact_org ON contact(organization_id);
CREATE INDEX idx_contact_email_work ON contact(email_work);
CREATE INDEX idx_contact_meeting_date ON contact(meeting_date);

INSERT INTO interaction (id, contact_id, date, type, direction, subject, summary, notes_link, outcome,
  outlook_ref, created_at, next_follow_up_set, stage_moved_to)
SELECT id, contact_id, date, type, direction, subject, summary, notes_link, outcome,
  outlook_ref, created_at, next_follow_up_set, stage_moved_to
FROM interaction_backup;

DROP TABLE interaction_backup;
