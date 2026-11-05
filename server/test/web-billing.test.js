'use strict';

process.env.DISABLE_AUTH        = 'false';
process.env.DISABLE_RATE_LIMIT  = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
// STRIPE_SECRET_KEY intentionally absent — Stripe calls return 503, non-Stripe paths testable.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');

const { setupFreshTestDb } = require('./helpers');
const { closeDb }          = require('../db');
const { createApp }        = require('../app');

let app;

before(async () => {
  delete process.env.BILLING_PORTAL_URL;
  delete process.env.APP_URL;
  delete process.env.APP_SCHEME;
  await setupFreshTestDb();
  app = createApp();
});

after(async () => closeDb());

beforeEach(async () => {
  await setupFreshTestDb();
  app = createApp();
});

async function register(email = 'web-billing@example.com', password = 'password123') {
  const res = await request(app).post('/auth/register').send({ email, password });
  assert.strictEqual(res.status, 201, `register failed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

// ── checkout-return relay (mobile deep-link) ────────────────────────────────

describe('GET /billing/checkout-return', () => {
  it('redirects success status to mobile deep link', async () => {
    const res = await request(app)
      .get('/billing/checkout-return?status=success')
      .redirects(0);
    assert.strictEqual(res.status, 302);
    assert.ok(
      res.headers.location.includes('status=success'),
      `Expected status=success in redirect, got: ${res.headers.location}`
    );
    assert.ok(
      res.headers.location.startsWith('elmer://'),
      `Expected elmer:// scheme, got: ${res.headers.location}`
    );
  });

  it('redirects cancel status to mobile deep link', async () => {
    const res = await request(app)
      .get('/billing/checkout-return?status=cancel')
      .redirects(0);
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('status=cancel'));
  });

  it('redirects portal_return status to mobile deep link', async () => {
    const res = await request(app)
      .get('/billing/checkout-return?status=portal_return')
      .redirects(0);
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('status=portal_return'));
  });

  it('sanitizes an invalid status to "unknown"', async () => {
    const res = await request(app)
      .get('/billing/checkout-return?status=javascript%3Aalert(1)')
      .redirects(0);
    assert.strictEqual(res.status, 302);
    assert.ok(
      res.headers.location.includes('status=unknown'),
      `Expected status=unknown for injection attempt, got: ${res.headers.location}`
    );
  });

  it('sanitizes an arbitrary string status to "unknown"', async () => {
    const res = await request(app)
      .get('/billing/checkout-return?status=hacked')
      .redirects(0);
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('status=unknown'));
  });

  it('defaults to "unknown" when status param is absent', async () => {
    const res = await request(app)
      .get('/billing/checkout-return')
      .redirects(0);
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('status=unknown'));
  });

  it('uses APP_SCHEME env for the deep-link scheme', async () => {
    process.env.APP_SCHEME = 'elmer-staging';
    const stagingApp = createApp();
    const res = await request(stagingApp)
      .get('/billing/checkout-return?status=success')
      .redirects(0);
    assert.strictEqual(res.status, 302);
    assert.ok(
      res.headers.location.startsWith('elmer-staging://'),
      `Expected elmer-staging:// scheme, got: ${res.headers.location}`
    );
    delete process.env.APP_SCHEME;
  });

  it('requires no auth — public relay endpoint', async () => {
    // checkout-return is a redirect relay; unauthenticated browsers arrive here
    const res = await request(app)
      .get('/billing/checkout-return?status=success')
      .redirects(0);
    assert.strictEqual(res.status, 302);
  });
});

// ── POST /billing/checkout-session ─────────────────────────────────────────

describe('POST /billing/checkout-session', () => {
  it('returns 401 without a Bearer token', async () => {
    const res = await request(app).post('/billing/checkout-session').send({});
    assert.strictEqual(res.status, 401);
  });

  it('returns 503 with auth but no STRIPE_SECRET_KEY (mobile source default)', async () => {
    const token = await register('checkout-mobile@example.com');
    const res = await request(app)
      .post('/billing/checkout-session')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    assert.strictEqual(res.status, 503);
  });

  it('returns 503 with auth but no STRIPE_SECRET_KEY (source=mobile)', async () => {
    const token = await register('checkout-mobile2@example.com');
    const res = await request(app)
      .post('/billing/checkout-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'mobile' });
    assert.strictEqual(res.status, 503);
  });

  it('returns 503 with auth but no STRIPE_SECRET_KEY (source=web)', async () => {
    const token = await register('checkout-web@example.com');
    const res = await request(app)
      .post('/billing/checkout-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });
    assert.strictEqual(res.status, 503);
  });
});

// ── POST /billing/portal-session ───────────────────────────────────────────

describe('POST /billing/portal-session', () => {
  it('returns 401 without a Bearer token', async () => {
    const res = await request(app).post('/billing/portal-session').send({});
    assert.strictEqual(res.status, 401);
  });

  it('returns 503 with auth but no STRIPE_SECRET_KEY', async () => {
    const token = await register('portal-mobile@example.com');
    const res = await request(app)
      .post('/billing/portal-session')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    assert.strictEqual(res.status, 503);
  });

  it('returns 503 with auth but no STRIPE_SECRET_KEY (source=web)', async () => {
    const token = await register('portal-web@example.com');
    const res = await request(app)
      .post('/billing/portal-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });
    assert.strictEqual(res.status, 503);
  });
});

// ── GET /billing/subscription ───────────────────────────────────────────────

describe('GET /billing/subscription', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/billing/subscription');
    assert.strictEqual(res.status, 401);
  });

  it('returns subscription status for authenticated user with no subscription', async () => {
    const token = await register('sub-status@example.com');
    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.ok('hasAccess' in res.body);
  });
});
