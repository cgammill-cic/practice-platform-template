-- 0032 — outreach drafting you control (Phase 2a, the owner 2026-09-25).
--
-- "Instead of automatically drafting messages, I would like to be able to tell it to run." Until now
-- drafting lived outside the app (a weekly Claude task plus an artifact page), so a shared or paid copy
-- could not use it. These three tables bring it in, under the owner's control:
--
-- outreach_item — ONE PERSON IN ONE BATCH, from queued to drafted to logged. Queued from the Dashboard's
--   Outreach Batch, the contact record, a pasted list, or a schedule's top-up. for_date holds someone for
--   a later run (a run drafts items with for_date <= today). The draft text is stored here, editable,
--   and so are the Outlook draft id and link when it was also saved to the mailbox. kind/sequence_step/
--   parent_item_id are for follow-up sequences (PR 2b); every 2a item is a first_touch.
--   One ACTIVE item per contact (queued or drafted), enforced by the partial unique index: queueing
--   twice, or a schedule topping up someone already waiting, is a no-op rather than a duplicate draft.
-- outreach_run — ONE DRAFTING RUN: who or what started it, how many it drafted, tokens and the error
--   text if any. This is the cost trail the Runs list and the monthly spend cap read.
-- outreach_schedule — WHEN TO RUN BY ITSELF: once at a local date+time, or weekly on chosen days every
--   N weeks. top_up_to fills the run to that many from the Outreach Batch (0 = queued people only).
--   Times are America/Chicago; next_run_utc is precomputed so the 5-minute cron tick is one indexed query.
--
-- Nothing here ever SENDS. Drafts are text in the app and, for email, a draft in the owner's Outlook.
--
-- Rollback: DROP TABLE outreach_item; DROP TABLE outreach_run; DROP TABLE outreach_schedule;
--   Loses queued people, drafts and schedules. Logged outreach is unaffected: logging writes the
--   interaction table exactly as before.

CREATE TABLE outreach_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule', 'sequence')),
  schedule_id INTEGER,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'partial', 'failed', 'skipped')),
  drafted INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  detail TEXT
);
CREATE INDEX idx_outreach_run_started ON outreach_run(started_at);

CREATE TABLE outreach_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contact(id),
  for_date TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('dashboard', 'contact', 'list', 'schedule', 'sequence')),
  kind TEXT NOT NULL DEFAULT 'first_touch' CHECK (kind IN ('first_touch', 'follow_up')),
  sequence_step INTEGER NOT NULL DEFAULT 0,
  parent_item_id INTEGER REFERENCES outreach_item(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'drafted', 'error', 'logged', 'skipped')),
  channel TEXT CHECK (channel IN ('email', 'linkedin')),
  draft_to TEXT,
  draft_subject TEXT,
  draft_body TEXT,
  instructions TEXT,
  outlook_draft_id TEXT,
  outlook_web_link TEXT,
  outlook_error TEXT,
  error TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  run_id INTEGER REFERENCES outreach_run(id),
  -- Set when a drafting worker takes the item; another worker skips it for 5 minutes. Stops a browser
  -- "Draft now" loop and the cron's resume from paying for the same draft twice.
  claimed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  drafted_at TEXT,
  logged_at TEXT
);
CREATE UNIQUE INDEX idx_outreach_item_active ON outreach_item(contact_id) WHERE status IN ('queued', 'drafted');
CREATE INDEX idx_outreach_item_status ON outreach_item(status, for_date);

CREATE TABLE outreach_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('once', 'weekly')),
  run_on_local TEXT,
  days_of_week TEXT,
  time_local TEXT NOT NULL,
  every_n_weeks INTEGER NOT NULL DEFAULT 1 CHECK (every_n_weeks BETWEEN 1 AND 8),
  top_up_to INTEGER NOT NULL DEFAULT 0 CHECK (top_up_to BETWEEN 0 AND 50),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  anchor_date TEXT,
  next_run_utc TEXT,
  last_run_at TEXT,
  last_result TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_outreach_schedule_due ON outreach_schedule(active, next_run_utc);
