-- 0003_interaction_outcome_fields.sql — feedback round 1 (2026-07-30)
-- Applied to practice-platform-dev and practice-platform-prod on 2026-07-30 via Cloudflare API.
--
-- Rationale: the interaction form can set a next follow-up date and move the stage, but neither was
-- stored ON the interaction — so the history couldn't answer "what did I decide to do next after that
-- call?". Recording both makes the timeline a narrative instead of a list of touches.
--
-- Rollback: SQLite cannot DROP COLUMN on older versions; rebuild the table or leave the columns unused.

ALTER TABLE interaction ADD COLUMN next_follow_up_set TEXT;
ALTER TABLE interaction ADD COLUMN stage_moved_to TEXT;
