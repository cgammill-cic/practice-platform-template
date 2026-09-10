-- 0013 — Title Case the multi-word activity categories.
--
-- "Let's make 'Business development' 'Business Development'. I like to capitalize both letters in
-- this type of deal." (2026-08-11)
--
-- WHY THIS CAME UP, because the sequence matters. The Outlook calendar was read on 2026-08-11 through a
-- Microsoft connector (not through the app — there is no calendar connection yet, see M365-001). Eleven
-- events in the week of 9 August carried the category `Business Development` with a capital D. The
-- standard agreed on 2026-07-29 and written into definitions.md §5a spells it `Business development`.
--
-- So the largest category in that actual week would have been REJECTED by the CHECK constraint added in
-- 0012 — which is the constraint doing precisely the job it was added for, three days early and before a
-- single row existed. The alternative design, no constraint, would have accepted both spellings and split
-- every report between them with nothing looking wrong.
--
-- Resolved in favour of the calendar rather than the document: Outlook is where the categorising actually
-- happens, and the operator has a stated preference. Four values change; the other six are single words or
-- already capitalised on both sides of the slash.
--
--   Business development     → Business Development
--   Client delivery          → Client Delivery
--   Firm development         → Firm Development
--   Professional development → Professional Development
--
--   Unchanged: Admin, Marketing/Content, Operations, Personal, Pursuit/Proposal, Travel
--
-- NOT case-folded on read instead. Comparing case-insensitively would have made this migration
-- unnecessary and is the wrong trade: it makes the stored value non-canonical, so two spellings coexist
-- in the data forever and the NEXT drift — a trailing space, "Client Delivery " — is hidden by the same
-- leniency. One spelling, enforced, and a loud failure when something disagrees.
--
-- WHY A TABLE REBUILD. SQLite cannot alter a CHECK constraint in place, so the table is recreated. Same
-- shape as 0005 and 0009, and far simpler than either: NOTHING references time_entry, so there are no
-- child rows to park.
--
-- PRE-FLIGHT, checked 2026-08-11: prod time_entry holds 0 rows and prod engagement holds 0 rows, so this
-- migration rewrites no live data at all. The CASE mapping below is still written properly, because dev,
-- local databases and any future instance may well have rows — a migration that is only correct on an
-- empty table is a trap for whoever runs it second.
--
-- Rollback: re-run this file with the CASE mapping reversed and the old spellings in the CHECK. Nothing
-- is lost either way; the values are a controlled list, not user prose.

CREATE TABLE time_entry_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  hours REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
  activity TEXT NOT NULL CHECK (activity IN (
    'Admin','Business Development','Client Delivery','Firm Development','Marketing/Content',
    'Operations','Personal','Professional Development','Pursuit/Proposal','Travel'
  )),
  engagement_id INTEGER REFERENCES engagement(id),
  contact_id INTEGER REFERENCES contact(id),
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  outlook_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO time_entry_new (id, date, hours, activity, engagement_id, contact_id, note, source,
  outlook_ref, created_at, updated_at)
SELECT id, date, hours,
  CASE activity
    WHEN 'Business development' THEN 'Business Development'
    WHEN 'Client delivery' THEN 'Client Delivery'
    WHEN 'Firm development' THEN 'Firm Development'
    WHEN 'Professional development' THEN 'Professional Development'
    ELSE activity
  END,
  engagement_id, contact_id, note, source, outlook_ref, created_at, updated_at
FROM time_entry;

DROP TABLE time_entry;
ALTER TABLE time_entry_new RENAME TO time_entry;

-- All three indexes from 0012 have to be recreated; a dropped table takes its indexes with it.
CREATE INDEX idx_time_entry_date ON time_entry(date);
CREATE INDEX idx_time_entry_engagement ON time_entry(engagement_id, date);
CREATE INDEX idx_time_entry_outlook ON time_entry(outlook_ref);

-- OUTSIDE THIS FILE: the four categories must be renamed in Outlook to match, or the calendar import
-- (M365-001) will flag every event carrying an old spelling. definitions.md §5a is the authority for the
-- list and has been updated in the same commit as this migration.
