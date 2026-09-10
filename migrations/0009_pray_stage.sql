-- 0009 — add 'pray' to the contact.stage CHECK constraint.
--
-- Why this exists
-- ---------------
-- "Pray" is one of the outcome codes in the source spreadsheet's Priority column — definitions.md
-- names them as CMPL, GHST, RTRD, Pray, NA — and it is the only one that never got a stage. A Pray row
-- imports today as an unrecognized code and lands in not_contacted, flagged on the preview. The operator
-- asked for the stage: "I may not use it much, but I want to have it."
--
-- It is an ACTIVE stage (same decision), so it sits in ACTIVE_STAGES in types.ts and a contact
-- there with no follow-up date reaches Needs Attention. That matters more than it sounds: a stage in
-- neither the active nor the terminal list appears in NO dashboard section, which is the invisible
-- contact this app exists to prevent.
--
-- The constraint is kept rather than dropped, for the reason 0005 gives: every dashboard section
-- selects on literal stage strings, so an unrecognized value fails silently and permanently. The
-- constraint turns that into a loud, immediate failure. The cost is this file.
--
-- WHY THIS IS NOT A COPY OF 0005
-- ------------------------------
-- 0005 parked one child table. That was correct in July and is wrong now. Checked against the live
-- schema 2026-08-04 — THREE tables reference contact(id):
--
--   interaction.contact_id   — 72 rows
--   action_item.contact_id   — 10 rows   (added by 0006, AFTER 0005 was written)
--   contact_tag.contact_id   —  0 rows   (empty today, parked anyway; empty is a fact about now)
--
-- With foreign_keys=1, DROP TABLE contact fails while ANY row exists in any of them. Following 0005's
-- shape would have rolled the whole batch back on the action items alone.
--
-- Two more differences from 0005, both from later migrations:
--   - last_attempt_at (0008) is a real column and must be carried across. It currently sits last,
--     appended by ALTER; it is placed next to last_touch here, which is where it belongs. Column ORDER
--     is safe to change — D1 returns objects keyed by name and every query in src/ names its columns
--     or uses SELECT c.*, which maps by name.
--   - idx_contact_attempt (0008) must be recreated. 0005 lists five indexes; there are six.
--
-- HOW TO APPLY (docs/runbook.md is the authority; follow it, not this summary)
-- ---------------------------------------------------------------------------
--   1. Take a MANUAL backup first — "Run backup now" on the dashboard, or POST /admin/backup. The
--      nightly cron runs at 07:00 UTC, so by afternoon it is hours stale and does not contain the
--      day's work. The runbook is explicit: never apply an untested migration without one.
--   2. Apply to practice-platform-dev (55a6f6d5-02cf-4158-a615-8e5c870c32de) and smoke-test.
--   3. Apply to practice-platform-prod (103144bd-0819-459b-b6f9-c72ea6d50375).
--   4. Record it in the ledger IN THE SAME SITTING:
--        INSERT INTO d1_migrations (name) VALUES ('0009_pray_stage.sql');
--      A hand-applied migration missing from the ledger puts us back where #54 started.
--
-- Both routes work: the Cloudflare connector, or `npx wrangler d1 migrations apply --remote`. The
-- second is safe NOW because #54 backfilled the d1_migrations table on 2026-08-03 (rows 0001-0008);
-- before that, wrangler believed nothing had ever been applied and --remote would have started
-- replaying 0001 against live data. The Workers Builds token can do neither — it covers Workers, KV
-- and R2, not D1 — so a migration never applies itself on merge. Someone applies it, deliberately.
--
-- PRE-FLIGHT (record these before running, compare after):
--   contact     289 rows, SUM(id) = 58745
--   interaction  72 rows, SUM(id) = 2697
--   action_item  10 rows, SUM(id) = 55
--   contact_tag   0 rows

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
  stage TEXT NOT NULL DEFAULT 'not_contacted' CHECK (stage IN ('meeting_scheduled','follow_up_action','in_conversation','awaiting_response','reach_out_later','not_contacted','stay_connected','pray','complete','no_response','retired','not_qualified')),
  strength TEXT CHECK (strength IN ('strong','warm','new','cold')),
  priority_tier INTEGER,
  escalation_rung INTEGER NOT NULL DEFAULT 0,
  referral_source_contact_id INTEGER REFERENCES contact_new(id),
  last_touch TEXT,
  last_attempt_at TEXT,
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

-- Self-reference points at contact_new, not contact: pointing at `contact` leaves a dangling
-- reference the instant the old table is dropped and D1 rolls the batch back (0005, note 1).
-- ALTER TABLE ... RENAME rewrites it to REFERENCES contact(id) automatically (0005, note 3).

INSERT INTO contact_new (id, full_name, title, organization_id, department, email_work, email_personal,
  phone, linkedin_url, stage, strength, priority_tier, escalation_rung, referral_source_contact_id,
  last_touch, last_attempt_at, next_follow_up, notes, source, import_meta, status, created_at,
  updated_at, birthday, meeting_date, meeting_time)
SELECT id, full_name, title, organization_id, department, email_work, email_personal,
  phone, linkedin_url, stage, strength, priority_tier, escalation_rung, referral_source_contact_id,
  last_touch, last_attempt_at, next_follow_up, notes, source, import_meta, status, created_at,
  updated_at, birthday, meeting_date, meeting_time
FROM contact;

-- Park every child row so the parent can be dropped, preserving ids exactly.
CREATE TABLE interaction_backup AS SELECT * FROM interaction;
CREATE TABLE action_item_backup AS SELECT * FROM action_item;
CREATE TABLE contact_tag_backup AS SELECT * FROM contact_tag;
DELETE FROM interaction;
DELETE FROM action_item;
DELETE FROM contact_tag;

DROP TABLE contact;
ALTER TABLE contact_new RENAME TO contact;

CREATE INDEX idx_contact_stage ON contact(stage);
CREATE INDEX idx_contact_next_follow_up ON contact(next_follow_up);
CREATE INDEX idx_contact_org ON contact(organization_id);
CREATE INDEX idx_contact_email_work ON contact(email_work);
CREATE INDEX idx_contact_meeting_date ON contact(meeting_date);
CREATE INDEX idx_contact_attempt ON contact(stage, last_attempt_at);

INSERT INTO interaction (id, contact_id, date, type, direction, subject, summary, notes_link, outcome,
  outlook_ref, created_at, next_follow_up_set, stage_moved_to)
SELECT id, contact_id, date, type, direction, subject, summary, notes_link, outcome,
  outlook_ref, created_at, next_follow_up_set, stage_moved_to
FROM interaction_backup;

INSERT INTO action_item (id, contact_id, interaction_id, description, due_date, done, done_at,
  created_at, updated_at)
SELECT id, contact_id, interaction_id, description, due_date, done, done_at, created_at, updated_at
FROM action_item_backup;

INSERT INTO contact_tag (contact_id, tag_id)
SELECT contact_id, tag_id FROM contact_tag_backup;

DROP TABLE interaction_backup;
DROP TABLE action_item_backup;
DROP TABLE contact_tag_backup;
