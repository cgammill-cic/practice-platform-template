-- 0022 — pursuits: an engagement now begins before it is won (PURS-001, 2026-09-02).
--
-- ============================================================================================
-- WHY THIS IS NOT A NEW TABLE
-- ============================================================================================
-- The request was to "track pursuits" and assign an opportunity to a company. The obvious build is a
-- `pursuit` table that converts into an `engagement` on a win. It was rejected, for one concrete reason
-- above the tidiness argument:
--
--   `time_entry.engagement_id` is the only way this app attaches hours to work, and `Pursuit/Proposal`
--   has been an activity since migration 0012. A separate pursuit table means proposal hours either
--   need a second foreign key on every time entry, or cannot be recorded against the thing they were
--   spent on. Keeping one row means "org design closes at 40% and costs 22 hours a proposal" is a
--   query, not a feature.
--
-- The second reason is that the data already says so. `Organizational Design` for one client (id 3) was in
-- this table as an ACTIVE engagement on 2026-08-17, and on 2026-09-02 it was described as something
-- that a proposal was still being created for. The row was always the pursuit; the schema simply had no way
-- to say which part of its life it was in.
--
-- ACCEPTED COST, STATED PLAINLY: `engagement` now holds rows that are not customers. A lost pursuit is
-- a row in the customer table. Every screen that means "client" must therefore select on status rather
-- than on the table, and the time-entry customer picker is the one that matters — offering a lost
-- pursuit invites hours onto work that never existed. src/types.ts carries the three status groups that
-- make this checkable in one place instead of eleven literal strings.
--
-- ============================================================================================
-- WHY THE TABLE HAS TO BE REBUILT
-- ============================================================================================
-- `billing_method` carries a CHECK from migration 0001 allowing only 'hourly','fixed_fee','retainer'.
-- "Time and materials not to exceed" was requested and it is not in that list, so a value the form
-- offers would be rejected by the database on write — the exact failure REL-022 exists to catch.
-- SQLite cannot alter a CHECK, so the table is rebuilt. The new columns come along in the same rebuild
-- rather than as eleven ALTERs, because the rebuild is the expensive part and it is already happening.
--
-- Two additions to the CHECK, not one:
--   'tm_not_to_exceed'  — what was asked for, with `not_to_exceed_amount` to hold the cap
--   'undecided'         — because the column is NOT NULL and a pursuit at 'identified' genuinely does
--                         not have a billing method yet. Without this, creating a pursuit forces a
--                         commercial decision months early, and whatever gets picked to get past the
--                         form is then wrong in the pipeline report. "Not decided yet" is a fact.
--
-- ============================================================================================
-- THE LIFECYCLE
-- ============================================================================================
-- `status` has no CHECK (see the note in types.ts), so this part costs nothing at the database. Five
-- pre-award values, two live, four closed:
--
--   identified  qualifying  proposal  submitted  verbal | active  on_hold | complete  lost
--                                                                          no_decision  withdrawn
--
-- `prospective` is retired here. It was one bucket covering everything from "they mentioned a need" to
-- "verbal yes, waiting on paper", which is the whole distinction a pipeline exists to draw. No
-- production row uses it (checked 2026-09-02: all four engagements are 'active'), so the UPDATE below
-- is a guard for the dev database and for anyone's local copy, not a data migration.
--
-- ============================================================================================
-- WHY THERE IS NO `probability` COLUMN
-- ============================================================================================
-- Deliberate. A weighted-pipeline percentage on a book this size is a number an operator would tune every
-- week and never trust, and once it exists every report is tempted to multiply by it. Stage is the
-- honest proxy: `verbal` and `identified` are different odds and everybody already knows it. If a
-- forecast is ever wanted, the right shape is a fixed percentage per stage held in code, where it can
-- be argued with, rather than a free number per row that quietly encodes optimism.
--
-- ============================================================================================
-- WHAT IS DELIBERATELY NOT HERE
-- ============================================================================================
-- The "pipeline core" scope was chosen over the full list. So no PO number, no bill-to contact, no
-- payment terms, no delivery site, no decision-process notes, no competitor column, and no renewal
-- dates on live work. All of them were on the table and all of them are second-pass. Invoicing stays
-- QuickBooks' job; the join keys (`qb_customer_id`, `qb_project_id`) already exist and are untouched.
--
-- The physical address requested is NOT added here either — `organization.address` has existed
-- since 0001. It is empty on effectively every organization because nothing in the app could ever write it,
-- which is an interface problem, not a schema one, and is fixed on the new organization screen.
--
-- ============================================================================================
-- HOW TO APPLY (docs/runbook.md is the authority; follow it, not this summary)
-- ============================================================================================
--   1. MANUAL BACKUP FIRST — /health → Run Backup Now. This migration drops a table.
--   2. Apply to practice-platform-dev (55a6f6d5-02cf-4158-a615-8e5c870c32de) and smoke-test.
--   3. Apply to practice-platform-prod (103144bd-0819-459b-b6f9-c72ea6d50375).
--   4. Ledger row in the same sitting:
--        INSERT INTO d1_migrations (name) VALUES ('0022_pursuit.sql');
--
-- PRE-FLIGHT (recorded from prod 2026-09-02; compare after):
--   engagement    4 rows, SUM(id) =    10
--   time_entry  144 rows, SUM(id) = 10440,  8 rows with engagement_id set
--   engagement has NO indexes today — the four created below are new, not restored.
--
-- ROLLBACK: rebuild `engagement` from this file's shape minus the new columns and with the original
-- three-value CHECK, then DROP TABLE engagement_contact. Any pursuit-only row (status in the pre-award
-- or lost groups) has no meaning under the old schema and would have to be deleted or accepted as an
-- odd-looking customer. Take the backup.

