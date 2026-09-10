-- 0021 — a small key/value table for operator preferences (DIGEST-001, 2026-09-02).
--
-- WHY A TABLE AT ALL. The daily digest needs an off switch: "I would like to have an on off switch that
-- would allow me to stop the daily digest if I don't find it useful or it's overly cumbersome." That is
-- one boolean, and a whole table for one boolean deserves an argument.
--
-- The alternatives were worse. A column on `ms_connection` would tie a scheduling preference to the
-- Outlook credential, so disconnecting Outlook would silently forget the choice — and worse, the row is
-- deleted on disconnect, so the preference would come back as "on" after a reconnect. An environment
-- variable cannot be changed from a screen, which defeats the point of a switch. A hardcoded constant is
-- not a switch.
--
-- WHAT IT IS NOT. Not a general configuration system, and deliberately not modelled as one: no types, no
-- validation, no schema for the values. It is a place to put the handful of small choices that belong to
-- the operator rather than to the deployment, read by name at the point of use. Today that is the digest
-- switch; the obvious next ones are the digest send time and whether weekends are included.
--
-- Values are TEXT because SQLite has no boolean, and because the next setting is unlikely to be one. The
-- reading convention lives in code (src/settings.ts): a value is on only when it is exactly '1'. Anything
-- else, including a missing row, reads as off — so a corrupted or half-written value fails closed and the
-- app goes quiet rather than emailing on a preference nobody set.
--
-- ROLLBACK: DROP TABLE app_setting;
-- No other table references it and nothing else reads it, so dropping it loses only the preferences.

CREATE TABLE app_setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seeded ON, which is the one debatable choice here.
--
-- The digest was requested alongside a switch to stop it, in that order — so the feature arriving
-- switched off would mean shipping something that does nothing until the operator finds a control they
-- did not know they needed. The switch exists for the day it stops being useful, not for the day it ships.
-- Turning it off is one click on /health, and the off state persists.
INSERT INTO app_setting (key, value) VALUES ('digest_enabled', '1');
