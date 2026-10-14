'use strict';

// Each test calls getDb() directly; no shared db reference that can go stale.
// WAL mode is tested on a temp file — in-memory databases fall back to 'memory' mode.
process.env.DISABLE_AUTH      = 'true';
process.env.DISABLE_RATE_LIMIT = 'true';

const { describe, it, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const os      = require('os');
const path    = require('path');
const fs      = require('fs');

const { getDb, closeDb } = require('../db');

// Use a temp file so WAL mode can be tested properly (WAL is a no-op on :memory:).
const TEST_DB = path.join(os.tmpdir(), `elmer-db-test-${process.pid}.db`);

before(() => {
  closeDb();
  process.env.DB_PATH = TEST_DB;
  getDb(); // initialise
});

after(() => {
  closeDb();
  fs.rmSync(TEST_DB, { force: true });
});

describe('Database initialisation', () => {
  it('creates the users table', () => {
    const row = getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
    ).get();
    assert.ok(row, 'users table should exist');
  });

  it('creates the sessions table', () => {
    const row = getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).get();
    assert.ok(row, 'sessions table should exist');
  });

  it('creates the connected_platforms table', () => {
    const row = getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='connected_platforms'"
    ).get();
    assert.ok(row, 'connected_platforms table should exist');
  });

  it('creates the oauth_states table', () => {
    const row = getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_states'"
    ).get();
    assert.ok(row, 'oauth_states table should exist');
  });

  it('creates the publishing_records table', () => {
    const row = getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='publishing_records'"
    ).get();
    assert.ok(row, 'publishing_records table should exist');
  });

  it('sets schema version to 1', () => {
    const version = getDb().pragma('user_version', { simple: true });
    assert.strictEqual(version, 1);
  });

  it('enables WAL journal mode (file-based database)', () => {
    const mode = getDb().pragma('journal_mode', { simple: true });
    assert.strictEqual(mode, 'wal');
  });

  it('enforces foreign key constraints', () => {
    assert.throws(() => {
      getDb().prepare(
        'INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES (99999, ?, ?, ?)'
      ).run('tok', Date.now(), Date.now() + 1000);
    }, /FOREIGN KEY constraint failed/);
  });

  it('multiple getDb() calls return the same instance', () => {
    assert.strictEqual(getDb(), getDb());
  });

  it('closeDb() then getDb() returns a fresh connection', () => {
    const first = getDb();
    closeDb();
    const second = getDb();
    assert.notStrictEqual(first, second, 'should be a new Database instance');
  });

  it('migration is idempotent — running on an existing schema is safe', () => {
    // Close and reopen; migrate() should detect version=1 and skip.
    closeDb();
    const db = getDb();
    const version = db.pragma('user_version', { simple: true });
    assert.strictEqual(version, 1, 'schema version should still be 1');
  });

  it('connected_platforms rejects invalid platform values', () => {
    const db  = getDb();
    const now = Date.now();
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users (email, password_hash, created_at, updated_at) VALUES (?,?,?,?)'
    ).run('fk@example.com', 'hash', now, now);

    assert.throws(() => {
      db.prepare(
        `INSERT INTO connected_platforms
           (user_id, platform, account_name, account_id, connected_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(lastInsertRowid, 'twitter', 'Test', 'id1', now, now);
    }, /CHECK constraint failed/);
  });
});
