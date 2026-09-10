-- 0026 — the activity vocabulary moves off a CHECK constraint and into a real table (2026-09-09).
--
-- THE REQUEST: "Can I have the application create a new category when I've added it to Outlook, but ask me
-- how to apply it in the app?" The immediate need was one category, Vacation/Holiday — but the honest
-- answer to "can the app create one itself" was no, and this migration is what makes it yes.
--
-- WHY THIS WAS THREE STEPS BEFORE. types.ts has said since migration 0012: "ADDING ONE TAKES THREE STEPS,
-- ALL OR NONE: add the category in Outlook, add it here, and write a migration rebuilding time_entry's
-- CHECK constraint." That is the correct amount of ceremony for the original ten — a controlled,
-- Outlook-synchronized standard, and REL-022's whole argument (vocabulary.ts) is that a value offered by
-- the code but rejected by the database silently loses hours. But it means every future category costs a
-- migration, which is more than "I added a category in Outlook" should cost.
--
-- WHY A TABLE MAKES THE THIRD STEP DISAPPEAR WITHOUT WEAKENING THE GUARANTEE. SQLite cannot ALTER a CHECK
-- constraint in place — 0013 rebuilt the whole table just to fix two spellings. A row in a real table needs
-- no rebuild. And it is not a looser guarantee: a time_entry.activity value not present in `activity` still
-- fails loudly, via a foreign key instead of a CHECK — REL-022's actual concern (a rejected write that
-- silently loses hours) is answered exactly as before. What disappears is only the SECOND source of truth
-- that could drift from the first: today, "what the app offers" and "what the database accepts" were two
-- separate lists (ACTIVITIES in types.ts, and the CHECK clause) that migration 0013 existed to catch
-- disagreeing. With one table serving both jobs, that drift becomes structurally impossible rather than
-- structurally caught — vocabulary.ts's activityStatus() is simplified accordingly (see that file).
--
-- WHAT DELIBERATELY DID NOT MOVE. `BILLABLE_ACTIVITY` stays a plain string constant in types.ts, still
-- naming `Client Delivery`. Only one activity has ever been billable, the weekly report is built around
-- exactly one named invoicing column ("Client Delivery, line by line"), and nothing here was asked to make
-- that flexible. `is_billable` exists on the row below for a future that widens it, but no self-service path
-- in this app sets it — a new BILLABLE activity is still a deliberate decision, not a same-day add. Only
-- `is_work` is genuinely self-service, because that is the actual thing changing: Personal was the only
-- non-work activity before, and after this migration Vacation/Holiday is a second one, which is exactly why
-- NON_WORK_ACTIVITY (a single name) had to become a per-row flag rather than staying a constant.
--
-- SEEDED WITH THE ORIGINAL TEN, PLUS Vacation/Holiday AS AN ELEVENTH — the original request, and the first
-- real use of the new mechanism rather than something only provable in the abstract. is_work = 0, the same
-- shape as Personal: real time, not worked time.
--
-- Rollback: the reverse rebuild — recreate time_entry with the CHECK constraint from migration 0013,
-- re-verifying no row carries an activity outside that ten first, then DROP TABLE activity. Every add is
-- audited (audit_event), so which activities were self-service additions is reconstructable from the trail.

CREATE TABLE activity (
  name TEXT PRIMARY KEY,
  is_work INTEGER NOT NULL DEFAULT 1,
  is_billable INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO activity (name, is_work, is_billable) VALUES
  ('Admin', 1, 0),
  ('Business Development', 1, 0),
  ('Client Delivery', 1, 1),
  ('Firm Development', 1, 0),
  ('Marketing/Content', 1, 0),
  ('Operations', 1, 0),
  ('Personal', 0, 0),
  ('Professional Development', 1, 0),
  ('Pursuit/Proposal', 1, 0),
  ('Travel', 1, 0),
  ('Vacation/Holiday', 0, 0);

-- ------------------------------------------------------------------ time_entry, rebuilt

CREATE TABLE time_entry_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  hours REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
  activity TEXT NOT NULL REFERENCES activity(name),
  engagement_id INTEGER REFERENCES engagement(id),
  contact_id INTEGER REFERENCES contact(id),
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  outlook_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  subject TEXT,
  hand_edited INTEGER NOT NULL DEFAULT 0
);

INSERT INTO time_entry_new (id, date, hours, activity, engagement_id, contact_id, note, source,
  outlook_ref, created_at, updated_at, subject, hand_edited)
SELECT id, date, hours, activity, engagement_id, contact_id, note, source,
  outlook_ref, created_at, updated_at, subject, hand_edited
FROM time_entry;

DROP TABLE time_entry;
ALTER TABLE time_entry_new RENAME TO time_entry;

CREATE INDEX idx_time_entry_date ON time_entry(date);
CREATE INDEX idx_time_entry_engagement ON time_entry(engagement_id, date);
CREATE INDEX idx_time_entry_outlook ON time_entry(outlook_ref);