-- ------------------------------------------------------------------ engagement, rebuilt

CREATE TABLE engagement_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER REFERENCES organization(id),
  name TEXT NOT NULL,
  service_type TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  start_date TEXT,
  end_date TEXT,
  billing_method TEXT NOT NULL CHECK (billing_method IN
    ('hourly','tm_not_to_exceed','fixed_fee','retainer','undecided')),
  hourly_rate REAL,
  fixed_fee_amount REAL,
  retainer_monthly_amount REAL,

  -- The cap on a not-to-exceed arrangement. Only meaningful when billing_method='tm_not_to_exceed';
  -- not enforced by a constraint because a method can be changed mid-form and a CHECK spanning two
  -- columns turns an ordinary edit into a rejected write.
  not_to_exceed_amount REAL,

  -- What the whole piece of work is worth, whatever the billing method. Deliberately separate from
  -- fixed_fee_amount and retainer_monthly_amount: those are contract terms, this is the number that
  -- belongs in a pipeline total. A retainer at 5,000/month for six months is a 30,000 pursuit, and no
  -- existing column could say so.
  expected_value REAL,

  -- When the client expects to decide. THE field that turns a list into a pipeline: without it nothing
  -- can answer "what could close before November", which is the question behind tracking pursuits.
  expected_decision_date TEXT,
  -- When the proposal actually went out, and when the answer came. The pair gives cycle time.
  submitted_date TEXT,
  decided_at TEXT,

  -- The pursuit's own follow-up, mirroring contact.next_follow_up on purpose. A pursuit with no dated
  -- next step rots exactly the way the 23 cadence-less contacts did in August, and a stalled proposal
  -- is more expensive than a stalled coffee chat.
  next_step TEXT,
  next_step_date TEXT,

  -- Where it came from, and who from. `origin_contact_id` is the person who referred it — the same
  -- shape as contact.referral_source_contact_id, and the reason this is worth a column at all: it
  -- turns "referrals work" into a countable claim about which channel produces PAID work rather than
  -- conversations.
  origin TEXT,
  origin_contact_id INTEGER REFERENCES contact(id),

  -- Why it ended, for the closed statuses. This is the half of demand analysis that is easy to skip
  -- and worthless to omit: won work says what was SOLD, not what is in demand. Three org-design
  -- pursuits lost on budget timing and two change projects won would otherwise read as "change
  -- management is in demand", which is survivorship bias with a chart on top.
  outcome_reason TEXT,
  outcome_note TEXT,

  qb_customer_id TEXT,
  qb_project_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO engagement_new (id, organization_id, name, service_type, status, start_date, end_date,
  billing_method, hourly_rate, fixed_fee_amount, retainer_monthly_amount, qb_customer_id,
  qb_project_id, created_at, updated_at)
