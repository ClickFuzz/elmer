'use strict';

// Tests for Meta (Facebook + Instagram) deauthorization and data deletion callbacks.
//
// Covers:
//   - JSON body (existing supertest convention — exercises the express.json() path)
//   - application/x-www-form-urlencoded body (Meta's actual production format —
//     exercises the express.urlencoded() path added by the V12 compliance work)
//   - Valid and invalid signed_request signatures
//   - Correct scoping: only the verified FB/IG user's rows are deleted
//   - Cross-user isolation: user A's callback cannot delete user B's data
//   - Existing rows without platform_user_id are left untouched
//   - Publishing records are also cleaned up by /delete callbacks
//   - Facebook OAuth callback stores platform_user_id

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'c'.repeat(64);
process.env.FACEBOOK_APP_ID           = 'test_fb_app_id';
process.env.FACEBOOK_APP_SECRET       = 'test_fb_secret';
process.env.FACEBOOK_REDIRECT_URI     = 'http://localhost:3001/facebook/callback';
process.env.INSTAGRAM_APP_ID          = 'test_ig_app_id';
process.env.INSTAGRAM_APP_SECRET      = 'test_ig_secret';
process.env.INSTAGRAM_REDIRECT_URI    = 'http://localhost:3001/instagram/callback';
process.env.THREADS_APP_SECRET        = 'test_threads_secret';
process.env.SERVER_URL                = 'https://api.getelmer.com';

const crypto  = require('crypto');
const { describe, it, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');

const { setupFreshTestDb, seedActiveSubscription } = require('./helpers');
const { getPool, closeDb }  = require('../db');
const { createApp }         = require('../app');
const { encrypt }           = require('../crypto');

after(async () => { await closeDb(); });

// ── Shared helpers ────────────────────────────────────────────────────────────

function makeSignedRequest(payload, secret) {
  const payloadStr = JSON.stringify(payload);
  const encoded    = Buffer.from(payloadStr).toString('base64url');
  const sig        = crypto.createHmac('sha256', secret).update(Buffer.from(payloadStr)).digest('base64url');
  return `${sig}.${encoded}`;
}

async function registerAndLogin(app, email, password = 'password123') {
  await request(app).post('/auth/register').send({ email, password });
  const login = await request(app).post('/auth/login').send({ email, password });
  const me    = await request(app).get('/auth/me')
    .set('Authorization', `Bearer ${login.body.token}`);
  const userId = me.body.userId;
  await seedActiveSubscription(userId);
  return { token: login.body.token, userId };
}

async function insertFbPage(userId, accountId, fbUserId = null) {
  const now = Date.now();
  const { rows: [{ id }] } = await getPool().query(
    `INSERT INTO connected_platforms
       (user_id, platform, account_name, account_id, access_token_enc, tasks_json,
        platform_user_id, selected, connected_at, updated_at)
     VALUES ($1, 'facebook', 'Test Page', $2, $3, '[]', $4, true, $5, $5)
     RETURNING id`,
    [userId, accountId, encrypt('tok'), fbUserId, now]
  );
  return id;
}

async function insertIgAccount(userId, igUserId) {
  const now = Date.now();
  const { rows: [{ id }] } = await getPool().query(
    `INSERT INTO connected_platforms
       (user_id, platform, account_name, account_id, access_token_enc,
        selected, connected_at, updated_at)
     VALUES ($1, 'instagram', 'Test IG', $2, $3, true, $4, $4)
     RETURNING id`,
    [userId, igUserId, encrypt('tok'), now]
  );
  return id;
}

async function insertFbPublishRecord(userId, jobRef) {
  const now = Date.now();
  const { rows: [{ id }] } = await getPool().query(
    `INSERT INTO publishing_records
       (user_id, platform, job_ref, status, created_at, updated_at)
     VALUES ($1, 'facebook', $2, 'published', $3, $3) RETURNING id`,
    [userId, jobRef, now]
  );
  return id;
}

async function insertIgPublishRecord(userId, jobRef) {
  const now = Date.now();
  const { rows: [{ id }] } = await getPool().query(
    `INSERT INTO publishing_records
       (user_id, platform, job_ref, status, created_at, updated_at)
     VALUES ($1, 'instagram', $2, 'published', $3, $3) RETURNING id`,
    [userId, jobRef, now]
  );
  return id;
}

// ── POST /facebook/uninstall ──────────────────────────────────────────────────

describe('POST /facebook/uninstall', () => {
  let app, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ userId } = await registerAndLogin(app, 'fbuninstall@example.com'));
  });

  it('returns 400 for missing signed_request', async () => {
    const res = await request(app).post('/facebook/uninstall').send({});
    assert.equal(res.status, 400);
  });

  it('returns 400 for invalid signature — JSON body', async () => {
    const res = await request(app).post('/facebook/uninstall')
      .send({ signed_request: 'badsig.badpayload' });
    assert.equal(res.status, 400);
  });

  it('returns 400 for invalid signature — URL-encoded body (Meta production format)', async () => {
    const res = await request(app).post('/facebook/uninstall')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('signed_request=badsig.badpayload');
    assert.equal(res.status, 400);
  });

  it('removes the Facebook connection for the verified user — JSON body', async () => {
    const fbUserId = 'fb-user-json-1';
    await insertFbPage(userId, 'page-json-1', fbUserId);

    const signed = makeSignedRequest({ user_id: fbUserId, algorithm: 'HMAC-SHA256' }, process.env.FACEBOOK_APP_SECRET);
    const res = await request(app).post('/facebook/uninstall').send({ signed_request: signed });
    assert.equal(res.status, 200);

    const { rows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE platform = 'facebook' AND platform_user_id = $1`,
      [fbUserId]
    );
    assert.equal(rows.length, 0, 'Connection row should be deleted');
  });

  it('removes the Facebook connection — URL-encoded body (Meta production format)', async () => {
    const fbUserId = 'fb-user-urlenc-1';
    await insertFbPage(userId, 'page-urlenc-1', fbUserId);

    const signed = makeSignedRequest({ user_id: fbUserId, algorithm: 'HMAC-SHA256' }, process.env.FACEBOOK_APP_SECRET);
    const res = await request(app).post('/facebook/uninstall')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`signed_request=${encodeURIComponent(signed)}`);
    assert.equal(res.status, 200);

    const { rows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE platform = 'facebook' AND platform_user_id = $1`,
      [fbUserId]
    );
    assert.equal(rows.length, 0, 'Connection row should be deleted via URL-encoded request');
  });

  it('does not delete connections belonging to other users', async () => {
    const { userId: userId2 } = await registerAndLogin(app, 'fbother@example.com');
    const fbUserId = 'fb-user-target';
    const fbOther  = 'fb-user-other';
    await insertFbPage(userId, 'page-target-id', fbUserId);
    await insertFbPage(userId2, 'page-other-id', fbOther);

    const signed = makeSignedRequest({ user_id: fbUserId, algorithm: 'HMAC-SHA256' }, process.env.FACEBOOK_APP_SECRET);
    await request(app).post('/facebook/uninstall').send({ signed_request: signed });

    // Other user's connection must be untouched
    const { rows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE platform = 'facebook' AND platform_user_id = $1`,
      [fbOther]
    );
    assert.equal(rows.length, 1, "Another user's connection must not be deleted");
  });

  it('does not delete rows with NULL platform_user_id for unrelated users', async () => {
    const { userId: userId2 } = await registerAndLogin(app, 'fbnull@example.com');
    // Row without platform_user_id (existing connection before V12)
    await insertFbPage(userId2, 'page-no-uid', null);

    const fbUserId = 'fb-user-known';
    await insertFbPage(userId, 'page-known', fbUserId);

    const signed = makeSignedRequest({ user_id: fbUserId, algorithm: 'HMAC-SHA256' }, process.env.FACEBOOK_APP_SECRET);
    await request(app).post('/facebook/uninstall').send({ signed_request: signed });

    // Null platform_user_id row must not be touched
    const { rows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE platform = 'facebook' AND platform_user_id IS NULL`
    );
    assert.equal(rows.length, 1, 'Row with NULL platform_user_id must not be deleted');
  });

  it('returns 200 and is idempotent when called twice', async () => {
    const fbUserId = 'fb-user-idem';
    await insertFbPage(userId, 'page-idem', fbUserId);

    const signed = makeSignedRequest({ user_id: fbUserId, algorithm: 'HMAC-SHA256' }, process.env.FACEBOOK_APP_SECRET);
    await request(app).post('/facebook/uninstall').send({ signed_request: signed });
    const res2 = await request(app).post('/facebook/uninstall').send({ signed_request: signed });
    assert.equal(res2.status, 200, 'Second call should still return 200');
  });
});

