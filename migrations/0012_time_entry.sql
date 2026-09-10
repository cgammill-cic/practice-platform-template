-- 0012 — time entries (TIME-001, issue #90).
--
-- "I would still like to know each week the hours I've worked on specific activities" — raised above
-- the user-accounts work in the same conversation, 2026-08-11.
--
-- Why this exists before the calendar import
-- -----------------------------------------
-- The eventual source is the Outlook calendar, and the ten activity categories were standardised in
-- July 2026 for exactly that purpose (decision-log 2026-07-29, definitions.md §5a). That path needs
-- Microsoft Graph (M365-001) and is not close.
--
-- Manual entry is NOT a stopgap for it. It is the permanent fallback for every week the calendar is
-- wrong, incomplete, or was never populated — and a calendar import lands in this same table with
-- source='calendar', so nothing here is thrown away later. That is the whole reason `source` and
-- `outlook_ref` exist on day one rather than being added by a later migration: an import needs to know
-- which rows it owns, and needs somewhere to record the event it came from so re-running it cannot
-- double-count. Both are cheap now and awkward later.
--
-- Why activity carries a CHECK constraint
-- --------------------------------------
-- A CHECK is expensive to change — SQLite cannot alter one in place, so the table has to be rebuilt
-- (see 0005 and 0009), and REL-022 exists because a value was once added to the code without the
-- matching migration and every write of it threw a 500 in production, silently.
--
-- It is still right here, and the calendar import is the reason. Today `activity` is only ever written
-- from a <select>, where a constraint protects against very little. But the import will write Outlook
-- category strings, and that is precisely where "Client Delivery" and "Client delivery" become two
-- categories that split every report between them without anything looking wrong. A constraint turns
-- that into a loud failure at import time, which is when someone can still fix the category in Outlook.
--
-- The list is the ten in definitions.md §5a, stored exactly as written there and in Outlook — values
-- equal labels, the same convention DEPARTMENTS uses in types.ts, so the import is a literal match with
-- no translation table to drift out of date. ADDING ONE MEANS: add it in Outlook, add it to ACTIVITIES
-- in types.ts, and write a migration that rebuilds this table. All three, or none.
--
-- Personal is on the list because it is on the Outlook standard, but it is NOT hours worked. The report
-- shows it below the line rather than in the total, and rather than excluding it — time is time, and a
-- week where the honest answer is "a lot of it was personal" should be readable, not silently missing.
--
-- hours is REAL
-- -------------
-- Quarter-hours and thirds of an hour both matter for a practice that bills hourly, and REAL avoids
-- inventing a minutes-based integer convention that every read would have to divide. The CHECK bounds it
-- to a sane single-entry range: > 0 because a zero-hour entry is a note, not time, and <= 24 because a
-- typed 80 is a typo that would otherwise quietly ruin a week's total.
--
-- engagement_id and contact_id are both nullable and both optional
-- ---------------------------------------------------------------
-- Not every hour belongs to a customer — Admin, Firm development and Marketing are real work with no
-- engagement behind them, and forcing a choice would produce a fake one. Unassigned time is reported as
-- its own line rather than hidden, the same rule the importer follows for unmapped values.
--
-- Rollback: DROP TABLE time_entry;  (drops the indexes with it — no other table references it)

CREATE TABLE time_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  hours REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
  activity TEXT NOT NULL CHECK (activity IN (
    'Admin','Business development','Client delivery','Firm development','Marketing/Content',
    'Operations','Personal','Professional development','Pursuit/Proposal','Travel'
  )),
  engagement_id INTEGER REFERENCES engagement(id),
  contact_id INTEGER REFERENCES contact(id),
  note TEXT,
  -- 'manual' or 'calendar'. Deliberately unconstrained: a future import may want a third value, and
  -- unlike activity there is no split-the-report failure mode to protect against here.
  source TEXT NOT NULL DEFAULT 'manual',
  -- The Outlook event id, for a later Graph import to deduplicate against. Unused until M365-001.
  outlook_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every read is "a week", so date leads. The second index serves hours-by-customer for a period.
CREATE INDEX idx_time_entry_date ON time_entry(date);
CREATE INDEX idx_time_entry_engagement ON time_entry(engagement_id, date);

-- A later calendar import will look rows up by the event it came from; cheap to create now while the
-- table is empty, and it keeps the dedupe honest from the first import rather than the second.
CREATE INDEX idx_time_entry_outlook ON time_entry(outlook_ref);

-- NOTE ON `engagement`: no schema change is needed for customers (CUST-001, #91). That table, including
-- qb_customer_id and qb_project_id, has existed since 0001 and has simply never had a screen. This
-- migration deliberately does not touch it.
