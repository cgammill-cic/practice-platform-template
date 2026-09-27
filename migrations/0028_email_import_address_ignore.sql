-- 0028 — ignore an address that will never become a contact (the owner, 2026-09-22).
--
-- "No matching contact" (0024, MAIL-001) already lists every address in a week's mail that isn't on
-- file, so a person could be added from it — but the only decision it offered was Add Contact. An
-- automated sender (noreply@event.eventbrite.com, a newsletter, a calendar bot) is never going to be a
-- contact, and without a real "no" it comes back on every visit — the exact silence problem 0024 fixed
-- for a single message and for a whole watched person, now needed for a bare address that was never
-- matched to anyone in the first place. The owner: "I want to have this list ultimately at zero."
--
-- WHY A SEPARATE TABLE RATHER THAN REUSING contact.email_import_ignore OR email_import_exclusion. Both
-- of those hang off a contact_id, and an unmatched address by definition has none — there is no contact
-- row to flag. Inventing a placeholder contact just to set a flag on it would put a fake person in every
-- contact count, report and worklist in the app for good. This table needs nothing but the address
-- itself: no FK, no cascade to design, nothing for health.ts's HANDLED set (REL-031) to track.
--
-- Rollback: DROP TABLE email_import_address_ignore. Loses the ignore list; recovered by re-adding each
-- address a second time, same as clearing email_import_exclusion would.

CREATE TABLE email_import_address_ignore (
  -- Stored lowercase/trimmed (mailimport.ts's own addr() shape), so a match is a plain equality check
  -- against the same normalized form contactsByEmail() already keys on.
  address TEXT PRIMARY KEY,
  ignored_at TEXT NOT NULL DEFAULT (datetime('now'))
);
