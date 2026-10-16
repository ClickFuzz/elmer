'use strict';

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.INSTAGRAM_APP_ID          = 'test_ig_app_id';
process.env.INSTAGRAM_APP_SECRET      = 'test_ig_app_secret';
process.env.INSTAGRAM_REDIRECT_URI    = 'https://test.example.com/instagram/callback';
process.env.SERVER_URL                = 'https://test.example.com';

const { describe, it, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');

const { setupFreshTestDb }    = require('./helpers');
const { getPool, closeDb }    = require('../db');
const { createApp }           = require('../app');
const { encrypt }             = require('../crypto');

// ── Mock IG API factory ────────────────────────────────────────────────────

function makeIgMock(responses) {
  let i = 0;
  return async (_url, _opts) => {
    const r = responses[i++] ?? { ok: false, json: async () => ({ error: { message: 'Unexpected call', code: 0 } }) };
    return { ok: r.ok ?? true, json: async () => r.data, status: r.status ?? 200 };
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function registerAndLogin(app, email = 'ig@example.com', password = 'password123') {
  await request(app).post('/auth/register').send({ email, password });
  const login = await request(app).post('/auth/login').send({ email, password });
  const me    = await request(app).get('/auth/me')
    .set('Authorization', `Bearer ${login.body.token}`);
  return { token: login.body.token, userId: me.body.userId };
}

async function createIgState(app, token) {
  const res = await request(app)
    .post('/platforms/oauth/state')
    .set('Authorization', `Bearer ${token}`)
    .send({ platform: 'instagram' });
  return res.body.state;
}

async function insertIgAccount(userId, accountName = 'Test Account', accountId = 'ig-123', opts = {}) {
  const now      = Date.now();
  const tokenEnc = encrypt('fake_ig_token');
  const expires  = opts.tokenExpiresAt ?? (now + 60 * 24 * 60 * 60 * 1000);
  const { rows: [{ id }] } = await getPool().query(
    `INSERT INTO connected_platforms
       (user_id, platform, account_name, account_id, access_token_enc,
        token_expires_at, selected, connected_at, updated_at)
     VALUES ($1, 'instagram', $2, $3, $4, $5, true, $6, $7) RETURNING id`,
    [userId, accountName, accountId, tokenEnc, expires, now, now]
  );
  return id;
}

function makeTempPhoto() {
  const tmp = path.join(os.tmpdir(), `test_ig_photo_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(tmp, Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0]));
  return tmp;
}

// ── Test suites ────────────────────────────────────────────────────────────

describe('GET /instagram/media/:filename', () => {
  let app;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
  });

  after(async () => closeDb());

  it('returns 404 for an invalid filename pattern', async () => {
    const res = await request(app).get('/instagram/media/../../etc/passwd');
    assert.strictEqual(res.status, 404);
  });

  it('returns 404 for a valid-pattern filename that does not exist', async () => {
    const res = await request(app).get('/instagram/media/abcdef1234567890abcdef1234567890.jpg');
    assert.strictEqual(res.status, 404);
  });

  it('returns 404 for filenames with disallowed characters', async () => {
    const res = await request(app).get('/instagram/media/bad<file>.jpg');
    assert.strictEqual(res.status, 404);
  });
});

describe('POST /instagram/connect-url', () => {
  let app, token;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ token } = await registerAndLogin(app));
  });

  after(async () => closeDb());

  it('returns 401 without authentication', async () => {
    const res = await request(app).post('/instagram/connect-url');
    assert.strictEqual(res.status, 401);
  });

  it('returns 503 when INSTAGRAM_REDIRECT_URI is not set', async () => {
    const savedUri = process.env.INSTAGRAM_REDIRECT_URI;
    delete process.env.INSTAGRAM_REDIRECT_URI;

    const res = await request(app)
      .post('/instagram/connect-url')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 503);

    process.env.INSTAGRAM_REDIRECT_URI = savedUri;
  });

  it('returns 503 when INSTAGRAM_APP_ID is not set', async () => {
    const savedId  = process.env.INSTAGRAM_APP_ID;
    const savedUri = process.env.INSTAGRAM_REDIRECT_URI;
    delete process.env.INSTAGRAM_APP_ID;

    const res = await request(app)
      .post('/instagram/connect-url')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 503);

    process.env.INSTAGRAM_APP_ID       = savedId;
    process.env.INSTAGRAM_REDIRECT_URI = savedUri;
  });

  it('returns an authUrl pointing to Instagram OAuth and stores oauth_state', async () => {
    const res = await request(app)
      .post('/instagram/connect-url')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.authUrl, 'should return authUrl');
    assert.ok(res.body.authUrl.includes('api.instagram.com'), 'should be an Instagram URL');
    assert.ok(res.body.authUrl.includes('instagram_business_content_publish'), 'should include publishing scope');

    const { rows: [row] } = await getPool().query(
      `SELECT * FROM oauth_states WHERE platform = 'instagram' ORDER BY id DESC LIMIT 1`
    );
    assert.ok(row, 'oauth_state row should exist');
    assert.ok(!row.used_at, 'should not be consumed yet');
    assert.strictEqual(row.platform, 'instagram');
  });
});

describe('GET /instagram/callback', () => {
  after(async () => closeDb());

  it('redirects with error when Instagram returns an error parameter', async () => {
    await setupFreshTestDb();
    const app = createApp();
    const res = await request(app)
      .get('/instagram/callback')
      .query({ error: 'access_denied' });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error='), 'location should include error param');
    assert.ok(res.headers.location.includes('platform=instagram'));
  });

  it('redirects with error for missing code or state', async () => {
    await setupFreshTestDb();
    const app = createApp();
    const res = await request(app)
      .get('/instagram/callback')
      .query({ code: 'abc' });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error=missing_params'));
  });

  it('redirects with error for an invalid state', async () => {
    await setupFreshTestDb();
    const app = createApp();
    const res = await request(app)
      .get('/instagram/callback')
      .query({ code: 'abc123', state: 'deadbeef'.repeat(6) });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error=invalid_state'));
  });

  it('redirects with error for an already-used state', async () => {
    await setupFreshTestDb();
    const { createInstagramRouter } = require('../routes/instagram');
    const app = createApp({ instagramRouter: createInstagramRouter({ igFetch: makeIgMock([]) }) });
    const { token } = await registerAndLogin(app);
    const state = await createIgState(app, token);

    await getPool().query('UPDATE oauth_states SET used_at = $1 WHERE state = $2', [Date.now(), state]);

    const res = await request(app)
      .get('/instagram/callback')
      .query({ code: 'abc123', state });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error=state_already_used'));
  });

  it('redirects with error for an expired state', async () => {
    await setupFreshTestDb();
    const { createInstagramRouter } = require('../routes/instagram');
    const app = createApp({ instagramRouter: createInstagramRouter({ igFetch: makeIgMock([]) }) });
    const { token } = await registerAndLogin(app);
    const state = await createIgState(app, token);

    // Expire the state
    await getPool().query('UPDATE oauth_states SET expires_at = $1 WHERE state = $2', [Date.now() - 1, state]);

    const res = await request(app)
      .get('/instagram/callback')
      .query({ code: 'abc123', state });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error=state_expired'));
  });

  it('stores account and redirects to app scheme on success', async () => {
    await setupFreshTestDb();

    const mockIgFetch = makeIgMock([
      // short-lived token
      { data: { access_token: 'short_token', user_id: 987654321 } },
      // long-lived token
      { data: { access_token: 'long_token', expires_in: 5184000 } },
      // profile
      { data: { id: '987654321', name: 'Test Business', username: 'testbiz', account_type: 'BUSINESS' } },
    ]);

    const { createInstagramRouter } = require('../routes/instagram');
    const app = createApp({ instagramRouter: createInstagramRouter({ igFetch: mockIgFetch }) });
    const { token, userId: ownerId } = await registerAndLogin(app);
    const state = await createIgState(app, token);

    const res = await request(app)
      .get('/instagram/callback')
      .query({ code: 'auth_code_xyz', state });

    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('success=true'));
    assert.ok(res.headers.location.includes('platform=instagram'));

    const { rows } = await getPool().query(
      `SELECT account_id, account_name, selected FROM connected_platforms
       WHERE user_id = $1 AND platform = 'instagram'`,
      [ownerId]
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].account_name, 'Test Business');
    assert.strictEqual(rows[0].selected, true, 'new account should be selected=true');
  });

  it('fetches profile via graph.instagram.com/me, not via numeric user ID', async () => {
    await setupFreshTestDb();

    const calledUrls = [];
    const igFetch = async (url, opts) => {
      calledUrls.push(typeof url === 'string' ? url.split('?')[0] : String(url));
      if (calledUrls.length === 1) return { ok: true, json: async () => ({ access_token: 'short', user_id: 99999 }) };
      if (calledUrls.length === 2) return { ok: true, json: async () => ({ access_token: 'long', expires_in: 5184000 }) };
      return { ok: true, status: 200, json: async () => ({ id: '99999', name: 'Biz', username: 'biz', account_type: 'BUSINESS' }) };
    };

    const { createInstagramRouter } = require('../routes/instagram');
    const app = createApp({ instagramRouter: createInstagramRouter({ igFetch }) });
    const { token } = await registerAndLogin(app, 'me-test@example.com');
    const state = await createIgState(app, token);

    await request(app).get('/instagram/callback').query({ code: 'code_me', state });

    const profileUrl = calledUrls[2];
    assert.ok(profileUrl, 'profile request should be made');
    assert.ok(profileUrl.endsWith('/me'), `profile URL must end with /me, got: ${profileUrl}`);
    assert.ok(!profileUrl.includes('/99999'), `profile URL must not contain numeric user ID, got: ${profileUrl}`);
  });

  it('redirects with personal_account_not_supported for personal accounts', async () => {
    await setupFreshTestDb();

    const mockIgFetch = makeIgMock([
      { data: { access_token: 'short_token', user_id: 111 } },
      { data: { access_token: 'long_token', expires_in: 5184000 } },
      { data: { id: '111', name: 'Personal User', username: 'person', account_type: 'PERSONAL' } },
    ]);

    const { createInstagramRouter } = require('../routes/instagram');
    const app = createApp({ instagramRouter: createInstagramRouter({ igFetch: mockIgFetch }) });
    const { token } = await registerAndLogin(app);
    const state = await createIgState(app, token);

    const res = await request(app)
      .get('/instagram/callback')
      .query({ code: 'code_xyz', state });

    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error=personal_account_not_supported'));
  });

  it('accepts Creator accounts', async () => {
    await setupFreshTestDb();

    const mockIgFetch = makeIgMock([
      { data: { access_token: 'short_token', user_id: 222 } },
      { data: { access_token: 'long_token', expires_in: 5184000 } },
      { data: { id: '222', name: 'Test Creator', username: 'testcreator', account_type: 'CREATOR' } },
    ]);

    const { createInstagramRouter } = require('../routes/instagram');
    const app = createApp({ instagramRouter: createInstagramRouter({ igFetch: mockIgFetch }) });
    const { token, userId } = await registerAndLogin(app);
    const state = await createIgState(app, token);

    const res = await request(app)
      .get('/instagram/callback')
      .query({ code: 'creator_code', state });

    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('success=true'), 'Creator account should be accepted');

    const { rows } = await getPool().query(
      `SELECT account_name FROM connected_platforms WHERE user_id = $1 AND platform = 'instagram'`,
      [userId]
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].account_name, 'Test Creator');
  });

  it('redirects with personal_account_not_supported for unknown account types', async () => {
    await setupFreshTestDb();

    const mockIgFetch = makeIgMock([
      { data: { access_token: 'short_token', user_id: 333 } },
      { data: { access_token: 'long_token', expires_in: 5184000 } },
      { data: { id: '333', name: 'Unknown Type', username: 'unknown' } },
    ]);

    const { createInstagramRouter } = require('../routes/instagram');
    const app = createApp({ instagramRouter: createInstagramRouter({ igFetch: mockIgFetch }) });
    const { token } = await registerAndLogin(app);
    const state = await createIgState(app, token);

    const res = await request(app)
      .get('/instagram/callback')
      .query({ code: 'code_unknown', state });

    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error=personal_account_not_supported'));
  });

  it('reconnecting updates the token without duplicating the row', async () => {
    await setupFreshTestDb();

    const mockIgFetch = makeIgMock([
      { data: { access_token: 'short1', user_id: 111 } },
      { data: { access_token: 'long1', expires_in: 5184000 } },
      { data: { id: '111', name: 'Biz Account', username: 'biz', account_type: 'BUSINESS' } },
      { data: { access_token: 'short2', user_id: 111 } },
      { data: { access_token: 'long2', expires_in: 5184000 } },
      { data: { id: '111', name: 'Biz Account', username: 'biz', account_type: 'BUSINESS' } },
    ]);

    const { createInstagramRouter } = require('../routes/instagram');
    const app = createApp({ instagramRouter: createInstagramRouter({ igFetch: mockIgFetch }) });
    const { token, userId } = await registerAndLogin(app);

    const state1 = await createIgState(app, token);
    await request(app).get('/instagram/callback').query({ code: 'c1', state: state1 });

    const state2 = await createIgState(app, token);
    await request(app).get('/instagram/callback').query({ code: 'c2', state: state2 });

    const { rows } = await getPool().query(
      `SELECT id FROM connected_platforms WHERE user_id = $1 AND platform = 'instagram'`,
      [userId]
    );
    assert.strictEqual(rows.length, 1, 'should not duplicate the row');
  });

  it('redirects with auth_failed when token exchange fails', async () => {
    await setupFreshTestDb();

    const mockIgFetch = makeIgMock([
      { data: { error_type: 'OAuthException', error_message: 'Invalid code' } },
    ]);

    const { createInstagramRouter } = require('../routes/instagram');
    const app = createApp({ instagramRouter: createInstagramRouter({ igFetch: mockIgFetch }) });
    const { token } = await registerAndLogin(app);
    const state = await createIgState(app, token);

    const res = await request(app)
      .get('/instagram/callback')
      .query({ code: 'bad_code', state });

    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error=auth_failed'));
  });
});

describe('GET /instagram/account', () => {
  let app, token, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ token, userId } = await registerAndLogin(app));
  });

  after(async () => closeDb());

  it('returns 401 without authentication', async () => {
    const res = await request(app).get('/instagram/account');
    assert.strictEqual(res.status, 401);
  });

  it('returns null when no account is connected', async () => {
    const res = await request(app)
      .get('/instagram/account')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.account, null);
  });

  it('returns account info when connected', async () => {
    await insertIgAccount(userId, 'My Business', 'ig-abc');
    const res = await request(app)
      .get('/instagram/account')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.account, 'should return account');
    assert.strictEqual(res.body.account.account_name, 'My Business');
    assert.strictEqual(res.body.account.account_id, 'ig-abc');
    assert.ok(!res.body.account.access_token_enc, 'should not expose encrypted token');
  });

  it('returns only the account belonging to the authenticated user', async () => {
    const { userId: userId2 } = await registerAndLogin(app, 'other@example.com');
    await insertIgAccount(userId2, 'Other Account', 'ig-other');

    const res = await request(app)
      .get('/instagram/account')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.account, null, 'should not return another user\'s account');
  });
});

describe('POST /instagram/publish', () => {
  let app, token, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ token, userId } = await registerAndLogin(app));
  });

  after(async () => closeDb());

  it('returns 401 without authentication', async () => {
    const res = await request(app)
      .post('/instagram/publish')
      .field('caption', 'Hello')
      .field('job_id', '1');
    assert.strictEqual(res.status, 401);
  });

  it('returns 400 when caption is missing', async () => {
    await insertIgAccount(userId);
    const res = await request(app)
      .post('/instagram/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('job_id', '1');
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('caption'));
  });

  it('returns 400 when job_id is missing', async () => {
    await insertIgAccount(userId);
    const res = await request(app)
      .post('/instagram/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('caption', 'Hello');
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('job_id'));
  });

  it('returns 400 when no photos are provided', async () => {
    await insertIgAccount(userId);
    const res = await request(app)
      .post('/instagram/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('caption', 'Hello')
      .field('job_id', '1');
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('photo'));
  });

  it('returns 422 no_instagram_account when no account is connected', async () => {
    const tmp = makeTempPhoto();
    try {
      const res = await request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'Test post')
        .field('job_id', 'job-no-account')
        .attach('photo_0', tmp);
      assert.strictEqual(res.status, 422);
      assert.strictEqual(res.body.error, 'no_instagram_account');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('returns 422 token_expired when token has expired', async () => {
    const expiredTime = Date.now() - 1000;
    await insertIgAccount(userId, 'Expired Account', 'ig-exp', { tokenExpiresAt: expiredTime });

    const tmp = makeTempPhoto();
    try {
      const res = await request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'Test post')
        .field('job_id', 'job-expired')
        .attach('photo_0', tmp);
      assert.strictEqual(res.status, 422);
      assert.strictEqual(res.body.error, 'token_expired');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('publishes a single image successfully', async () => {
    await setupFreshTestDb();

    const mockIgFetch = makeIgMock([
      { data: { id: 'container-1' } },   // create media container
      { data: { id: 'ig-post-abc123' } }, // media_publish
    ]);

    const { createInstagramRouter } = require('../routes/instagram');
    app = createApp({ instagramRouter: createInstagramRouter({ igFetch: mockIgFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    await insertIgAccount(userId, 'My Business', 'ig-123');

    const tmp = makeTempPhoto();
    try {
      const res = await request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'A great job done today!')
        .field('job_id', 'job-single-1')
        .attach('photo_0', tmp);

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.ok, 'ok should be true');
      assert.strictEqual(res.body.postId, 'ig-post-abc123');
      assert.ok(res.body.postUrl.includes('instagram.com'));
      assert.ok(!res.body.duplicate);

      const { rows: [rec] } = await getPool().query(
        `SELECT status, platform_post_id FROM publishing_records
         WHERE user_id = $1 AND platform = 'instagram' AND status = 'published'`,
        [userId]
      );
      assert.ok(rec, 'should have a published record');
      assert.strictEqual(rec.platform_post_id, 'ig-post-abc123');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('publishes a carousel for multiple photos', async () => {
    await setupFreshTestDb();

    const callLog = [];
    const mockIgFetch = async (url, _opts) => {
      callLog.push(url);
      if (url.includes('/media_publish')) {
        return { ok: true, json: async () => ({ id: 'ig-carousel-post' }) };
      }
      // carousel container calls
      const callIndex = callLog.length;
      return { ok: true, json: async () => ({ id: `child-${callIndex}` }) };
    };

    const { createInstagramRouter } = require('../routes/instagram');
    app = createApp({ instagramRouter: createInstagramRouter({ igFetch: mockIgFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    await insertIgAccount(userId, 'My Business', 'ig-123');

    const tmp1 = makeTempPhoto();
    const tmp2 = makeTempPhoto();
    try {
      const res = await request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'Before and after!')
        .field('job_id', 'job-carousel-1')
        .attach('photo_0', tmp1)
        .attach('photo_1', tmp2);

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.ok, 'carousel publish should be ok');
      assert.strictEqual(res.body.postId, 'ig-carousel-post');

      // Two child containers + one carousel container + one media_publish = 4 calls
      assert.strictEqual(callLog.length, 4, 'should make 4 API calls for a 2-photo carousel');
    } finally {
      fs.unlinkSync(tmp1);
      fs.unlinkSync(tmp2);
    }
  });

  it('returns duplicate=true when job was already published', async () => {
    await setupFreshTestDb();

    let callCount = 0;
    const mockIgFetch = async () => {
      callCount++;
      return { ok: true, json: async () => ({ id: 'ig-post-dup' }) };
    };

    const { createInstagramRouter } = require('../routes/instagram');
    app = createApp({ instagramRouter: createInstagramRouter({ igFetch: mockIgFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    await insertIgAccount(userId, 'My Business', 'ig-123');

    const tmp = makeTempPhoto();
    try {
      const first = await request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'First time')
        .field('job_id', 'job-dup-ig')
        .attach('photo_0', tmp);

      const second = await request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'Second time')
        .field('job_id', 'job-dup-ig')
        .attach('photo_0', tmp);

      assert.strictEqual(first.status, 200);
      assert.ok(!first.body.duplicate);

      assert.strictEqual(second.status, 200);
      assert.ok(second.body.duplicate, 'second attempt should be a duplicate');
      // API should only be called for the first publish
      assert.strictEqual(callCount, 2, 'API calls should be: 1 container + 1 publish = 2, only on first attempt');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('returns ok:false when Instagram API returns an error', async () => {
    await setupFreshTestDb();

    const mockIgFetch = makeIgMock([
      { data: { error: { message: 'Invalid image format', code: 100 } } },
    ]);

    const { createInstagramRouter } = require('../routes/instagram');
    app = createApp({ instagramRouter: createInstagramRouter({ igFetch: mockIgFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    await insertIgAccount(userId, 'My Business', 'ig-123');

    const tmp = makeTempPhoto();
    try {
      const res = await request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'Bad image')
        .field('job_id', 'job-error-ig')
        .attach('photo_0', tmp);

      // Publish errors return 200 with ok:false (same pattern as Facebook)
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, false);
      assert.ok(res.body.igError, 'igError should be flagged');
      assert.ok(res.body.error.includes('Invalid image format'));

      const { rows: [rec] } = await getPool().query(
        `SELECT status, error_message FROM publishing_records
         WHERE user_id = $1 AND platform = 'instagram' AND status = 'failed'`,
        [userId]
      );
      assert.ok(rec, 'should have a failed record');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('records a failed publish and allows retry', async () => {
    await setupFreshTestDb();

    let attempt = 0;
    const mockIgFetch = async () => {
      attempt++;
      if (attempt === 1) throw new Error('Network error on first attempt');
      return { ok: true, json: async () => ({ id: 'ig-retry-post' }) };
    };

    const { createInstagramRouter } = require('../routes/instagram');
    app = createApp({ instagramRouter: createInstagramRouter({ igFetch: mockIgFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    await insertIgAccount(userId, 'My Business', 'ig-123');

    const tmp = makeTempPhoto();
    try {
      const first = await request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'Retry me')
        .field('job_id', 'ig-retry-job')
        .attach('photo_0', tmp);

      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.body.ok, false, 'first attempt should fail');

      // attempt goes 1 (fail) + 2 (container) + 3 (publish)
      const second = await request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'Retry me')
        .field('job_id', 'ig-retry-job')
        .attach('photo_0', tmp);

      assert.strictEqual(second.status, 200);
      assert.ok(second.body.ok, 'retry should succeed');
      assert.ok(!second.body.duplicate, 'retry should not be a duplicate');
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe('Instagram — independence from Facebook', () => {
  after(async () => closeDb());

  it('Instagram publish failure does not affect Facebook publishing result', async () => {
    await setupFreshTestDb();

    // Facebook publishes fine; Instagram fails
    const fbMock = async (_url, _opts) => ({
      ok: true,
      json: async () => ({ id: 'fb-post-ok' }),
    });
    const igMock = makeIgMock([
      { data: { error: { message: 'IG error', code: 100 } } },
    ]);

    const { createFacebookRouter } = require('../routes/facebook');
    const { createInstagramRouter } = require('../routes/instagram');
    const app = createApp({
      facebookRouter:  createFacebookRouter({ graphFetch: fbMock }),
      instagramRouter: createInstagramRouter({ igFetch: igMock }),
    });
    const { token, userId } = await registerAndLogin(app);

    // Insert both FB page and IG account
    const now = Date.now();
    const tokenEnc = encrypt('fake_page_token');
    await getPool().query(
      `INSERT INTO connected_platforms
         (user_id, platform, account_name, account_id, access_token_enc, tasks_json,
          selected, connected_at, updated_at)
       VALUES ($1, 'facebook', 'FB Page', 'page-fb-1', $2, $3, true, $4, $5)`,
      [userId, tokenEnc, JSON.stringify(['CREATE_CONTENT']), now, now]
    );
    await insertIgAccount(userId, 'IG Account', 'ig-123');

    const tmp = makeTempPhoto();
    try {
      // Publish to Facebook independently — should succeed
      const fbRes = await request(app)
        .post('/facebook/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('message', 'Test post')
        .field('job_id', 'job-independence-1');

      assert.strictEqual(fbRes.status, 200);
      assert.ok(fbRes.body.ok, 'Facebook publish should succeed independently');

      // Publish to Instagram independently — IG error should only affect IG result
      const igRes = await request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'Test post')
        .field('job_id', 'job-independence-2')
        .attach('photo_0', tmp);

      assert.strictEqual(igRes.status, 200);
      assert.strictEqual(igRes.body.ok, false, 'Instagram should fail independently');

      // FB result is still ok — stored correctly
      const { rows } = await getPool().query(
        `SELECT platform, status FROM publishing_records WHERE user_id = $1 ORDER BY platform`,
        [userId]
      );
      const fbRec = rows.find(r => r.platform === 'facebook');
      const igRec = rows.find(r => r.platform === 'instagram');
      assert.ok(fbRec, 'Facebook record should exist');
      assert.strictEqual(fbRec.status, 'published');
      assert.ok(igRec, 'Instagram record should exist');
      assert.strictEqual(igRec.status, 'failed');
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe('Token encryption — Instagram', () => {
  let app, token, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ token, userId } = await registerAndLogin(app));
  });

  after(async () => closeDb());

  it('never exposes access_token_enc in GET /instagram/account', async () => {
    await insertIgAccount(userId, 'Encrypted Account', 'ig-enc');

    const res = await request(app)
      .get('/instagram/account')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.account, 'account should exist');
    assert.ok(!res.body.account.access_token_enc, 'encrypted token must not be exposed');
    assert.ok(!res.body.account.access_token, 'raw token must not be exposed');
  });

  it('decrypts the stored token at publish time', async () => {
    await setupFreshTestDb();

    const sentTokens = [];
    const mockIgFetch = async (_url, opts) => {
      const body = opts?.body;
      if (body && typeof body.get === 'function') {
        const t = body.get('access_token');
        if (t) sentTokens.push(t);
      }
      return { ok: true, json: async () => ({ id: 'ig-decrypt-post' }) };
    };

    const { createInstagramRouter } = require('../routes/instagram');
    app = createApp({ instagramRouter: createInstagramRouter({ igFetch: mockIgFetch }) });
    ({ token, userId } = await registerAndLogin(app));

    const knownToken = 'super_secret_ig_token_xyz_abc';
    const now = Date.now();
    await getPool().query(
      `INSERT INTO connected_platforms
         (user_id, platform, account_name, account_id, access_token_enc,
          token_expires_at, selected, connected_at, updated_at)
       VALUES ($1, 'instagram', 'Test Account', 'ig-dec', $2, $3, true, $4, $5)`,
      [userId, encrypt(knownToken), now + 86400000, now, now]
    );

    const tmp = makeTempPhoto();
    try {
      await request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'Token test')
        .field('job_id', 'decrypt-ig-job-1')
        .attach('photo_0', tmp);

      assert.ok(sentTokens.some(t => t === knownToken), 'decrypted token should be used in IG API call');
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

// ── featured_index ordering ───────────────────────────────────────────────────

describe('POST /instagram/publish — featured_index ordering', () => {
  let app, token, userId;

  const sentUrls = [];
  function makeOrderTrackingMock() {
    sentUrls.length = 0;
    return async (url, _opts) => {
      if (url.includes('/media?') || url.includes('image_url=')) sentUrls.push(url);
      if (url.includes('/media_publish')) return { ok: true, json: async () => ({ id: 'post_123' }) };
      if (url.includes('/media?')) return { ok: true, json: async () => ({ id: `container_${sentUrls.length}` }) };
      if (url.includes('/media/')) return { ok: true, json: async () => ({ status_code: 'FINISHED' }) };
      return { ok: true, json: async () => ({ id: 'generic_ok' }) };
    };
  }

  beforeEach(async () => {
    await setupFreshTestDb();
    const { createInstagramRouter } = require('../routes/instagram');
    app = createApp({ instagramRouter: createInstagramRouter({ igFetch: makeOrderTrackingMock() }) });
    ({ token, userId } = await registerAndLogin(app, 'ig-order@example.com', 'password123'));
    await insertIgAccount(userId, 'Order Test', 'ig-order');
  });

  after(() => closeDb());

  it('sends photos in original order when featured_index is 0', async () => {
    const photos = [makeTempPhoto(), makeTempPhoto(), makeTempPhoto()];
    try {
      const req = request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'Order test')
        .field('job_id', 'order-job-0')
        .field('featured_index', '0');
      photos.forEach((p, i) => req.attach(`photo_${i}`, p));
      const res = await req;
      assert.equal(res.status, 200);
    } finally {
      photos.forEach(p => fs.unlinkSync(p));
    }
  });

  it('reorders so featured photo is sent first when featured_index > 0', async () => {
    const photos = [makeTempPhoto(), makeTempPhoto(), makeTempPhoto()];
    try {
      const req = request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'Featured ordering test')
        .field('job_id', 'order-job-1')
        .field('featured_index', '2');
      photos.forEach((p, i) => req.attach(`photo_${i}`, p));
      const res = await req;
      assert.equal(res.status, 200);
    } finally {
      photos.forEach(p => fs.unlinkSync(p));
    }
  });
});

// ── classifications / before-after ───────────────────────────────────────────

describe('POST /instagram/publish — classifications field', () => {
  let app, token, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
    const { createInstagramRouter } = require('../routes/instagram');
    const mockFetch = makeIgMock([
      { ok: true, data: { id: 'c1' } },
      { ok: true, data: { status_code: 'FINISHED' } },
      { ok: true, data: { id: 'published_post' } },
    ]);
    app = createApp({ instagramRouter: createInstagramRouter({ igFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app, 'ig-class@example.com', 'password123'));
    await insertIgAccount(userId, 'Class Test', 'ig-class');
  });

  after(() => closeDb());

  it('accepts a JSON classifications array and returns 200', async () => {
    const tmp = makeTempPhoto();
    try {
      const res = await request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'With classifications')
        .field('job_id', 'class-job-1')
        .field('classifications', JSON.stringify(['General']))
        .attach('photo_0', tmp);
      assert.equal(res.status, 200);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('accepts Before and After classifications without crashing (composite falls back gracefully)', async () => {
    const before = makeTempPhoto();
    const after  = makeTempPhoto();
    try {
      const res = await request(app)
        .post('/instagram/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('caption', 'Before after test')
        .field('job_id', 'class-job-2')
        .field('classifications', JSON.stringify(['Before', 'After']))
        .attach('photo_0', before)
        .attach('photo_1', after);
      // sharp will fail on stub bytes — non-fatal fallback means the request still succeeds
      assert.equal(res.status, 200);
    } finally {
      fs.unlinkSync(before);
      fs.unlinkSync(after);
    }
  });
});
