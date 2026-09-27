-- 0033 — follow-up sequences for outreach (Phase 2b, the owner 2026-09-25).
--
-- "Sequence" meant a multi-step follow-up: after a first message is logged as sent, draft a follow-up
-- N business days later if there has been no reply (default 5 and 12, a setting). The follow-ups are
-- ordinary outreach_item rows (kind = 'follow_up', sequence_step 1..n, parent_item_id = the first
-- touch), which 0032 already allowed for. The one fact that had no home is "the owner said stop":
--
-- sequence_stopped — on the FIRST-TOUCH item. 1 = no more follow-ups for that outreach, set by the
--   Stop Follow-ups button (card, Outreach page or contact record) or when a follow-up is skipped. The
--   other stop conditions are read live and need no column: a reply (an inbound or two-way non-meeting
--   interaction since the first touch was logged), the contact leaving Awaiting Response, the last step.
--
-- Rollback: ALTER TABLE outreach_item DROP COLUMN sequence_stopped;  (follow-ups then continue until a
--   reply, a stage change or the last step, which is the safe direction; nothing is ever sent anyway).

ALTER TABLE outreach_item ADD COLUMN sequence_stopped INTEGER NOT NULL DEFAULT 0;