// ── POST /facebook/delete ─────────────────────────────────────────────────────

describe('POST /facebook/delete', () => {
  let app, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ userId } = await registerAndLogin(app, 'fbdelete@example.com'));
  });

  it('returns 400 for invalid signed_request', async () => {
    const res = await request(app).post('/facebook/delete')
      .send({ signed_request: 'notvalid.abc' });
    assert.equal(res.status, 400);
  });

  it('returns confirmation code and status URL — JSON body', async () => {
    const fbUserId = 'fb-del-user-1';
    await insertFbPage(userId, 'page-del-1', fbUserId);

    const signed = makeSignedRequest({ user_id: fbUserId, algorithm: 'HMAC-SHA256' }, process.env.FACEBOOK_APP_SECRET);
    const res = await request(app).post('/facebook/delete').send({ signed_request: signed });
    assert.equal(res.status, 200);
    assert.ok(res.body.confirmation_code, 'Must return confirmation_code');
    assert.ok(res.body.url?.includes('/facebook/deletion-status'), 'Must return deletion-status URL');
  });

  it('returns confirmation code and status URL — URL-encoded body', async () => {
    const fbUserId = 'fb-del-urlenc-1';
    await insertFbPage(userId, 'page-del-urlenc', fbUserId);

    const signed = makeSignedRequest({ user_id: fbUserId, algorithm: 'HMAC-SHA256' }, process.env.FACEBOOK_APP_SECRET);
    const res = await request(app).post('/facebook/delete')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`signed_request=${encodeURIComponent(signed)}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.confirmation_code);
    assert.ok(res.body.url?.includes('/facebook/deletion-status'));
  });

  it('deletes connected_platforms rows for the verified FB user', async () => {
    const fbUserId = 'fb-del-user-2';
    await insertFbPage(userId, 'page-del-2', fbUserId);

    const signed = makeSignedRequest({ user_id: fbUserId, algorithm: 'HMAC-SHA256' }, process.env.FACEBOOK_APP_SECRET);
    await request(app).post('/facebook/delete').send({ signed_request: signed });

    const { rows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE platform = 'facebook' AND platform_user_id = $1`,
      [fbUserId]
    );
    assert.equal(rows.length, 0, 'Connection row must be deleted');
  });

  it('deletes Facebook publishing records for the mapped Elmer user', async () => {
    const fbUserId = 'fb-del-pub-user';
    await insertFbPage(userId, 'page-del-pub', fbUserId);
    const recordId = await insertFbPublishRecord(userId, 'fb_1_job1_page1');

    const signed = makeSignedRequest({ user_id: fbUserId, algorithm: 'HMAC-SHA256' }, process.env.FACEBOOK_APP_SECRET);
    await request(app).post('/facebook/delete').send({ signed_request: signed });

    const { rows } = await getPool().query(
      'SELECT * FROM publishing_records WHERE id = $1',
      [recordId]
    );
    assert.equal(rows.length, 0, 'Publishing record must be deleted');
  });

  it('does not delete publishing records belonging to other Elmer users', async () => {
    const { userId: userId2 } = await registerAndLogin(app, 'fbdel2@example.com');
    const fbUserId = 'fb-del-scoped-user';
    await insertFbPage(userId, 'page-scoped', fbUserId);

    // User2 has unrelated FB publishing records
    const record2Id = await insertFbPublishRecord(userId2, 'fb_2_job1_page2');

    const signed = makeSignedRequest({ user_id: fbUserId, algorithm: 'HMAC-SHA256' }, process.env.FACEBOOK_APP_SECRET);
    await request(app).post('/facebook/delete').send({ signed_request: signed });

    const { rows } = await getPool().query(
      'SELECT * FROM publishing_records WHERE id = $1',
      [record2Id]
    );
    assert.equal(rows.length, 1, "Another user's publishing record must not be deleted");
  });

  it('does not touch rows with NULL platform_user_id', async () => {
    const { userId: userId2 } = await registerAndLogin(app, 'fbdelnull@example.com');
    const nullRowId = await insertFbPage(userId2, 'page-null-uid', null);

    const fbUserId = 'fb-del-known-user';
    await insertFbPage(userId, 'page-known-del', fbUserId);

    const signed = makeSignedRequest({ user_id: fbUserId, algorithm: 'HMAC-SHA256' }, process.env.FACEBOOK_APP_SECRET);
    await request(app).post('/facebook/delete').send({ signed_request: signed });

    const { rows } = await getPool().query(
      'SELECT * FROM connected_platforms WHERE id = $1',
      [nullRowId]
    );
    assert.equal(rows.length, 1, 'Row with NULL platform_user_id must not be deleted');
  });

  it('is idempotent — second call returns 200 with a fresh confirmation code', async () => {
    const fbUserId = 'fb-del-idem';
    await insertFbPage(userId, 'page-idem-del', fbUserId);

    const signed = makeSignedRequest({ user_id: fbUserId, algorithm: 'HMAC-SHA256' }, process.env.FACEBOOK_APP_SECRET);
    const res1 = await request(app).post('/facebook/delete').send({ signed_request: signed });
    const res2 = await request(app).post('/facebook/delete').send({ signed_request: signed });
    assert.equal(res2.status, 200);
    assert.ok(res2.body.confirmation_code, 'Must still return a confirmation code');
    assert.notEqual(res1.body.confirmation_code, res2.body.confirmation_code, 'Each call returns a unique code');
  });
});

