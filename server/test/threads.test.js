'use strict';

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.THREADS_APP_ID            = 'test_th_app_id';
process.env.THREADS_APP_SECRET        = 'test_th_app_secret';
process.env.THREADS_REDIRECT_URI      = 'https://test.example.com/threads/callback';
process.env.SERVER_URL                = 'https://test.example.com';

const { describe, it, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');
const crypto  = require('crypto');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');

const { setupFreshTestDb }    = require('./helpers');
const { getPool, closeDb }    = require('../db');
const { createApp }           = require('../app');
const { encrypt }             = require('../crypto');

// ── Mock Threads API factory ───────────────────────────────────────────────

function makeThreadsMock(responses) {
  let i = 0;
  return async (_url, _opts) => {
    const r = responses[i++] ?? { ok: false, data: { error: { message: 'Unexpected call', code: 0 } } };
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.data };
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function registerAndLogin(app, email = 'th@example.com', password = 'password123') {
  await request(app).post('/auth/register').send({ email, password });
  const login = await request(app).post('/auth/login').send({ email, password });
  const me    = await request(app).get('/auth/me')
    .set('Authorization', `Bearer ${login.body.token}`);
  return { token: login.body.token, userId: me.body.userId };
}

async function insertThAccount(userId, opts = {}) {
  const now      = Date.now();
  const tokenEnc = encrypt('fake_th_token');
  const expires  = opts.tokenExpiresAt ?? (now + 60 * 24 * 60 * 60 * 1000);
  const { rows: [{ id }] } = await getPool().query(
    `INSERT INTO connected_platforms
       (user_id, platform, account_name, account_id, access_token_enc,
        token_expires_at, selected, connected_at, updated_at)
     VALUES ($1, 'threads', $2, $3, $4, $5, true, $6, $7) RETURNING id`,
    [userId, opts.accountName ?? 'testuser', opts.accountId ?? 'th-123', tokenEnc, expires, now, now]
  );
  return id;
}

function makeTempPhoto() {
  const tmp = path.join(os.tmpdir(), `test_th_photo_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(tmp, Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0]));
  return tmp;
}

// Build a valid signed_request with the test secret
function makeSignedRequest(payload, secret = process.env.THREADS_APP_SECRET) {
  const payloadStr  = JSON.stringify(payload);
  const encoded     = Buffer.from(payloadStr).toString('base64url');
  const sig         = crypto.createHmac('sha256', secret).update(Buffer.from(payloadStr)).digest('base64url');
  return `${sig}.${encoded}`;
}

after(async () => { await closeDb(); });

// ── GET /threads/media/:filename ────────────────────────────────────────────

describe('GET /threads/media/:filename', () => {
  let app;
  beforeEach(async () => { await setupFreshTestDb(); app = createApp(); });

  it('returns 404 for unknown file', async () => {
    const res = await request(app).get('/threads/media/nonexistent.jpg');
    assert.equal(res.status, 404);
  });

  it('returns 404 for disallowed filename patterns', async () => {
    const res = await request(app).get('/threads/media/../secret.txt');
    assert.equal(res.status, 404);
  });
});

// ── POST /threads/connect-url ────────────────────────────────────────────────

describe('POST /threads/connect-url', () => {
  let app;
  beforeEach(async () => { await setupFreshTestDb(); app = createApp(); });

  it('requires auth', async () => {
    const res = await request(app).post('/threads/connect-url');
    assert.equal(res.status, 401);
  });

  it('returns authUrl with correct base and params', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app)
      .post('/threads/connect-url')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.authUrl, 'authUrl present');
    const url = new URL(res.body.authUrl);
    assert.equal(url.origin + url.pathname, 'https://threads.net/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), process.env.THREADS_APP_ID);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.ok(url.searchParams.get('state'), 'state present');
    assert.ok(url.searchParams.get('scope')?.includes('threads_basic'), 'threads_basic in scope');
    assert.ok(url.searchParams.get('scope')?.includes('threads_content_publish'), 'threads_content_publish in scope');
  });

  it('stores oauth state in DB', async () => {
    const { token } = await registerAndLogin(app);
    await request(app).post('/threads/connect-url').set('Authorization', `Bearer ${token}`);
    const { rows } = await getPool().query(`SELECT * FROM oauth_states WHERE platform = 'threads'`);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].expires_at > Date.now());
  });

  it('returns 503 when THREADS_APP_ID is missing', async () => {
    const saved = process.env.THREADS_APP_ID;
    delete process.env.THREADS_APP_ID;
    const { token } = await registerAndLogin(app);
    const res = await request(app).post('/threads/connect-url').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 503);
    process.env.THREADS_APP_ID = saved;
  });
});

// ── GET /threads/callback ────────────────────────────────────────────────────

describe('GET /threads/callback', () => {
  let app;
  beforeEach(async () => { await setupFreshTestDb(); });

  it('redirects with error when igError param present', async () => {
    app = createApp();
    const res = await request(app).get('/threads/callback?error=access_denied');
    assert.equal(res.status, 302);
    assert.ok(res.headers.location?.includes('error=access_denied'));
  });

  it('redirects with missing_params when code/state absent', async () => {
    app = createApp();
    const res = await request(app).get('/threads/callback');
    assert.equal(res.status, 302);
    assert.ok(res.headers.location?.includes('missing_params'));
  });

  it('redirects with invalid_state for unknown state', async () => {
    app = createApp();
    const res = await request(app).get('/threads/callback?code=abc&state=unknownstate');
    assert.equal(res.status, 302);
    assert.ok(res.headers.location?.includes('invalid_state'));
  });

  it('completes OAuth flow and stores encrypted token', async () => {
    const mockFetch = makeThreadsMock([
      // Step 1: short-lived token
      { data: { access_token: 'short_token', user_id: 'th-123' } },
      // Step 2: long-lived token
      { data: { access_token: 'long_token', expires_in: 5184000 } },
      // Step 3: profile
      { data: { id: 'th-123', name: 'Test User', username: 'testuser' } },
    ]);
    app = createApp({ threadsRouter: require('../routes/threads').createThreadsRouter({ threadsFetch: mockFetch }) });

    const { token, userId } = await registerAndLogin(app);
    const stateRes = await request(app)
      .post('/threads/connect-url')
      .set('Authorization', `Bearer ${token}`);
    const state = new URL(stateRes.body.authUrl).searchParams.get('state');

    const res = await request(app).get(`/threads/callback?code=testcode&state=${state}`);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location?.includes('success=true'));
    assert.ok(res.headers.location?.includes('platform=threads'));

    const { rows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE user_id = $1 AND platform = 'threads'`,
      [userId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].account_id, 'th-123');
    assert.equal(rows[0].account_name, 'Test User');
    assert.ok(rows[0].access_token_enc, 'token encrypted');
  });

  it('prevents state replay', async () => {
    const mockFetch = makeThreadsMock([
      { data: { access_token: 'short_token', user_id: 'th-123' } },
      { data: { access_token: 'long_token', expires_in: 5184000 } },
      { data: { id: 'th-123', name: 'Test User', username: 'testuser' } },
    ]);
    app = createApp({ threadsRouter: require('../routes/threads').createThreadsRouter({ threadsFetch: mockFetch }) });

    const { token } = await registerAndLogin(app);
    const stateRes = await request(app).post('/threads/connect-url').set('Authorization', `Bearer ${token}`);
    const state = new URL(stateRes.body.authUrl).searchParams.get('state');

    await request(app).get(`/threads/callback?code=testcode&state=${state}`);
    const res2 = await request(app).get(`/threads/callback?code=testcode&state=${state}`);
    assert.equal(res2.status, 302);
    assert.ok(res2.headers.location?.includes('state_already_used'));
  });
});

