'use strict';

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SERVER_URL                = 'https://api.getelmer.com';

const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const fs  = require('fs');
const os  = require('os');
const path = require('path');

const { setupFreshTestDb }  = require('./helpers');
const { getPool, closeDb }  = require('../db');
const { createApp }         = require('../app');
const { encrypt, decrypt }  = require('../crypto');
const { createWordPressRouter, markdownToHtml, normalizeWordPressUrl } = require('../routes/wordpress');

after(async () => { await closeDb(); });

// ── Helpers ────────────────────────────────────────────────────────────────

async function registerAndLogin(app, email = 'wp@example.com', password = 'password123') {
  await request(app).post('/auth/register').send({ email, password });
  const login = await request(app).post('/auth/login').send({ email, password });
  const me    = await request(app).get('/auth/me').set('Authorization', `Bearer ${login.body.token}`);
  return { token: login.body.token, userId: me.body.userId };
}

async function insertWpSite(userId, siteUrl = 'https://myblog.example.com', opts = {}) {
  const now = Date.now();
  const cred = encrypt(JSON.stringify({ userLogin: 'admin', password: 'xxxx xxxx xxxx xxxx xxxx xxxx' }));
  const { rows: [{ id }] } = await getPool().query(
    `INSERT INTO connected_platforms
       (user_id, platform, account_name, account_id, access_token_enc, selected, connected_at, updated_at)
     VALUES ($1, 'wordpress', $2, $3, $4, true, $5, $6) RETURNING id`,
    [userId, opts.siteName ?? 'My Blog', siteUrl, cred, now, now]
  );
  return id;
}

async function insertOAuthState(userId, opts = {}) {
  const state = opts.state ?? require('crypto').randomBytes(24).toString('hex');
  const now   = Date.now();
  const ttl   = opts.expired ? -1000 : 10 * 60 * 1000;
  await getPool().query(
    `INSERT INTO oauth_states (state, user_id, platform, created_at, expires_at)
     VALUES ($1, $2, 'wordpress', $3, $4)`,
    [state, userId, now, now + ttl]
  );
  return state;
}

function makeTempPhoto() {
  const tmp = path.join(os.tmpdir(), `wp_test_photo_${Date.now()}.jpg`);
  fs.writeFileSync(tmp, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]));
  return tmp;
}

// WP API mock factory: returns a function that matches URLs to handlers
function makeWpMock(handlers) {
  return async (url, opts) => {
    for (const { pattern, method, response } of handlers) {
      const methodMatch = !method || method.toLowerCase() === (opts?.method ?? 'get').toLowerCase();
      const urlMatch    = typeof pattern === 'string'
        ? url.includes(pattern)
        : pattern.test(url);
      if (urlMatch && methodMatch) {
        const r = typeof response === 'function' ? response(url, opts) : response;
        return {
          ok:     r.ok ?? true,
          status: r.status ?? 200,
          json:   async () => r.data,
          text:   async () => JSON.stringify(r.data),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'Not found' }), text: async () => '{}' };
  };
}

const WP_SITE_INFO = {
  name: 'My Test Blog',
  authentication: { 'application-passwords': { endpoints: { authorization: 'https://myblog.example.com/wp-admin/authorize-application.php' } } },
};

const WP_USER_ME = {
  id: 1,
  name: 'Admin',
  capabilities: { publish_posts: true, edit_posts: true },
};

// ── Unit tests: markdownToHtml ─────────────────────────────────────────────

