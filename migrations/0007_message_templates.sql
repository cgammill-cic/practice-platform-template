-- 0007 — message templates (REL-008 Part A, issue #19).
--
-- "I think I should have a 'message template' link where I can easily create a message template,
-- copy and paste into Outlook." — the owner, 2026-08-01. And, separately: "If I could have the option
-- to add more communications templates, that would be good."
--
-- Why a table rather than constants in the source
-- -----------------------------------------------
-- The original REL-008 acceptance criteria said templates are "stored in the app", which reads as
-- hardcoded. That is wrong here for a specific reason: the first-touch message announced a career move
-- ("I recently started my own advisory business"). That sentence has a shelf life. By autumn it is
-- the wrong opening, and if it lives in TypeScript then rewording it needs a deploy — which is a
-- reliable way to ensure it never gets reworded. Copy that goes stale silently is the same class of
-- failure as a commitment that goes quiet.
--
-- rung is NULLABLE on purpose. The escalation ladder (REL-008 Part B) will point at specific rungs,
-- but the owner asked to "add more communications templates", and most of what he will write — a
-- thank-you after a meeting, an intro request, a re-engagement note — belongs to no rung at all. Tying
-- every template to a ladder position would make the library refuse the majority of its own use cases.
--
-- There is deliberately no rung 4 template. The owner: "don't worry about the text message. I generally
-- make that more personal." The ladder will still track that a text was sent; it just will not offer
-- canned words for it, because a text that reads like a template defeats the purpose of sending one.
--
-- channel is constrained but includes 'other', so a new medium does not require a migration to record.
-- 'text' remains a valid channel even with no seeded template, so one can be added later.

CREATE TABLE message_template (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','linkedin','text','other')),
  -- Escalation ladder position, 1-5, or NULL for a template that belongs to no rung.
  rung INTEGER,
  -- Email subject line. NULL for channels that have no subject.
  subject TEXT,
  body TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  -- Display order, so the ladder messages sort ahead of ad-hoc ones without depending on id.
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The list page asks "what is active, in display order" on every load.
CREATE INDEX idx_template_active ON message_template(active, sort_order, name);

-- SEED TEXT REWRITTEN GENERICALLY, 2026-09-25 (Phase 3a packaging). The original seed was the owner's own
-- wording, verbatim (a career announcement, an email address, a signature), which was right for
-- his copy and wrong for anyone else's: every new copy would have opened with his career news. This file
-- was already applied to the owner's database on 2026-08-01, and migrations never re-run, so his templates
-- are untouched by this edit; only databases created from now on get the text below. The schema above
-- is unchanged, so the schema manifest is unaffected. Placeholders ({first_name}) are filled on the
-- Templates page; each owner is expected to rewrite these in their own voice.
INSERT INTO message_template (name, channel, rung, subject, body, sort_order) VALUES
('Initial outreach — reconnect', 'email', 1, 'Catching up',
'Hi {first_name},

I hope you''re doing well. It has been too long, and I wanted to reach out.

I''d enjoy hearing what you''ve been working on lately. If you have time in the next couple of weeks for a short call, let me know what works and I''ll send an invite. And if the timing isn''t right, no need to reply.

Looking forward to catching up.', 10),

('Follow-up — did this reach you', 'email', 2, 'Following up',
'Hi {first_name}, I wanted to circle back in case my last note got buried. No pressure at all; I''d just enjoy catching up when the timing works for you.', 20),

('LinkedIn — reconnect', 'linkedin', 3, NULL,
'Hi {first_name}, I hope you''re doing well. I sent a note by email but wanted to try here too. Would you be open to catching up sometime in the next few weeks? No pressure if the timing is off.', 30);
