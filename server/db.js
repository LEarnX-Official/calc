/**
 * SQLite storage. One file, no migrations framework — the schema is created
 * idempotently on boot and versioned by a user_version pragma.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'quotecraft.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  business_name TEXT NOT NULL,
  vertical      TEXT NOT NULL DEFAULT 'residential-cleaning',
  plan          TEXT NOT NULL DEFAULT 'trial',
  config_json   TEXT NOT NULL,
  branding_json TEXT NOT NULL DEFAULT '{}',
  webhook_url   TEXT,
  notify_email  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT,
  email        TEXT,
  phone        TEXT,
  address      TEXT,
  note         TEXT,
  quote_total  REAL,
  quote_json   TEXT,
  input_json   TEXT,
  source_url   TEXT,
  status       TEXT NOT NULL DEFAULT 'new',
  webhook_state TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  meta       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id, created_at DESC);
`);

const now = () => new Date().toISOString();
const id = (prefix) => prefix + '_' + crypto.randomBytes(9).toString('base64url');

/** Slugs appear in embed URLs, so they must be URL-safe and unique. */
function uniqueSlug(base) {
  let slug = String(base || 'company').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'company';
  const exists = db.prepare('SELECT 1 FROM tenants WHERE slug = ?');
  if (!exists.get(slug)) return slug;
  for (let i = 2; i < 500; i++) {
    const candidate = slug + '-' + i;
    if (!exists.get(candidate)) return candidate;
  }
  return slug + '-' + crypto.randomBytes(3).toString('hex');
}

function logEvent(tenantId, kind, meta) {
  try {
    db.prepare('INSERT INTO events (tenant_id, kind, meta, created_at) VALUES (?,?,?,?)')
      .run(tenantId, kind, meta ? JSON.stringify(meta) : null, now());
  } catch (_) { /* analytics must never break a request */ }
}

module.exports = { db, now, id, uniqueSlug, logEvent, DATA_DIR };
