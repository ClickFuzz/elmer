'use strict';

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'b'.repeat(64);

const { describe, it, before, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');

const { setupFreshTestDb } = require('./helpers');
const { getPool, closeDb } = require('../db');
const { createApp }        = require('../app');

let app;
let token;
let userId;

before(async () => {
  await setupFreshTestDb();
  app = createApp();
});

after(async () => closeDb());

beforeEach(async () => {
  await setupFreshTestDb();
  app = createApp();

  const res = await request(app)
    .post('/auth/register')
    .send({ email: 'plat@example.com', password: 'password123' });
  token = res.body.token;

  const me = await request(app)
    .get('/auth/me')
    .set('Authorization', `Bearer ${token}`);
  userId = me.body.userId;
});

// ── OAuth state creation ──────────────────────────────────────────────────────

describe('POST /platforms/oauth/state', () => {
  it('returns 201 with a state and expiry for a valid platform', async () => {
    const res = await request(app)
      .post('/platforms/oauth/state')
      .set('Authorization', `Bearer ${token}`)
      .send({ platform: 'google' });
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.state);
    assert.match(res.body.state, /^[0-9a-f]{48}$/);
    assert.ok(res.body.expiresAt > Date.now());
  });

  it('accepts facebook and wordpress as valid platforms', async () => {
    for (const platform of ['facebook', 'wordpress']) {
      const res = await request(app)
        .post('/platforms/oauth/state')
        .set('Authorization', `Bearer ${token}`)
        .send({ platform });
      assert.strictEqual(res.status, 201, `${platform} should be accepted`);
    }
  });

  it('returns 400 for an invalid platform', async () => {
    const res = await request(app)
      .post('/platforms/oauth/state')
      .set('Authorization', `Bearer ${token}`)
      .send({ platform: 'twitter' });
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 when platform is missing', async () => {
    const res = await request(app)
      .post('/platforms/oauth/state')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    assert.strictEqual(res.status, 400);
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app)
      .post('/platforms/oauth/state')
      .send({ platform: 'google' });
    assert.strictEqual(res.status, 401);
  });

  it('creates two unique state values for two requests', async () => {
    const r1 = await request(app)
      .post('/platforms/oauth/state')
      .set('Authorization', `Bearer ${token}`)
      .send({ platform: 'google' });
    const r2 = await request(app)
      .post('/platforms/oauth/state')
      .set('Authorization', `Bearer ${token}`)
      .send({ platform: 'google' });
    assert.notStrictEqual(r1.body.state, r2.body.state);
  });
});

// ── OAuth state validation ────────────────────────────────────────────────────

describe('POST /platforms/oauth/state/validate', () => {
  it('validates and consumes a valid state', async () => {
    const create = await request(app)
      .post('/platforms/oauth/state')
      .set('Authorization', `Bearer ${token}`)
      .send({ platform: 'google' });
    const { state } = create.body;

    const res = await request(app)
      .post('/platforms/oauth/state/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ state });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.platform, 'google');
    assert.strictEqual(res.body.userId, userId);
  });

  it('returns 400 for a second use of the same state (single-use)', async () => {
    const { body: { state } } = await request(app)
      .post('/platforms/oauth/state')
      .set('Authorization', `Bearer ${token}`)
      .send({ platform: 'facebook' });

    await request(app)
      .post('/platforms/oauth/state/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ state });

    const second = await request(app)
      .post('/platforms/oauth/state/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ state });
    assert.strictEqual(second.status, 400);
    assert.match(second.body.error, /already used/i);
  });

  it('returns 400 for an invalid (nonexistent) state', async () => {
    const res = await request(app)
      .post('/platforms/oauth/state/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'deadbeef'.repeat(6) });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /invalid/i);
  });

  it('returns 400 for an expired state', async () => {
    const now = Date.now();
    await getPool().query(
      `INSERT INTO oauth_states (state, user_id, platform, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      ['expiredstate' + 'f'.repeat(36), userId, 'google', now - 20 * 60 * 1000, now - 1]
    );

    const res = await request(app)
      .post('/platforms/oauth/state/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'expiredstate' + 'f'.repeat(36) });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /expired/i);
  });

  it('returns 400 when state parameter is missing', async () => {
    const res = await request(app)
      .post('/platforms/oauth/state/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    assert.strictEqual(res.status, 400);
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app)
      .post('/platforms/oauth/state/validate')
      .send({ state: 'anything' });
    assert.strictEqual(res.status, 401);
  });
});

// ── GET /platforms ────────────────────────────────────────────────────────────

describe('GET /platforms', () => {
  it('returns an empty list when no platforms are connected', async () => {
    const res = await request(app)
      .get('/platforms')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.platforms, []);
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app).get('/platforms');
    assert.strictEqual(res.status, 401);
  });

  it("returns only the authenticated user's platforms", async () => {
    const r2 = await request(app)
      .post('/auth/register')
      .send({ email: 'other@example.com', password: 'password123' });
    const me2 = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${r2.body.token}`);
    const userId2 = me2.body.userId;

    const now = Date.now();
    await getPool().query(
      `INSERT INTO connected_platforms
         (user_id, platform, account_name, account_id, connected_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId2, 'google', 'Other Business', 'id-other', now, now]
    );

    const res = await request(app)
      .get('/platforms')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.platforms, [], 'user 1 should see no platforms');
  });
});

// ── DELETE /platforms/:id ─────────────────────────────────────────────────────

describe('DELETE /platforms/:id', () => {
  it('disconnects a platform the user owns', async () => {
    const now = Date.now();
    const { rows: [{ id: insertedId }] } = await getPool().query(
      `INSERT INTO connected_platforms
         (user_id, platform, account_name, account_id, connected_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, 'facebook', 'My Page', 'fb-123', now, now]
    );

    const res = await request(app)
      .delete(`/platforms/${insertedId}`)
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);

    const { rows } = await getPool().query(
      'SELECT id FROM connected_platforms WHERE id = $1', [insertedId]
    );
    assert.strictEqual(rows.length, 0);
  });

  it('returns 404 for a platform that does not exist', async () => {
    const res = await request(app)
      .delete('/platforms/99999')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 404);
  });

  it("returns 404 when trying to disconnect another user's platform", async () => {
    const r2 = await request(app)
      .post('/auth/register')
      .send({ email: 'thief@example.com', password: 'password123' });
    const me2 = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${r2.body.token}`);
    const userId2 = me2.body.userId;

    const now = Date.now();
    const { rows: [{ id: victimId }] } = await getPool().query(
      `INSERT INTO connected_platforms
         (user_id, platform, account_name, account_id, connected_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId2, 'wordpress', 'Victim Site', 'wp-1', now, now]
    );

    const res = await request(app)
      .delete(`/platforms/${victimId}`)
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 404);
  });

  it('returns 400 for a non-numeric ID', async () => {
    const res = await request(app)
      .delete('/platforms/abc')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 400);
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app).delete('/platforms/1');
    assert.strictEqual(res.status, 401);
  });
});
