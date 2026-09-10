-- 0010 — count the outreach that was recorded on the interaction form (#82).
--
-- Data only. No schema change: `last_attempt_at` and `escalation_rung` both already exist (0008, 0001).
--
-- What was wrong
-- --------------
-- 0008 gave the ladder its two stored facts, and only POST /escalation/:id/attempt ever maintained them.
-- Everything logged through Record an Interaction — which is how most outreach gets recorded — moved
-- the derived attempt count on the chase row and left the stored column untouched. On 2026-08-04 that
-- produced a row reading "no attempt recorded" and "1 attempt · tried email" at the same time, for
-- a contact who had in fact just been emailed. The write side is fixed in contacts.ts; this catches
-- up the rows already in that state.
--
-- How many rows, and who
-- ----------------------
-- Counted on prod before writing this (2026-08-04): 40 active contacts had recorded outreach the ladder
-- had not counted, not one. Fourteen are in awaiting_response — the stage the chase list draws from — and
-- thirteen of those fourteen had `last_attempt_at IS NULL` alongside an attempt dated 2026-08-04, so the
-- chase list was sorting that morning's entire outreach to the top of the list as "never contacted".
-- The fourteenth contact's stored date is right, because they were later chased with the
-- button too, but their rung says 1 where two attempts exist. The remaining 26 sit in in_conversation,
-- meeting_scheduled, complete, reach_out_later, stay_connected and no_response.
--
-- The definition used here is the one in src/attempts.ts: type IN (email, linkedin, text, call) AND the
-- direction is not 'inbound'. 0008 filtered on type alone and had no direction clause to inherit, so
-- this is the same rule with the one exclusion that matters added. NULL direction still counts, exactly
-- as it did in 0008.
--
-- Why every stage, where 0008 covered awaiting_response only
-- ---------------------------------------------------------
-- 0008 was cautious for a good reason, stated in its header: it inferred an attempt from the most recent
-- interaction of ANY direction, so it restricted itself to the stage where "the last interaction is by
-- definition the outreach rather than a response". This migration does not need that shelter — inbound
-- interactions are excluded outright, so what is being counted is outreach on its own terms rather than
-- outreach inferred from a stage.
--
-- And going forward the write side sets these columns at every stage, so restricting the backfill to
-- awaiting_response would leave the other 28 contacts permanently behind, with the new health check in
-- attempts.ts reporting drift that no future write would ever clear.
--
-- Nothing goes backwards
-- ----------------------
-- Both columns can only move forward. `escalation_rung` takes MAX(stored, counted) and `last_attempt_at`
-- takes MAX(stored, latest attempt date), so a rung recorded by the chase button whose interaction was
-- later deleted keeps its value. That is #57's decision — these are stored precisely so that editing
-- history cannot silently reorder the worklist — and a backfill is not the place to overturn it. (On
-- prod today no row is in that position: no contact has a rung higher than their counted attempts.)
--
-- Idempotent: running it twice changes nothing the second time. Both assignments are MAX against what is
-- already there, and the WHERE clause only matches rows that are actually behind.
--
-- What this migration does NOT touch
-- ----------------------------------
-- `next_follow_up`. It is tempting — thirteen contacts were emailed on 2026-08-04 and the chase button
-- would have set a follow-up three business days out. But those rows already carry 2026-08-07, set by
-- the interaction form from what the operator typed, and rewriting dates they chose in order to match what a
-- different button would have chosen is not a backfill. `last_touch` is likewise untouched: it is derived
-- from interactions and was already correct throughout — it was never the field that failed.
--
-- Rollback
-- --------
-- Not reversible from within SQL: the prior values are gone once this runs. Recovery is from the nightly
-- R2 backup (see docs/runbook.md → Restore procedure), restoring `contact.escalation_rung` and
-- `contact.last_attempt_at` for the affected ids. Take a manual backup before applying. Note that
-- reverting the DATA without also reverting src/contacts.ts leaves the columns correct but drifting again
-- from the next recorded interaction onwards, and reverting the CODE without the data is harmless — the
-- rows are simply accurate and no longer maintained.
--
-- Verify after applying. The UPDATE's own reported change count is the first check — it should be 40 on
-- prod as of 2026-08-04, and 0 on any later re-run. Then this must return no rows at all:
--
--   SELECT c.id, c.full_name, c.escalation_rung, c.last_attempt_at
--     FROM contact c WHERE c.status='active'
--      AND ((SELECT COUNT(*) FROM interaction i WHERE i.contact_id=c.id
--              AND i.type IN ('email','linkedin','text','call')
--              AND (i.direction IS NULL OR i.direction <> 'inbound')) > c.escalation_rung
--        OR (SELECT MAX(i.date) FROM interaction i WHERE i.contact_id=c.id
--              AND i.type IN ('email','linkedin','text','call')
--              AND (i.direction IS NULL OR i.direction <> 'inbound')) > COALESCE(c.last_attempt_at,''));
--
-- The second query is the same question GET /health now asks under "Outreach attempts", so the health
-- page is the ongoing check and this is the one-off confirmation.
--
-- A note on rehearsal: applying this to dev proves the SQL parses and nothing more, because dev holds no
-- rows. It was rehearsed against a local copy carrying the shapes that matter — a two_way attempt, an
-- inbound attempt-type interaction that must NOT count, a back-dated attempt on a contact whose stored
-- date is newer, and a contact whose rung already exceeds their counted attempts.

UPDATE contact
SET escalation_rung = MAX(
      escalation_rung,
      (SELECT COUNT(*) FROM interaction i
         WHERE i.contact_id = contact.id
           AND i.type IN ('email','linkedin','text','call')
           AND (i.direction IS NULL OR i.direction <> 'inbound'))
    ),
    last_attempt_at = NULLIF(
      MAX(
        COALESCE(last_attempt_at, ''),
        COALESCE((SELECT MAX(i.date) FROM interaction i
                    WHERE i.contact_id = contact.id
                      AND i.type IN ('email','linkedin','text','call')
                      AND (i.direction IS NULL OR i.direction <> 'inbound')), '')
      ), ''),
    updated_at = datetime('now')
WHERE status = 'active'
  AND EXISTS (
    SELECT 1 FROM interaction i
      WHERE i.contact_id = contact.id
        AND i.type IN ('email','linkedin','text','call')
        AND (i.direction IS NULL OR i.direction <> 'inbound')
  )
  AND (
    (SELECT COUNT(*) FROM interaction i
       WHERE i.contact_id = contact.id
         AND i.type IN ('email','linkedin','text','call')
         AND (i.direction IS NULL OR i.direction <> 'inbound')) > escalation_rung
    OR
    (SELECT MAX(i.date) FROM interaction i
       WHERE i.contact_id = contact.id
         AND i.type IN ('email','linkedin','text','call')
         AND (i.direction IS NULL OR i.direction <> 'inbound')) > COALESCE(last_attempt_at, '')
  );
