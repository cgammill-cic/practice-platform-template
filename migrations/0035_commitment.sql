-- 0035 — sales commitments (the owner 2026-09-27, with the sales-advisor skill).
--
-- A commitment is something the owner commits to doing to sell better: "ask a connector for two
-- introductions by Friday", "define the entry offer by Oct 15", "log 12 BD hours this week". It is
-- agreed in a sales-advisor session (or typed in by hand), and the next session opens by asking what
-- happened. That review is the point, so a commitment can end three ways, not two:
--   done    — it happened
--   missed  — it did not, and the next session should ask why (the honest outcome the advisor needs)
--   dropped — it stopped making sense (a pursuit died, a better move came up)
-- and outcome_note carries what actually happened in his own words.
--
-- Why not action_item (0006): action_item.contact_id is NOT NULL and an action item means "what I owe
-- this person" — a promise made in a meeting. A commitment is the owner's own discipline; a person and a
-- pursuit are optional context, and many ("define the entry offer") have neither.
--
-- contact_id and engagement_id are nullable links. Deleting a contact UNLINKS its commitments (see
-- contactList.ts) rather than blocking or deleting them — the commitment and its outcome are his
-- record, the person was context. There is no engagement delete path today.
--
-- source: 'app' when typed on a page, 'advisor' when the sales-advisor skill wrote it after he
-- confirmed the rows in a session. Both are audited (entity 'commitment').
--
-- Rollback: DROP TABLE commitment;  (nothing else references it)

CREATE TABLE commitment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','missed','dropped')),
  outcome_note TEXT,
  category TEXT CHECK (category IS NULL OR category IN ('activity','relationship','pursuit','offer','positioning','other')),
  contact_id INTEGER REFERENCES contact(id),
  engagement_id INTEGER REFERENCES engagement(id),
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','advisor')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE INDEX idx_commitment_open ON commitment(status, due_date);
CREATE INDEX idx_commitment_contact ON commitment(contact_id);
CREATE INDEX idx_commitment_engagement ON commitment(engagement_id);
