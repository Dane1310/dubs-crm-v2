// db.js — foundational relational schema.
// Uses Node's built-in node:sqlite (no external DB driver dependency).
// SQLite chosen deliberately: single file, zero infrastructure to run,
// fully relational, trivially portable to Postgres later if an
// organisation's scale ever demands it. Right-sized for "multiple
// smaller businesses," not enterprise load.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.FOUNDATION_DB_PATH || path.join(__dirname, 'foundation.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS organisations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  organisation_id TEXT,             -- NULL = system default role, usable by any org
  name TEXT NOT NULL,
  FOREIGN KEY (organisation_id) REFERENCES organisations(id)
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (permission_id) REFERENCES permissions(id)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  UNIQUE(organisation_id, email),
  FOREIGN KEY (organisation_id) REFERENCES organisations(id),
  FOREIGN KEY (role_id) REFERENCES roles(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  organisation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  organisation_id TEXT,
  user_id TEXT,
  event TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  timestamp TEXT NOT NULL,
  metadata TEXT
);

-- Phase 4 additions: Leads + Contacts. Contacts are split out from Leads
-- (Phase 2 §E) rather than kept as flattened fields on the lead row.

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  name TEXT,
  email TEXT,
  phone TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organisation_id) REFERENCES organisations(id)
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  contact_id TEXT,
  legacy_id TEXT,              -- original ID from the existing CRM, kept for traceability
  company TEXT NOT NULL,
  source TEXT,                 -- e.g. 'CIPC Sourced', 'Historical import' — free text, org-configurable later
  stage TEXT NOT NULL DEFAULT 'New',
  owner_user_id TEXT,          -- nullable: the existing CRM has no real user accounts yet, only agent NAMES
  owner_name_raw TEXT,         -- preserves the original agent display name when no user account exists yet
  industry TEXT,
  address TEXT,
  website TEXT,
  follow_up_date TEXT,
  date_added TEXT,
  duplicate_flag INTEGER NOT NULL DEFAULT 0,
  duplicate_of_lead_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  raw_extra TEXT,               -- JSON — legacy fields not yet modelled as first-class columns (enrichmentStatus, regDate, imported, needsReassignment, etc.), so nothing from the source is silently dropped
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organisation_id) REFERENCES organisations(id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  FOREIGN KEY (owner_user_id) REFERENCES users(id),
  UNIQUE(organisation_id, legacy_id)   -- makes re-running a migration safely detectable
);

CREATE TABLE IF NOT EXISTS migration_runs (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  source_label TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  source_count INTEGER,
  migrated_count INTEGER,
  duplicate_count INTEGER,
  rejected_count INTEGER,
  contacts_created_count INTEGER,
  report_json TEXT
);

