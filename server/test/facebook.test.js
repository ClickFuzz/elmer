'use strict';

process.env.DB_PATH                   = ':memory:';
process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'c'.repeat(64);
process.env.FACEBOOK_APP_ID           = 'test_app_id';
process.env.FACEBOOK_APP_SECRET       = 'test_app_secret';
process.env.FACEBOOK_REDIRECT_URI     = 'http://localhost:3001/facebook/callback';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');

const { getDb, closeDb }       = require('../db');
const { createApp }            = require('../app');
const { encrypt }              = require('../crypto');

// ── Mock Graph API factory ─────────────────────────────────────────────────
// Returns a fetch-compatible function that can be pre-programmed with
// sequential responses for each call.

function makeGraphMock(responses) {
  let i = 0;
  return async (_url, _opts) => {
    const r = responses[i++] ?? { ok: false, json: async () => ({ error: { message: 'Unexpected call', code: 0 } }) };
    return { ok: r.ok ?? true, json: async () => r.data, status: r.status ?? 200 };
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function registerAndLogin(app, email = 'fb@example.com', password = 'password123') {
  await request(app).post('/auth/register').send({ email, password });
  const login = await request(app).post('/auth/login').send({ email, password });
  const me    = await request(app).get('/auth/me')
    .set('Authorization', `Bearer ${login.body.token}`);
  return { token: login.body.token, userId: me.body.userId };
}

async function createFbState(app, token) {
  // Directly insert an oauth_state so the callback endpoint can consume it.
  // We return both the raw state string and the user data.
  const res = await request(app)
    .post('/platforms/oauth/state')
    .set('Authorization', `Bearer ${token}`)
    .send({ platform: 'facebook' });
  return res.body.state;
}

// Inserts a connected Facebook page directly into the DB.
function insertFbPage(db, userId, pageName = 'My Page', pageAccountId = 'page-123') {
  const now = Date.now();
  const tokenEnc = encrypt('fake_page_token');
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO connected_platforms
       (user_id, platform, account_name, account_id, access_token_enc, connected_at, updated_at)
     VALUES (?, 'facebook', ?, ?, ?, ?, ?)`
  ).run(userId, pageName, pageAccountId, tokenEnc, now, now);
  return lastInsertRowid;
}

// ── Test suites ────────────────────────────────────────────────────────────

// Each suite gets a fresh in-memory DB and a custom graphFetch mock.

describe('POST /facebook/connect-url', () => {
  let app, token;

  beforeEach(async () => {
    closeDb();
    app = createApp();
    ({ token } = await registerAndLogin(app));
  });

  after(() => closeDb());

  it('returns 401 without authentication', async () => {
    const res = await request(app).post('/facebook/connect-url');
    assert.strictEqual(res.status, 401);
  });

  it('returns 503 when Facebook env vars are not set', async () => {
    const savedId  = process.env.FACEBOOK_APP_ID;
    const savedUri = process.env.FACEBOOK_REDIRECT_URI;
    delete process.env.FACEBOOK_APP_ID;
    delete process.env.FACEBOOK_REDIRECT_URI;

    const res = await request(app)
      .post('/facebook/connect-url')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 503);

    process.env.FACEBOOK_APP_ID       = savedId;
    process.env.FACEBOOK_REDIRECT_URI = savedUri;
  });

  it('returns an authUrl and stores oauth_state', async () => {
    const res = await request(app)
      .post('/facebook/connect-url')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.authUrl, 'should return authUrl');
    assert.ok(res.body.authUrl.includes('facebook.com'), 'should be a Facebook URL');
    assert.ok(res.body.authUrl.includes('pages_manage_posts'), 'should request publishing permission');

    // Confirm state was persisted
    const db  = getDb();
    const row = db.prepare(
      `SELECT * FROM oauth_states WHERE platform = 'facebook' ORDER BY id DESC LIMIT 1`
    ).get();
    assert.ok(row, 'oauth_state row should exist');
    assert.ok(!row.used_at, 'should not be consumed yet');
  });
});

describe('GET /facebook/callback', () => {
  // Each test builds its own app with a custom graphFetch so responses are isolated.

  after(() => closeDb());

  it('redirects with error when Facebook returns an error parameter', async () => {
    closeDb();
    const app = createApp();
    const res = await request(app)
      .get('/facebook/callback')
      .query({ error: 'access_denied', error_description: 'User denied access' });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error='), 'location should include error param');
  });

  it('redirects with error for missing code or state', async () => {
    closeDb();
    const app = createApp();
    const res = await request(app)
      .get('/facebook/callback')
      .query({ code: 'abc' }); // state missing
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error=missing_params'));
  });

  it('redirects with error for an invalid state', async () => {
    closeDb();
    const app = createApp();
    const res = await request(app)
      .get('/facebook/callback')
      .query({ code: 'abc123', state: 'deadbeef'.repeat(6) });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error=invalid_state'));
  });

  it('redirects with error for an already-used state', async () => {
    closeDb();
    const { createFacebookRouter } = require('../routes/facebook');
    const app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: makeGraphMock([]) }) });
    const { token } = await registerAndLogin(app);
    const state = await createFbState(app, token);

    // Manually mark the state as used
    const db  = getDb();
    db.prepare('UPDATE oauth_states SET used_at = ? WHERE state = ?').run(Date.now(), state);

    const res = await request(app)
      .get('/facebook/callback')
      .query({ code: 'abc123', state });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error=state_already_used'));
  });

  it('stores page tokens and redirects to app scheme on success', async () => {
    closeDb();

    const mockGraphFetch = makeGraphMock([
      // short-lived token exchange
      { data: { access_token: 'short_token', token_type: 'bearer' } },
      // long-lived token exchange
      { data: { access_token: 'long_token', expires_in: 5183944, token_type: 'bearer' } },
      // me/accounts — returns two pages
      { data: { data: [
        { id: 'page-1', name: 'My Shop', access_token: 'page_token_1', tasks: ['ADVERTISE', 'CREATE_CONTENT'] },
        { id: 'page-2', name: 'Side Biz', access_token: 'page_token_2', tasks: ['CREATE_CONTENT'] },
      ] } },
    ]);

    const { createFacebookRouter } = require('../routes/facebook');
    const app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockGraphFetch }) });
    const { token, userId: ownerId } = await registerAndLogin(app);
    const state = await createFbState(app, token);

    const res = await request(app)
      .get('/facebook/callback')
      .query({ code: 'auth_code_xyz', state });

    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('success=true'));
    assert.ok(res.headers.location.includes('page_count=2'));

    // Confirm pages are in connected_platforms
    const db    = getDb();
    const pages = db.prepare(
      `SELECT account_id, account_name FROM connected_platforms
       WHERE user_id = ? AND platform = 'facebook'
       ORDER BY account_name`
    ).all(ownerId);
    assert.strictEqual(pages.length, 2);
    assert.strictEqual(pages[0].account_name, 'My Shop');
    assert.strictEqual(pages[1].account_name, 'Side Biz');
  });

  it('reconnecting overwrites the existing token without duplicating the row', async () => {
    closeDb();

    const mockGraphFetch = makeGraphMock([
      { data: { access_token: 'short1' } },
      { data: { access_token: 'long1' } },
      { data: { data: [{ id: 'page-1', name: 'My Shop', access_token: 'token_first' }] } },
      // second connect — same page, new token
      { data: { access_token: 'short2' } },
      { data: { access_token: 'long2' } },
      { data: { data: [{ id: 'page-1', name: 'My Shop', access_token: 'token_second' }] } },
    ]);

    const { createFacebookRouter } = require('../routes/facebook');
    const app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockGraphFetch }) });
    const { token, userId } = await registerAndLogin(app);

    // First connect
    const state1 = await createFbState(app, token);
    await request(app).get('/facebook/callback').query({ code: 'c1', state: state1 });

    // Second connect
    const state2 = await createFbState(app, token);
    await request(app).get('/facebook/callback').query({ code: 'c2', state: state2 });

    const db    = getDb();
    const rows  = db.prepare(
      `SELECT id FROM connected_platforms WHERE user_id = ? AND platform = 'facebook'`
    ).all(userId);
    assert.strictEqual(rows.length, 1, 'should not duplicate the row');
  });

  it('redirects with no_manageable_pages error when user has no pages', async () => {
    closeDb();

    const mockGraphFetch = makeGraphMock([
      { data: { access_token: 'short_token' } },
      { data: { access_token: 'long_token' } },
      { data: { data: [] } },
    ]);

    const { createFacebookRouter } = require('../routes/facebook');
    const app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockGraphFetch }) });
    const { token } = await registerAndLogin(app);
    const state = await createFbState(app, token);

    const res = await request(app)
      .get('/facebook/callback')
      .query({ code: 'code_xyz', state });

    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error=no_manageable_pages'));
  });
});

describe('GET /facebook/pages', () => {
  let app, token, userId;

  beforeEach(async () => {
    closeDb();
    app = createApp();
    ({ token, userId } = await registerAndLogin(app));
  });

  after(() => closeDb());

  it('returns 401 without authentication', async () => {
    const res = await request(app).get('/facebook/pages');
    assert.strictEqual(res.status, 401);
  });

  it('returns empty array when no pages are connected', async () => {
    const res = await request(app)
      .get('/facebook/pages')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.pages, []);
  });

  it('returns only pages belonging to the authenticated user', async () => {
    // Insert a page for user 1 and a page for user 2
    const db = getDb();
    insertFbPage(db, userId, 'User1 Page', 'page-u1');

    const { userId: userId2 } = await registerAndLogin(app, 'other@example.com');
    insertFbPage(db, userId2, 'User2 Page', 'page-u2');

    const res = await request(app)
      .get('/facebook/pages')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.pages.length, 1);
    assert.strictEqual(res.body.pages[0].account_name, 'User1 Page');
  });

  it('returns multiple pages sorted by name', async () => {
    const db = getDb();
    insertFbPage(db, userId, 'Zed Page',   'page-z');
    insertFbPage(db, userId, 'Alpha Page', 'page-a');

    const res = await request(app)
      .get('/facebook/pages')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.body.pages.length, 2);
    assert.strictEqual(res.body.pages[0].account_name, 'Alpha Page');
    assert.strictEqual(res.body.pages[1].account_name, 'Zed Page');
  });
});

describe('POST /facebook/publish', () => {
  let app, token, userId, platformId;

  beforeEach(async () => {
    closeDb();
    app = createApp();
    ({ token, userId } = await registerAndLogin(app));
    platformId = insertFbPage(getDb(), userId);
  });

  after(() => closeDb());

  it('returns 401 without authentication', async () => {
    const res = await request(app)
      .post('/facebook/publish')
      .field('message', 'Hello')
      .field('platform_id', String(platformId))
      .field('job_id', '1');
    assert.strictEqual(res.status, 401);
  });

  it('returns 400 when message is missing', async () => {
    const res = await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('platform_id', String(platformId))
      .field('job_id', '1');
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 when platform_id is invalid', async () => {
    const res = await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Hello')
      .field('platform_id', 'abc')
      .field('job_id', '1');
    assert.strictEqual(res.status, 400);
  });

  it('returns 404 when platform is not owned by user', async () => {
    const { userId: userId2 } = await registerAndLogin(app, 'other2@example.com');
    const otherId = insertFbPage(getDb(), userId2, 'Other Page', 'page-other');

    // user1 tries to publish to user2's page
    const res = await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Hello')
      .field('platform_id', String(otherId))
      .field('job_id', '42');
    assert.strictEqual(res.status, 404);
  });

  it('publishes a text-only post and records the result', async () => {
    closeDb();
    const mockFetch = makeGraphMock([
      { data: { id: 'page-123_post-456' } },
    ]);
    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    platformId = insertFbPage(getDb(), userId);

    const res = await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Great job done today!')
      .field('platform_id', String(platformId))
      .field('job_id', 'job-1');

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);
    assert.ok(res.body.postId, 'should return postId');
    assert.ok(!res.body.duplicate, 'should not be a duplicate');

    // Verify publishing_records row
    const db  = getDb();
    const rec = db.prepare(
      `SELECT * FROM publishing_records WHERE user_id = ? AND platform = 'facebook' AND status = 'published'`
    ).get(userId);
    assert.ok(rec, 'should have a published record');
    assert.strictEqual(rec.platform_post_id, 'page-123_post-456');
  });

  it('prevents duplicate publishing for the same job_id', async () => {
    closeDb();

    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return { ok: true, json: async () => ({ id: 'page-123_post-999' }) };
    };
    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    platformId = insertFbPage(getDb(), userId);

    const payload = {
      message: 'First post', platform_id: String(platformId), job_id: 'job-dup',
    };

    const first  = await request(app).post('/facebook/publish').set('Authorization', `Bearer ${token}`).field(payload);
    const second = await request(app).post('/facebook/publish').set('Authorization', `Bearer ${token}`).field(payload);

    assert.strictEqual(first.status, 200);
    assert.ok(!first.body.duplicate);

    assert.strictEqual(second.status, 200);
    assert.ok(second.body.duplicate, 'second attempt should be a duplicate');
    assert.strictEqual(callCount, 1, 'Graph API should be called only once');
  });

  it('publishes with multiple photos and uses the staged-media flow', async () => {
    closeDb();

    const stagingCalls = [];
    const mockFetch = async (url, opts) => {
      if (url.includes('/photos')) {
        stagingCalls.push(url);
        return { ok: true, json: async () => ({ id: `staged-${stagingCalls.length}` }) };
      }
      // feed post
      return { ok: true, json: async () => ({ id: 'page-123_multi-post' }) };
    };

    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    platformId = insertFbPage(getDb(), userId);

    // Create two real temp files to simulate photo uploads
    const fs_  = require('fs');
    const os_  = require('os');
    const path_ = require('path');
    const tmp1  = path_.join(os_.tmpdir(), `test_photo1_${Date.now()}.jpg`);
    const tmp2  = path_.join(os_.tmpdir(), `test_photo2_${Date.now()}.jpg`);
    fs_.writeFileSync(tmp1, Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0])); // minimal JPEG header
    fs_.writeFileSync(tmp2, Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0]));

    try {
      const res = await request(app)
        .post('/facebook/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('message', 'Before and after!')
        .field('platform_id', String(platformId))
        .field('job_id', 'multi-job-1')
        .attach('photo_0', tmp1)
        .attach('photo_1', tmp2);

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.ok);
      assert.strictEqual(stagingCalls.length, 2, 'should stage two photos');
      assert.ok(!res.body.duplicate);
    } finally {
      fs_.unlinkSync(tmp1);
      fs_.unlinkSync(tmp2);
    }
  });

  it('returns 422 with fbError flag when the Graph API returns a Facebook error', async () => {
    closeDb();

    const mockFetch = makeGraphMock([
      { ok: false, status: 400, data: { error: { message: 'Invalid OAuth access token.', code: 190 } } },
    ]);
    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    platformId = insertFbPage(getDb(), userId);

    const res = await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Post text')
      .field('platform_id', String(platformId))
      .field('job_id', 'error-job-1');

    assert.strictEqual(res.status, 422);
    assert.ok(res.body.fbError);

    // Confirm failure record was saved
    const db  = getDb();
    const rec = db.prepare(
      `SELECT status, error_message FROM publishing_records
       WHERE user_id = ? AND platform = 'facebook' AND status = 'failed'`
    ).get(userId);
    assert.ok(rec, 'should have a failed record');
    assert.ok(rec.error_message.includes('Invalid OAuth'));
  });

  it('records a failed publish and allows retry', async () => {
    closeDb();

    let attempt = 0;
    const mockFetch = async () => {
      attempt++;
      if (attempt === 1) throw new Error('Network error');
      return { ok: true, json: async () => ({ id: 'page-123_retry-post' }) };
    };

    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    platformId = insertFbPage(getDb(), userId);

    const payload = {
      message: 'Retry me', platform_id: String(platformId), job_id: 'retry-job',
    };

    const first = await request(app).post('/facebook/publish').set('Authorization', `Bearer ${token}`).field(payload);
    assert.strictEqual(first.status, 502, 'first attempt should fail');

    const second = await request(app).post('/facebook/publish').set('Authorization', `Bearer ${token}`).field(payload);
    assert.strictEqual(second.status, 200, 'retry should succeed');
    assert.ok(second.body.ok);
    assert.ok(!second.body.duplicate);
  });
});

describe('Token storage and encryption', () => {
  let app, token, userId;

  before(() => {
    closeDb();
    app = createApp();
  });

  after(() => closeDb());

  beforeEach(async () => {
    closeDb();
    app = createApp();
    ({ token, userId } = await registerAndLogin(app));
  });

  it('stores page tokens encrypted and never exposes them in GET /facebook/pages', async () => {
    insertFbPage(getDb(), userId, 'Encrypted Page', 'page-enc');

    const res = await request(app)
      .get('/facebook/pages')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    const page = res.body.pages[0];
    assert.ok(!page.access_token_enc, 'encrypted token should not appear in response');
    assert.ok(!page.access_token,     'raw token should not appear in response');
  });

  it('stores page tokens encrypted and never exposes them in GET /platforms', async () => {
    insertFbPage(getDb(), userId, 'Platform Page', 'page-plat');

    const res = await request(app)
      .get('/platforms')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    const page = res.body.platforms[0];
    assert.ok(!page.access_token_enc, 'encrypted token should not appear in response');
    assert.ok(!page.access_token,     'raw token should not appear in response');
  });

  it('can decrypt a stored token at publish time', async () => {
    closeDb();

    const sentToken = [];
    const mockFetch = async (_url, opts) => {
      // Capture access_token from URLSearchParams or FormData body
      const body = opts?.body;
      if (body && typeof body.get === 'function') {
        const t = body.get('access_token');
        if (t) sentToken.push(t);
      }
      return { ok: true, json: async () => ({ id: 'page-123_dec-post' }) };
    };

    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));

    // Insert a page with a known token
    const known = 'super_secret_page_token_abc';
    const db    = getDb();
    const now   = Date.now();
    const { lastInsertRowid: pid } = db.prepare(
      `INSERT INTO connected_platforms
         (user_id, platform, account_name, account_id, access_token_enc, connected_at, updated_at)
       VALUES (?, 'facebook', 'Test Page', 'page-dec', ?, ?, ?)`
    ).run(userId, encrypt(known), now, now);

    await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Token test')
      .field('platform_id', String(pid))
      .field('job_id', 'decrypt-job-1');

    assert.ok(sentToken.some(t => t === known), 'decrypted token should be used in Graph API call');
  });
});