// ── GET /facebook/deletion-status ────────────────────────────────────────────

describe('GET /facebook/deletion-status', () => {
  let app;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
  });

  it('returns 200 HTML without exposing private data', async () => {
    const res = await request(app).get('/facebook/deletion-status?code=abc123');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.includes('text/html'));
    assert.ok(res.text.toLowerCase().includes('deletion') || res.text.toLowerCase().includes('removed'));
    // Must not contain any user-identifying information
    assert.ok(!res.text.includes('@'), 'Must not include any email address in status page');
  });
});

// ── POST /instagram/uninstall ─────────────────────────────────────────────────

describe('POST /instagram/uninstall', () => {
  let app, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ userId } = await registerAndLogin(app, 'iguninstall@example.com'));
  });

  it('returns 400 for missing signed_request', async () => {
    const res = await request(app).post('/instagram/uninstall').send({});
    assert.equal(res.status, 400);
  });

  it('returns 400 for invalid signature — JSON body', async () => {
    const res = await request(app).post('/instagram/uninstall')
      .send({ signed_request: 'badsig.badpayload' });
    assert.equal(res.status, 400);
  });

  it('returns 400 for invalid signature — URL-encoded body', async () => {
    const res = await request(app).post('/instagram/uninstall')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('signed_request=badsig.badpayload');
    assert.equal(res.status, 400);
  });

  it('removes the Instagram connection — JSON body', async () => {
    const igUserId = 'ig-user-json-1';
    await insertIgAccount(userId, igUserId);

    const signed = makeSignedRequest({ user_id: igUserId, algorithm: 'HMAC-SHA256' }, process.env.INSTAGRAM_APP_SECRET);
    const res = await request(app).post('/instagram/uninstall').send({ signed_request: signed });
    assert.equal(res.status, 200);

    const { rows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE platform = 'instagram' AND account_id = $1`,
      [igUserId]
    );
    assert.equal(rows.length, 0, 'Instagram connection should be deleted');
  });

  it('removes the Instagram connection — URL-encoded body (Meta production format)', async () => {
    const igUserId = 'ig-user-urlenc-1';
    await insertIgAccount(userId, igUserId);

    const signed = makeSignedRequest({ user_id: igUserId, algorithm: 'HMAC-SHA256' }, process.env.INSTAGRAM_APP_SECRET);
    const res = await request(app).post('/instagram/uninstall')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`signed_request=${encodeURIComponent(signed)}`);
    assert.equal(res.status, 200);

    const { rows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE platform = 'instagram' AND account_id = $1`,
      [igUserId]
    );
    assert.equal(rows.length, 0, 'Instagram connection should be deleted via URL-encoded request');
  });

  it('does not delete other users\' Instagram connections', async () => {
    const { userId: userId2 } = await registerAndLogin(app, 'igother@example.com');
    const igTarget  = 'ig-target-user';
    const igOther   = 'ig-other-user';
    await insertIgAccount(userId, igTarget);
    await insertIgAccount(userId2, igOther);

    const signed = makeSignedRequest({ user_id: igTarget, algorithm: 'HMAC-SHA256' }, process.env.INSTAGRAM_APP_SECRET);
    await request(app).post('/instagram/uninstall').send({ signed_request: signed });

    const { rows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE platform = 'instagram' AND account_id = $1`,
      [igOther]
    );
    assert.equal(rows.length, 1, "Another user's Instagram connection must not be deleted");
  });

  it('returns 200 and is idempotent', async () => {
    const igUserId = 'ig-idem-user';
    await insertIgAccount(userId, igUserId);

    const signed = makeSignedRequest({ user_id: igUserId, algorithm: 'HMAC-SHA256' }, process.env.INSTAGRAM_APP_SECRET);
    await request(app).post('/instagram/uninstall').send({ signed_request: signed });
    const res2 = await request(app).post('/instagram/uninstall').send({ signed_request: signed });
    assert.equal(res2.status, 200);
  });
});

// ── POST /instagram/delete ────────────────────────────────────────────────────

describe('POST /instagram/delete', () => {
  let app, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ userId } = await registerAndLogin(app, 'igdelete@example.com'));
  });

  it('returns 400 for invalid signed_request', async () => {
    const res = await request(app).post('/instagram/delete')
      .send({ signed_request: 'notvalid.abc' });
    assert.equal(res.status, 400);
  });

  it('returns confirmation code and status URL — JSON body', async () => {
    const igUserId = 'ig-del-user-1';
    await insertIgAccount(userId, igUserId);

    const signed = makeSignedRequest({ user_id: igUserId, algorithm: 'HMAC-SHA256' }, process.env.INSTAGRAM_APP_SECRET);
    const res = await request(app).post('/instagram/delete').send({ signed_request: signed });
    assert.equal(res.status, 200);
    assert.ok(res.body.confirmation_code, 'Must return confirmation_code');
    assert.ok(res.body.url?.includes('/instagram/deletion-status'), 'Must return deletion-status URL');
  });

  it('returns confirmation code and status URL — URL-encoded body', async () => {
    const igUserId = 'ig-del-urlenc-1';
    await insertIgAccount(userId, igUserId);

    const signed = makeSignedRequest({ user_id: igUserId, algorithm: 'HMAC-SHA256' }, process.env.INSTAGRAM_APP_SECRET);
    const res = await request(app).post('/instagram/delete')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`signed_request=${encodeURIComponent(signed)}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.confirmation_code);
    assert.ok(res.body.url?.includes('/instagram/deletion-status'));
  });

  it('deletes connected_platforms row for the verified IG user', async () => {
    const igUserId = 'ig-del-user-2';
    await insertIgAccount(userId, igUserId);

    const signed = makeSignedRequest({ user_id: igUserId, algorithm: 'HMAC-SHA256' }, process.env.INSTAGRAM_APP_SECRET);
    await request(app).post('/instagram/delete').send({ signed_request: signed });

    const { rows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE platform = 'instagram' AND account_id = $1`,
      [igUserId]
    );
    assert.equal(rows.length, 0, 'Instagram connection row must be deleted');
  });

  it('deletes Instagram publishing records for the mapped Elmer user', async () => {
    const igUserId = 'ig-del-pub-user';
    await insertIgAccount(userId, igUserId);
    const recordId = await insertIgPublishRecord(userId, `ig_${userId}_job1`);

    const signed = makeSignedRequest({ user_id: igUserId, algorithm: 'HMAC-SHA256' }, process.env.INSTAGRAM_APP_SECRET);
    await request(app).post('/instagram/delete').send({ signed_request: signed });

    const { rows } = await getPool().query(
      'SELECT * FROM publishing_records WHERE id = $1',
      [recordId]
    );
    assert.equal(rows.length, 0, 'Instagram publishing record must be deleted');
  });

  it('does not delete publishing records belonging to other Elmer users', async () => {
    const { userId: userId2 } = await registerAndLogin(app, 'igdel2@example.com');
    const igUserId = 'ig-del-scoped';
    await insertIgAccount(userId, igUserId);

    const record2Id = await insertIgPublishRecord(userId2, `ig_${userId2}_job1`);

    const signed = makeSignedRequest({ user_id: igUserId, algorithm: 'HMAC-SHA256' }, process.env.INSTAGRAM_APP_SECRET);
    await request(app).post('/instagram/delete').send({ signed_request: signed });

    const { rows } = await getPool().query(
      'SELECT * FROM publishing_records WHERE id = $1',
      [record2Id]
    );
    assert.equal(rows.length, 1, "Another user's Instagram publishing record must not be deleted");
  });

  it('is idempotent — second call returns 200 with fresh confirmation code', async () => {
    const igUserId = 'ig-del-idem';
    await insertIgAccount(userId, igUserId);

    const signed = makeSignedRequest({ user_id: igUserId, algorithm: 'HMAC-SHA256' }, process.env.INSTAGRAM_APP_SECRET);
    const res1 = await request(app).post('/instagram/delete').send({ signed_request: signed });
    const res2 = await request(app).post('/instagram/delete').send({ signed_request: signed });
    assert.equal(res2.status, 200);
    assert.ok(res2.body.confirmation_code);
    assert.notEqual(res1.body.confirmation_code, res2.body.confirmation_code, 'Each call returns a unique code');
  });
});

// ── GET /instagram/deletion-status ───────────────────────────────────────────

describe('GET /instagram/deletion-status', () => {
  let app;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
  });

  it('returns 200 HTML without exposing private data', async () => {
    const res = await request(app).get('/instagram/deletion-status?code=xyz789');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.includes('text/html'));
    assert.ok(res.text.toLowerCase().includes('deletion') || res.text.toLowerCase().includes('removed'));
    assert.ok(!res.text.includes('@'), 'Must not include any email address');
  });
});

// ── Facebook OAuth callback stores platform_user_id ──────────────────────────

describe('Facebook OAuth callback — platform_user_id storage', () => {
  let app;

  beforeEach(async () => {
    await setupFreshTestDb();
    // App is built with a mock graphFetch that simulates a full OAuth callback.
  });

  it('stores platform_user_id when /me returns a user ID', async () => {
    const { createFacebookRouter } = require('../routes/facebook');
    const { createApp: ca } = require('../app');

    let callIndex = 0;
    const mockCalls = [
      // Step 1: short-lived token exchange
      { data: { access_token: 'short_token' } },
      // Step 2: long-lived token exchange
      { data: { access_token: 'long_token', expires_in: 5184000 } },
      // Step 3: /me for platform_user_id
      { data: { id: 'fb-uid-123' } },
      // Step 4: /me/accounts for pages
      { data: { data: [{ id: 'page-abc', name: 'My Page', access_token: 'page_tok', tasks: ['CREATE_CONTENT'] }] } },
    ];
    const graphFetch = async () => {
      const r = mockCalls[callIndex++];
      return { ok: true, status: 200, json: async () => r.data };
    };

    const fbRouter = createFacebookRouter({ graphFetch });
    app = ca({ facebookRouter: fbRouter });

    // Register a user and create a state token
    await request(app).post('/auth/register').send({ email: 'fbcb@example.com', password: 'pass1234' });
    const login = await request(app).post('/auth/login').send({ email: 'fbcb@example.com', password: 'pass1234' });
    const token = login.body.token;
    const me    = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    const userId = me.body.userId;
    await seedActiveSubscription(userId);

    const stateRes = await request(app)
      .post('/platforms/oauth/state')
      .set('Authorization', `Bearer ${token}`)
      .send({ platform: 'facebook' });
    const state = stateRes.body.state;

    // Trigger the callback
    await request(app).get(`/facebook/callback?code=testcode&state=${state}`);

    // Verify platform_user_id was stored
    const { rows } = await getPool().query(
      `SELECT platform_user_id FROM connected_platforms WHERE user_id = $1 AND platform = 'facebook'`,
      [userId]
    );
    assert.ok(rows.length > 0, 'Page row must be created');
    assert.equal(rows[0].platform_user_id, 'fb-uid-123', 'platform_user_id must be stored');
  });

  it('completes OAuth callback even when /me fails (platform_user_id stored as NULL)', async () => {
    const { createFacebookRouter } = require('../routes/facebook');
    const { createApp: ca } = require('../app');

    let callIndex = 0;
    const mockCalls = [
      { data: { access_token: 'short_token' } },
      { data: { access_token: 'long_token', expires_in: 5184000 } },
      // /me call fails
      { data: { error: { message: 'Service unavailable', code: 2 } } },
      { data: { data: [{ id: 'page-xyz', name: 'My Page', access_token: 'page_tok', tasks: ['CREATE_CONTENT'] }] } },
    ];
    const graphFetch = async () => {
      const r = mockCalls[callIndex++];
      return { ok: true, status: 200, json: async () => r.data };
    };

    const fbRouter = createFacebookRouter({ graphFetch });
    app = ca({ facebookRouter: fbRouter });

    await request(app).post('/auth/register').send({ email: 'fbcb2@example.com', password: 'pass1234' });
    const login = await request(app).post('/auth/login').send({ email: 'fbcb2@example.com', password: 'pass1234' });
    const token = login.body.token;
    const me    = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    const userId = me.body.userId;
    await seedActiveSubscription(userId);

    const stateRes = await request(app)
      .post('/platforms/oauth/state')
      .set('Authorization', `Bearer ${token}`)
      .send({ platform: 'facebook' });
    const state = stateRes.body.state;

    const cbRes = await request(app).get(`/facebook/callback?code=testcode&state=${state}`);
    // Must still redirect to success — /me failure is non-fatal
    assert.ok(cbRes.headers.location?.includes('success=true'), 'Callback must succeed even when /me fails');

    const { rows } = await getPool().query(
      `SELECT platform_user_id FROM connected_platforms WHERE user_id = $1 AND platform = 'facebook'`,
      [userId]
    );
    assert.ok(rows.length > 0, 'Page row must be created');
    assert.equal(rows[0].platform_user_id, null, 'platform_user_id must be NULL when /me fails');
  });
});

// ── Facebook /delete — debug_token backfill ───────────────────────────────────

describe('Facebook /delete — debug_token backfill for legacy NULL platform_user_id', () => {
  beforeEach(async () => {
    await setupFreshTestDb();
  });

  it('backfills platform_user_id and deletes row when debug_token returns matching user_id', async () => {
    const { createFacebookRouter } = require('../routes/facebook');
    const { createApp: ca } = require('../app');

    const graphFetch = async (url) => {
      if (String(url).includes('debug_token')) {
        return { ok: true, json: async () => ({ data: { user_id: 'fb-legacy-owner-1' } }) };
      }
      throw new Error('Unexpected graphFetch call');
    };
    const fbRouter = createFacebookRouter({ graphFetch });
    const app = ca({ facebookRouter: fbRouter });

    const { userId } = await registerAndLogin(app, 'backfill1@example.com');
    await insertFbPage(userId, 'page-legacy-1', null);
    const pubRecId = await insertFbPublishRecord(userId, 'fb_1_legacy_1');

    const signed = makeSignedRequest(
      { user_id: 'fb-legacy-owner-1', algorithm: 'HMAC-SHA256' },
      process.env.FACEBOOK_APP_SECRET
    );
    const res = await request(app).post('/facebook/delete').send({ signed_request: signed });
    assert.equal(res.status, 200);
    assert.ok(res.body.confirmation_code);
    assert.ok(res.body.url?.includes('/facebook/deletion-status'));

    // Platform row must be deleted after backfill confirmed ownership
    const { rows: platRows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE user_id = $1 AND platform = 'facebook'`,
      [userId]
    );
    assert.equal(platRows.length, 0, 'Row must be deleted after debug_token confirms ownership');

    // Publishing record must also be deleted
    const { rows: pubRows } = await getPool().query(
      'SELECT * FROM publishing_records WHERE id = $1', [pubRecId]
    );
    assert.equal(pubRows.length, 0, 'Publishing record must be deleted');

    // deletion_request must show completed
    const { rows: drRows } = await getPool().query(
      `SELECT status FROM deletion_requests WHERE confirmation_code = $1`,
      [res.body.confirmation_code]
    );
    assert.equal(drRows[0]?.status, 'completed');
  });

  it('backfills platform_user_id but does NOT delete row when debug_token returns a different user_id', async () => {
    const { createFacebookRouter } = require('../routes/facebook');
    const { createApp: ca } = require('../app');

    // debug_token returns a different owner than the requester
    const graphFetch = async (url) => {
      if (String(url).includes('debug_token')) {
        return { ok: true, json: async () => ({ data: { user_id: 'fb-actual-owner' } }) };
      }
      throw new Error('Unexpected graphFetch call');
    };
    const fbRouter = createFacebookRouter({ graphFetch });
    const app = ca({ facebookRouter: fbRouter });

    const { userId } = await registerAndLogin(app, 'backfill2@example.com');
    const rowId = await insertFbPage(userId, 'page-legacy-2', null);

    // Request deletion for a different user than the actual token owner
    const signed = makeSignedRequest(
      { user_id: 'fb-requesting-user', algorithm: 'HMAC-SHA256' },
      process.env.FACEBOOK_APP_SECRET
    );
    const res = await request(app).post('/facebook/delete').send({ signed_request: signed });
    assert.equal(res.status, 200);

    // Row must NOT be deleted (actual owner != requester)
    const { rows } = await getPool().query(
      'SELECT platform_user_id FROM connected_platforms WHERE id = $1', [rowId]
    );
    assert.equal(rows.length, 1, 'Row must not be deleted when debug_token resolves to a different user');
    // platform_user_id must be backfilled to the actual owner even though no deletion occurred
    assert.equal(rows[0].platform_user_id, 'fb-actual-owner', 'platform_user_id must be backfilled');

    // Status is 'no_data' (resolvedAll=true, 0 rows matched — confirmed not the user's data)
    const { rows: drRows } = await getPool().query(
      `SELECT status FROM deletion_requests WHERE confirmation_code = $1`,
      [res.body.confirmation_code]
    );
    assert.equal(drRows[0]?.status, 'no_data');
  });

  it('reports failed status when debug_token call throws (network error on legacy tokens)', async () => {
    const { createFacebookRouter } = require('../routes/facebook');
    const { createApp: ca } = require('../app');

    // Mock throws to simulate network failure
    const graphFetch = async () => { throw new Error('Network error'); };
    const fbRouter = createFacebookRouter({ graphFetch });
    const app = ca({ facebookRouter: fbRouter });

    const { userId } = await registerAndLogin(app, 'backfill3@example.com');
    const rowId = await insertFbPage(userId, 'page-legacy-3', null);

    const signed = makeSignedRequest(
      { user_id: 'fb-any-user', algorithm: 'HMAC-SHA256' },
      process.env.FACEBOOK_APP_SECRET
    );
    const res = await request(app).post('/facebook/delete').send({ signed_request: signed });
    assert.equal(res.status, 200);
    assert.ok(res.body.confirmation_code);

    // Row must NOT be deleted
    const { rows } = await getPool().query(
      'SELECT * FROM connected_platforms WHERE id = $1', [rowId]
    );
    assert.equal(rows.length, 1, 'Row must not be deleted when debug_token call fails');

    // Status must be 'failed' — identity could not be verified due to network error
    const { rows: drRows } = await getPool().query(
      `SELECT status FROM deletion_requests WHERE confirmation_code = $1`,
      [res.body.confirmation_code]
    );
    assert.equal(drRows[0]?.status, 'failed');
  });

  it('reports failed status when debug_token returns an HTTP error response (not a network throw)', async () => {
    const { createFacebookRouter } = require('../routes/facebook');
    const { createApp: ca } = require('../app');

    // Mock returns a non-ok HTTP response (e.g., 400 for invalid/expired token)
    const graphFetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid OAuth access token', code: 190 } }),
    });
    const fbRouter = createFacebookRouter({ graphFetch });
    const app = ca({ facebookRouter: fbRouter });

    const { userId } = await registerAndLogin(app, 'backfill4@example.com');
    const rowId = await insertFbPage(userId, 'page-legacy-4', null);

    const signed = makeSignedRequest(
      { user_id: 'fb-any-user-2', algorithm: 'HMAC-SHA256' },
      process.env.FACEBOOK_APP_SECRET
    );
    const res = await request(app).post('/facebook/delete').send({ signed_request: signed });
    assert.equal(res.status, 200);
    assert.ok(res.body.confirmation_code);

    // Row must NOT be deleted
    const { rows } = await getPool().query(
      'SELECT * FROM connected_platforms WHERE id = $1', [rowId]
    );
    assert.equal(rows.length, 1, 'Row must not be deleted when debug_token returns HTTP error');

    // HTTP error must be treated as unverifiable — failed, not no_data
    const { rows: drRows } = await getPool().query(
      `SELECT status FROM deletion_requests WHERE confirmation_code = $1`,
      [res.body.confirmation_code]
    );
    assert.equal(drRows[0]?.status, 'failed', 'HTTP error from debug_token must produce failed, not no_data or completed');
  });
});

