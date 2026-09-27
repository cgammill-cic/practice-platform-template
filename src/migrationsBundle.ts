// GENERATED FILE — do not edit by hand. Run `npm run migrations:bundle` after adding a migration.
//
// Every migration in migrations/, split into statements with comments removed, in file order. The app
// applies pending ones itself (src/migrate.ts) so an updated copy never needs a terminal. The names are
// the migration file names, which is what D1's own d1_migrations ledger records, so Wrangler and the app
// agree on what has been applied.
//
// Generated from 35 migration files, 0001_initial_schema.sql … 0035_commitment.sql.

export interface BundledMigration {
  name: string;
  statements: readonly string[];
}

export const MIGRATIONS: readonly BundledMigration[] = [
 {
  "name": "0001_initial_schema.sql",
  "statements": [
   "CREATE TABLE organization ( id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, domain TEXT, industry TEXT, address TEXT, relationship_status TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')) )",
   "CREATE UNIQUE INDEX idx_organization_name ON organization(name)",
   "CREATE TABLE contact ( id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, title TEXT, organization_id INTEGER REFERENCES organization(id), department TEXT, email_primary TEXT, email_secondary TEXT, phone TEXT, linkedin_url TEXT, stage TEXT NOT NULL DEFAULT 'not_contacted' CHECK (stage IN ('meeting_scheduled','in_conversation','awaiting_response','reach_out_later','not_contacted','stay_connected','complete','no_response','retired','not_qualified')), strength TEXT CHECK (strength IN ('strong','warm','new','cold')), priority_tier INTEGER, escalation_rung INTEGER NOT NULL DEFAULT 0, referral_source_contact_id INTEGER REFERENCES contact(id), last_touch TEXT, next_follow_up TEXT, notes TEXT, source TEXT, import_meta TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')) )",
   "CREATE INDEX idx_contact_stage ON contact(stage)",
   "CREATE INDEX idx_contact_next_follow_up ON contact(next_follow_up)",
   "CREATE INDEX idx_contact_email ON contact(email_primary)",
   "CREATE INDEX idx_contact_org ON contact(organization_id)",
   "CREATE TABLE interaction ( id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL REFERENCES contact(id), date TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('meeting','call','email','text','linkedin','note')), direction TEXT CHECK (direction IN ('outbound','inbound','two_way')), subject TEXT, summary TEXT, notes_link TEXT, outcome TEXT, outlook_ref TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')) )",
   "CREATE INDEX idx_interaction_contact ON interaction(contact_id, date DESC)",
   "CREATE TABLE engagement ( id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id INTEGER REFERENCES organization(id), name TEXT NOT NULL, service_type TEXT, status TEXT NOT NULL DEFAULT 'active', start_date TEXT, end_date TEXT, billing_method TEXT NOT NULL CHECK (billing_method IN ('hourly','fixed_fee','retainer')), hourly_rate REAL, fixed_fee_amount REAL, retainer_monthly_amount REAL, qb_customer_id TEXT, qb_project_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')) )",
   "CREATE TABLE tag ( id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE )",
   "CREATE TABLE contact_tag ( contact_id INTEGER NOT NULL REFERENCES contact(id), tag_id INTEGER NOT NULL REFERENCES tag(id), PRIMARY KEY (contact_id, tag_id) )",
   "CREATE TABLE audit_event ( id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, ts TEXT NOT NULL DEFAULT (datetime('now')), entity TEXT NOT NULL, entity_id TEXT, action TEXT NOT NULL, before_summary TEXT, after_summary TEXT, source TEXT, correlation_id TEXT )",
   "CREATE INDEX idx_audit_ts ON audit_event(ts)",
   "CREATE TABLE backup_run ( id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT (datetime('now')), status TEXT NOT NULL CHECK (status IN ('ok','alert')), detail TEXT, row_counts TEXT, checksum TEXT, object_key TEXT )",
   "INSERT INTO tag (name) VALUES ('lc-mm-executive'),('private-equity'),('hr-leader'),('finance-leader'),('executive'), ('former-colleague'),('referral-source'),('client'),('prospect'),('friend'),('verify-email')"
  ]
 },
 {
  "name": "0002_email_split_and_birthday.sql",
  "statements": [
   "ALTER TABLE contact RENAME COLUMN email_primary TO email_work",
   "ALTER TABLE contact RENAME COLUMN email_secondary TO email_personal",
   "ALTER TABLE contact ADD COLUMN birthday TEXT",
   "DROP INDEX IF EXISTS idx_contact_email",
   "CREATE INDEX idx_contact_email_work ON contact(email_work)",
   "CREATE INDEX idx_contact_email_personal ON contact(email_personal)"
  ]
 },
 {
  "name": "0003_interaction_outcome_fields.sql",
  "statements": [
   "ALTER TABLE interaction ADD COLUMN next_follow_up_set TEXT",
   "ALTER TABLE interaction ADD COLUMN stage_moved_to TEXT"
  ]
 },
 {
  "name": "0004_meeting_schedule.sql",
  "statements": [
   "ALTER TABLE contact ADD COLUMN meeting_date TEXT",
   "ALTER TABLE contact ADD COLUMN meeting_time TEXT",
   "CREATE INDEX idx_contact_meeting_date ON contact(meeting_date)"
  ]
 },
 {
  "name": "0005_follow_up_action_stage.sql",
  "statements": [
   "CREATE TABLE contact_new ( id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, title TEXT, organization_id INTEGER REFERENCES organization(id), department TEXT, email_work TEXT, email_personal TEXT, phone TEXT, linkedin_url TEXT, stage TEXT NOT NULL DEFAULT 'not_contacted' CHECK (stage IN ('meeting_scheduled','follow_up_action','in_conversation','awaiting_response','reach_out_later','not_contacted','stay_connected','complete','no_response','retired','not_qualified')), strength TEXT CHECK (strength IN ('strong','warm','new','cold')), priority_tier INTEGER, escalation_rung INTEGER NOT NULL DEFAULT 0, referral_source_contact_id INTEGER REFERENCES contact_new(id), last_touch TEXT, next_follow_up TEXT, notes TEXT, source TEXT, import_meta TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), birthday TEXT, meeting_date TEXT, meeting_time TEXT )",
   "INSERT INTO contact_new (id, full_name, title, organization_id, department, email_work, email_personal, phone, linkedin_url, stage, strength, priority_tier, escalation_rung, referral_source_contact_id, last_touch, next_follow_up, notes, source, import_meta, status, created_at, updated_at, birthday, meeting_date, meeting_time) SELECT id, full_name, title, organization_id, department, email_work, email_personal, phone, linkedin_url, stage, strength, priority_tier, escalation_rung, referral_source_contact_id, last_touch, next_follow_up, notes, source, import_meta, status, created_at, updated_at, birthday, meeting_date, meeting_time FROM contact",
   "CREATE TABLE interaction_backup AS SELECT * FROM interaction",
   "DELETE FROM interaction",
   "DROP TABLE contact",
   "ALTER TABLE contact_new RENAME TO contact",
   "CREATE INDEX idx_contact_stage ON contact(stage)",
   "CREATE INDEX idx_contact_next_follow_up ON contact(next_follow_up)",
   "CREATE INDEX idx_contact_org ON contact(organization_id)",
   "CREATE INDEX idx_contact_email_work ON contact(email_work)",
   "CREATE INDEX idx_contact_meeting_date ON contact(meeting_date)",
   "INSERT INTO interaction (id, contact_id, date, type, direction, subject, summary, notes_link, outcome, outlook_ref, created_at, next_follow_up_set, stage_moved_to) SELECT id, contact_id, date, type, direction, subject, summary, notes_link, outcome, outlook_ref, created_at, next_follow_up_set, stage_moved_to FROM interaction_backup",
   "DROP TABLE interaction_backup"
  ]
 },
 {
  "name": "0006_action_items.sql",
  "statements": [
   "CREATE TABLE action_item ( id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL REFERENCES contact(id), interaction_id INTEGER REFERENCES interaction(id), description TEXT NOT NULL, due_date TEXT, done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)), done_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')) )",
   "CREATE INDEX idx_action_open ON action_item(done, due_date)",
   "CREATE INDEX idx_action_contact ON action_item(contact_id)",
   "CREATE INDEX idx_action_interaction ON action_item(interaction_id)"
  ]
 },
 {
  "name": "0007_message_templates.sql",
  "statements": [
   "CREATE TABLE message_template ( id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','linkedin','text','other')), rung INTEGER, subject TEXT, body TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)), sort_order INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')) )",
   "CREATE INDEX idx_template_active ON message_template(active, sort_order, name)",
   "INSERT INTO message_template (name, channel, rung, subject, body, sort_order) VALUES ('Initial outreach — reconnect', 'email', 1, 'Catching up', 'Hi {first_name}, I hope you''re doing well. It has been too long, and I wanted to reach out. I''d enjoy hearing what you''ve been working on lately. If you have time in the next couple of weeks for a short call, let me know what works and I''ll send an invite. And if the timing isn''t right, no need to reply. Looking forward to catching up.', 10), ('Follow-up — did this reach you', 'email', 2, 'Following up', 'Hi {first_name}, I wanted to circle back in case my last note got buried. No pressure at all; I''d just enjoy catching up when the timing works for you.', 20), ('LinkedIn — reconnect', 'linkedin', 3, NULL, 'Hi {first_name}, I hope you''re doing well. I sent a note by email but wanted to try here too. Would you be open to catching up sometime in the next few weeks? No pressure if the timing is off.', 30)"
  ]
 },
 {
  "name": "0008_escalation_attempts.sql",
  "statements": [
   "ALTER TABLE contact ADD COLUMN last_attempt_at TEXT",
   "UPDATE contact SET last_attempt_at = ( SELECT MAX(i.date) FROM interaction i WHERE i.contact_id = contact.id AND i.type IN ('email','linkedin','text','call') ), escalation_rung = ( SELECT COUNT(*) FROM interaction i WHERE i.contact_id = contact.id AND i.type IN ('email','linkedin','text','call') ), updated_at = datetime('now') WHERE status = 'active' AND stage = 'awaiting_response' AND EXISTS ( SELECT 1 FROM interaction i WHERE i.contact_id = contact.id AND i.type IN ('email','linkedin','text','call') )",
   "CREATE INDEX idx_contact_attempt ON contact(stage, last_attempt_at)"
  ]
 },
 {
  "name": "0009_pray_stage.sql",
  "statements": [
   "CREATE TABLE contact_new ( id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, title TEXT, organization_id INTEGER REFERENCES organization(id), department TEXT, email_work TEXT, email_personal TEXT, phone TEXT, linkedin_url TEXT, stage TEXT NOT NULL DEFAULT 'not_contacted' CHECK (stage IN ('meeting_scheduled','follow_up_action','in_conversation','awaiting_response','reach_out_later','not_contacted','stay_connected','pray','complete','no_response','retired','not_qualified')), strength TEXT CHECK (strength IN ('strong','warm','new','cold')), priority_tier INTEGER, escalation_rung INTEGER NOT NULL DEFAULT 0, referral_source_contact_id INTEGER REFERENCES contact_new(id), last_touch TEXT, last_attempt_at TEXT, next_follow_up TEXT, notes TEXT, source TEXT, import_meta TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), birthday TEXT, meeting_date TEXT, meeting_time TEXT )",
   "INSERT INTO contact_new (id, full_name, title, organization_id, department, email_work, email_personal, phone, linkedin_url, stage, strength, priority_tier, escalation_rung, referral_source_contact_id, last_touch, last_attempt_at, next_follow_up, notes, source, import_meta, status, created_at, updated_at, birthday, meeting_date, meeting_time) SELECT id, full_name, title, organization_id, department, email_work, email_personal, phone, linkedin_url, stage, strength, priority_tier, escalation_rung, referral_source_contact_id, last_touch, last_attempt_at, next_follow_up, notes, source, import_meta, status, created_at, updated_at, birthday, meeting_date, meeting_time FROM contact",
   "CREATE TABLE interaction_backup AS SELECT * FROM interaction",
   "CREATE TABLE action_item_backup AS SELECT * FROM action_item",
   "CREATE TABLE contact_tag_backup AS SELECT * FROM contact_tag",
   "DELETE FROM interaction",
   "DELETE FROM action_item",
   "DELETE FROM contact_tag",
   "DROP TABLE contact",
   "ALTER TABLE contact_new RENAME TO contact",
   "CREATE INDEX idx_contact_stage ON contact(stage)",
   "CREATE INDEX idx_contact_next_follow_up ON contact(next_follow_up)",
   "CREATE INDEX idx_contact_org ON contact(organization_id)",
   "CREATE INDEX idx_contact_email_work ON contact(email_work)",
   "CREATE INDEX idx_contact_meeting_date ON contact(meeting_date)",
   "CREATE INDEX idx_contact_attempt ON contact(stage, last_attempt_at)",
   "INSERT INTO interaction (id, contact_id, date, type, direction, subject, summary, notes_link, outcome, outlook_ref, created_at, next_follow_up_set, stage_moved_to) SELECT id, contact_id, date, type, direction, subject, summary, notes_link, outcome, outlook_ref, created_at, next_follow_up_set, stage_moved_to FROM interaction_backup",
   "INSERT INTO action_item (id, contact_id, interaction_id, description, due_date, done, done_at, created_at, updated_at) SELECT id, contact_id, interaction_id, description, due_date, done, done_at, created_at, updated_at FROM action_item_backup",
   "INSERT INTO contact_tag (contact_id, tag_id) SELECT contact_id, tag_id FROM contact_tag_backup",
   "DROP TABLE interaction_backup",
   "DROP TABLE action_item_backup",
   "DROP TABLE contact_tag_backup"
  ]
 },
 {
  "name": "0010_attempt_backfill_from_interactions.sql",
  "statements": [
   "UPDATE contact SET escalation_rung = MAX( escalation_rung, (SELECT COUNT(*) FROM interaction i WHERE i.contact_id = contact.id AND i.type IN ('email','linkedin','text','call') AND (i.direction IS NULL OR i.direction <> 'inbound')) ), last_attempt_at = NULLIF( MAX( COALESCE(last_attempt_at, ''), COALESCE((SELECT MAX(i.date) FROM interaction i WHERE i.contact_id = contact.id AND i.type IN ('email','linkedin','text','call') AND (i.direction IS NULL OR i.direction <> 'inbound')), '') ), ''), updated_at = datetime('now') WHERE status = 'active' AND EXISTS ( SELECT 1 FROM interaction i WHERE i.contact_id = contact.id AND i.type IN ('email','linkedin','text','call') AND (i.direction IS NULL OR i.direction <> 'inbound') ) AND ( (SELECT COUNT(*) FROM interaction i WHERE i.contact_id = contact.id AND i.type IN ('email','linkedin','text','call') AND (i.direction IS NULL OR i.direction <> 'inbound')) > escalation_rung OR (SELECT MAX(i.date) FROM interaction i WHERE i.contact_id = contact.id AND i.type IN ('email','linkedin','text','call') AND (i.direction IS NULL OR i.direction <> 'inbound')) > COALESCE(last_attempt_at, '') )"
  ]
 },
 {
  "name": "0011_no_linkedin_flag.sql",
  "statements": [
   "ALTER TABLE contact ADD COLUMN no_linkedin INTEGER NOT NULL DEFAULT 0",
   "CREATE INDEX idx_contact_no_linkedin ON contact(status, no_linkedin, priority_tier)"
  ]
 },
 {
  "name": "0012_time_entry.sql",
  "statements": [
   "CREATE TABLE time_entry ( id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, hours REAL NOT NULL CHECK (hours > 0 AND hours <= 24), activity TEXT NOT NULL CHECK (activity IN ( 'Admin','Business development','Client delivery','Firm development','Marketing/Content', 'Operations','Personal','Professional development','Pursuit/Proposal','Travel' )), engagement_id INTEGER REFERENCES engagement(id), contact_id INTEGER REFERENCES contact(id), note TEXT, source TEXT NOT NULL DEFAULT 'manual', outlook_ref TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')) )",
   "CREATE INDEX idx_time_entry_date ON time_entry(date)",
   "CREATE INDEX idx_time_entry_engagement ON time_entry(engagement_id, date)",
   "CREATE INDEX idx_time_entry_outlook ON time_entry(outlook_ref)"
  ]
 },
 {
  "name": "0013_activity_title_case.sql",
  "statements": [
   "CREATE TABLE time_entry_new ( id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, hours REAL NOT NULL CHECK (hours > 0 AND hours <= 24), activity TEXT NOT NULL CHECK (activity IN ( 'Admin','Business Development','Client Delivery','Firm Development','Marketing/Content', 'Operations','Personal','Professional Development','Pursuit/Proposal','Travel' )), engagement_id INTEGER REFERENCES engagement(id), contact_id INTEGER REFERENCES contact(id), note TEXT, source TEXT NOT NULL DEFAULT 'manual', outlook_ref TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')) )",
   "INSERT INTO time_entry_new (id, date, hours, activity, engagement_id, contact_id, note, source, outlook_ref, created_at, updated_at) SELECT id, date, hours, CASE activity WHEN 'Business development' THEN 'Business Development' WHEN 'Client delivery' THEN 'Client Delivery' WHEN 'Firm development' THEN 'Firm Development' WHEN 'Professional development' THEN 'Professional Development' ELSE activity END, engagement_id, contact_id, note, source, outlook_ref, created_at, updated_at FROM time_entry",
   "DROP TABLE time_entry",
   "ALTER TABLE time_entry_new RENAME TO time_entry",
   "CREATE INDEX idx_time_entry_date ON time_entry(date)",
   "CREATE INDEX idx_time_entry_engagement ON time_entry(engagement_id, date)",
   "CREATE INDEX idx_time_entry_outlook ON time_entry(outlook_ref)"
  ]
 },
 {
  "name": "0014_interaction_format.sql",
  "statements": [
   "ALTER TABLE interaction ADD COLUMN format TEXT CHECK (format IN ( 'meal','coffee','in_person_other','teams','phone','video_other','other' ))",
   "CREATE INDEX idx_interaction_format ON interaction(date, format)"
  ]
 },
 {
  "name": "0015_touch_interval.sql",
  "statements": [
   "ALTER TABLE contact ADD COLUMN touch_interval_days INTEGER CHECK (touch_interval_days IS NULL OR (touch_interval_days >= 1 AND touch_interval_days <= 1095))"
  ]
 },
 {
  "name": "0016_ms_connection.sql",
  "statements": [
   "CREATE TABLE ms_connection ( id INTEGER PRIMARY KEY CHECK (id = 1), account_upn TEXT NOT NULL, account_id TEXT, refresh_token_enc TEXT NOT NULL, scope TEXT, connected_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, last_error TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')) )"
  ]
 },
 {
  "name": "0017_time_entry_subject.sql",
  "statements": [
   "ALTER TABLE time_entry ADD COLUMN subject TEXT"
  ]
 },
 {
  "name": "0018_organization_calendar_tag.sql",
  "statements": [
   "ALTER TABLE organization ADD COLUMN calendar_tag TEXT"
  ]
 },
 {
  "name": "0019_time_entry_hand_edited.sql",
  "statements": [
   "ALTER TABLE time_entry ADD COLUMN hand_edited INTEGER NOT NULL DEFAULT 0"
  ]
 },
 {
  "name": "0020_contact_stage_event.sql",
  "statements": [
   "CREATE TABLE contact_stage_event ( id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL REFERENCES contact(id), from_stage TEXT, to_stage TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT (datetime('now')), origin TEXT NOT NULL DEFAULT 'trigger', audit_event_id INTEGER )",
   "CREATE INDEX idx_stage_event_contact ON contact_stage_event (contact_id, changed_at)",
   "CREATE INDEX idx_stage_event_when ON contact_stage_event (changed_at)",
   "CREATE INDEX idx_stage_event_to ON contact_stage_event (to_stage, changed_at)",
   "CREATE TRIGGER contact_stage_change AFTER UPDATE OF stage ON contact FOR EACH ROW WHEN old.stage IS NOT new.stage BEGIN INSERT INTO contact_stage_event (contact_id, from_stage, to_stage, origin) VALUES (new.id, old.stage, new.stage, 'trigger'); END",
   "CREATE TRIGGER contact_stage_initial AFTER INSERT ON contact FOR EACH ROW BEGIN INSERT INTO contact_stage_event (contact_id, from_stage, to_stage, origin) VALUES (new.id, NULL, new.stage, 'trigger'); END",
   "INSERT INTO contact_stage_event (contact_id, from_stage, to_stage, changed_at, origin, audit_event_id) SELECT CAST(a.entity_id AS INTEGER), p.from_stage, p.to_stage, a.ts, 'audit-backfill', a.id FROM ( SELECT e.id, e.ts, e.entity_id, substr(e.after_summary, instr(e.after_summary, 'stage ') + 6) AS rest FROM audit_event e WHERE e.entity = 'contact' AND e.action = 'update' AND e.after_summary LIKE '%stage %' AND e.after_summary LIKE '%→%' AND e.entity_id GLOB '[0-9]*' ) a JOIN ( SELECT id, substr(rest, 1, instr(rest, ' → ') - 1) AS from_stage, CASE WHEN instr( CASE WHEN instr(substr(rest, instr(rest, ' → ') + 3), ';') > 0 THEN substr(substr(rest, instr(rest, ' → ') + 3), 1, instr(substr(rest, instr(rest, ' → ') + 3), ';') - 1) ELSE substr(rest, instr(rest, ' → ') + 3) END, ' (') > 0 THEN substr( CASE WHEN instr(substr(rest, instr(rest, ' → ') + 3), ';') > 0 THEN substr(substr(rest, instr(rest, ' → ') + 3), 1, instr(substr(rest, instr(rest, ' → ') + 3), ';') - 1) ELSE substr(rest, instr(rest, ' → ') + 3) END, 1, instr( CASE WHEN instr(substr(rest, instr(rest, ' → ') + 3), ';') > 0 THEN substr(substr(rest, instr(rest, ' → ') + 3), 1, instr(substr(rest, instr(rest, ' → ') + 3), ';') - 1) ELSE substr(rest, instr(rest, ' → ') + 3) END, ' (') - 1) ELSE CASE WHEN instr(substr(rest, instr(rest, ' → ') + 3), ';') > 0 THEN substr(substr(rest, instr(rest, ' → ') + 3), 1, instr(substr(rest, instr(rest, ' → ') + 3), ';') - 1) ELSE substr(rest, instr(rest, ' → ') + 3) END END AS to_stage FROM ( SELECT e.id, substr(e.after_summary, instr(e.after_summary, 'stage ') + 6) AS rest FROM audit_event e WHERE e.entity = 'contact' AND e.action = 'update' AND e.after_summary LIKE '%stage %' AND e.after_summary LIKE '%→%' AND e.entity_id GLOB '[0-9]*' ) WHERE instr(rest, ' → ') > 0 ) p ON p.id = a.id WHERE p.from_stage IN ('meeting_scheduled','follow_up_action','in_conversation','awaiting_response', 'reach_out_later','not_contacted','stay_connected','pray','complete', 'no_response','retired','not_qualified') AND p.to_stage IN ('meeting_scheduled','follow_up_action','in_conversation','awaiting_response', 'reach_out_later','not_contacted','stay_connected','pray','complete', 'no_response','retired','not_qualified') AND EXISTS (SELECT 1 FROM contact c WHERE c.id = CAST(a.entity_id AS INTEGER))",
   "INSERT INTO contact_stage_event (contact_id, from_stage, to_stage, changed_at, origin, audit_event_id) SELECT CAST(entity_id AS INTEGER), NULL, to_stage, ts, 'audit-backfill', id FROM ( SELECT e.id, e.ts, e.entity_id, CASE WHEN instr(substr(e.after_summary, instr(e.after_summary, 'stage ') + 6), ' · ') > 0 THEN substr(substr(e.after_summary, instr(e.after_summary, 'stage ') + 6), 1, instr(substr(e.after_summary, instr(e.after_summary, 'stage ') + 6), ' · ') - 1) ELSE substr(e.after_summary, instr(e.after_summary, 'stage ') + 6) END AS to_stage FROM audit_event e WHERE e.entity = 'contact' AND e.action = 'create' AND e.after_summary LIKE '%stage %' AND e.after_summary NOT LIKE '%→%' AND e.entity_id GLOB '[0-9]*' ) WHERE to_stage IN ('meeting_scheduled','follow_up_action','in_conversation','awaiting_response', 'reach_out_later','not_contacted','stay_connected','pray','complete', 'no_response','retired','not_qualified') AND EXISTS (SELECT 1 FROM contact c WHERE c.id = CAST(entity_id AS INTEGER))"
  ]
 },
 {
  "name": "0021_app_setting.sql",
  "statements": [
   "CREATE TABLE app_setting ( key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')) )",
   "INSERT INTO app_setting (key, value) VALUES ('digest_enabled', '1')"
  ]
 },
 {
  "name": "0022_pursuit.sql",
  "statements": [
   "CREATE TABLE engagement_new ( id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id INTEGER REFERENCES organization(id), name TEXT NOT NULL, service_type TEXT, status TEXT NOT NULL DEFAULT 'active', start_date TEXT, end_date TEXT, billing_method TEXT NOT NULL CHECK (billing_method IN ('hourly','tm_not_to_exceed','fixed_fee','retainer','undecided')), hourly_rate REAL, fixed_fee_amount REAL, retainer_monthly_amount REAL, not_to_exceed_amount REAL, expected_value REAL, expected_decision_date TEXT, submitted_date TEXT, decided_at TEXT, next_step TEXT, next_step_date TEXT, origin TEXT, origin_contact_id INTEGER REFERENCES contact(id), outcome_reason TEXT, outcome_note TEXT, qb_customer_id TEXT, qb_project_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')) )",
   "INSERT INTO engagement_new (id, organization_id, name, service_type, status, start_date, end_date, billing_method, hourly_rate, fixed_fee_amount, retainer_monthly_amount, qb_customer_id, qb_project_id, created_at, updated_at) SELECT id, organization_id, name, service_type, status, start_date, end_date, billing_method, hourly_rate, fixed_fee_amount, retainer_monthly_amount, qb_customer_id, qb_project_id, created_at, updated_at FROM engagement",
   "CREATE TABLE time_entry_backup AS SELECT * FROM time_entry",
   "DELETE FROM time_entry",
   "DROP TABLE engagement",
   "ALTER TABLE engagement_new RENAME TO engagement",
   "INSERT INTO time_entry (id, date, hours, activity, engagement_id, contact_id, note, source, outlook_ref, created_at, updated_at, subject, hand_edited) SELECT id, date, hours, activity, engagement_id, contact_id, note, source, outlook_ref, created_at, updated_at, subject, hand_edited FROM time_entry_backup",
   "DROP TABLE time_entry_backup",
   "CREATE INDEX idx_engagement_org ON engagement(organization_id)",
   "CREATE INDEX idx_engagement_status ON engagement(status)",
   "CREATE INDEX idx_engagement_decision ON engagement(expected_decision_date)",
   "CREATE INDEX idx_engagement_next_step ON engagement(next_step_date)",
   "CREATE TABLE engagement_contact ( engagement_id INTEGER NOT NULL REFERENCES engagement(id) ON DELETE CASCADE, contact_id INTEGER NOT NULL REFERENCES contact(id), role TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (engagement_id, contact_id, role) )",
   "CREATE INDEX idx_engagement_contact_contact ON engagement_contact(contact_id)",
   "UPDATE engagement SET status = 'qualifying' WHERE status = 'prospective'",
   "UPDATE engagement SET service_type = 'Change Management' WHERE service_type = 'Change Management'",
   "UPDATE engagement SET service_type = 'HCM & Payroll' WHERE service_type = 'Payroll Support'",
   "UPDATE engagement SET service_type = 'Organizational Design' WHERE id = 3 AND service_type = 'Executive Support'",
   "UPDATE engagement SET service_type = 'Executive/Sponsor Support' WHERE service_type = 'Executive Support'"
  ]
 },
 {
  "name": "0023_org_not_duplicate.sql",
  "statements": [
   "CREATE TABLE organization_not_duplicate ( a_id INTEGER NOT NULL REFERENCES organization(id) ON DELETE CASCADE, b_id INTEGER NOT NULL REFERENCES organization(id) ON DELETE CASCADE, note TEXT, decided_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (a_id, b_id) )",
   "CREATE INDEX idx_org_not_dupe_b ON organization_not_duplicate(b_id)"
  ]
 },
 {
  "name": "0024_email_import_review.sql",
  "statements": [
   "CREATE TABLE email_import_exclusion ( message_id TEXT NOT NULL, contact_id INTEGER NOT NULL REFERENCES contact(id) ON DELETE CASCADE, excluded_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (message_id, contact_id) )",
   "ALTER TABLE contact ADD COLUMN email_import_ignore INTEGER NOT NULL DEFAULT 0"
  ]
 },
 {
  "name": "0025_feature_request.sql",
  "statements": [
   "CREATE TABLE feature_request ( id INTEGER PRIMARY KEY AUTOINCREMENT, submitted_by TEXT, summary TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'considering', 'planned', 'done', 'declined')), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')) )",
   "CREATE INDEX idx_feature_request_status ON feature_request(status, created_at)"
  ]
 },
 {
  "name": "0026_activity_table.sql",
  "statements": [
   "CREATE TABLE activity ( name TEXT PRIMARY KEY, is_work INTEGER NOT NULL DEFAULT 1, is_billable INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')) )",
   "INSERT INTO activity (name, is_work, is_billable) VALUES ('Admin', 1, 0), ('Business Development', 1, 0), ('Client Delivery', 1, 1), ('Firm Development', 1, 0), ('Marketing/Content', 1, 0), ('Operations', 1, 0), ('Personal', 0, 0), ('Professional Development', 1, 0), ('Pursuit/Proposal', 1, 0), ('Travel', 1, 0), ('Vacation/Holiday', 0, 0)",
   "CREATE TABLE time_entry_new ( id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, hours REAL NOT NULL CHECK (hours > 0 AND hours <= 24), activity TEXT NOT NULL REFERENCES activity(name), engagement_id INTEGER REFERENCES engagement(id), contact_id INTEGER REFERENCES contact(id), note TEXT, source TEXT NOT NULL DEFAULT 'manual', outlook_ref TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), subject TEXT, hand_edited INTEGER NOT NULL DEFAULT 0 )",
   "INSERT INTO time_entry_new (id, date, hours, activity, engagement_id, contact_id, note, source, outlook_ref, created_at, updated_at, subject, hand_edited) SELECT id, date, hours, activity, engagement_id, contact_id, note, source, outlook_ref, created_at, updated_at, subject, hand_edited FROM time_entry",
   "DROP TABLE time_entry",
   "ALTER TABLE time_entry_new RENAME TO time_entry",
   "CREATE INDEX idx_time_entry_date ON time_entry(date)",
   "CREATE INDEX idx_time_entry_engagement ON time_entry(engagement_id, date)",
   "CREATE INDEX idx_time_entry_outlook ON time_entry(outlook_ref)"
  ]
 },
 {
  "name": "0027_mail_body_setting.sql",
  "statements": [
   "INSERT INTO app_setting (key, value) VALUES ('mail_body_to_summary', '1')"
  ]
 },
 {
  "name": "0028_email_import_address_ignore.sql",
  "statements": [
   "CREATE TABLE email_import_address_ignore ( address TEXT PRIMARY KEY, ignored_at TEXT NOT NULL DEFAULT (datetime('now')) )"
  ]
 },
 {
  "name": "0029_priority_contact_flag.sql",
  "statements": [
   "ALTER TABLE contact ADD COLUMN is_priority INTEGER NOT NULL DEFAULT 0"
  ]
 },
 {
  "name": "0030_meeting_calendar_link.sql",
  "statements": [
   "ALTER TABLE contact ADD COLUMN meeting_event_id TEXT",
   "ALTER TABLE contact ADD COLUMN meeting_event_dismissed TEXT"
  ]
 },
 {
  "name": "0031_app_user.sql",
  "statements": [
   "CREATE TABLE app_user ( id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')), pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, pw_iterations INTEGER NOT NULL, must_change_pw INTEGER NOT NULL DEFAULT 1 CHECK (must_change_pw IN (0, 1)), status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')), session_version INTEGER NOT NULL DEFAULT 1, failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT, last_login_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')) )"
  ]
 },
 {
  "name": "0032_outreach.sql",
  "statements": [
   "CREATE TABLE outreach_run ( id INTEGER PRIMARY KEY AUTOINCREMENT, trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule', 'sequence')), schedule_id INTEGER, started_by TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT, status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'partial', 'failed', 'skipped')), drafted INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0, detail TEXT )",
   "CREATE INDEX idx_outreach_run_started ON outreach_run(started_at)",
   "CREATE TABLE outreach_item ( id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL REFERENCES contact(id), for_date TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('dashboard', 'contact', 'list', 'schedule', 'sequence')), kind TEXT NOT NULL DEFAULT 'first_touch' CHECK (kind IN ('first_touch', 'follow_up')), sequence_step INTEGER NOT NULL DEFAULT 0, parent_item_id INTEGER REFERENCES outreach_item(id), status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'drafted', 'error', 'logged', 'skipped')), channel TEXT CHECK (channel IN ('email', 'linkedin')), draft_to TEXT, draft_subject TEXT, draft_body TEXT, instructions TEXT, outlook_draft_id TEXT, outlook_web_link TEXT, outlook_error TEXT, error TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, run_id INTEGER REFERENCES outreach_run(id), claimed_at TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), drafted_at TEXT, logged_at TEXT )",
   "CREATE UNIQUE INDEX idx_outreach_item_active ON outreach_item(contact_id) WHERE status IN ('queued', 'drafted')",
   "CREATE INDEX idx_outreach_item_status ON outreach_item(status, for_date)",
   "CREATE TABLE outreach_schedule ( id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('once', 'weekly')), run_on_local TEXT, days_of_week TEXT, time_local TEXT NOT NULL, every_n_weeks INTEGER NOT NULL DEFAULT 1 CHECK (every_n_weeks BETWEEN 1 AND 8), top_up_to INTEGER NOT NULL DEFAULT 0 CHECK (top_up_to BETWEEN 0 AND 50), active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)), anchor_date TEXT, next_run_utc TEXT, last_run_at TEXT, last_result TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')) )",
   "CREATE INDEX idx_outreach_schedule_due ON outreach_schedule(active, next_run_utc)"
  ]
 },
 {
  "name": "0033_outreach_sequence.sql",
  "statements": [
   "ALTER TABLE outreach_item ADD COLUMN sequence_stopped INTEGER NOT NULL DEFAULT 0"
  ]
 },
 {
  "name": "0034_password_reset.sql",
  "statements": [
   "CREATE TABLE password_reset ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES app_user(id), token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT, requested_ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')) )",
   "CREATE INDEX idx_password_reset_user ON password_reset(user_id, created_at)"
  ]
 },
 {
  "name": "0035_commitment.sql",
  "statements": [
   "CREATE TABLE commitment ( id INTEGER PRIMARY KEY AUTOINCREMENT, description TEXT NOT NULL, due_date TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','missed','dropped')), outcome_note TEXT, category TEXT CHECK (category IS NULL OR category IN ('activity','relationship','pursuit','offer','positioning','other')), contact_id INTEGER REFERENCES contact(id), engagement_id INTEGER REFERENCES engagement(id), source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','advisor')), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT )",
   "CREATE INDEX idx_commitment_open ON commitment(status, due_date)",
   "CREATE INDEX idx_commitment_contact ON commitment(contact_id)",
   "CREATE INDEX idx_commitment_engagement ON commitment(engagement_id)"
  ]
 }
];
