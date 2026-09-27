-- 0027 — a switch for pulling email content into the interaction Summary (MAIL-003, the owner 2026-09-21).
--
-- The email importer widened from Mail.ReadBasic to Mail.Read so a logged message's plain-text content
-- can be copied into the interaction's Summary box, instead of leaving it for the owner to type by hand.
-- Same breath, he asked for an off switch: "if a new user doesn't want to pull that much information (or
-- if in reality it is a burden), I want to be able to turn it off without needing new code." That is the
-- app_setting table (migration 0021) again — an operator preference, not a deployment config, read by
-- name at the point of use. See src/settings.ts for the on/off convention and digest_enabled for the
-- precedent this follows.
--
-- Seeded ON. He asked for the feature before asking for the switch, same ordering as the digest — so it
-- should arrive doing the thing he asked for, with the switch there for the day it stops being useful (or
-- for a future deployment where it never was).
--
-- ROLLBACK: DELETE FROM app_setting WHERE key = 'mail_body_to_summary';

INSERT INTO app_setting (key, value) VALUES ('mail_body_to_summary', '1');
