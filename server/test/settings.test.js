'use strict';

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const { describe, it, before, after, beforeEach } = require('node:test');
const assert   = require('node:assert/strict');
const request  = require('supertest');

const { setupFreshTestDb } = require('./helpers');
const { closeDb }          = require('../db');
const { createApp }        = require('../app');

let app;

before(async () => {
  await setupFreshTestDb();
  app = createApp();
});

after(async () => closeDb());

beforeEach(async () => {
  await setupFreshTestDb();
  app = createApp();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function register(email = 'user@example.com', password = 'password123') {
  const res = await request(app).post('/auth/register').send({ email, password });
  assert.strictEqual(res.status, 201, 'register should succeed');
  return res.body.token;
}

// ── GET /auth/settings ────────────────────────────────────────────────────────

describe('GET /auth/settings', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/auth/settings');
    assert.strictEqual(res.status, 401);
  });

  it('returns empty settings and version 0 for a new user', async () => {
    const token = await register();
    const res   = await request(app)
      .get('/auth/settings')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.settings, {});
    assert.strictEqual(res.body.version, 0);
  });

  it('returns stored settings after a PATCH', async () => {
    const token = await register();
    await request(app)
      .patch('/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ settings: { name: 'Acme Plumbing', category: 'Plumbing' }, version: 0 });

    const res = await request(app)
      .get('/auth/settings')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.settings.name, 'Acme Plumbing');
    assert.strictEqual(res.body.settings.category, 'Plumbing');
    assert.strictEqual(res.body.version, 1);
  });
});

// ── PATCH /auth/settings ──────────────────────────────────────────────────────

describe('PATCH /auth/settings', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .patch('/auth/settings')
      .send({ settings: { name: 'Test' }, version: 0 });
    assert.strictEqual(res.status, 401);
  });

  it('returns 400 when settings is missing', async () => {
    const token = await register();
    const res   = await request(app)
      .patch('/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 0 });
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 when version is missing', async () => {
    const token = await register();
    const res   = await request(app)
      .patch('/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ settings: { name: 'Test' } });
    assert.strictEqual(res.status, 400);
  });

  it('creates settings and returns version 1', async () => {
    const token = await register();
    const res   = await request(app)
      .patch('/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ settings: { name: 'Sunrise Electric', website: 'https://sunrise.com' }, version: 0 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.settings.name, 'Sunrise Electric');
    assert.strictEqual(res.body.settings.website, 'https://sunrise.com');
    assert.strictEqual(res.body.version, 1);
  });

  it('merges partial updates without losing existing fields', async () => {
    const token = await register();
    // First PATCH: establish baseline
    await request(app)
      .patch('/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ settings: { name: 'Sunrise Electric', category: 'Electrical' }, version: 0 });
    // Second PATCH: only update description
    const res = await request(app)
      .patch('/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ settings: { description: 'Top-quality wiring' }, version: 1 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.settings.name, 'Sunrise Electric');      // preserved
    assert.strictEqual(res.body.settings.category, 'Electrical');        // preserved
    assert.strictEqual(res.body.settings.description, 'Top-quality wiring'); // new
    assert.strictEqual(res.body.version, 2);
  });

  it('increments version on each successful update', async () => {
    const token = await register();
    let expectedVersion = 1;
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .patch('/auth/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ settings: { name: `Name ${i}` }, version: i });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.version, expectedVersion++);
    }
  });

  it('returns 409 with current settings when version is stale', async () => {
    const token = await register();
    // Create version 1
    await request(app)
      .patch('/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ settings: { name: 'Original' }, version: 0 });

    // Send stale version 0 again
    const res = await request(app)
      .patch('/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ settings: { name: 'Overwrite Attempt' }, version: 0 });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'version_conflict');
    assert.strictEqual(res.body.current.version, 1);
    assert.strictEqual(res.body.current.settings.name, 'Original');
  });

  it('is idempotent: same version succeeds once, conflicts on repeat', async () => {
    const token = await register();
    const r1 = await request(app)
      .patch('/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ settings: { name: 'First' }, version: 0 });
    assert.strictEqual(r1.status, 200);

    const r2 = await request(app)
      .patch('/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ settings: { name: 'Second' }, version: 0 });
    assert.strictEqual(r2.status, 409);
  });

  it('isolates settings between users', async () => {
    const tokenA = await register('a@example.com');
    const tokenB = await register('b@example.com');

    await request(app)
      .patch('/auth/settings')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ settings: { name: 'User A Company' }, version: 0 });

    const resB = await request(app)
      .get('/auth/settings')
      .set('Authorization', `Bearer ${tokenB}`);
    assert.strictEqual(resB.body.settings.name, undefined, 'user B should see empty settings');
  });
});

// ── /billing/subscription includes businessName ───────────────────────────────

describe('GET /billing/subscription — businessName field', () => {
  it('returns empty businessName for a new user', async () => {
    const token = await register();
    const res   = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.businessName, '');
  });

  it('returns businessName once settings are saved', async () => {
    const token = await register();
    await request(app)
      .patch('/auth/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ settings: { name: 'Acme Roofing' }, version: 0 });

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.businessName, 'Acme Roofing');
    assert.strictEqual(res.body.onboardingCompleted, true);
  });

  it('onboardingCompleted false when no business name', async () => {
    const token = await register();
    const res   = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.onboardingCompleted, false);
  });
});
