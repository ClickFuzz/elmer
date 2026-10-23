'use strict';

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.GOOGLE_CLIENT_ID          = 'test_google_client_id';
process.env.GOOGLE_CLIENT_SECRET      = 'test_google_client_secret';
process.env.GOOGLE_REDIRECT_URI       = 'https://test.example.com/google/callback';
process.env.SERVER_URL                = 'https://test.example.com';

const { describe, it, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');

const { setupFreshTestDb, seedActiveSubscription } = require('./helpers');
const { getPool, closeDb }  = require('../db');
const { createApp }         = require('../app');
const { createGoogleRouter } = require('../routes/google');
const { encrypt }           = require('../crypto');

after(async () => { await closeDb(); });

// ── Mock Google API factory ────────────────────────────────────────────────

function makeGbpMock(responses) {
  let i = 0;
  return async (_url, _opts) => {
    const r = responses[i++] ?? { ok: false, data: { error: { message: 'Unexpected call', status: 'UNKNOWN' } }, status: 500 };
    return {
      ok:     r.ok ?? true,
      status: r.status ?? 200,
      json:   async () => r.data,
    };
  };
}

// ── Shared helpers ─────────────────────────────────────────────────────────

async function registerAndLogin(app, email = 'google@example.com', pass = 'password123') {
  await request(app).post('/auth/register').send({ email, password: pass });
  const login = await request(app).post('/auth/login').send({ email, password: pass });
  const me    = await request(app).get('/auth/me').set('Authorization', `Bearer ${login.body.token}`);
  const userId = me.body.userId;
  await seedActiveSubscription(userId);
  return { token: login.body.token, userId };
}

async function createGoogleState(app, token) {
  const res = await request(app)
    .post('/platforms/oauth/state')
    .set('Authorization', `Bearer ${token}`)
    .send({ platform: 'google' });
  return res.body.state;
}

async function insertGoogleLocation(userId, opts = {}) {
  const now       = Date.now();
  const tokenEnc  = encrypt(opts.accessToken ?? 'fake_access_token');
  const rTokenEnc = encrypt(opts.refreshToken ?? 'fake_refresh_token');
  const accountId = opts.accountId ?? 'accounts/123/locations/456';
  const expires   = opts.tokenExpiresAt ?? (now + 3600 * 1000);
  const { rows: [{ id }] } = await getPool().query(
    `INSERT INTO connected_platforms
       (user_id, platform, account_name, account_id, access_token_enc, refresh_token_enc,
        token_expires_at, selected, tasks_json, connected_at, updated_at)
     VALUES ($1, 'google', $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      userId,
      opts.accountName ?? 'My Business — 123 Main St',
      accountId,
      tokenEnc,
      rTokenEnc,
      expires,
      opts.selected ?? true,
      JSON.stringify({ locationTitle: 'My Business', locationAddress: '123 Main St' }),
      now,
      now,
    ]
  );
  return id;
}

function makeTempPhoto() {
  const tmp = path.join(os.tmpdir(), `test_gbp_photo_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(tmp, Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]));
  return tmp;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /google/connect-url', () => {
  let app;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).post('/google/connect-url');
    assert.equal(res.status, 401);
  });

  it('returns authUrl when configured', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app)
      .post('/google/connect-url')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.authUrl === 'string');
    assert.ok(res.body.authUrl.includes('accounts.google.com'));
    assert.ok(res.body.authUrl.includes('business.manage'));
    assert.ok(res.body.authUrl.includes('offline'));
  });

  it('returns 503 when GOOGLE_CLIENT_ID is not set', async () => {
    const saved = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    const { token } = await registerAndLogin(app, 'g2@example.com');
    const res = await request(app)
      .post('/google/connect-url')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 503);
    process.env.GOOGLE_CLIENT_ID = saved;
  });
});