// ── GET /facebook/deletion-status — confirmation code lookup ──────────────────

describe('GET /facebook/deletion-status — confirmation code lookup', () => {
  let app;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
  });

  it('shows completed message for a completed deletion request', async () => {
    await getPool().query(
      `INSERT INTO deletion_requests (platform, confirmation_code, status, created_at, completed_at)
       VALUES ('facebook', 'fb-code-completed', 'completed', $1, $1)`,
      [Date.now()]
    );
    const res = await request(app).get('/facebook/deletion-status?code=fb-code-completed');
    assert.equal(res.status, 200);
    assert.ok(res.text.toLowerCase().includes('removed'), 'Must show completion message');
    assert.ok(!res.text.includes('@'), 'Must not expose personal data');
  });

  it('shows no_data message when confirmed no data found', async () => {
    await getPool().query(
      `INSERT INTO deletion_requests (platform, confirmation_code, status, created_at)
       VALUES ('facebook', 'fb-code-nodata', 'no_data', $1)`,
      [Date.now()]
    );
    const res = await request(app).get('/facebook/deletion-status?code=fb-code-nodata');
    assert.equal(res.status, 200);
    assert.ok(
      res.text.toLowerCase().includes('no data') || res.text.toLowerCase().includes('not found') || res.text.toLowerCase().includes('processed'),
      'Must show no_data message (confirmed not present)'
    );
    assert.ok(!res.text.includes('@'), 'Must not expose personal data');
  });

  it('shows failed message for a failed deletion request', async () => {
    await getPool().query(
      `INSERT INTO deletion_requests (platform, confirmation_code, status, created_at)
       VALUES ('facebook', 'fb-code-failed', 'failed', $1)`,
      [Date.now()]
    );
    const res = await request(app).get('/facebook/deletion-status?code=fb-code-failed');
    assert.equal(res.status, 200);
    assert.ok(
      res.text.toLowerCase().includes('error') || res.text.toLowerCase().includes('contact'),
      'Must show error/contact message for failed status'
    );
    assert.ok(!res.text.includes('@'), 'Must not expose personal data');
  });

  it('shows not-found message for an unknown confirmation code', async () => {
    const res = await request(app).get('/facebook/deletion-status?code=unknown-code-fb-xyz');
    assert.equal(res.status, 200);
    assert.ok(res.text.toLowerCase().includes('not found'), 'Must indicate code not found');
  });

  it('shows generic info page when no code is provided', async () => {
    const res = await request(app).get('/facebook/deletion-status');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.includes('text/html'));
    assert.ok(!res.text.includes('@'), 'Must not expose personal data');
  });
});

