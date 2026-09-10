-- 0007 — message templates.
--
-- Canned outreach copy you can tune to your own voice, organized by escalation-ladder position and
-- channel, so the words you use most are one click from being pasted where you need them.
--
-- Why a table rather than constants in the source
-- -----------------------------------------------
-- The wording of an outreach message has a shelf life — it goes stale as circumstances change, and if it
-- lives in TypeScript, rewording it needs a deploy, which is a reliable way to ensure it never gets
-- reworded. Copy that goes stale silently is the same class of failure as a commitment that goes quiet.
--
-- `rung` is NULLABLE on purpose. The escalation ladder points at specific rungs, but most of what you'll
-- write — a thank-you after a meeting, an intro request, a re-engagement note — belongs to no rung at
-- all. Tying every template to a ladder position would make the library refuse the majority of its own
-- use cases.
--
-- `channel` is constrained but includes 'other', so a new medium does not require a migration to record.
-- 'text' is a valid channel even with no seeded template below — a text that reads like a template
-- defeats the purpose of sending one, so it's worth writing those fresh each time rather than seeding a
-- canned one.

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

-- Starter templates — generic on purpose. Edit these to your own voice on the Templates page; nothing
-- about the feature requires keeping this wording.
INSERT INTO message_template (name, channel, rung, subject, body, sort_order) VALUES
('Initial outreach — reconnecting', 'email', 1, 'Catching up',
'I hope you''re doing well — it''s been a while! I wanted to reach out and see how things are going on your end.

I''d love to reconnect and hear what you''ve been working on. Let me know if you have some time in the next week or two and I''ll send a calendar invite.

Looking forward to catching up.', 10),

('Follow-up — did this reach you', 'email', 2, 'Following up',
'I wanted to circle back and see if my last email reached you okay. Let me know either way — thanks!', 20),

('LinkedIn — reconnecting', 'linkedin', 3, NULL,
'Hey, I hope you''re doing well. I sent a couple of emails your way but wanted to reach out here too in case they didn''t land. Would love to reconnect when you have a moment.', 30);