SELECT id, organization_id, name, service_type, status, start_date, end_date,
  billing_method, hourly_rate, fixed_fee_amount, retainer_monthly_amount, qb_customer_id,
  qb_project_id, created_at, updated_at
FROM engagement;

-- Park the one child table so the parent can be dropped, preserving ids exactly (the 0009 pattern;
-- 0005's single-table version is not enough and 0009 explains why). Checked 2026-09-02: `time_entry`
-- is the ONLY table referencing engagement(id).
CREATE TABLE time_entry_backup AS SELECT * FROM time_entry;
DELETE FROM time_entry;

DROP TABLE engagement;
ALTER TABLE engagement_new RENAME TO engagement;

INSERT INTO time_entry (id, date, hours, activity, engagement_id, contact_id, note, source,
  outlook_ref, created_at, updated_at, subject, hand_edited)
SELECT id, date, hours, activity, engagement_id, contact_id, note, source,
  outlook_ref, created_at, updated_at, subject, hand_edited
FROM time_entry_backup;

DROP TABLE time_entry_backup;

-- New indexes. `engagement` had none — four rows never needed them, but the pipeline view groups by
-- status, the dashboard and the digest select on the two dates, and every contact and time-entry
-- screen joins on organization_id.
CREATE INDEX idx_engagement_org ON engagement(organization_id);
CREATE INDEX idx_engagement_status ON engagement(status);
CREATE INDEX idx_engagement_decision ON engagement(expected_decision_date);
CREATE INDEX idx_engagement_next_step ON engagement(next_step_date);

-- ------------------------------------------------------------------ people on the pursuit

-- The biggest actual gap in the old schema: there was NO relationship between an engagement and a
-- contact. The decision maker and the influencers on a pursuit are the same people already
-- in the contact table — copying names onto the engagement would create a second, staler copy of the
-- record this whole app exists to keep straight.
--
-- The primary key is all three columns, so one person can hold two roles on the same pursuit (the
-- decision maker is often also the champion) but cannot be added twice in the same role by a double
-- click. ON DELETE CASCADE on the engagement side because a link to a deleted pursuit is nothing; the
-- contact side has no cascade for the reason REL-031 documents — deleting a contact is already a
-- deliberate, enumerated operation and this table joins that list rather than quietly emptying itself.
CREATE TABLE engagement_contact (
  engagement_id INTEGER NOT NULL REFERENCES engagement(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contact(id),
  role TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (engagement_id, contact_id, role)
);

-- Reverse lookup: "which pursuits is this person named on", which the contact record needs.
CREATE INDEX idx_engagement_contact_contact ON engagement_contact(contact_id);

-- ------------------------------------------------------------------ vocabulary backfill

-- `prospective` retired in favour of the five pre-award stages. Zero rows in production; this is a
-- guard for other copies of the database.
UPDATE engagement SET status = 'qualifying' WHERE status = 'prospective';

-- service_type becomes a controlled list, so the four existing free-text values are mapped onto it.
-- The interesting one is id 3: `Organizational Design` for that client was filed under 'Executive Support',
-- so a demand report run today would have shown zero demand for org design — which is precisely the
-- drift a controlled list exists to stop, caught on a table with four rows in it.
UPDATE engagement SET service_type = 'Change Management'                WHERE service_type = 'Change Management';
UPDATE engagement SET service_type = 'HCM & Payroll'                    WHERE service_type = 'Payroll Support';
UPDATE engagement SET service_type = 'Organizational Design'            WHERE id = 3 AND service_type = 'Executive Support';
UPDATE engagement SET service_type = 'Executive/Sponsor Support'        WHERE service_type = 'Executive Support';

-- Anything else that was typed freehand keeps its text and shows as an unrecognised value on the form
-- rather than being guessed at or blanked. Four rows are known; this line is for the fifth someone
-- adds to a dev database.