// ── POST /instagram/delete — deletion_request tracking ───────────────────────

describe('POST /instagram/delete — deletion_request status tracking', () => {
  let app, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ userId } = await registerAndLogin(app, 'igdeltrack@example.com'));
  });

  it('persists deletion_request with completed status after successful deletion', async () => {
    const igUserId = 'ig-track-user-1';
    await insertIgAccount(userId, igUserId);

    const signed = makeSignedRequest(
      { user_id: igUserId, algorithm: 'HMAC-SHA256' },
      process.env.INSTAGRAM_APP_SECRET
    );
    const res = await request(app).post('/instagram/delete').send({ signed_request: signed });
    assert.equal(res.status, 200);
    assert.ok(res.body.confirmation_code);

    const { rows } = await getPool().query(
      `SELECT status, connections_deleted FROM deletion_requests WHERE confirmation_code = $1`,
      [res.body.confirmation_code]
    );
    assert.equal(rows[0]?.status, 'completed', 'deletion_request must have completed status');
    assert.equal(rows[0]?.connections_deleted, 1, 'Must record the number of connections deleted');
  });

  it('status page shows completed message when queried with the returned code', async () => {
    const igUserId = 'ig-track-user-2';
    await insertIgAccount(userId, igUserId);

    const signed = makeSignedRequest(
      { user_id: igUserId, algorithm: 'HMAC-SHA256' },
      process.env.INSTAGRAM_APP_SECRET
    );
    const deleteRes = await request(app).post('/instagram/delete').send({ signed_request: signed });
    const { confirmation_code } = deleteRes.body;

    const statusRes = await request(app).get(`/instagram/deletion-status?code=${confirmation_code}`);
    assert.equal(statusRes.status, 200);
    assert.ok(statusRes.text.toLowerCase().includes('removed'), 'Status page must confirm deletion');
  });

  it('status page shows not-found for an unknown code', async () => {
    const res = await request(app).get('/instagram/deletion-status?code=ig-unknown-code');
    assert.equal(res.status, 200);
    assert.ok(res.text.toLowerCase().includes('not found'));
  });
});

