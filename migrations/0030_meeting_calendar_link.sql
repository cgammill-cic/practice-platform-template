-- 0030 — link a contact's meeting to the Outlook event that set it (the owner, 2026-09-24).
--
-- "I don't want to have to remember to log a meeting and right now, I'm having to do that." When an
-- invite is sent or received, the hourly calendar sync (src/meetingsync.ts) now sets the contact to
-- Meeting Scheduled with the meeting's date and time. Two facts are needed to do that safely, and the
-- schema could express neither.
--
-- meeting_event_id — WHICH EVENT SET THIS MEETING. The Graph event id (one per occurrence, because
-- calendarView expands recurring series). It is how the sync tells "I set this, so when the event is
-- rescheduled I may move it" apart from "the owner typed this date, so hands off". NULL means typed by
-- hand, or no meeting. Cleared wherever meeting_date is cleared: resolving the meeting, and the contact
-- form when the date is changed or erased.
--
-- meeting_event_dismissed — THE EVENT HE HAS ALREADY DEALT WITH. Set to the outgoing meeting_event_id
-- when a synced meeting is resolved (Held / No-Show / Cancelled) or erased by hand. Without it, a
-- meeting marked Cancelled whose invite still sits on the calendar — the other side never withdrew it —
-- would be put straight back by the next hourly run, forever. One id, not a table: only the most recent
-- decision per contact matters, and the next occurrence of a series has a different id, so it is still
-- picked up.
--
-- Both nullable TEXT, no index (read per contact, ~4,600 rows), no backfill: every existing meeting was
-- typed by hand, which is exactly what NULL says.
--
-- Rollback: ALTER TABLE contact DROP COLUMN meeting_event_id; ALTER TABLE contact DROP COLUMN meeting_event_dismissed;
--   Loses the event links; the sync then treats every meeting as hand-typed, which is the safe direction.

ALTER TABLE contact ADD COLUMN meeting_event_id TEXT;
ALTER TABLE contact ADD COLUMN meeting_event_dismissed TEXT;