describe('GET /google/callback — state validation', () => {
  let app;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
  });

  it('redirects with missing_params when code or state absent', async () => {
    const res = await request(app).get('/google/callback').redirects(0);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('missing_params'));
  });

  it('redirects with invalid_state for unknown state', async () => {
    const res = await request(app)
      .get('/google/callback?code=abc&state=badstate')
      .redirects(0);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('invalid_state'));
  });

  it('redirects with state_expired for expired state', async () => {
    const { token } = await registerAndLogin(app);
    const state = await createGoogleState(app, token);
    // Manually expire the state
    await getPool().query(
      `UPDATE oauth_states SET expires_at = $1 WHERE state = $2`,
      [Date.now() - 1000, state]
    );
    const res = await request(app)
      .get(`/google/callback?code=abc&state=${state}`)
      .redirects(0);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('state_expired'));
  });

  it('redirects with state_already_used on replay', async () => {
    const { token } = await registerAndLogin(app);
    const state = await createGoogleState(app, token);

    const mock = makeGbpMock([
      // token exchange
      { data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
      // accounts
      { data: { accounts: [{ name: 'accounts/1' }] } },
      // locations
      { data: { locations: [{ name: 'locations/1', title: 'My Biz' }] } },
    ]);
    const googleRouter = createGoogleRouter({ apiFetch: mock });
    const app2 = createApp({ googleRouter });

    await request(app2).get(`/google/callback?code=abc&state=${state}`).redirects(0);

    // Second attempt
    const res2 = await request(app2).get(`/google/callback?code=abc&state=${state}`).redirects(0);
    assert.ok(res2.headers.location.includes('state_already_used'));
  });
});

describe('GET /google/callback — successful connection', () => {
  let app;

  beforeEach(async () => { await setupFreshTestDb(); });

  it('stores locations and redirects with success=true', async () => {
    const { token } = await registerAndLogin(createApp());
    const state = await createGoogleState(createApp(), token);

    const mock = makeGbpMock([
      // token exchange
      { data: { access_token: 'at_ok', refresh_token: 'rt_ok', expires_in: 3600 } },
      // accounts list
      { data: { accounts: [{ name: 'accounts/42' }] } },
      // locations for accounts/42
      {
        data: {
          locations: [
            { name: 'locations/99', title: 'Downtown Store', storefrontAddress: { addressLines: ['1 Main St'], locality: 'Denver', administrativeArea: 'CO' } },
          ],
        },
      },
    ]);
    const googleRouter = createGoogleRouter({ apiFetch: mock });
    app = createApp({ googleRouter });

    const res = await request(app)
      .get(`/google/callback?code=mycode&state=${state}`)
      .redirects(0);

    assert.equal(res.status, 302);
    assert.ok(res.headers.location.includes('success=true'));
    assert.ok(res.headers.location.includes('location_count=1'));

    const { rows } = await getPool().query(
      `SELECT account_name, account_id FROM connected_platforms WHERE platform = 'google'`
    );
    assert.equal(rows.length, 1);
    assert.ok(rows[0].account_name.includes('Downtown Store'));
    assert.equal(rows[0].account_id, 'accounts/42/locations/99');
  });

  it('redirects with no_business_accounts when accounts list is empty', async () => {
    const { token } = await registerAndLogin(createApp());
    const state = await createGoogleState(createApp(), token);

    const mock = makeGbpMock([
      { data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
      { data: { accounts: [] } },
    ]);
    app = createApp({ googleRouter: createGoogleRouter({ apiFetch: mock }) });

    const res = await request(app)
      .get(`/google/callback?code=mycode&state=${state}`)
      .redirects(0);
    assert.ok(res.headers.location.includes('no_business_accounts'));
  });

  it('redirects with no_locations when locations list is empty', async () => {
    const { token } = await registerAndLogin(createApp());
    const state = await createGoogleState(createApp(), token);

    const mock = makeGbpMock([
      { data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
      { data: { accounts: [{ name: 'accounts/1' }] } },
      { data: { locations: [] } },
    ]);
    app = createApp({ googleRouter: createGoogleRouter({ apiFetch: mock }) });

    const res = await request(app)
      .get(`/google/callback?code=mycode&state=${state}`)
      .redirects(0);
    assert.ok(res.headers.location.includes('no_locations'));
  });

  it('redirects with auth_failed when token exchange errors', async () => {
    const { token } = await registerAndLogin(createApp());
    const state = await createGoogleState(createApp(), token);

    const mock = makeGbpMock([
      { data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked' } },
    ]);
    app = createApp({ googleRouter: createGoogleRouter({ apiFetch: mock }) });

    const res = await request(app)
      .get(`/google/callback?code=bad&state=${state}`)
      .redirects(0);
    assert.ok(res.headers.location.includes('auth_failed'));
  });
});

describe('GET /google/locations', () => {
  let app;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/google/locations');
    assert.equal(res.status, 401);
  });

  it('returns empty array when no locations', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app)
      .get('/google/locations')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.locations, []);
  });

  it('returns connected locations', async () => {
    const { token, userId } = await registerAndLogin(app);
    await insertGoogleLocation(userId);
    const res = await request(app)
      .get('/google/locations')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.locations.length, 1);
    assert.equal(res.body.locations[0].account_id, 'accounts/123/locations/456');
    assert.equal(res.body.locations[0].selected, true);
  });

  it('does not expose tokens', async () => {
    const { token, userId } = await registerAndLogin(app);
    await insertGoogleLocation(userId);
    const res = await request(app)
      .get('/google/locations')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    const loc = res.body.locations[0];
    assert.ok(!loc.access_token_enc);
    assert.ok(!loc.refresh_token_enc);
  });
});