// ── POST /threads/delete — deletion_request tracking ─────────────────────────

describe('POST /threads/delete — deletion_request status tracking', () => {
  let app, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ userId } = await registerAndLogin(app, 'threadsdeltrack@example.com'));
  });

  async function insertThreadsAccount(uid, threadsUserId) {
    const now = Date.now();
    await getPool().query(
      `INSERT INTO connected_platforms
         (user_id, platform, account_name, account_id, access_token_enc,
          selected, connected_at, updated_at)
       VALUES ($1, 'threads', 'Test Threads', $2, $3, true, $4, $4)`,
      [uid, threadsUserId, encrypt('tok'), now]
    );
  }

  it('persists deletion_request with completed status after successful deletion', async () => {
    const threadsUserId = 'threads-track-1';
    await insertThreadsAccount(userId, threadsUserId);

    const signed = makeSignedRequest(
      { user_id: threadsUserId, algorithm: 'HMAC-SHA256' },
      process.env.THREADS_APP_SECRET
    );
    const res = await request(app).post('/threads/delete').send({ signed_request: signed });
    assert.equal(res.status, 200);
    assert.ok(res.body.confirmation_code);
    assert.ok(res.body.url?.includes('/threads/deletion-status'));

    const { rows } = await getPool().query(
      `SELECT status FROM deletion_requests WHERE confirmation_code = $1`,
      [res.body.confirmation_code]
    );
    assert.equal(rows[0]?.status, 'completed', 'deletion_request must show completed');
  });

  it('status page shows completed message when queried with the returned code', async () => {
    const threadsUserId = 'threads-track-2';
    await insertThreadsAccount(userId, threadsUserId);

    const signed = makeSignedRequest(
      { user_id: threadsUserId, algorithm: 'HMAC-SHA256' },
      process.env.THREADS_APP_SECRET
    );
    const deleteRes = await request(app).post('/threads/delete').send({ signed_request: signed });
    const { confirmation_code } = deleteRes.body;

    const statusRes = await request(app).get(`/threads/deletion-status?code=${confirmation_code}`);
    assert.equal(statusRes.status, 200);
    assert.ok(statusRes.text.toLowerCase().includes('removed'), 'Status page must confirm deletion');
  });

  it('status page shows not-found for an unknown code', async () => {
    const res = await request(app).get('/threads/deletion-status?code=threads-unknown-code');
    assert.equal(res.status, 200);
    assert.ok(res.text.toLowerCase().includes('not found'));
  });
});
