-- 0008 — escalation attempt tracking (REL-008 Part B, issue #19).
--
-- Adds the one fact the ladder cannot work without: when YOU last reached out.
--
-- Why not last_touch
-- ------------------
-- last_touch is derived from all interactions including inbound ones (contacts.ts,
-- recomputeLastTouch). If a contact replies, last_touch moves — so reading it as "when I last chased
-- them" would treat their reply as your attempt and reset the ladder at exactly the moment it should
-- stop. Two different questions need two different columns.
--
-- Why a stored column rather than deriving the rung from interactions
-- ------------------------------------------------------------------
-- Deriving avoids a migration, but interaction history is editable
-- (REL-012), so correcting a mistyped date on an old interaction would silently move a contact's
-- position in the ladder. A stored value states where they are as a fact. Same argument that settled
-- REL-015: a value derivable only by calculation is what hid a contact from every list.
--
-- Backfill, and what it does NOT claim
-- -----------------------------------
-- last_attempt_at is set from the most recent attempt-type interaction (email, linkedin, text, call)
-- for contacts in awaiting_response. That inference is sound for this stage specifically: the stage
-- means "reached out, no reply yet", so the last interaction on such a contact is by definition the
-- outreach rather than a response.
--
-- escalation_rung is set to the COUNT of those attempts, not to a guessed ladder position. The
-- distinction matters, and the live data is why: of the nine awaiting_response contacts with one
-- attempt each, some were emailed, some were messaged on LinkedIn, and one was texted. Nobody started
-- at rung 1 and walked up. Setting rung = 3 because the attempt happened to be a LinkedIn message
-- would invent a history of two earlier emails that never happened. "One attempt made" is the only
-- thing the data actually supports.
--
-- Contacts in other stages are left NULL. A contact who replied is not mid-ladder, and inventing an
-- attempt date for them would put them on a chase list they do not belong on.

ALTER TABLE contact ADD COLUMN last_attempt_at TEXT;

-- Sound for awaiting_response only, per the note above.
UPDATE contact
SET last_attempt_at = (
      SELECT MAX(i.date) FROM interaction i
      WHERE i.contact_id = contact.id AND i.type IN ('email','linkedin','text','call')
    ),
    escalation_rung = (
      SELECT COUNT(*) FROM interaction i
      WHERE i.contact_id = contact.id AND i.type IN ('email','linkedin','text','call')
    ),
    updated_at = datetime('now')
WHERE status = 'active'
  AND stage = 'awaiting_response'
  AND EXISTS (
    SELECT 1 FROM interaction i
    WHERE i.contact_id = contact.id AND i.type IN ('email','linkedin','text','call')
  );

-- The chase list asks "who is awaiting a response, oldest attempt first" on every dashboard load.
CREATE INDEX idx_contact_attempt ON contact(stage, last_attempt_at);
