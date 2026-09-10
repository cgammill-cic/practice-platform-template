// GENERATED FILE — do not edit by hand. Run `npm run schema:manifest` after adding a migration.
//
// The schema objects that migrations/*.sql say should exist, derived from those files in order, with
// drops and renames honoured (0005 and 0013 rebuild tables, so a naive CREATE scan would be wrong).
// /health compares this against the live database's sqlite_master and reports anything missing.
//
// This exists because on 2026-08-24 the local dev database had none of migration 0020's stage-history
// triggers — the file was committed and correct, it had just never been run there. Trigger-dependent
// behaviour then tested as "no events", which is indistinguishable from "working" unless something is
// checking. A Worker cannot read migrations/ at runtime, so the expectation has to be compiled in.
//
// Generated from 26 migration files, 0001_initial_schema.sql … 0026_activity_table.sql.

export const EXPECTED_TABLES: readonly string[] = [
  "action_item",
  "activity",
  "app_setting",
  "audit_event",
  "backup_run",
  "contact",
  "contact_stage_event",
  "contact_tag",
  "email_import_exclusion",
  "engagement",
  "engagement_contact",
  "feature_request",
  "interaction",
  "message_template",
  "ms_connection",
  "organization",
  "organization_not_duplicate",
  "tag",
  "time_entry",
];

export const EXPECTED_INDEXES: readonly string[] = [
  "idx_action_contact",
  "idx_action_interaction",
  "idx_action_open",
  "idx_audit_ts",
  "idx_contact_attempt",
  "idx_contact_email_work",
  "idx_contact_meeting_date",
  "idx_contact_next_follow_up",
  "idx_contact_no_linkedin",
  "idx_contact_org",
  "idx_contact_stage",
  "idx_engagement_contact_contact",
  "idx_engagement_decision",
  "idx_engagement_next_step",
  "idx_engagement_org",
  "idx_engagement_status",
  "idx_feature_request_status",
  "idx_interaction_contact",
  "idx_interaction_format",
  "idx_org_not_dupe_b",
  "idx_organization_name",
  "idx_stage_event_contact",
  "idx_stage_event_to",
  "idx_stage_event_when",
  "idx_template_active",
  "idx_time_entry_date",
  "idx_time_entry_engagement",
  "idx_time_entry_outlook",
];

/**
 * Triggers are the reason this file exists. They are invisible in every screen, they are not exercised
 * by reading data, and their absence looks like a quiet success rather than a failure.
 */
export const EXPECTED_TRIGGERS: readonly string[] = [
  "contact_stage_change",
  "contact_stage_initial",
];

/** How many migration files this was generated from, for the health page to quote. */
export const MIGRATION_COUNT = 26;

/** Which migration last created each object, for the health page to name in its remedy. */
export const OBJECT_SOURCE: Readonly<Record<string, string>> = {
  "index:idx_action_contact": "0006_action_items.sql",
  "index:idx_action_interaction": "0006_action_items.sql",
  "index:idx_action_open": "0006_action_items.sql",
  "index:idx_audit_ts": "0001_initial_schema.sql",
  "index:idx_contact_attempt": "0009_pray_stage.sql",
  "index:idx_contact_email_work": "0009_pray_stage.sql",
  "index:idx_contact_meeting_date": "0009_pray_stage.sql",
  "index:idx_contact_next_follow_up": "0009_pray_stage.sql",
  "index:idx_contact_no_linkedin": "0011_no_linkedin_flag.sql",
  "index:idx_contact_org": "0009_pray_stage.sql",
  "index:idx_contact_stage": "0009_pray_stage.sql",
  "index:idx_engagement_contact_contact": "0022_pursuit.sql",
  "index:idx_engagement_decision": "0022_pursuit.sql",
  "index:idx_engagement_next_step": "0022_pursuit.sql",
  "index:idx_engagement_org": "0022_pursuit.sql",
  "index:idx_engagement_status": "0022_pursuit.sql",
  "index:idx_feature_request_status": "0025_feature_request.sql",
  "index:idx_interaction_contact": "0001_initial_schema.sql",
  "index:idx_interaction_format": "0014_interaction_format.sql",
  "index:idx_org_not_dupe_b": "0023_org_not_duplicate.sql",
  "index:idx_organization_name": "0001_initial_schema.sql",
  "index:idx_stage_event_contact": "0020_contact_stage_event.sql",
  "index:idx_stage_event_to": "0020_contact_stage_event.sql",
  "index:idx_stage_event_when": "0020_contact_stage_event.sql",
  "index:idx_template_active": "0007_message_templates.sql",
  "index:idx_time_entry_date": "0026_activity_table.sql",
  "index:idx_time_entry_engagement": "0026_activity_table.sql",
  "index:idx_time_entry_outlook": "0026_activity_table.sql",
  "table:action_item": "0006_action_items.sql",
  "table:activity": "0026_activity_table.sql",
  "table:app_setting": "0021_app_setting.sql",
  "table:audit_event": "0001_initial_schema.sql",
  "table:backup_run": "0001_initial_schema.sql",
  "table:contact": "0009_pray_stage.sql",
  "table:contact_stage_event": "0020_contact_stage_event.sql",
  "table:contact_tag": "0001_initial_schema.sql",
  "table:email_import_exclusion": "0024_email_import_review.sql",
  "table:engagement": "0022_pursuit.sql",
  "table:engagement_contact": "0022_pursuit.sql",
  "table:feature_request": "0025_feature_request.sql",
  "table:interaction": "0001_initial_schema.sql",
  "table:message_template": "0007_message_templates.sql",
  "table:ms_connection": "0016_ms_connection.sql",
  "table:organization": "0001_initial_schema.sql",
  "table:organization_not_duplicate": "0023_org_not_duplicate.sql",
  "table:tag": "0001_initial_schema.sql",
  "table:time_entry": "0026_activity_table.sql",
  "trigger:contact_stage_change": "0020_contact_stage_event.sql",
  "trigger:contact_stage_initial": "0020_contact_stage_event.sql",
};