describe('POST /google/locations/selection', () => {
  let app;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).post('/google/locations/selection').send({ location_ids: [] });
    assert.equal(res.status, 401);
  });

  it('updates location selection', async () => {
    const { token, userId } = await registerAndLogin(app);
    const id1 = await insertGoogleLocation(userId, { accountId: 'accounts/1/locations/1', selected: true });
    await insertGoogleLocation(userId, { accountId: 'accounts/1/locations/2', selected: true });

    const res = await request(app)
      .post('/google/locations/selection')
      .set('Authorization', `Bearer ${token}`)
      .send({ location_ids: [id1] });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const { rows } = await getPool().query(
      `SELECT account_id, selected FROM connected_platforms WHERE user_id = $1 AND platform = 'google' ORDER BY id`,
      [userId]
    );
    assert.equal(rows.find(r => r.account_id === 'accounts/1/locations/1').selected, true);
    assert.equal(rows.find(r => r.account_id === 'accounts/1/locations/2').selected, false);
  });

  it('returns 400 when location_ids is not an array', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app)
      .post('/google/locations/selection')
      .set('Authorization', `Bearer ${token}`)
      .send({ location_ids: 'bad' });
    assert.equal(res.status, 400);
  });
});

describe('GET /google/media/:filename', () => {
  let app;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
  });

  it('returns 404 for unknown filename', async () => {
    const res = await request(app).get('/google/media/nonexistent.jpg');
    assert.equal(res.status, 404);
  });

  it('returns 404 for path traversal attempts', async () => {
    const res = await request(app).get('/google/media/../../etc/passwd');
    assert.equal(res.status, 404);
  });
});

