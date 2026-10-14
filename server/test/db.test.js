'use strict';

process.env.DISABLE_RATE_LIMIT = 'true';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupFreshTestDb } = require('./helpers');
const { getPool, closeDb, initDb } = require('../db');

before(async () => {
  await setupFreshTestDb();
});

after(async () => {
  await closeDb();
});

describe('Database initialisation', () => {
  it('creates the users table', async () => {
    const { rows } = await getPool().query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'users'`
    );
    assert.ok(rows.length > 0, 'users table should exist');
  });

  it('creates the sessions table', async () => {
    const { rows } = await getPool().query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'sessions'`
    );
    assert.ok(rows.length > 0, 'sessions table should exist');
  });

  it('creates the connected_platforms table', async () => {
    const { rows } = await getPool().query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'connected_platforms'`
    );
    assert.ok(rows.length > 0, 'connected_platforms table should exist');
  });

  it('creates the oauth_states table', async () => {
    const { rows } = await getPool().query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'oauth_states'`
    );
    assert.ok(rows.length > 0, 'oauth_states table should exist');
  });

  it('creates the publishing_records table', async () => {
    const { rows } = await getPool().query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'publishing_records'`
    );
    assert.ok(rows.length > 0, 'publishing_records table should exist');
  });

  it('records schema version 1 in schema_migrations', async () => {
    const { rows } = await getPool().query(
      'SELECT version FROM schema_migrations WHERE version = 1'
    );
    assert.ok(rows.length > 0, 'schema version 1 should be recorded');
  });

  it('migration is idempotent — calling initDb again is safe', async () => {
    await initDb(); // second call; should not throw or alter data
    const { rows } = await getPool().query(
      'SELECT version FROM schema_migrations WHERE version = 1'
    );
    assert.ok(rows.length > 0, 'schema version should still be 1');
  });

  it('enforces foreign key constraints on sessions', async () => {
    await assert.rejects(
      () => getPool().query(
        'INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES ($1, $2, $3, $4)',
        [99999, 'tok'.repeat(22), Date.now(), Date.now() + 1000]
      ),
      /foreign key/i
    );
  });

  it('connected_platforms rejects invalid platform values', async () => {
    const now = Date.now();
    const { rows: [user] } = await getPool().query(
      'INSERT INTO users (email, password_hash, created_at, updated_at) VALUES ($1, $2, $3, $4) RETURNING id',
      ['fk@example.com', 'hash', now, now]
    );

    await assert.rejects(
      () => getPool().query(
        `INSERT INTO connected_platforms
           (user_id, platform, account_name, account_id, connected_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.id, 'twitter', 'Test', 'id1', now, now]
      ),
      /check/i
    );
  });

  it('getPool() returns the same instance on repeated calls', () => {
    assert.strictEqual(getPool(), getPool());
  });
});
