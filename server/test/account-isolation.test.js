'use strict';

// Regression tests for account isolation: sign-out token invalidation,
// cross-account platform data leakage, and cross-account publish attempts.

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'd'.repeat(64);
process.env.FACEBOOK_APP_ID           = 'test_app_id';
process.env.FACEBOOK_APP_SECRET       = 'test_app_secret';
process.env.FACEBOOK_REDIRECT_URI     = 'http://localhost:3001/facebook/callback';
process.env.INSTAGRAM_APP_ID          = 'test_ig_app_id';
process.env.INSTAGRAM_APP_SECRET      = 'test_ig_app_secret';
process.env.INSTAGRAM_REDIRECT_URI    = 'https://test.example.com/instagram/callback';
process.env.THREADS_APP_ID            = 'test_th_app_id';
process.env.THREADS_APP_SECRET        = 'test_th_app_secret';
process.env.THREADS_REDIRECT_URI      = 'https://test.example.com/threads/callback';
process.env.SERVER_URL                = 'https://test.example.com';

const { describe, it, beforeEach, after } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');

const { setupFreshTestDb, seedActiveSubscription } = require('./helpers');
const { getPool, closeDb } = require('../db');
const { createApp }        = require('../app');
const { encrypt }          = require('../crypto');

// ── Helpers ────────────────────────────────────────────────────────────────

async function registerAndLogin(app, email, password = 'password123') {
  await request(app).post('/auth/register').send({ email, password });
  const login = await request(app).post('/auth/login').send({ email, password });
  const me    = await request(app).get('/auth/me').set('Authorization', `Bearer ${login.body.token}`);
  const userId = me.body.userId;
  await seedActiveSubscription(userId);
  return { token: login.body.token, userId };
}

async function insertPlatform(userId, platform, accountName, accountId) {
  const now = Date.now();
  const { rows: [{ id }] } = await getPool().query(
    `INSERT INTO connected_platforms
       (user_id, platform, account_name, account_id, access_token_enc,
        tasks_json, selected, connected_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, '["CREATE_CONTENT"]', true, $6, $7) RETURNING id`,
    [userId, platform, accountName, accountId, encrypt('fake_token'), now, now]
  );
  return id;
}

let app;

beforeEach(async () => {
  await setupFreshTestDb();
  app = createApp();
});

after(() => closeDb());

// ── Session invalidation on logout ─────────────────────────────────────────

describe('session invalidation on logout', () => {
  it('rejects the session token on all protected endpoints after logout', async () => {
    const { token } = await registerAndLogin(app, 'logout@example.com');

    await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const endpoints = [
      () => request(app).get('/auth/me').set('Authorization', `Bearer ${token}`),
      () => request(app).get('/platforms').set('Authorization', `Bearer ${token}`),
      () => request(app).get('/facebook/pages').set('Authorization', `Bearer ${token}`),
      () => request(app).get('/instagram/account').set('Authorization', `Bearer ${token}`),
      () => request(app).get('/threads/account').set('Authorization', `Bearer ${token}`),
    ];

    for (const call of endpoints) {
      const res = await call();
      assert.strictEqual(res.status, 401, `expected 401 after logout for ${res.req?.path}`);
    }
  });
});

// ── Platform list isolation ────────────────────────────────────────────────

describe('GET /platforms — account isolation', () => {
  it("returns only the authenticated user's platforms", async () => {
    const userA = await registerAndLogin(app, 'a@example.com');
    const userB = await registerAndLogin(app, 'b@example.com');

    await insertPlatform(userA.userId, 'facebook', 'A Page', 'page-a');
    await insertPlatform(userA.userId, 'instagram', 'A IG', 'ig-a');

    const res = await request(app)
      .get('/platforms')
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(200);

    assert.strictEqual(res.body.platforms.length, 0, "user B should see no platforms");
  });

  it("each user sees only their own platforms when both have connections", async () => {
    const userA = await registerAndLogin(app, 'a2@example.com');
    const userB = await registerAndLogin(app, 'b2@example.com');

    await insertPlatform(userA.userId, 'facebook', 'A Page', 'page-a2');
    await insertPlatform(userB.userId, 'threads', 'B Threads', 'th-b2');

    const resA = await request(app).get('/platforms').set('Authorization', `Bearer ${userA.token}`).expect(200);
    const resB = await request(app).get('/platforms').set('Authorization', `Bearer ${userB.token}`).expect(200);

    assert.strictEqual(resA.body.platforms.length, 1);
    assert.strictEqual(resA.body.platforms[0].platform, 'facebook');

    assert.strictEqual(resB.body.platforms.length, 1);
    assert.strictEqual(resB.body.platforms[0].platform, 'threads');
  });
});

