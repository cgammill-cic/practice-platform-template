-- 0004_meeting_schedule.sql — feedback 2026-07-30
-- Applied to practice-platform-dev and practice-platform-prod on 2026-07-30 via Cloudflare API.
--
-- Rationale: dashboard section 1 was labelled "This Week's Meetings" but queried only
-- stage = 'meeting_scheduled' — there was no field recording WHEN a meeting was, so the heading
-- promised date filtering the data could not support. These columns supply the missing structure.
-- Phase 2 (Microsoft Graph) will populate them from the Outlook calendar; until then they're manual.
--
-- Rollback: SQLite cannot DROP COLUMN on older versions; drop the index and leave the columns unused.

ALTER TABLE contact ADD COLUMN meeting_date TEXT;
ALTER TABLE contact ADD COLUMN meeting_time TEXT;
CREATE INDEX idx_contact_meeting_date ON contact(meeting_date);