describe('markdownToHtml', () => {
  it('converts h2 headings', () => {
    const html = markdownToHtml('## My Heading');
    assert.equal(html, '<h2>My Heading</h2>');
  });

  it('converts h3 headings', () => {
    const html = markdownToHtml('### Sub');
    assert.equal(html, '<h3>Sub</h3>');
  });

  it('wraps plain text in p tags', () => {
    const html = markdownToHtml('Just a paragraph.');
    assert.equal(html, '<p>Just a paragraph.</p>');
  });

  it('handles multiple blocks separated by blank lines', () => {
    const html = markdownToHtml('## Title\n\nParagraph one.\n\nParagraph two.');
    assert.ok(html.includes('<h2>Title</h2>'));
    assert.ok(html.includes('<p>Paragraph one.</p>'));
    assert.ok(html.includes('<p>Paragraph two.</p>'));
  });

  it('escapes HTML entities', () => {
    const html = markdownToHtml('A & B < C > D');
    assert.ok(html.includes('A &amp; B &lt; C &gt; D'));
  });

  it('converts bold inline markdown', () => {
    const html = markdownToHtml('This is **bold** text.');
    assert.ok(html.includes('<strong>bold</strong>'));
  });

  it('returns empty string for empty input', () => {
    assert.equal(markdownToHtml(''), '');
    assert.equal(markdownToHtml(null), '');
  });
});

// ── Unit tests: normalizeWordPressUrl ──────────────────────────────────────

describe('normalizeWordPressUrl', () => {
  it('accepts valid HTTPS URL', () => {
    const r = normalizeWordPressUrl('https://myblog.example.com');
    assert.equal(r.url, 'https://myblog.example.com');
  });

  it('adds https:// if missing', () => {
    const r = normalizeWordPressUrl('myblog.example.com');
    assert.equal(r.url, 'https://myblog.example.com');
  });

  it('strips trailing slash', () => {
    const r = normalizeWordPressUrl('https://myblog.example.com/');
    assert.equal(r.url, 'https://myblog.example.com');
  });

  it('strips path — uses origin only', () => {
    const r = normalizeWordPressUrl('https://myblog.example.com/some/path');
    assert.equal(r.url, 'https://myblog.example.com');
  });

  it('rejects http:// URLs', () => {
    const r = normalizeWordPressUrl('http://myblog.example.com');
    assert.ok(r.error);
    assert.match(r.error, /HTTPS/i);
  });

  it('rejects localhost', () => {
    const r = normalizeWordPressUrl('https://localhost:8080');
    assert.ok(r.error);
  });

  it('rejects 127.x.x.x', () => {
    const r = normalizeWordPressUrl('https://127.0.0.1');
    assert.ok(r.error);
  });

  it('rejects 192.168.x.x', () => {
    const r = normalizeWordPressUrl('https://192.168.1.100');
    assert.ok(r.error);
  });

  it('rejects 10.x.x.x', () => {
    const r = normalizeWordPressUrl('https://10.0.0.1');
    assert.ok(r.error);
  });

  it('rejects garbage input', () => {
    const r = normalizeWordPressUrl('not a url !!!');
    assert.ok(r.error);
  });
});

// ── POST /wordpress/connect-url ────────────────────────────────────────────

describe('POST /wordpress/connect-url', () => {
  let app;
  beforeEach(async () => {
    await setupFreshTestDb();
    const wpFetch = makeWpMock([
      { pattern: '/wp-json/', response: { data: WP_SITE_INFO } },
    ]);
    app = createApp({ wordpressRouter: createWordPressRouter({ wpFetch }) });
  });

  it('requires auth', async () => {
    const res = await request(app).post('/wordpress/connect-url').send({ siteUrl: 'https://myblog.example.com' });
    assert.equal(res.status, 401);
  });

  it('rejects missing siteUrl', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app).post('/wordpress/connect-url')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('rejects non-HTTPS URL', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app).post('/wordpress/connect-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ siteUrl: 'http://myblog.example.com' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /HTTPS/i);
  });

  it('rejects private IP', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app).post('/wordpress/connect-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ siteUrl: 'https://192.168.1.1' });
    assert.equal(res.status, 400);
  });

  it('returns 422 when WP REST API unavailable', async () => {
    const badFetch = makeWpMock([
      { pattern: '/wp-json/', response: { ok: false, status: 404, data: {} } },
    ]);
    const localApp = createApp({ wordpressRouter: createWordPressRouter({ wpFetch: badFetch }) });
    const { token } = await registerAndLogin(localApp);
    const res = await request(localApp).post('/wordpress/connect-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ siteUrl: 'https://myblog.example.com' });
    assert.equal(res.status, 422);
    assert.ok(res.body.error);
  });

  it('returns 422 when Application Passwords not supported', async () => {
    const noAppPassFetch = makeWpMock([
      { pattern: '/wp-json/', response: { data: { name: 'Site', authentication: {} } } },
    ]);
    const localApp = createApp({ wordpressRouter: createWordPressRouter({ wpFetch: noAppPassFetch }) });
    const { token } = await registerAndLogin(localApp);
    const res = await request(localApp).post('/wordpress/connect-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ siteUrl: 'https://myblog.example.com' });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /Application Password/i);
  });

  it('returns authUrl for a valid WordPress site', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app).post('/wordpress/connect-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ siteUrl: 'https://myblog.example.com' });
    assert.equal(res.status, 200);
    assert.ok(res.body.authUrl);
    assert.match(res.body.authUrl, /authorize-application\.php/);
    assert.match(res.body.authUrl, /app_name=Elmer/);
    assert.match(res.body.authUrl, /success_url=/);
    // state is URL-encoded inside success_url, so check for its encoded form
    assert.match(res.body.authUrl, /state(?:=|%3D)/i);
  });

  it('creates an oauth_states row', async () => {
    const { token } = await registerAndLogin(app);
    await request(app).post('/wordpress/connect-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ siteUrl: 'https://myblog.example.com' });
    const { rows } = await getPool().query(`SELECT * FROM oauth_states WHERE platform = 'wordpress'`);
    assert.equal(rows.length, 1);
  });
});