describe('POST /google/publish', () => {
  let app;
  let tmpPhoto;

  beforeEach(async () => {
    await setupFreshTestDb();
    tmpPhoto = makeTempPhoto();
  });

  after(() => {
    if (tmpPhoto && fs.existsSync(tmpPhoto)) fs.unlinkSync(tmpPhoto);
  });

  it('returns 401 without auth', async () => {
    app = createApp();
    const res = await request(app).post('/google/publish').send({ message: 'hi', job_id: '1' });
    assert.equal(res.status, 401);
  });

  it('returns 402 SUBSCRIPTION_REQUIRED when free publication is redeemed and no subscription', async () => {
    app = createApp();
    const email = 'nosub_gbp@example.com';
    await request(app).post('/auth/register').send({ email, password: 'password123' });
    const login = await request(app).post('/auth/login').send({ email, password: 'password123' });
    // Mark free publication as redeemed to simulate a user who already used their free post
    const { rows } = await getPool().query('SELECT id FROM users WHERE email = $1', [email]);
    await getPool().query(
      `UPDATE free_publications SET status = 'redeemed', redeemed_at = $2, updated_at = $2 WHERE user_id = $1`,
      [rows[0].id, Date.now()]
    );
    const res = await request(app)
      .post('/google/publish')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ message: 'hi', job_id: '1' });
    assert.equal(res.status, 402);
    assert.equal(res.body.error, 'SUBSCRIPTION_REQUIRED');
  });

  it('returns 422 when no locations are selected', async () => {
    app = createApp();
    const { token, userId } = await registerAndLogin(app);
    await insertGoogleLocation(userId, { selected: false });
    const res = await request(app)
      .post('/google/publish')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'hi', job_id: '1' });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'no_locations_selected');
  });

  it('returns 400 when message is missing', async () => {
    app = createApp();
    const { token, userId } = await registerAndLogin(app);
    await insertGoogleLocation(userId);
    const res = await request(app)
      .post('/google/publish')
      .set('Authorization', `Bearer ${token}`)
      .send({ job_id: '1' });
    assert.equal(res.status, 400);
  });

  it('publishes successfully to a location', async () => {
    const postName = 'accounts/123/locations/456/localPosts/789';
    const mock = makeGbpMock([
      // POST local post
      { data: { name: postName } },
    ]);
    app = createApp({ googleRouter: createGoogleRouter({ apiFetch: mock }) });
    const { token, userId } = await registerAndLogin(app);
    await insertGoogleLocation(userId);

    const res = await request(app)
      .post('/google/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Great job today!')
      .field('job_id', 'job_001');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.results.length, 1);
    assert.equal(res.body.results[0].ok, true);
    assert.equal(res.body.results[0].postId, postName);

    const { rows } = await getPool().query(
      `SELECT status, platform_post_id FROM publishing_records WHERE platform = 'google' AND job_ref LIKE 'gbp_%'`
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'published');
    assert.equal(rows[0].platform_post_id, postName);
  });

  it('is idempotent — second publish returns duplicate=true', async () => {
    const postName = 'accounts/123/locations/456/localPosts/789';
    let callCount = 0;
    const mock = async () => {
      callCount++;
      return { ok: true, status: 200, json: async () => ({ name: postName }) };
    };
    app = createApp({ googleRouter: createGoogleRouter({ apiFetch: mock }) });
    const { token, userId } = await registerAndLogin(app);
    await insertGoogleLocation(userId);

    const req1 = () => request(app)
      .post('/google/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'First post')
      .field('job_id', 'dup_job_001');

    const res1 = await req1();
    assert.equal(res1.body.results[0].ok, true);
    assert.equal(res1.body.results[0].duplicate, undefined);

    const apiCallsAfterFirst = callCount;

    const res2 = await req1();
    assert.equal(res2.body.results[0].ok, true);
    assert.equal(res2.body.results[0].duplicate, true);
    // No new API call should have been made
    assert.equal(callCount, apiCallsAfterFirst);
  });

  it('returns reconnect_required on 401 from GBP API', async () => {
    const mock = makeGbpMock([
      // Initial 401
      { ok: false, status: 401, data: { error: { message: 'Invalid credentials', status: 'UNAUTHENTICATED' } } },
      // Refresh token call (also fails for simplicity — token is invalid)
      { ok: false, status: 400, data: { error: 'invalid_grant' } },
    ]);
    app = createApp({ googleRouter: createGoogleRouter({ apiFetch: mock }) });
    const { token, userId } = await registerAndLogin(app);
    await insertGoogleLocation(userId);

    const res = await request(app)
      .post('/google/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Test post')
      .field('job_id', 'reconnect_job_001');

    assert.equal(res.status, 200);
    assert.equal(res.body.results[0].ok, false);
    assert.equal(res.body.results[0].reconnect_required, true);
  });

  it('returns partial success when one of two locations fails', async () => {
    let callIdx = 0;
    const mock = async () => {
      callIdx++;
      if (callIdx === 1) {
        return { ok: true, status: 200, json: async () => ({ name: 'accounts/1/locations/1/localPosts/ok' }) };
      }
      return { ok: false, status: 500, json: async () => ({ error: { message: 'Internal error', status: 'INTERNAL' } }) };
    };
    app = createApp({ googleRouter: createGoogleRouter({ apiFetch: mock }) });
    const { token, userId } = await registerAndLogin(app);
    await insertGoogleLocation(userId, { accountId: 'accounts/1/locations/1' });
    await insertGoogleLocation(userId, { accountId: 'accounts/1/locations/2' });

    const res = await request(app)
      .post('/google/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Partial test')
      .field('job_id', 'partial_job_001');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true); // at least one succeeded
    const results = res.body.results;
    assert.equal(results.length, 2);
    const okResult  = results.find(r => r.ok === true);
    const errResult = results.find(r => r.ok === false);
    assert.ok(okResult);
    assert.ok(errResult);
  });

  it('proactively refreshes token when close to expiry', async () => {
    let callUrls = [];
    const mock = async (url, opts) => {
      callUrls.push(url);
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'refreshed_at', expires_in: 3600 }) };
      }
      return { ok: true, status: 200, json: async () => ({ name: 'accounts/123/locations/456/localPosts/999' }) };
    };
    app = createApp({ googleRouter: createGoogleRouter({ apiFetch: mock }) });
    const { token, userId } = await registerAndLogin(app);
    // Insert with token_expires_at just 2 minutes from now (< 5min threshold)
    await insertGoogleLocation(userId, { tokenExpiresAt: Date.now() + 2 * 60 * 1000 });

    const res = await request(app)
      .post('/google/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Refresh test')
      .field('job_id', 'refresh_job_001');

    assert.equal(res.status, 200);
    // Refresh token endpoint should have been called
    const refreshCalled = callUrls.some(u => u.includes('oauth2.googleapis.com/token'));
    assert.ok(refreshCalled, 'Expected token refresh to be called');
  });

  it('truncates message at 1500 chars', async () => {
    let capturedBody = null;
    const mock = async (url, opts) => {
      if (opts?.method === 'POST' && url.includes('localPosts')) {
        capturedBody = JSON.parse(opts.body);
      }
      return { ok: true, status: 200, json: async () => ({ name: 'accounts/123/locations/456/localPosts/trunc' }) };
    };
    app = createApp({ googleRouter: createGoogleRouter({ apiFetch: mock }) });
    const { token, userId } = await registerAndLogin(app);
    await insertGoogleLocation(userId);

    const longMessage = 'A'.repeat(2000);
    const res = await request(app)
      .post('/google/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', longMessage)
      .field('job_id', 'trunc_job_001');

    assert.equal(res.status, 200);
    assert.ok(capturedBody !== null);
    assert.equal(capturedBody.summary.length, 1500);
  });

  it('includes CTA when business_url is provided', async () => {
    let capturedBody = null;
    const mock = async (url, opts) => {
      if (opts?.method === 'POST' && url.includes('localPosts')) {
        capturedBody = JSON.parse(opts.body);
      }
      return { ok: true, status: 200, json: async () => ({ name: 'accounts/123/locations/456/localPosts/cta' }) };
    };
    app = createApp({ googleRouter: createGoogleRouter({ apiFetch: mock }) });
    const { token, userId } = await registerAndLogin(app);
    await insertGoogleLocation(userId);

    const res = await request(app)
      .post('/google/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Post with CTA')
      .field('job_id', 'cta_job_001')
      .field('business_url', 'https://mybusiness.com/contact');

    assert.equal(res.status, 200);
    assert.ok(capturedBody !== null);
    assert.equal(capturedBody.callToAction?.actionType, 'LEARN_MORE');
    assert.equal(capturedBody.callToAction?.url, 'https://mybusiness.com/contact');
  });

  it('does not include CTA when business_url is absent', async () => {
    let capturedBody = null;
    const mock = async (url, opts) => {
      if (opts?.method === 'POST' && url.includes('localPosts')) {
        capturedBody = JSON.parse(opts.body);
      }
      return { ok: true, status: 200, json: async () => ({ name: 'accounts/123/locations/456/localPosts/nocta' }) };
    };
    app = createApp({ googleRouter: createGoogleRouter({ apiFetch: mock }) });
    const { token, userId } = await registerAndLogin(app);
    await insertGoogleLocation(userId);

    const res = await request(app)
      .post('/google/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Post without CTA')
      .field('job_id', 'nocta_job_001');

    assert.equal(res.status, 200);
    assert.ok(capturedBody !== null);
    assert.ok(!capturedBody.callToAction, 'callToAction should not be present');
  });

  it('does not leak location tokens across users', async () => {
    const mock = async (url, opts) => {
      return { ok: true, status: 200, json: async () => ({ name: 'accounts/123/locations/456/localPosts/x' }) };
    };
    app = createApp({ googleRouter: createGoogleRouter({ apiFetch: mock }) });

    const { userId: userA }  = await registerAndLogin(app, 'usera_gbp@example.com');
    const { token: tokenB } = await registerAndLogin(app, 'userb_gbp@example.com');

    await insertGoogleLocation(userA, { accountId: 'accounts/1/locations/1' });

    // User B should see no locations
    const res = await request(app)
      .post('/google/publish')
      .set('Authorization', `Bearer ${tokenB}`)
      .field('message', 'Should fail')
      .field('job_id', 'isolation_001');

    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'no_locations_selected');
  });
});
