'use strict';

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'c'.repeat(64);
process.env.FACEBOOK_APP_ID           = 'test_app_id';
process.env.FACEBOOK_APP_SECRET       = 'test_app_secret';
process.env.FACEBOOK_REDIRECT_URI     = 'http://localhost:3001/facebook/callback';

const { describe, it, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');

const { setupFreshTestDb, seedActiveSubscription } = require('./helpers');
const { getPool, closeDb } = require('../db');
const { createApp }        = require('../app');
const { encrypt }          = require('../crypto');

// ── Mock Graph API factory ─────────────────────────────────────────────────

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
  const userId = me.body.userId;
  await seedActiveSubscription(userId);
  return { token: login.body.token, userId };
}

async function createFbState(app, token) {
  const res = await request(app)
    .post('/platforms/oauth/state')
    .set('Authorization', `Bearer ${token}`)
    .send({ platform: 'facebook' });
  return res.body.state;
}

// opts.selected defaults to true; opts.tasks defaults to ['CREATE_CONTENT']
async function insertFbPage(userId, pageName = 'My Page', pageAccountId = 'page-123', opts = {}) {
  const now      = Date.now();
  const tokenEnc = encrypt('fake_page_token');
  const selected = opts.selected ?? true;
  const tasksJson = JSON.stringify(opts.tasks ?? ['CREATE_CONTENT']);
  const { rows: [{ id }] } = await getPool().query(
    `INSERT INTO connected_platforms
       (user_id, platform, account_name, account_id, access_token_enc, tasks_json,
        selected, connected_at, updated_at)
     VALUES ($1, 'facebook', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [userId, pageName, pageAccountId, tokenEnc, tasksJson, selected, now, now]
  );
  return id;
}

async function selectFbPages(app, token, pageIds) {
  return request(app)
    .post('/facebook/pages/selection')
    .set('Authorization', `Bearer ${token}`)
    .send({ page_ids: pageIds });
}

// ── Test suites ────────────────────────────────────────────────────────────

describe('POST /facebook/connect-url', () => {
  let app, token;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ token } = await registerAndLogin(app));
  });

  after(async () => closeDb());

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

    const { rows: [row] } = await getPool().query(
      `SELECT * FROM oauth_states WHERE platform = 'facebook' ORDER BY id DESC LIMIT 1`
    );
    assert.ok(row, 'oauth_state row should exist');
    assert.ok(!row.used_at, 'should not be consumed yet');
  });

  it('includes business_management in the auth scope for Business Portfolio support', async () => {
    const res = await request(app)
      .post('/facebook/connect-url')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.authUrl.includes('business_management'), 'should request business_management scope');
  });
});

describe('GET /facebook/callback', () => {
  after(async () => closeDb());

  it('redirects with error when Facebook returns an error parameter', async () => {
    await setupFreshTestDb();
    const app = createApp();
    const res = await request(app)
      .get('/facebook/callback')
      .query({ error: 'access_denied', error_description: 'User denied access' });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error='), 'location should include error param');
  });

  it('redirects with error for missing code or state', async () => {
    await setupFreshTestDb();
    const app = createApp();
    const res = await request(app)
      .get('/facebook/callback')
      .query({ code: 'abc' });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error=missing_params'));
  });

  it('redirects with error for an invalid state', async () => {
    await setupFreshTestDb();
    const app = createApp();
    const res = await request(app)
      .get('/facebook/callback')
      .query({ code: 'abc123', state: 'deadbeef'.repeat(6) });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error=invalid_state'));
  });

  it('redirects with error for an already-used state', async () => {
    await setupFreshTestDb();
    const { createFacebookRouter } = require('../routes/facebook');
    const app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: makeGraphMock([]) }) });
    const { token } = await registerAndLogin(app);
    const state = await createFbState(app, token);

    await getPool().query('UPDATE oauth_states SET used_at = $1 WHERE state = $2', [Date.now(), state]);

    const res = await request(app)
      .get('/facebook/callback')
      .query({ code: 'abc123', state });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('error=state_already_used'));
  });

  it('stores page tokens and redirects to app scheme on success', async () => {
    await setupFreshTestDb();

    const mockGraphFetch = makeGraphMock([
      { data: { access_token: 'short_token', token_type: 'bearer' } },
      { data: { access_token: 'long_token', expires_in: 5183944, token_type: 'bearer' } },
      { data: { id: 'fb-user-success' } },  // /me — platform_user_id mapping
      { data: { data: [
        { id: 'page-1', name: 'My Shop',  access_token: 'page_token_1', tasks: ['CREATE_CONTENT'] },
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

    const { rows: pages } = await getPool().query(
      `SELECT account_id, account_name, selected FROM connected_platforms
       WHERE user_id = $1 AND platform = 'facebook'
       ORDER BY account_name`,
      [ownerId]
    );
    assert.strictEqual(pages.length, 2);
    assert.strictEqual(pages[0].account_name, 'My Shop');
    assert.strictEqual(pages[1].account_name, 'Side Biz');
    // New pages must be auto-selected on first connect
    assert.strictEqual(pages[0].selected, true, 'new pages should be selected=true');
    assert.strictEqual(pages[1].selected, true, 'new pages should be selected=true');
  });

  it('reconnecting overwrites the existing token without duplicating the row', async () => {
    await setupFreshTestDb();

    const mockGraphFetch = makeGraphMock([
      { data: { access_token: 'short1' } },
      { data: { access_token: 'long1' } },
      { data: { id: 'fb-user-reconnect' } },  // /me — first connect
      { data: { data: [{ id: 'page-1', name: 'My Shop', access_token: 'token_first' }] } },
      { data: { access_token: 'short2' } },
      { data: { access_token: 'long2' } },
      { data: { id: 'fb-user-reconnect' } },  // /me — second connect (same user)
      { data: { data: [{ id: 'page-1', name: 'My Shop', access_token: 'token_second' }] } },
    ]);

    const { createFacebookRouter } = require('../routes/facebook');
    const app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockGraphFetch }) });
    const { token, userId } = await registerAndLogin(app);

    const state1 = await createFbState(app, token);
    await request(app).get('/facebook/callback').query({ code: 'c1', state: state1 });

    // Deselect the page between connects to verify selection is preserved
    await getPool().query(
      `UPDATE connected_platforms SET selected = false WHERE user_id = $1 AND platform = 'facebook'`,
      [userId]
    );

    const state2 = await createFbState(app, token);
    await request(app).get('/facebook/callback').query({ code: 'c2', state: state2 });

    const { rows } = await getPool().query(
      `SELECT id, selected FROM connected_platforms WHERE user_id = $1 AND platform = 'facebook'`,
      [userId]
    );
    assert.strictEqual(rows.length, 1, 'should not duplicate the row');
    // Reconnect must NOT change selected — user's choice is preserved
    assert.strictEqual(rows[0].selected, false, 'reconnect should not change selected state');
  });

  it('redirects with no_manageable_pages error when user has no pages', async () => {
    await setupFreshTestDb();

    const mockGraphFetch = makeGraphMock([
      { data: { access_token: 'short_token' } },
      { data: { access_token: 'long_token' } },
      { data: { id: 'fb-user-nopages' } },  // /me — platform_user_id mapping
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

  it('redirects with insufficient_permissions when Graph API returns permission error', async () => {
    await setupFreshTestDb();

    // Facebook error code 10 = Application does not have permission
    const mockGraphFetch = makeGraphMock([
      { data: { access_token: 'short_token' } },
      { data: { access_token: 'long_token' } },
      { data: { id: 'fb-user-permfail' } },  // /me — platform_user_id mapping (succeeds)
      { ok: false, data: { error: { message: 'Permissions error', code: 10 } } },
    ]);

    const { createFacebookRouter } = require('../routes/facebook');
    const app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockGraphFetch }) });
    const { token } = await registerAndLogin(app);
    const state = await createFbState(app, token);

    const res = await request(app)
      .get('/facebook/callback')
      .query({ code: 'code_xyz', state });

    assert.strictEqual(res.status, 302);
    assert.ok(
      res.headers.location.includes('error=insufficient_permissions'),
      `expected insufficient_permissions, got: ${res.headers.location}`
    );
  });
});

describe('GET /facebook/pages', () => {
  let app, token, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ token, userId } = await registerAndLogin(app));
  });

  after(async () => closeDb());

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

  it('returns pages with a selected field', async () => {
    await insertFbPage(userId, 'Selected Page', 'page-s', { selected: true });
    await insertFbPage(userId, 'Deselected Page', 'page-d', { selected: false });

    const res = await request(app)
      .get('/facebook/pages')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    const byName = Object.fromEntries(res.body.pages.map(p => [p.account_name, p]));
    assert.strictEqual(byName['Selected Page'].selected, true);
    assert.strictEqual(byName['Deselected Page'].selected, false);
  });

  it('returns only pages belonging to the authenticated user', async () => {
    await insertFbPage(userId, 'User1 Page', 'page-u1');

    const { userId: userId2 } = await registerAndLogin(app, 'other@example.com');
    await insertFbPage(userId2, 'User2 Page', 'page-u2');

    const res = await request(app)
      .get('/facebook/pages')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.pages.length, 1);
    assert.strictEqual(res.body.pages[0].account_name, 'User1 Page');
  });

  it('returns multiple pages sorted by name', async () => {
    await insertFbPage(userId, 'Zed Page',   'page-z');
    await insertFbPage(userId, 'Alpha Page', 'page-a');

    const res = await request(app)
      .get('/facebook/pages')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.body.pages.length, 2);
    assert.strictEqual(res.body.pages[0].account_name, 'Alpha Page');
    assert.strictEqual(res.body.pages[1].account_name, 'Zed Page');
  });
});

describe('POST /facebook/pages/selection', () => {
  let app, token, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ token, userId } = await registerAndLogin(app));
  });

  after(async () => closeDb());

  it('returns 401 without authentication', async () => {
    const res = await request(app)
      .post('/facebook/pages/selection')
      .send({ page_ids: [] });
    assert.strictEqual(res.status, 401);
  });

  it('returns 400 when page_ids is not an array', async () => {
    const res = await request(app)
      .post('/facebook/pages/selection')
      .set('Authorization', `Bearer ${token}`)
      .send({ page_ids: 'not-an-array' });
    assert.strictEqual(res.status, 400);
  });

  it('selects specified pages and deselects the rest', async () => {
    const id1 = await insertFbPage(userId, 'Page A', 'page-a', { selected: true });
    const id2 = await insertFbPage(userId, 'Page B', 'page-b', { selected: true });
    const id3 = await insertFbPage(userId, 'Page C', 'page-c', { selected: true });

    // Deselect Page A and C, keep only B
    const res = await selectFbPages(app, token, [id2]);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);

    const { rows } = await getPool().query(
      `SELECT account_name, selected FROM connected_platforms WHERE user_id = $1 AND platform = 'facebook' ORDER BY account_name`,
      [userId]
    );
    const byName = Object.fromEntries(rows.map(r => [r.account_name, r.selected]));
    assert.strictEqual(byName['Page A'], false);
    assert.strictEqual(byName['Page B'], true);
    assert.strictEqual(byName['Page C'], false);
  });

  it('deselects all pages when page_ids is empty', async () => {
    await insertFbPage(userId, 'Page A', 'page-a', { selected: true });
    await insertFbPage(userId, 'Page B', 'page-b', { selected: true });

    const res = await selectFbPages(app, token, []);
    assert.strictEqual(res.status, 200);

    const { rows } = await getPool().query(
      `SELECT selected FROM connected_platforms WHERE user_id = $1 AND platform = 'facebook'`,
      [userId]
    );
    assert.ok(rows.every(r => r.selected === false), 'all pages should be deselected');
  });

  it('silently ignores page IDs that belong to another user', async () => {
    const { userId: userId2 } = await registerAndLogin(app, 'other@example.com');
    const otherId = await insertFbPage(userId2, 'Other Page', 'page-other', { selected: false });

    // Try to select another user's page — should silently fail (not select it)
    const res = await selectFbPages(app, token, [otherId]);
    assert.strictEqual(res.status, 200);

    const { rows } = await getPool().query(
      `SELECT selected FROM connected_platforms WHERE id = $1`,
      [otherId]
    );
    assert.strictEqual(rows[0].selected, false, 'should not select another user\'s page');
  });
});

describe('POST /facebook/publish', () => {
  let app, token, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ token, userId } = await registerAndLogin(app));
  });

  after(async () => closeDb());

  it('returns 401 without authentication', async () => {
    const res = await request(app)
      .post('/facebook/publish')
      .field('message', 'Hello')
      .field('job_id', '1');
    assert.strictEqual(res.status, 401);
  });

  it('returns 400 when message is missing', async () => {
    await insertFbPage(userId);
    const res = await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('job_id', '1');
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 when job_id is missing', async () => {
    await insertFbPage(userId);
    const res = await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Hello');
    assert.strictEqual(res.status, 400);
  });

  it('returns 422 no_pages_selected when no pages are selected', async () => {
    await insertFbPage(userId, 'My Page', 'page-123', { selected: false });
    const res = await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Hello')
      .field('job_id', 'job-no-pages');
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.error, 'no_pages_selected');
  });

  it('publishes a text-only post and records the result', async () => {
    await setupFreshTestDb();
    const mockFetch = makeGraphMock([
      { data: { id: 'page-123_post-456' } },
    ]);
    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    await insertFbPage(userId, 'My Page', 'page-123', { selected: true });

    const res = await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Great job done today!')
      .field('job_id', 'job-1');

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok, 'overall ok should be true');
    assert.strictEqual(res.body.results.length, 1);
    const result = res.body.results[0];
    assert.ok(result.ok, 'page result ok should be true');
    assert.ok(result.postId, 'should return postId');
    assert.ok(!result.duplicate, 'should not be a duplicate');

    const { rows: [rec] } = await getPool().query(
      `SELECT * FROM publishing_records WHERE user_id = $1 AND platform = 'facebook' AND status = 'published'`,
      [userId]
    );
    assert.ok(rec, 'should have a published record');
    assert.strictEqual(rec.platform_post_id, 'page-123_post-456');
  });

  it('prevents duplicate publishing for the same job_id and page', async () => {
    await setupFreshTestDb();

    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return { ok: true, json: async () => ({ id: 'page-123_post-999' }) };
    };
    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    await insertFbPage(userId, 'My Page', 'page-123', { selected: true });

    const first  = await request(app).post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'First post').field('job_id', 'job-dup');
    const second = await request(app).post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'First post').field('job_id', 'job-dup');

    assert.strictEqual(first.status, 200);
    assert.ok(!first.body.results[0].duplicate);

    assert.strictEqual(second.status, 200);
    assert.ok(second.body.results[0].duplicate, 'second attempt should be a duplicate');
    assert.strictEqual(callCount, 1, 'Graph API should be called only once');
  });

  it('uses separate idempotency keys for different pages on the same job', async () => {
    await setupFreshTestDb();

    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return { ok: true, json: async () => ({ id: `post-${callCount}` }) };
    };
    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    await insertFbPage(userId, 'Page A', 'page-aaa', { selected: true });
    await insertFbPage(userId, 'Page B', 'page-bbb', { selected: true });

    const res = await request(app).post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Multi-page job').field('job_id', 'job-multi');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.results.length, 2);
    assert.ok(res.body.results.every(r => r.ok));
    assert.strictEqual(callCount, 2, 'each page should be published independently');
  });

  it('publishes to multiple pages and returns per-page results', async () => {
    await setupFreshTestDb();

    const mockFetch = makeGraphMock([
      { data: { id: 'page-aaa_post-1' } },
      { data: { id: 'page-bbb_post-2' } },
    ]);
    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    await insertFbPage(userId, 'Alpha Page', 'page-aaa', { selected: true });
    await insertFbPage(userId, 'Beta Page',  'page-bbb', { selected: true });

    const res = await request(app).post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Two pages').field('job_id', 'job-two-pages');

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok, 'overall ok should be true when any page succeeds');
    assert.strictEqual(res.body.results.length, 2);
    assert.ok(res.body.results.every(r => r.ok), 'all results should be ok');
    const names = res.body.results.map(r => r.pageName).sort();
    assert.deepStrictEqual(names, ['Alpha Page', 'Beta Page']);
  });

  it('returns partial success when one page fails and one succeeds', async () => {
    await setupFreshTestDb();

    let callN = 0;
    const mockFetch = async () => {
      callN++;
      if (callN === 1) throw new Error('Network failure');
      return { ok: true, json: async () => ({ id: 'page-bbb_post-ok' }) };
    };
    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    await insertFbPage(userId, 'Alpha Page', 'page-aaa', { selected: true });
    await insertFbPage(userId, 'Beta Page',  'page-bbb', { selected: true });

    const res = await request(app).post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Partial').field('job_id', 'job-partial');

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok, 'overall ok should be true when at least one page succeeded');
    const byName = Object.fromEntries(res.body.results.map(r => [r.pageName, r]));
    assert.strictEqual(byName['Alpha Page'].ok, false, 'first page should have failed');
    assert.strictEqual(byName['Beta Page'].ok, true, 'second page should have succeeded');
  });

  it('publishes with multiple photos and uses the staged-media flow', async () => {
    await setupFreshTestDb();

    const stagingCalls = [];
    const mockFetch = async (url, _opts) => {
      if (url.includes('/photos')) {
        stagingCalls.push(url);
        return { ok: true, json: async () => ({ id: `staged-${stagingCalls.length}` }) };
      }
      return { ok: true, json: async () => ({ id: 'page-123_multi-post' }) };
    };

    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    await insertFbPage(userId, 'My Page', 'page-123', { selected: true });

    const fs_   = require('fs');
    const os_   = require('os');
    const path_ = require('path');
    const tmp1  = path_.join(os_.tmpdir(), `test_photo1_${Date.now()}.jpg`);
    const tmp2  = path_.join(os_.tmpdir(), `test_photo2_${Date.now()}.jpg`);
    fs_.writeFileSync(tmp1, Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0]));
    fs_.writeFileSync(tmp2, Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0]));

    try {
      const res = await request(app)
        .post('/facebook/publish')
        .set('Authorization', `Bearer ${token}`)
        .field('message', 'Before and after!')
        .field('job_id', 'multi-job-1')
        .attach('photo_0', tmp1)
        .attach('photo_1', tmp2);

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.ok);
      assert.ok(res.body.results[0].ok);
      assert.strictEqual(stagingCalls.length, 2, 'should stage two photos');
      assert.ok(!res.body.results[0].duplicate);
    } finally {
      fs_.unlinkSync(tmp1);
      fs_.unlinkSync(tmp2);
    }
  });

  it('returns a failed result (not 422) when the Graph API returns a Facebook error', async () => {
    await setupFreshTestDb();

    const mockFetch = makeGraphMock([
      { ok: false, status: 400, data: { error: { message: 'Invalid OAuth access token.', code: 190 } } },
    ]);
    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    await insertFbPage(userId, 'My Page', 'page-123', { selected: true });

    const res = await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Post text')
      .field('job_id', 'error-job-1');

    // Multi-page API always returns 200; failures appear as results items
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, false, 'overall ok should be false when all pages fail');
    assert.strictEqual(res.body.results[0].ok, false);
    assert.ok(res.body.results[0].fbError, 'fbError should be flagged in the result');

    const { rows: [rec] } = await getPool().query(
      `SELECT status, error_message FROM publishing_records
       WHERE user_id = $1 AND platform = 'facebook' AND status = 'failed'`,
      [userId]
    );
    assert.ok(rec, 'should have a failed record');
    assert.ok(rec.error_message.includes('Invalid OAuth'));
  });

  it('records a failed publish and allows retry', async () => {
    await setupFreshTestDb();

    let attempt = 0;
    const mockFetch = async () => {
      attempt++;
      if (attempt === 1) throw new Error('Network error');
      return { ok: true, json: async () => ({ id: 'page-123_retry-post' }) };
    };

    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));
    await insertFbPage(userId, 'My Page', 'page-123', { selected: true });

    const first = await request(app).post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Retry me').field('job_id', 'retry-job');
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.results[0].ok, false, 'first attempt should fail');

    const second = await request(app).post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Retry me').field('job_id', 'retry-job');
    assert.strictEqual(second.status, 200);
    assert.ok(second.body.results[0].ok, 'retry should succeed');
    assert.ok(!second.body.results[0].duplicate, 'retry should not be flagged as duplicate');
  });

  it('skips pages without CREATE_CONTENT or MANAGE task', async () => {
    await setupFreshTestDb();

    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: makeGraphMock([]) }) });
    ({ token, userId } = await registerAndLogin(app));
    await insertFbPage(userId, 'Restricted Page', 'page-restricted', { selected: true, tasks: ['ADVERTISE'] });

    const res = await request(app).post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Test').field('job_id', 'job-restricted');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, false);
    assert.ok(res.body.results[0].error.includes('CREATE_CONTENT'));
  });
});

describe('Token storage and encryption', () => {
  let app, token, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp();
    ({ token, userId } = await registerAndLogin(app));
  });

  after(async () => closeDb());

  it('stores page tokens encrypted and never exposes them in GET /facebook/pages', async () => {
    await insertFbPage(userId, 'Encrypted Page', 'page-enc');

    const res = await request(app)
      .get('/facebook/pages')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    const page = res.body.pages[0];
    assert.ok(!page.access_token_enc, 'encrypted token should not appear in response');
    assert.ok(!page.access_token,     'raw token should not appear in response');
  });

  it('stores page tokens encrypted and never exposes them in GET /platforms', async () => {
    await insertFbPage(userId, 'Platform Page', 'page-plat');

    const res = await request(app)
      .get('/platforms')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    const page = res.body.platforms[0];
    assert.ok(!page.access_token_enc, 'encrypted token should not appear in response');
    assert.ok(!page.access_token,     'raw token should not appear in response');
  });

  it('can decrypt a stored token at publish time', async () => {
    await setupFreshTestDb();

    const sentToken = [];
    const mockFetch = async (_url, opts) => {
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

    const known = 'super_secret_page_token_abc';
    const now   = Date.now();
    await getPool().query(
      `INSERT INTO connected_platforms
         (user_id, platform, account_name, account_id, access_token_enc, tasks_json,
          selected, connected_at, updated_at)
       VALUES ($1, 'facebook', 'Test Page', 'page-dec', $2, $3, true, $4, $5)`,
      [userId, encrypt(known), JSON.stringify(['CREATE_CONTENT']), now, now]
    );

    await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Token test')
      .field('job_id', 'decrypt-job-1');

    assert.ok(sentToken.some(t => t === known), 'decrypted token should be used in Graph API call');
  });
});

// ── Reconnect required ────────────────────────────────────────────────────────

describe('POST /facebook/publish — reconnect_required', () => {
  let app, token, userId;

  beforeEach(async () => {
    await setupFreshTestDb();
  });

  after(async () => closeDb());

  it('sets reconnect_required=true when Meta returns error code 190', async () => {
    const mockFetch = async (_url, opts) => {
      const body = opts?.body;
      if (body && typeof body.get === 'function' && body.get('access_token')) {
        return { ok: true, json: async () => ({ error: { message: 'Invalid OAuth access token.', code: 190, error_subcode: 460 } }) };
      }
      return { ok: true, json: async () => ({}) };
    };

    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));

    const now = Date.now();
    await getPool().query(
      `INSERT INTO connected_platforms
         (user_id, platform, account_name, account_id, access_token_enc, tasks_json,
          selected, connected_at, updated_at)
       VALUES ($1, 'facebook', 'Revoked Page', 'pg-190', $2, '["CREATE_CONTENT"]', true, $3, $4)`,
      [userId, encrypt('old_token'), now, now]
    );

    const res = await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Reconnect test')
      .field('job_id', 'reconnect-job-1');

    assert.strictEqual(res.status, 200);
    const result = res.body.results[0];
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reconnect_required, true);
    assert.strictEqual(result.fbCode, 190);
  });

  it('does not set reconnect_required for non-auth errors (code 368)', async () => {
    const mockFetch = async (_url, opts) => {
      const body = opts?.body;
      if (body && typeof body.get === 'function' && body.get('access_token')) {
        return { ok: true, json: async () => ({ error: { message: 'Rate limit exceeded.', code: 368 } }) };
      }
      return { ok: true, json: async () => ({}) };
    };

    const { createFacebookRouter } = require('../routes/facebook');
    app = createApp({ facebookRouter: createFacebookRouter({ graphFetch: mockFetch }) });
    ({ token, userId } = await registerAndLogin(app));

    const now = Date.now();
    await getPool().query(
      `INSERT INTO connected_platforms
         (user_id, platform, account_name, account_id, access_token_enc, tasks_json,
          selected, connected_at, updated_at)
       VALUES ($1, 'facebook', 'Rate Limited Page', 'pg-368', $2, '["CREATE_CONTENT"]', true, $3, $4)`,
      [userId, encrypt('ok_token'), now, now]
    );

    const res = await request(app)
      .post('/facebook/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('message', 'Rate limit test')
      .field('job_id', 'ratelimit-job-1');

    assert.strictEqual(res.status, 200);
    const result = res.body.results[0];
    assert.strictEqual(result.ok, false);
    assert.ok(!result.reconnect_required, 'should not be set for non-auth error');
  });
});
