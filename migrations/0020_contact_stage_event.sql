-- 0020_contact_stage_event.sql
--
-- Records every stage change as a dated row, so "how did the pipeline move" becomes answerable.
--
-- THE PROBLEM. `contact.stage` holds where a relationship IS. Nothing holds where it has BEEN. So
-- "how many contacts moved from awaiting_response to in_conversation last month", "how long does a
-- contact typically sit at meeting_scheduled", and "is outreach converting better than it was in June"
-- are all unanswerable — not hard, unanswerable, because the data was never kept. `interaction`,
-- `time_entry` and `action_item` are all dated and fine. Stages were the hole.
--
-- This cannot be backfilled from nothing, and every week without it is a week of history permanently
-- gone. That is why it is being done now rather than when the reporting is actually built (ANLY-001,
-- #101), which is explicitly low priority.
--
-- ============================================================================
-- IT TURNS OUT MOST OF THE HISTORY *CAN* BE RECOVERED, AND #101 SAID OTHERWISE
-- ============================================================================
-- #101 states: "the audit trail is not a substitute — it records stage changes in prose (`stage
-- awaiting_response → in_conversation`), which is readable but not aggregatable."
--
-- That was written from the shape of the string, not from the data. The stage records are in exactly two
-- regular forms, and both parse:
--
--   1. transitions — `stage <from> → <to>`, either at the start of after_summary or after a prefix
--      (`gave up chasing after 3 attempts; stage awaiting_response → no_response`).
--   2. creations — action='create', `<name> · stage <value>`, no arrow. The contact's FIRST stage.
--
-- So the backfill below recovers real dated history rather than starting from zero today. The claim in
-- #101 was pessimistic and is corrected there.
--
-- PARSED CONSERVATIVELY. Both extracted values are checked against the stage vocabulary, and a row whose
-- from/to is not a recognised stage is SKIPPED rather than stored. The string is prose written for a
-- human, and `notes` edits also land in after_summary — an unvalidated parse would happily invent a
-- stage called "07/28 - email". Skipping loses a row; guessing corrupts the series.
--
-- APPLIED TO PRODUCTION 2026-08-13, and RECONCILED rather than assumed. My first estimate was "211
-- rows expected" — that was the count of audit rows mentioning the word "stage", which is not the same
-- thing at all, and taking it at face value would have hidden the parse bug noted further down:
--
--   211  audit rows mention "stage" anywhere (the figure quoted in #101)
--   145  of those are actual stage records — 132 update-with-arrow + 13 create
--   144  recovered into this table
--     1  skipped: a create for contact 376 ("ZZZ Test"), since deleted — the EXISTS guard working
--
--   The other 66 mention "stage" only in prose (a notes edit, a before_summary) and are not stage
--   changes. Result: 144 events across 111 contacts, 2026-07-30 to 2026-08-16.
--
-- The lesson worth keeping: the INSERT reported 143 and looked like a success. It was one short, and the
-- only reason that surfaced was checking the recovered count against the candidate count instead of
-- against an expectation formed before looking.
--
-- ============================================================================
-- CAPTURED BY TRIGGER, NOT BY CALLING CODE
-- ============================================================================
-- Stage is written from at least five places — the contact edit form, the inline dashboard actions, the
-- escalation ladder, the bulk list actions and the importer — and the failure mode of instrumenting each
-- one is that a sixth gets added later and silently records nothing. That is REL-022's lesson exactly: a
-- value added in one place and not the others, failing quietly.
--
-- A trigger cannot be forgotten. Every UPDATE that changes stage is captured, including from paths that
-- do not exist yet, and including a change made by hand in the D1 console.
--
-- THE COST, STATED: a trigger cannot know WHO or from WHICH SCREEN. `actor` and `source` are therefore
-- not recorded here. That is an acceptable trade because the audit trail already answers "who did it"
-- and this table exists to answer "what moved, and when". Do not "fix" this by moving capture into
-- application code to get the actor back — you would trade a guarantee for a field you already have
-- somewhere else.
--
-- ROLLBACK.
--   DROP TRIGGER contact_stage_change;
--   DROP TRIGGER contact_stage_initial;
--   DROP TABLE contact_stage_event;

CREATE TABLE contact_stage_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contact(id),
  -- NULL means this is the contact's first recorded stage rather than a move from somewhere.
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- 'trigger' for anything captured live; 'audit-backfill' for rows reconstructed from audit_event.
  -- Kept so a later reader can tell recovered history from recorded history, which matters because the
  -- backfilled rows carry the audit row's timestamp and the recovered set is not guaranteed complete.
  origin TEXT NOT NULL DEFAULT 'trigger',
  -- The audit_event this row was reconstructed from, so any backfilled row can be traced to its source.
  audit_event_id INTEGER
);

CREATE INDEX idx_stage_event_contact ON contact_stage_event (contact_id, changed_at);
CREATE INDEX idx_stage_event_when ON contact_stage_event (changed_at);
CREATE INDEX idx_stage_event_to ON contact_stage_event (to_stage, changed_at);

-- ---------------------------------------------------------------- live capture

CREATE TRIGGER contact_stage_change
AFTER UPDATE OF stage ON contact
FOR EACH ROW WHEN old.stage IS NOT new.stage
BEGIN
  INSERT INTO contact_stage_event (contact_id, from_stage, to_stage, origin)
  VALUES (new.id, old.stage, new.stage, 'trigger');
END;

-- A new contact's starting stage is a real data point: "he added 12 contacts straight into
-- awaiting_response in July" is a fact about how the pipeline was fed, and without this row those
-- contacts would appear in no movement report until they happened to move.
CREATE TRIGGER contact_stage_initial
AFTER INSERT ON contact
FOR EACH ROW
BEGIN
  INSERT INTO contact_stage_event (contact_id, from_stage, to_stage, origin)
  VALUES (new.id, NULL, new.stage, 'trigger');
END;

-- ---------------------------------------------------------------- backfill from audit_event
--
-- Transitions. `stage <from> → <to>`, with the arrow as a three-character ' → ' (SQLite's instr/substr
-- work in characters on TEXT, so the multi-byte arrow counts as one).
--
-- The WHERE clause validates BOTH extracted values against the stage vocabulary. An audit row whose
-- prose happens to contain the word "stage" but is not a stage change contributes nothing.

INSERT INTO contact_stage_event (contact_id, from_stage, to_stage, changed_at, origin, audit_event_id)
SELECT
  CAST(a.entity_id AS INTEGER),
  p.from_stage,
  p.to_stage,
  a.ts,
  'audit-backfill',
  a.id
FROM (
  SELECT
    e.id, e.ts, e.entity_id,
    -- everything after the first 'stage '
    substr(e.after_summary, instr(e.after_summary, 'stage ') + 6) AS rest
  FROM audit_event e
  WHERE e.entity = 'contact'
    AND e.action = 'update'
    AND e.after_summary LIKE '%stage %'
    AND e.after_summary LIKE '%→%'
    AND e.entity_id GLOB '[0-9]*'
) a
JOIN (
  SELECT
    id,
    substr(rest, 1, instr(rest, ' → ') - 1) AS from_stage,
    -- The value runs to the first ';' OR the first ' (' — both terminators are real. A single audit row
    -- reads `stage not_contacted → awaiting_response (applied from interaction 92)`, and cutting only at
    -- ';' produced "awaiting_response (applied from interaction 92)", which failed the vocabulary check
    -- and silently dropped a genuine transition. Found by reconciling the recovered count against the
    -- candidate count rather than by accepting the first number the INSERT reported.
    CASE
      WHEN instr(
             CASE WHEN instr(substr(rest, instr(rest, ' → ') + 3), ';') > 0
                  THEN substr(substr(rest, instr(rest, ' → ') + 3), 1, instr(substr(rest, instr(rest, ' → ') + 3), ';') - 1)
                  ELSE substr(rest, instr(rest, ' → ') + 3) END, ' (') > 0
        THEN substr(
               CASE WHEN instr(substr(rest, instr(rest, ' → ') + 3), ';') > 0
                    THEN substr(substr(rest, instr(rest, ' → ') + 3), 1, instr(substr(rest, instr(rest, ' → ') + 3), ';') - 1)
                    ELSE substr(rest, instr(rest, ' → ') + 3) END,
               1,
               instr(
                 CASE WHEN instr(substr(rest, instr(rest, ' → ') + 3), ';') > 0
                      THEN substr(substr(rest, instr(rest, ' → ') + 3), 1, instr(substr(rest, instr(rest, ' → ') + 3), ';') - 1)
                      ELSE substr(rest, instr(rest, ' → ') + 3) END, ' (') - 1)
      ELSE
        CASE WHEN instr(substr(rest, instr(rest, ' → ') + 3), ';') > 0
             THEN substr(substr(rest, instr(rest, ' → ') + 3), 1, instr(substr(rest, instr(rest, ' → ') + 3), ';') - 1)
             ELSE substr(rest, instr(rest, ' → ') + 3) END
    END AS to_stage
  FROM (
    SELECT
      e.id,
      substr(e.after_summary, instr(e.after_summary, 'stage ') + 6) AS rest
    FROM audit_event e
    WHERE e.entity = 'contact'
      AND e.action = 'update'
      AND e.after_summary LIKE '%stage %'
      AND e.after_summary LIKE '%→%'
      AND e.entity_id GLOB '[0-9]*'
  )
  WHERE instr(rest, ' → ') > 0
) p ON p.id = a.id
WHERE p.from_stage IN ('meeting_scheduled','follow_up_action','in_conversation','awaiting_response',
                       'reach_out_later','not_contacted','stay_connected','pray','complete',
                       'no_response','retired','not_qualified')
  AND p.to_stage IN ('meeting_scheduled','follow_up_action','in_conversation','awaiting_response',
                     'reach_out_later','not_contacted','stay_connected','pray','complete',
                     'no_response','retired','not_qualified')
  AND EXISTS (SELECT 1 FROM contact c WHERE c.id = CAST(a.entity_id AS INTEGER));

-- Creations. `action='create'` with `· stage <value>` and no arrow — the contact's first stage.
-- The value runs to the next ' · ' or to the end of the string.

INSERT INTO contact_stage_event (contact_id, from_stage, to_stage, changed_at, origin, audit_event_id)
SELECT
  CAST(entity_id AS INTEGER),
  NULL,
  to_stage,
  ts,
  'audit-backfill',
  id
FROM (
  SELECT
    e.id, e.ts, e.entity_id,
    CASE
      WHEN instr(substr(e.after_summary, instr(e.after_summary, 'stage ') + 6), ' · ') > 0
        THEN substr(substr(e.after_summary, instr(e.after_summary, 'stage ') + 6), 1,
                    instr(substr(e.after_summary, instr(e.after_summary, 'stage ') + 6), ' · ') - 1)
      ELSE substr(e.after_summary, instr(e.after_summary, 'stage ') + 6)
    END AS to_stage
  FROM audit_event e
  WHERE e.entity = 'contact'
    AND e.action = 'create'
    AND e.after_summary LIKE '%stage %'
    AND e.after_summary NOT LIKE '%→%'
    AND e.entity_id GLOB '[0-9]*'
)
WHERE to_stage IN ('meeting_scheduled','follow_up_action','in_conversation','awaiting_response',
                   'reach_out_later','not_contacted','stay_connected','pray','complete',
                   'no_response','retired','not_qualified')
  AND EXISTS (SELECT 1 FROM contact c WHERE c.id = CAST(entity_id AS INTEGER));

-- NOT SEEDED: a synthetic "initial stage" row for the 295 contacts that arrived through the REL-001
-- import. Their stage came from a spreadsheet code, and `contact.created_at` records when the row was
-- written, not when the relationship reached that stage. Inventing 295 movement events dated to import
-- day would put a spike in every trend chart that never happened. They enter the series the first time
-- they genuinely move.
