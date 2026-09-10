-- 0023 — remembering that two companies are NOT the same company (ORG-002, 2026-09-02).
--
-- ============================================================================================
-- WHY THIS TABLE EXISTS AT ALL
-- ============================================================================================
-- On being offered a duplicate-organization cleanup:
--
--   "I would need to be able to validate duplicate entries because some companies have sub-businesses
--    that are legitimate. I would prefer to have a list of potential duplicates that I can go through,
--    update (consolidate if necessary or mark as not a duplicate)."
--
-- That sentence rules out the obvious build. Any rule that collapses similar names would merge two real
-- businesses, and there would be nothing on any screen afterwards to say it had happened. So candidates
-- are only ever SUGGESTED, and the person decides.
--
-- The decision then has to be remembered, and that is what this table is for. Without it the candidate
-- list is regenerated from the names every time — so the pairs already judged come back
-- on every visit, and come back again each time an import adds a contact to either side. A review queue
-- that re-asks questions it has already been answered is a queue nobody opens twice, which would make
-- the whole feature worse than nothing: it would look like coverage.
--
-- ============================================================================================
-- WHY IT IS A TABLE OF *NEGATIVES*
-- ============================================================================================
-- The rows say "these two are different companies". There is no corresponding table of confirmed
-- duplicates, and that asymmetry is deliberate: a confirmed duplicate is ACTED on — merged — and then
-- one of the two ids no longer exists, so there is nothing left to record. Only the "leave them alone"
-- answer needs to survive, because both rows survive with it.
--
-- ============================================================================================
-- WHY THE ORDER IS NORMALISED IN CODE RATHER THAN CONSTRAINED HERE
-- ============================================================================================
-- (a_id, b_id) is stored with a_id < b_id, so the pair (5, 12) and the pair (12, 5) are one row rather
-- than two. That could have been a CHECK (a_id < b_id), and it is not, for the reason migration 0018
-- gives about `calendar_tag`: a constraint violation surfaces as a SQLite error with no actionable
-- message, and the caller here is a single well-known function. src/orgdupes.ts orders the pair before
-- every read and every write. The primary key still makes a double-click a no-op rather than two rows.
--
-- ============================================================================================
-- WHAT SURVIVES A MERGE
-- ============================================================================================
-- When two organizations ARE merged, the surviving id keeps any "not a duplicate" rows it held, and the
-- rows belonging to the disappearing id are deleted rather than repointed. Repointing looks tidier and
-- is wrong: "A is not B" says nothing about whether the survivor of a B/C merge is A. A judgement is
-- about two specific companies, and one of them no longer exists.
--
-- ON DELETE CASCADE on both columns so a deleted organization cannot leave a row pointing at nothing.
-- That is the merge path's safety net, not its mechanism — the merge deletes these rows explicitly, and
-- the cascade is there for any other route by which an organization might go.
--
-- ============================================================================================
-- HOW TO APPLY (docs/runbook.md is the authority)
-- ============================================================================================
--   1. Apply to practice-platform-dev (55a6f6d5-02cf-4158-a615-8e5c870c32de).
--   2. Apply to practice-platform-prod (103144bd-0819-459b-b6f9-c72ea6d50375).
--   3. Ledger row in the same sitting:
--        INSERT INTO d1_migrations (name) VALUES ('0023_org_not_duplicate.sql');
--
-- No backup step is called out beyond the nightly one: this migration only CREATES, and touches no
-- existing row. Contrast 0022, which dropped and rebuilt a table.
--
-- ROLLBACK: DROP TABLE organization_not_duplicate;
-- Nothing else reads it. Dropping it loses only the "leave these two alone" decisions, and the effect is
-- that already-judged pairs reappear in the review queue — annoying, not damaging.

CREATE TABLE organization_not_duplicate (
  a_id INTEGER NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  b_id INTEGER NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- Why they are different, in the operator's own words, when they care to say. Optional, and worth
  -- having: for a sub-business case the reason ("separate practice, bills separately") is the thing a
  -- future reader — including a future maintainer — would otherwise have to reconstruct from nothing.
  note TEXT,
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (a_id, b_id)
);

-- The queue asks "is this pair already judged?" once per candidate, in both directions of lookup. The
-- primary key covers (a_id, …); this covers the other side.
CREATE INDEX idx_org_not_dupe_b ON organization_not_duplicate(b_id);