-- Phase 5 additions: Activities + Tasks/Follow-ups (Phase 2 §F/§G).

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  lead_id TEXT,
  contact_id TEXT,
  user_id TEXT NOT NULL,          -- who logged/performed it
  channel TEXT NOT NULL,          -- call | email | whatsapp | meeting | note | other (free text — org-configurable, never hardcoded)
  direction TEXT,                 -- outbound | inbound | null
  outcome TEXT,
  notes TEXT,
  duration_seconds INTEGER,
  external_ref TEXT,              -- future telephony/email provider ID — nullable, unused until VOIP phase
  follow_up_id TEXT,              -- nullable link to a Task this activity generated
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organisation_id) REFERENCES organisations(id),
  FOREIGN KEY (lead_id) REFERENCES leads(id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS stage_history (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  previous_stage TEXT,
  new_stage TEXT NOT NULL,
  changed_by_user_id TEXT,
  changed_at TEXT NOT NULL,
  FOREIGN KEY (organisation_id) REFERENCES organisations(id),
  FOREIGN KEY (lead_id) REFERENCES leads(id),
  FOREIGN KEY (changed_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  lead_id TEXT,
  contact_id TEXT,
  assigned_user_id TEXT NOT NULL,
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',   -- org-configurable vocabulary later; simple default now
  status TEXT NOT NULL DEFAULT 'open',       -- open | done | escalated
  originating_activity_id TEXT,              -- nullable — which activity created this task, if any
  completed_at TEXT,
  completed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organisation_id) REFERENCES organisations(id),
  FOREIGN KEY (lead_id) REFERENCES leads(id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  FOREIGN KEY (assigned_user_id) REFERENCES users(id),
  FOREIGN KEY (originating_activity_id) REFERENCES activities(id)
);
`);

// Phase 9 prep: two legacy Leaderboard inputs — `reason` (negative-outcome
// reason) and `sentiment` (promoter/passive/detractor) — exist in the
// client-side LEADS[].log[] entries but were never modelled as backend
// columns. Every other legacy input (channel, outcome, notes, occurred_at,
// agent/user, lead, stage + stage timing) already has a backend home.
// Added via ALTER rather than editing the CREATE TABLE above so this stays
// a non-destructive migration against any existing foundation.db.
const activityCols = db.prepare(`PRAGMA table_info(activities)`).all().map(c => c.name);
if (!activityCols.includes('reason')) {
  db.exec(`ALTER TABLE activities ADD COLUMN reason TEXT;`);
}
if (!activityCols.includes('sentiment')) {
  db.exec(`ALTER TABLE activities ADD COLUMN sentiment TEXT;`);
}

// Identity-bridge prep: the floor agent roster (PINS/ROLES/ACTIVE_AGENTS)
// identifies people by a free-text display name, not an email — but users
// only had `email` until now. `display_name` is the join key
// provision_agents.js uses to map an existing roster name onto a real
// users.id (and, once mapped, to backfill leads.owner_name_raw ->
// owner_user_id). Nullable/non-destructive ALTER, same pattern as above.
const userCols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
if (!userCols.includes('display_name')) {
db.exec(`ALTER TABLE users ADD COLUMN display_name TEXT;`);
}
if (!userCols.includes('crm_title')) {
db.exec(`ALTER TABLE users ADD COLUMN crm_title TEXT;`);
}
if (!userCols.includes('provisioned_from')) {
// Traceability: how this user record came to exist — 'registration'
// (normal signup) vs 'roster_provisioning' (created by
// provision_agents.js from a floor-agent name with no login intended).
db.exec(`ALTER TABLE users ADD COLUMN provisioned_from TEXT;`);
}

// PIN-agent identity bridge: lets a roster-provisioned user (status
// 'provisioned', no password login possible — see provision_agents.js)
// authenticate with a PIN instead, so their floor activity can be
// attributed to a real backend user_id rather than left as a raw name.
// Nullable — most rows never set this (regular password-login users don't
// need it). Same hash/salt scheme as password_hash/password_salt (the
// scrypt helpers in auth.js are already credential-agnostic), not a new
// crypto mechanism or a second identity system.
if (!userCols.includes('pin_hash')) {
  db.exec(`ALTER TABLE users ADD COLUMN pin_hash TEXT;`);
}
if (!userCols.includes('pin_salt')) {
  db.exec(`ALTER TABLE users ADD COLUMN pin_salt TEXT;`);
}

// Clock-in/out: a simple append-mostly table of shift sessions, one open
// row (clock_out_at IS NULL) per user at a time. New table via CREATE TABLE
// IF NOT EXISTS, same non-destructive pattern as everything else in this
// file -- safe against an existing foundation.db (including one restored
// from a Turso snapshot taken before this feature existed).
db.exec(`
CREATE TABLE IF NOT EXISTS clock_sessions (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  clock_in_at TEXT NOT NULL,
  clock_out_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organisation_id) REFERENCES organisations(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_clock_sessions_open
  ON clock_sessions (organisation_id, user_id, clock_out_at);
`);

module.exports = db;
