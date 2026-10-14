'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SCHEMA_VERSION = 1;

let _db = null;

function getDb() {
  if (_db) return _db;

  const dbPath = process.env.DB_PATH || path.join(__dirname, 'elmer.db');

  // Ensure parent directory exists for file-based DBs
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');

  migrate(_db);
  return _db;
}

function migrate(db) {
  const version = db.pragma('user_version', { simple: true });

  if (version >= SCHEMA_VERSION) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      token      TEXT    NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_token   ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS business_settings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL UNIQUE,
      settings_json TEXT    NOT NULL DEFAULT '{}',
      updated_at    INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS connected_platforms (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           INTEGER NOT NULL,
      platform          TEXT    NOT NULL
        CHECK(platform IN ('google','facebook','wordpress')),
      account_name      TEXT    NOT NULL,
      account_id        TEXT    NOT NULL,
      access_token_enc  TEXT,
      refresh_token_enc TEXT,
      token_expires_at  INTEGER,
      connected_at      INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      UNIQUE(user_id, platform, account_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      state      TEXT    NOT NULL UNIQUE,
      user_id    INTEGER NOT NULL,
      platform   TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at    INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states(state);

    CREATE TABLE IF NOT EXISTS publishing_records (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER NOT NULL,
      platform         TEXT    NOT NULL,
      platform_post_id TEXT,
      job_ref          TEXT,
      status           TEXT    NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','published','failed')),
      error_message    TEXT,
      published_at     INTEGER,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function cleanExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

// Used in tests and graceful shutdown to release the connection.
function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { getDb, closeDb, cleanExpiredSessions };