// ── GET /wordpress/callback ────────────────────────────────────────────────

describe('GET /wordpress/callback', () => {
  let app;
  beforeEach(async () => {
    await setupFreshTestDb();
    const wpFetch = makeWpMock([
      { pattern: '/wp-json/wp/v2/users/me', response: { data: WP_USER_ME } },
      { pattern: '/wp-json/', response: { data: WP_SITE_INFO } },
    ]);
    app = createApp({ wordpressRouter: createWordPressRouter({ wpFetch }) });
  });

  it('redirects with error when WordPress sends error=rejected', async () => {
    const { userId } = await registerAndLogin(app);
    const state = await insertOAuthState(userId);
    const res = await request(app)
      .get(`/wordpress/callback?state=${state}&error=rejected`)
      .redirects(0);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=rejected/);
    assert.match(res.headers.location, /platform=wordpress/);
  });

  it('redirects with error for missing params', async () => {
    const res = await request(app)
      .get('/wordpress/callback?state=abc')
      .redirects(0);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=missing_params/);
  });

  it('redirects with error for invalid state', async () => {
    const res = await request(app)
      .get('/wordpress/callback?state=invalid&site_url=https%3A%2F%2Fmyblog.example.com&user_login=admin&password=abc123')
      .redirects(0);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=invalid_state/);
  });

  it('redirects with error for expired state', async () => {
    const { userId } = await registerAndLogin(app);
    const state = await insertOAuthState(userId, { expired: true });
    const res = await request(app)
      .get(`/wordpress/callback?state=${state}&site_url=https%3A%2F%2Fmyblog.example.com&user_login=admin&password=abc123`)
      .redirects(0);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=state_expired/);
  });

  it('redirects with error when SSRF site_url is private', async () => {
    const { userId } = await registerAndLogin(app);
    const state = await insertOAuthState(userId);
    const res = await request(app)
      .get(`/wordpress/callback?state=${state}&site_url=https%3A%2F%2F192.168.1.1&user_login=admin&password=abc123`)
      .redirects(0);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=invalid_site/);
  });

  it('redirects with error when credentials fail verification', async () => {
    const badFetch = makeWpMock([
      { pattern: '/wp-json/wp/v2/users/me', response: { ok: false, status: 401, data: { code: 'invalid_credentials' } } },
    ]);
    const localApp = createApp({ wordpressRouter: createWordPressRouter({ wpFetch: badFetch }) });
    const { userId } = await registerAndLogin(localApp);
    const state = await insertOAuthState(userId);
    const res = await request(localApp)
      .get(`/wordpress/callback?state=${state}&site_url=https%3A%2F%2Fmyblog.example.com&user_login=admin&password=abc123`)
      .redirects(0);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=auth_failed/);
  });

  it('stores credentials and redirects with success=true on valid callback', async () => {
    const { userId } = await registerAndLogin(app);
    const state = await insertOAuthState(userId);
    const res = await request(app)
      .get(`/wordpress/callback?state=${state}&site_url=https%3A%2F%2Fmyblog.example.com&user_login=admin&password=xxxx+xxxx+xxxx+xxxx+xxxx+xxxx`)
      .redirects(0);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /success=true/);
    assert.match(res.headers.location, /platform=wordpress/);

    const { rows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE user_id = $1 AND platform = 'wordpress'`,
      [userId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].account_id, 'https://myblog.example.com');
    // Encrypted credential must decrypt correctly
    const creds = JSON.parse(decrypt(rows[0].access_token_enc));
    assert.equal(creds.userLogin, 'admin');
    assert.ok(creds.password);
  });

  it('prevents state replay — second use redirects with state_already_used', async () => {
    const { userId } = await registerAndLogin(app);
    const state = await insertOAuthState(userId);
    const params = `?state=${state}&site_url=https%3A%2F%2Fmyblog.example.com&user_login=admin&password=abc`;
    await request(app).get(`/wordpress/callback${params}`).redirects(0);
    const res2 = await request(app).get(`/wordpress/callback${params}`).redirects(0);
    assert.equal(res2.status, 302);
    assert.match(res2.headers.location, /error=state_already_used/);
  });

  it('upserts on reconnect — updates token without creating duplicate', async () => {
    const { userId } = await registerAndLogin(app);

    // First connect
    let state = await insertOAuthState(userId);
    await request(app)
      .get(`/wordpress/callback?state=${state}&site_url=https%3A%2F%2Fmyblog.example.com&user_login=admin&password=first_pass`)
      .redirects(0);

    // Reconnect
    state = await insertOAuthState(userId);
    await request(app)
      .get(`/wordpress/callback?state=${state}&site_url=https%3A%2F%2Fmyblog.example.com&user_login=admin&password=new_pass`)
      .redirects(0);

    const { rows } = await getPool().query(
      `SELECT * FROM connected_platforms WHERE user_id = $1 AND platform = 'wordpress'`,
      [userId]
    );
    assert.equal(rows.length, 1);
    const creds = JSON.parse(decrypt(rows[0].access_token_enc));
    assert.equal(creds.password, 'new_pass');
  });
});

// ── GET /wordpress/sites ───────────────────────────────────────────────────

describe('GET /wordpress/sites', () => {
  let app;
  beforeEach(async () => {
    await setupFreshTestDb();
    app = createApp({ wordpressRouter: createWordPressRouter() });
  });

  it('requires auth', async () => {
    const res = await request(app).get('/wordpress/sites');
    assert.equal(res.status, 401);
  });

  it('returns empty array when no sites connected', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app).get('/wordpress/sites').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.sites, []);
  });

  it('returns connected sites', async () => {
    const { token, userId } = await registerAndLogin(app);
    await insertWpSite(userId, 'https://myblog.example.com', { siteName: 'My Blog' });
    const res = await request(app).get('/wordpress/sites').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.sites.length, 1);
    assert.equal(res.body.sites[0].account_name, 'My Blog');
    assert.equal(res.body.sites[0].account_id, 'https://myblog.example.com');
  });

  it('isolates sites by user', async () => {
    const { token: tokenA, userId: uidA } = await registerAndLogin(app, 'a@ex.com');
    const { token: tokenB, userId: uidB } = await registerAndLogin(app, 'b@ex.com');
    await insertWpSite(uidA, 'https://site-a.example.com');
    await insertWpSite(uidB, 'https://site-b.example.com');

    const resA = await request(app).get('/wordpress/sites').set('Authorization', `Bearer ${tokenA}`);
    assert.equal(resA.body.sites.length, 1);
    assert.equal(resA.body.sites[0].account_id, 'https://site-a.example.com');

    const resB = await request(app).get('/wordpress/sites').set('Authorization', `Bearer ${tokenB}`);
    assert.equal(resB.body.sites.length, 1);
    assert.equal(resB.body.sites[0].account_id, 'https://site-b.example.com');
  });
});

// ── DELETE /wordpress/sites/:id ───────────────────────────────────────────

describe('DELETE /wordpress/sites/:id', () => {
  let app;
  beforeEach(async () => {
    await setupFreshTestDb();
    const wpFetch = makeWpMock([
      { pattern: '/wp-json/wp/v2/users/me/application-passwords', response: { data: [{ name: 'Elmer', uuid: 'test-uuid' }] } },
      { pattern: 'test-uuid', method: 'delete', response: { data: {} } },
    ]);
    app = createApp({ wordpressRouter: createWordPressRouter({ wpFetch }) });
  });

  it('requires auth', async () => {
    const res = await request(app).delete('/wordpress/sites/1');
    assert.equal(res.status, 401);
  });

  it('returns 400 for non-integer id', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app).delete('/wordpress/sites/abc').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 400);
  });

  it('returns 404 for unknown site', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app).delete('/wordpress/sites/99999').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 404);
  });

  it('prevents cross-user deletion', async () => {
    const { userId: uidA } = await registerAndLogin(app, 'a@ex.com');
    const { token: tokenB } = await registerAndLogin(app, 'b@ex.com');
    const siteId = await insertWpSite(uidA, 'https://site-a.example.com');
    const res = await request(app).delete(`/wordpress/sites/${siteId}`).set('Authorization', `Bearer ${tokenB}`);
    assert.equal(res.status, 404);
  });

  it('deletes site and returns ok', async () => {
    const { token, userId } = await registerAndLogin(app);
    const siteId = await insertWpSite(userId);
    const res = await request(app).delete(`/wordpress/sites/${siteId}`).set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const { rows } = await getPool().query(
      `SELECT id FROM connected_platforms WHERE id = $1`, [siteId]
    );
    assert.equal(rows.length, 0);
  });
});

// ── POST /wordpress/publish ────────────────────────────────────────────────

describe('POST /wordpress/publish', () => {
  let app;
  let wpFetch;

  beforeEach(async () => {
    await setupFreshTestDb();
    wpFetch = makeWpMock([
      { pattern: '/wp-json/wp/v2/media', method: 'post', response: { data: { id: 42, source_url: 'https://myblog.example.com/wp-content/uploads/photo.jpg' } } },
      { pattern: '/wp-json/wp/v2/posts', method: 'post', response: { data: { id: 99, link: 'https://myblog.example.com/my-post/' } } },
    ]);
    app = createApp({ wordpressRouter: createWordPressRouter({ wpFetch }) });
  });

  it('requires auth', async () => {
    const res = await request(app).post('/wordpress/publish').send({ title: 'T', content: 'C', job_id: '1', wp_site_id: '1' });
    assert.equal(res.status, 401);
  });

  it('rejects missing title', async () => {
    const { token, userId } = await registerAndLogin(app);
    const siteId = await insertWpSite(userId);
    const res = await request(app).post('/wordpress/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('content', 'Content')
      .field('job_id', 'j1')
      .field('wp_site_id', String(siteId));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /title/i);
  });

  it('rejects missing wp_site_id', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app).post('/wordpress/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'T')
      .field('content', 'C')
      .field('job_id', 'j1');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /wp_site_id/i);
  });

  it('returns 422 when site not connected', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app).post('/wordpress/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'T')
      .field('content', 'C')
      .field('job_id', 'j1')
      .field('wp_site_id', '99999');
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'no_wordpress_site');
  });

  it('prevents cross-user publish', async () => {
    const { userId: uidA } = await registerAndLogin(app, 'a@ex.com');
    const { token: tokenB } = await registerAndLogin(app, 'b@ex.com');
    const siteId = await insertWpSite(uidA);
    const res = await request(app).post('/wordpress/publish')
      .set('Authorization', `Bearer ${tokenB}`)
      .field('title', 'T')
      .field('content', 'C')
      .field('job_id', 'j1')
      .field('wp_site_id', String(siteId));
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'no_wordpress_site');
  });

  it('publishes successfully without photos', async () => {
    const { token, userId } = await registerAndLogin(app);
    const siteId = await insertWpSite(userId);

    const res = await request(app).post('/wordpress/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'My Article')
      .field('content', '## Intro\n\nThis is a test article.')
      .field('job_id', 'j1')
      .field('wp_site_id', String(siteId));

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.postId, '99');
    assert.equal(res.body.postUrl, 'https://myblog.example.com/my-post/');

    const { rows } = await getPool().query(
      `SELECT status FROM publishing_records WHERE job_ref = $1 AND platform = 'wordpress'`,
      [`wp_${userId}_j1_${siteId}`]
    );
    assert.equal(rows[0].status, 'published');
  });

  it('publishes with photos', async () => {
    const { token, userId } = await registerAndLogin(app);
    const siteId = await insertWpSite(userId);
    const photoPath = makeTempPhoto();

    const res = await request(app).post('/wordpress/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'Photo Post')
      .field('content', '## Section\n\nText here.')
      .field('job_id', 'j2')
      .field('wp_site_id', String(siteId))
      .field('featured_index', '0')
      .field('classifications', '["General"]')
      .attach('photo_0', photoPath);

    fs.unlinkSync(photoPath);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('is idempotent — second call returns duplicate:true', async () => {
    const { token, userId } = await registerAndLogin(app);
    const siteId = await insertWpSite(userId);

    const params = { title: 'T', content: 'C', job_id: 'idem1', wp_site_id: String(siteId) };

    const res1 = await request(app).post('/wordpress/publish')
      .set('Authorization', `Bearer ${token}`)
      .field(params);
    assert.equal(res1.body.ok, true);
    assert.equal(res1.body.duplicate, undefined);

    const res2 = await request(app).post('/wordpress/publish')
      .set('Authorization', `Bearer ${token}`)
      .field(params);
    assert.equal(res2.body.ok, true);
    assert.equal(res2.body.duplicate, true);

    // Only one publishing_records row
    const { rows } = await getPool().query(
      `SELECT id FROM publishing_records WHERE platform = 'wordpress' AND job_ref = $1`,
      [`wp_${userId}_idem1_${siteId}`]
    );
    assert.equal(rows.length, 1);
  });

  it('records failure and returns ok:false on WP API error', async () => {
    const failFetch = makeWpMock([
      { pattern: '/wp-json/wp/v2/posts', method: 'post', response: { ok: false, status: 403, data: { message: 'Forbidden' } } },
    ]);
    const failApp = createApp({ wordpressRouter: createWordPressRouter({ wpFetch: failFetch }) });
    const { token, userId } = await registerAndLogin(failApp);
    const siteId = await insertWpSite(userId);

    const res = await request(failApp).post('/wordpress/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'T')
      .field('content', 'C')
      .field('job_id', 'fail1')
      .field('wp_site_id', String(siteId));

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.error);

    const { rows } = await getPool().query(
      `SELECT status FROM publishing_records WHERE job_ref = $1 AND platform = 'wordpress'`,
      [`wp_${userId}_fail1_${siteId}`]
    );
    assert.equal(rows[0].status, 'failed');
  });

  it('uses seo_slug and seo_excerpt when provided', async () => {
    let capturedBody;
    const captureFetch = makeWpMock([
      {
        pattern: '/wp-json/wp/v2/posts',
        method: 'post',
        response: (url, opts) => {
          capturedBody = JSON.parse(opts.body);
          return { data: { id: 100, link: 'https://myblog.example.com/test-slug/' } };
        },
      },
    ]);
    const captureApp = createApp({ wordpressRouter: createWordPressRouter({ wpFetch: captureFetch }) });
    const { token, userId } = await registerAndLogin(captureApp);
    const siteId = await insertWpSite(userId);

    await request(captureApp).post('/wordpress/publish')
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'T')
      .field('content', 'C')
      .field('job_id', 'seo1')
      .field('wp_site_id', String(siteId))
      .field('seo_slug', 'test-slug')
      .field('seo_excerpt', 'SEO description here');

    assert.equal(capturedBody.slug, 'test-slug');
    assert.equal(capturedBody.excerpt, 'SEO description here');
  });
});
