-- 0025 — a place to write down "it would be good if..." (2026-09-09).
--
-- The request: "it would be good to include an area where people can recommend enhancements that I could
-- then incorporate into the application if it's deemed necessary."
--
-- WHY PER-INSTANCE, NOT CENTRALIZED BACK TO ONE OPERATOR. This ships in the same shared codebase every
-- PKG-001 instance runs, so everyone who gets their own deployment gets this page too — for their
-- own use, on their own data, same as everything else in this app. A CENTRALIZED version (every
-- instance's requests landing in one place a single maintainer reads) would need a shared service every
-- instance calls home to, which is exactly the shared infrastructure PKG-001 (#96) rejected on confidentiality
-- grounds: a request text field is a much smaller risk than a contact record, but "no shared backend,
-- full stop" is the property that makes the risk analysis simple, and a single exception starts eroding
-- it. So this is a local backlog, same shape wherever it runs. Getting a request from one deployment
-- back to whoever maintains the shared codebase is a conversation between them, not a network call this
-- app makes on their behalf.
--
-- No foreign keys to contact or organization — a clean leaf table, so it carries no REL-031 obligation
-- (see docs/definitions.md §4a): nothing here needs a line in health.ts's HANDLED set.
--
-- STATUS IS A SMALL, FIXED VOCABULARY rather than a boolean done/not-done, because "recommend, then I
-- decide if it's worth building" (the original framing) is a review workflow with more than two states:
-- new (unreviewed), considering (read, undecided), planned (accepted, not built yet), done, declined.
-- Closed states (done, declined) are both "this is settled", but conflating them would erase whether a
-- request was ever actually acted on — the same distinction action_item's `done` vs `deleted` already
-- draws for a different kind of commitment.
--
-- `submitted_by` is free text, not a foreign key to a user table — there is no user table yet (AUTH-001,
-- #94, not built). Free text here costs nothing to widen later; a nullable FK to a not-yet-existing
-- table would cost a migration either way.
--
-- Rollback: DROP TABLE feature_request. Every write here is also audited via audit_event, same as
-- everything else in the app, so the set of requests remains reconstructable even after a drop.

CREATE TABLE feature_request (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submitted_by TEXT,
  summary TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'considering', 'planned', 'done', 'declined')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The list page's only real query: open ones (everything short of done/declined) first, oldest first
-- within that — a request sitting unreviewed the longest is the one most worth looking at.
CREATE INDEX idx_feature_request_status ON feature_request(status, created_at);