// ── GET /threads/account ─────────────────────────────────────────────────────

describe('GET /threads/account', () => {
  let app;
  beforeEach(async () => { await setupFreshTestDb(); app = createApp(); });

  it('requires auth', async () => {
    const res = await request(app).get('/threads/account');
    assert.equal(res.status, 401);
  });

  it('returns null when no account connected', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app).get('/threads/account').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.account, null);
  });

  it('returns account info when connected', async () => {
    const { token, userId } = await registerAndLogin(app);
    await insertThAccount(userId, { accountName: 'myprofile', accountId: 'th-999' });
    const res = await request(app).get('/threads/account').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.account.account_name, 'myprofile');
    assert.equal(res.body.account.account_id, 'th-999');
  });
});

// ── POST /threads/publish — text-only ────────────────────────────────────────

describe('POST /threads/publish (text-only)', () => {
  let app;
  beforeEach(async () => { await setupFreshTestDb(); });

  it('requires auth', async () => {
    app = createApp();
    const res = await request(app).post('/threads/publish').send({ text: 'hello', job_id: '1' });
    assert.equal(res.status, 401);
  });

  it('returns 422 when no Threads account connected', async () => {
    app = createApp();
    const { token } = await registerAndLogin(app);
    const res = await request(app)
      .post('/threads/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('text', 'Hello Threads')
      .field('job_id', '42');
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'no_threads_account');
  });

  it('returns 422 when token expired', async () => {
    app = createApp();
    const { token, userId } = await registerAndLogin(app);
    await insertThAccount(userId, { tokenExpiresAt: Date.now() - 1000 });
    const res = await request(app)
      .post('/threads/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('text', 'Hello')
      .field('job_id', '1');
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'token_expired');
  });

  it('publishes a text-only post successfully', async () => {
    const mockFetch = makeThreadsMock([
      { data: { id: 'container-1' } },           // create container
      { data: { id: 'post-abc-123' } },           // threads_publish
    ]);
    app = createApp({ threadsRouter: require('../routes/threads').createThreadsRouter({ threadsFetch: mockFetch }) });

    const { token, userId } = await registerAndLogin(app);
    await insertThAccount(userId);

    const res = await request(app)
      .post('/threads/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('text', 'Hello Threads!')
      .field('job_id', '10');

    assert.equal(res.body.ok, true);
    assert.equal(res.body.postId, 'post-abc-123');
    assert.ok(res.body.postUrl?.includes('threads.net'));

    const { rows } = await getPool().query(`SELECT * FROM publishing_records WHERE platform = 'threads'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'published');
    assert.equal(rows[0].platform_post_id, 'post-abc-123');
  });

  it('returns duplicate:true for already published job', async () => {
    const mockFetch = makeThreadsMock([
      { data: { id: 'container-1' } },
      { data: { id: 'post-dup-1' } },
    ]);
    app = createApp({ threadsRouter: require('../routes/threads').createThreadsRouter({ threadsFetch: mockFetch }) });

    const { token, userId } = await registerAndLogin(app);
    await insertThAccount(userId);

    // First publish
    await request(app)
      .post('/threads/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('text', 'Hello')
      .field('job_id', '5');

    // Second publish (duplicate)
    const res = await request(app)
      .post('/threads/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('text', 'Hello')
      .field('job_id', '5');

    assert.equal(res.body.ok, true);
    assert.equal(res.body.duplicate, true);
  });

  it('sets reconnect_required on API error code 190', async () => {
    const mockFetch = makeThreadsMock([
      { data: { error: { message: 'Token expired', code: 190 } } },
    ]);
    app = createApp({ threadsRouter: require('../routes/threads').createThreadsRouter({ threadsFetch: mockFetch }) });

    const { token, userId } = await registerAndLogin(app);
    await insertThAccount(userId);

    const res = await request(app)
      .post('/threads/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('text', 'Hello')
      .field('job_id', '99');

    assert.equal(res.body.ok, false);
    assert.equal(res.body.reconnect_required, true);
  });

  it('marks publishing_record as failed on API error', async () => {
    const mockFetch = makeThreadsMock([
      { data: { error: { message: 'Rate limit exceeded', code: 32 } } },
    ]);
    app = createApp({ threadsRouter: require('../routes/threads').createThreadsRouter({ threadsFetch: mockFetch }) });

    const { token, userId } = await registerAndLogin(app);
    await insertThAccount(userId);

    const res = await request(app)
      .post('/threads/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('text', 'Hello')
      .field('job_id', '55');

    assert.equal(res.body.ok, false);
    const { rows } = await getPool().query(`SELECT status FROM publishing_records WHERE platform = 'threads'`);
    assert.equal(rows[0].status, 'failed');
  });

  it('requires text field', async () => {
    app = createApp();
    const { token, userId } = await registerAndLogin(app);
    await insertThAccount(userId);
    const res = await request(app)
      .post('/threads/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('job_id', '1');
    assert.equal(res.status, 400);
    assert.ok(res.body.error?.includes('text'));
  });
});

// ── POST /threads/publish — single image ─────────────────────────────────────

describe('POST /threads/publish (single image)', () => {
  let app;
  let tmpPhoto;
  beforeEach(async () => {
    await setupFreshTestDb();
    tmpPhoto = makeTempPhoto();
  });
  after(() => { if (tmpPhoto && fs.existsSync(tmpPhoto)) fs.unlinkSync(tmpPhoto); });

  it('publishes a single-image post', async () => {
    const mockFetch = makeThreadsMock([
      { data: { id: 'container-img-1' } },      // create IMAGE container
      { data: { status: 'FINISHED' } },          // waitForThreadsContainer poll
      { data: { id: 'post-img-abc' } },          // threads_publish
    ]);
    app = createApp({ threadsRouter: require('../routes/threads').createThreadsRouter({ threadsFetch: mockFetch }) });

    const { token, userId } = await registerAndLogin(app);
    await insertThAccount(userId);

    const res = await request(app)
      .post('/threads/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('text', 'Check out this photo!')
      .field('job_id', '20')
      .attach('photo_0', tmpPhoto, 'photo_0.jpg');

    assert.equal(res.body.ok, true);
    assert.equal(res.body.postId, 'post-img-abc');
  });
});

// ── POST /threads/publish — carousel ─────────────────────────────────────────

describe('POST /threads/publish (carousel)', () => {
  let app;
  let tmpPhoto1, tmpPhoto2;
  beforeEach(async () => {
    await setupFreshTestDb();
    tmpPhoto1 = makeTempPhoto();
    tmpPhoto2 = makeTempPhoto();
  });
  after(() => {
    [tmpPhoto1, tmpPhoto2].forEach(p => { if (p && fs.existsSync(p)) fs.unlinkSync(p); });
  });

  it('publishes a carousel post', async () => {
    const mockFetch = makeThreadsMock([
      { data: { id: 'child-1' } },        // carousel item 1 (parallel create)
      { data: { id: 'child-2' } },        // carousel item 2 (parallel create)
      { data: { status: 'FINISHED' } },   // waitForThreadsContainer poll — child-1 (parallel wait)
      { data: { status: 'FINISHED' } },   // waitForThreadsContainer poll — child-2 (parallel wait)
      { data: { id: 'carousel-1' } },     // CAROUSEL container
      { data: { status: 'FINISHED' } },   // waitForThreadsContainer poll — carousel-1
      { data: { id: 'post-car-abc' } },   // threads_publish
    ]);
    app = createApp({ threadsRouter: require('../routes/threads').createThreadsRouter({ threadsFetch: mockFetch }) });

    const { token, userId } = await registerAndLogin(app);
    await insertThAccount(userId);

    const res = await request(app)
      .post('/threads/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('text', 'Carousel post!')
      .field('job_id', '30')
      .attach('photo_0', tmpPhoto1, 'photo_0.jpg')
      .attach('photo_1', tmpPhoto2, 'photo_1.jpg');

    assert.equal(res.body.ok, true);
    assert.equal(res.body.postId, 'post-car-abc');
  });
});

// ── POST /threads/uninstall ───────────────────────────────────────────────────

describe('POST /threads/uninstall', () => {
  let app;
  beforeEach(async () => { await setupFreshTestDb(); app = createApp(); });

  it('returns 400 for missing signed_request', async () => {
    const res = await request(app).post('/threads/uninstall').send({});
    assert.equal(res.status, 400);
  });

  it('returns 400 for invalid signed_request', async () => {
    const res = await request(app).post('/threads/uninstall').send({ signed_request: 'bad.data' });
    assert.equal(res.status, 400);
  });

  it('removes connected platform and returns 200', async () => {
    const { userId } = await registerAndLogin(app);
    await insertThAccount(userId, { accountId: 'th-uninstall-99' });

    const signed = makeSignedRequest({ user_id: 'th-uninstall-99', algorithm: 'HMAC-SHA256' });
    const res = await request(app).post('/threads/uninstall').send({ signed_request: signed });
    assert.equal(res.status, 200);

    const { rows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE account_id = 'th-uninstall-99' AND platform = 'threads'`
    );
    assert.equal(rows.length, 0);
  });
});

// ── POST /threads/delete ──────────────────────────────────────────────────────

describe('POST /threads/delete', () => {
  let app;
  beforeEach(async () => { await setupFreshTestDb(); app = createApp(); });

  it('returns 400 for invalid signed_request', async () => {
    const res = await request(app).post('/threads/delete').send({ signed_request: 'notvalid.abc' });
    assert.equal(res.status, 400);
  });

  it('removes threads data and returns confirmation JSON', async () => {
    const { userId } = await registerAndLogin(app);
    await insertThAccount(userId, { accountId: 'th-delete-42' });

    const signed = makeSignedRequest({ user_id: 'th-delete-42', algorithm: 'HMAC-SHA256' });
    const res = await request(app).post('/threads/delete').send({ signed_request: signed });
    assert.equal(res.status, 200);
    assert.ok(res.body.url, 'url present');
    assert.ok(res.body.confirmation_code, 'confirmation_code present');

    const { rows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE account_id = 'th-delete-42' AND platform = 'threads'`
    );
    assert.equal(rows.length, 0);
  });

  it('returns valid confirmation URL pointing to deletion-status endpoint', async () => {
    const signed = makeSignedRequest({ user_id: 'nobody', algorithm: 'HMAC-SHA256' });
    const res = await request(app).post('/threads/delete').send({ signed_request: signed });
    assert.ok(res.body.url?.includes('/threads/deletion-status'));
  });
});

// ── GET /threads/deletion-status ─────────────────────────────────────────────

describe('GET /threads/deletion-status', () => {
  let app;
  beforeEach(async () => { await setupFreshTestDb(); app = createApp(); });

  it('returns an HTML page', async () => {
    const res = await request(app).get('/threads/deletion-status?code=abc123');
    assert.equal(res.status, 200);
    assert.ok(res.text?.includes('Deletion') || res.text?.includes('deletion'));
  });
});

// ── Unauthorized access ───────────────────────────────────────────────────────

describe('Unauthorized access', () => {
  let app;
  beforeEach(async () => { await setupFreshTestDb(); app = createApp(); });

  it('cannot get another user\'s account', async () => {
    const u1 = await registerAndLogin(app, 'u1@example.com');
    const u2 = await registerAndLogin(app, 'u2@example.com');
    await insertThAccount(u1.userId, { accountId: 'th-u1' });

    const res = await request(app)
      .get('/threads/account')
      .set('Authorization', `Bearer ${u2.token}`);
    assert.equal(res.body.account, null);
  });

  it('cannot publish to another user\'s account', async () => {
    const u1 = await registerAndLogin(app, 'x1@example.com');
    const u2 = await registerAndLogin(app, 'x2@example.com');
    await insertThAccount(u1.userId, { accountId: 'th-x1' });

    const res = await request(app)
      .post('/threads/publish')
      .set('Authorization', `Bearer ${u2.token}`)
      .field('text', 'Attempt')
      .field('job_id', '1');
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'no_threads_account');
  });
});