// ── Facebook isolation ─────────────────────────────────────────────────────

describe('GET /facebook/pages — account isolation', () => {
  it("returns empty list for a user with no connected pages even if another user has pages", async () => {
    const userA = await registerAndLogin(app, 'fba@example.com');
    const userB = await registerAndLogin(app, 'fbb@example.com');

    await insertPlatform(userA.userId, 'facebook', 'A Page', 'page-fba');

    const res = await request(app)
      .get('/facebook/pages')
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(200);

    assert.strictEqual(res.body.pages.length, 0);
  });
});

describe('POST /facebook/publish — cross-account isolation', () => {
  it("returns no_pages_selected for a user who has no pages, even if another user does", async () => {
    const userA = await registerAndLogin(app, 'fbpa@example.com');
    const userB = await registerAndLogin(app, 'fbpb@example.com');

    await insertPlatform(userA.userId, 'facebook', 'A Page', 'page-fbpa');

    const res = await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${userB.token}`)
      .field('message', 'cross-account publish attempt')
      .field('job_id', 'cross-fb-1')
      .expect(422);

    assert.strictEqual(res.body.error, 'no_pages_selected');
  });
});

// ── Instagram isolation ────────────────────────────────────────────────────

describe('GET /instagram/account — account isolation', () => {
  it("returns no account for a user with no IG connection even if another user has one", async () => {
    const userA = await registerAndLogin(app, 'iga@example.com');
    const userB = await registerAndLogin(app, 'igb@example.com');

    await insertPlatform(userA.userId, 'instagram', 'A IG Account', 'ig-iga');

    const res = await request(app)
      .get('/instagram/account')
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(200);

    assert.strictEqual(res.body.account, null);
  });
});

describe('POST /instagram/publish — cross-account isolation', () => {
  it("returns no_account for a user with no IG connection even if another user has one", async () => {
    const userA = await registerAndLogin(app, 'igpa@example.com');
    const userB = await registerAndLogin(app, 'igpb@example.com');

    await insertPlatform(userA.userId, 'instagram', 'A IG Account', 'ig-igpa');

    const res = await request(app)
      .post('/instagram/publish')
      .set('Authorization', `Bearer ${userB.token}`)
      .field('caption', 'cross-account publish attempt')
      .field('job_id', 'cross-ig-1')
      .expect(422);

    assert.strictEqual(res.body.error, 'no_instagram_account');
  });
});

// ── Threads isolation ──────────────────────────────────────────────────────

describe('GET /threads/account — account isolation', () => {
  it("returns no account for a user with no Threads connection even if another user has one", async () => {
    const userA = await registerAndLogin(app, 'tha@example.com');
    const userB = await registerAndLogin(app, 'thb@example.com');

    await insertPlatform(userA.userId, 'threads', 'A Threads Account', 'th-tha');

    const res = await request(app)
      .get('/threads/account')
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(200);

    assert.strictEqual(res.body.account, null);
  });
});

describe('POST /threads/publish — cross-account isolation', () => {
  it("returns no_account for a user with no Threads connection even if another user has one", async () => {
    const userA = await registerAndLogin(app, 'thpa@example.com');
    const userB = await registerAndLogin(app, 'thpb@example.com');

    await insertPlatform(userA.userId, 'threads', 'A Threads Account', 'th-thpa');

    const res = await request(app)
      .post('/threads/publish')
      .set('Authorization', `Bearer ${userB.token}`)
      .field('text', 'cross-account publish attempt')
      .field('job_id', 'cross-th-1')
      .expect(422);

    assert.strictEqual(res.body.error, 'no_threads_account');
  });
});

// ── Platform disconnect isolation ──────────────────────────────────────────

describe('DELETE /platforms/:id — ownership enforcement', () => {
  it("returns 404 when a user tries to delete another user's platform connection", async () => {
    const userA = await registerAndLogin(app, 'dela@example.com');
    const userB = await registerAndLogin(app, 'delb@example.com');

    const platformId = await insertPlatform(userA.userId, 'instagram', 'A IG', 'ig-del');

    await request(app)
      .delete(`/platforms/${platformId}`)
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(404);

    // confirm the platform still exists for user A
    const { rows } = await getPool().query(
      'SELECT id FROM connected_platforms WHERE id = $1 AND user_id = $2',
      [platformId, userA.userId]
    );
    assert.strictEqual(rows.length, 1, 'platform should still exist for user A');
  });
});
