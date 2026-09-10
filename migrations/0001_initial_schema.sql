-- 0001_initial_schema.sql — F-002 (#10)
-- Applied to practice-platform-dev and practice-platform-prod on 2026-07-29 via Cloudflare API.
-- Rollback: DROP TABLE backup_run, audit_event, contact_tag, tag, engagement, interaction, contact, organization (reverse dependency order).

CREATE TABLE organization (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  domain TEXT,
  industry TEXT,
  address TEXT,
  relationship_status TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_organization_name ON organization(name);

CREATE TABLE contact (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  title TEXT,
  organization_id INTEGER REFERENCES organization(id),
  department TEXT,
  email_primary TEXT,
  email_secondary TEXT,
  phone TEXT,
  linkedin_url TEXT,
  stage TEXT NOT NULL DEFAULT 'not_contacted' CHECK (stage IN ('meeting_scheduled','in_conversation','awaiting_response','reach_out_later','not_contacted','stay_connected','complete','no_response','retired','not_qualified')),
  strength TEXT CHECK (strength IN ('strong','warm','new','cold')),
  priority_tier INTEGER,
  escalation_rung INTEGER NOT NULL DEFAULT 0,
  referral_source_contact_id INTEGER REFERENCES contact(id),
  last_touch TEXT,
  next_follow_up TEXT,
  notes TEXT,
  source TEXT,
  import_meta TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_contact_stage ON contact(stage);
CREATE INDEX idx_contact_next_follow_up ON contact(next_follow_up);
CREATE INDEX idx_contact_email ON contact(email_primary);
CREATE INDEX idx_contact_org ON contact(organization_id);

CREATE TABLE interaction (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contact(id),
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('meeting','call','email','text','linkedin','note')),
  direction TEXT CHECK (direction IN ('outbound','inbound','two_way')),
  subject TEXT,
  summary TEXT,
  notes_link TEXT,
  outcome TEXT,
  outlook_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_interaction_contact ON interaction(contact_id, date DESC);

CREATE TABLE engagement (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER REFERENCES organization(id),
  name TEXT NOT NULL,
  service_type TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  start_date TEXT,
  end_date TEXT,
  billing_method TEXT NOT NULL CHECK (billing_method IN ('hourly','fixed_fee','retainer')),
  hourly_rate REAL,
  fixed_fee_amount REAL,
  retainer_monthly_amount REAL,
  qb_customer_id TEXT,
  qb_project_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tag (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE contact_tag (
  contact_id INTEGER NOT NULL REFERENCES contact(id),
  tag_id INTEGER NOT NULL REFERENCES tag(id),
  PRIMARY KEY (contact_id, tag_id)
);

CREATE TABLE audit_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  entity TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  before_summary TEXT,
  after_summary TEXT,
  source TEXT,
  correlation_id TEXT
);
CREATE INDEX idx_audit_ts ON audit_event(ts);

CREATE TABLE backup_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL CHECK (status IN ('ok','alert')),
  detail TEXT,
  row_counts TEXT,
  checksum TEXT,
  object_key TEXT
);

-- Seed the controlled tag list (definitions.md §3)
INSERT INTO tag (name) VALUES
 ('lc-mm-executive'),('private-equity'),('hr-leader'),('finance-leader'),('executive'),
 ('former-colleague'),('referral-source'),('client'),('prospect'),('friend'),('verify-email');
