-- 0006 — action items (REL-007, issue #18).
--
-- "Capture action items from meetings and check them off so that nothing I promised in a meeting
-- disappears into the notes."
--
-- Why a table rather than a field
-- ------------------------------
-- The Follow-Up Action stage (REL-020) answers "whose court is this in?" — one answer per contact.
-- It cannot answer "what exactly did I promise?", because one meeting can produce three commitments
-- with different due dates that get completed at different times. That needs rows, not a stage and a
-- notes field.
--
-- interaction_id is nullable on purpose. Most items come out of a meeting and should point at it, so
-- the item carries its own provenance — "this came from the 30 July call". But a commitment can also
-- arise from an email or a corridor conversation that was never logged, and refusing to record it
-- until an interaction exists would push it back into somebody's memory, which is the failure this
-- feature exists to prevent.
--
-- done is stored alongside done_at rather than inferred from it: an item can be completed without a
-- known completion date when it is entered retrospectively, and "done, date unknown" is honest where
-- a NULL date silently meaning "open" would not be.
--
-- ON DELETE behaviour is deliberately absent. Contacts carrying interactions cannot be deleted at all
-- (REL-019), and a contact carrying open action items should not vanish either — the delete
-- confirmation page counts them so the operator sees what would be lost.

CREATE TABLE action_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contact(id),
  interaction_id INTEGER REFERENCES interaction(id),
  description TEXT NOT NULL,
  due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The dashboard asks "what is open, soonest first" on every load, with undated items surfacing too.
CREATE INDEX idx_action_open ON action_item(done, due_date);
CREATE INDEX idx_action_contact ON action_item(contact_id);
CREATE INDEX idx_action_interaction ON action_item(interaction_id);
