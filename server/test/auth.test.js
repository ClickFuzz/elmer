'use strict';

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const { describe, it, before, after, beforeEach } = require('node:test');
const assert   = require('node:assert/strict');
const request  = require('supertest');

const { setupFreshTestDb, seedActiveSubscription } = require('./helpers');
const { closeDb, getPool }  = require('../db');
const { createApp }         = require('../app');

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
  return request(app).post('/auth/register').send({ email, password });
}

async function login(email = 'user@example.com', password = 'password123') {
  return request(app).post('/auth/login').send({ email, password });
}

// ── Registration ─────────────────────────────────────────────────────────────

describe('POST /auth/register', () => {
  it('returns 201 and a token for valid credentials', async () => {
    const res = await register();
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.token, 'should return token');
    assert.ok(res.body.expiresAt > Date.now(), 'expiresAt should be in the future');
    assert.match(res.body.token, /^[0-9a-f]{64}$/);
  });

  it('returns 409 for a duplicate email', async () => {
    await register();
    const res = await register();
    assert.strictEqual(res.status, 409);
  });

  it('is case-insensitive for email — duplicate detected across cases', async () => {
    await register('User@Example.com');
    const res = await register('user@example.com');
    assert.strictEqual(res.status, 409);
  });

  it('returns 400 for an invalid email', async () => {
    const res = await register('not-an-email');
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 for a missing email', async () => {
    const res = await request(app).post('/auth/register').send({ password: 'password123' });
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 when password is fewer than 8 characters', async () => {
    const res = await register('user@example.com', 'short');
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 when password is missing', async () => {
    const res = await request(app).post('/auth/register').send({ email: 'user@example.com' });
    assert.strictEqual(res.status, 400);
  });
});

// ── Login ─────────────────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
  beforeEach(async () => { await register(); });

  it('returns 200 and a token for correct credentials', async () => {
    const res = await login();
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.token);
    assert.match(res.body.token, /^[0-9a-f]{64}$/);
  });

  it('returns 401 for a wrong password', async () => {
    const res = await login('user@example.com', 'wrongpassword');
    assert.strictEqual(res.status, 401);
  });

  it('returns 401 for an unknown email', async () => {
    const res = await login('nobody@example.com', 'password123');
    assert.strictEqual(res.status, 401);
  });

  it('returns 400 when body is missing', async () => {
    const res = await request(app).post('/auth/login').send({});
    assert.strictEqual(res.status, 400);
  });

  it('does not distinguish between wrong password and unknown email (same error)', async () => {
    const wrongPw = await login('user@example.com', 'wrongpassword');
    const noUser  = await login('nobody@example.com', 'password123');
    assert.strictEqual(wrongPw.body.error, noUser.body.error);
  });
});

// ── Session / GET /auth/me ─────────────────────────────────────────────────

describe('GET /auth/me', () => {
  it('returns user info for a valid token', async () => {
    await register();
    const { body: { token } } = await login();
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.email, 'user@example.com');
    assert.ok(res.body.userId);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/auth/me');
    assert.strictEqual(res.status, 401);
  });

  it('returns 401 for a malformed token', async () => {
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', 'Bearer notavalidtoken');
    assert.strictEqual(res.status, 401);
  });

  it('returns 401 for a fabricated token that does not exist in the DB', async () => {
    const fakeToken = 'a'.repeat(64);
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${fakeToken}`);
    assert.strictEqual(res.status, 401);
  });
});

// ── Logout ────────────────────────────────────────────────────────────────────

describe('POST /auth/logout', () => {
  it('invalidates the session token', async () => {
    await register();
    const { body: { token } } = await login();

    const logoutRes = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(logoutRes.status, 200);
    assert.ok(logoutRes.body.ok);

    const meRes = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(meRes.status, 401);
  });

  it('returns 401 when called without a token', async () => {
    const res = await request(app).post('/auth/logout');
    assert.strictEqual(res.status, 401);
  });
});

// ── DELETE /auth/account ──────────────────────────────────────────────────────

// Seeds a canceled Stripe subscription (status = 'canceled') for the given user.
async function seedCanceledStripeSubscription(userId) {
  const pool = getPool();
  const now  = Date.now();
  const customerId = `cus_canceled_${userId}`;
  await pool.query(
    `INSERT INTO stripe_customers (user_id, customer_id, created_at, updated_at)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (user_id) DO UPDATE SET customer_id = $2, updated_at = $3`,
    [userId, customerId, now]
  );
  await pool.query(
    `INSERT INTO subscriptions
       (user_id, provider, provider_subscription_id,
        stripe_subscription_id, stripe_customer_id, status,
        current_period_start, current_period_end, trial_start, trial_end,
        cancel_at_period_end, cancel_at, canceled_at, trial_used, created_at, updated_at)
     VALUES ($1, 'stripe', $2, $2, $3, 'canceled', $4, $5, null, null, false, null, $4, true, $4, $4)
     ON CONFLICT (user_id, provider, provider_subscription_id) DO UPDATE SET status = 'canceled', updated_at = $4`,
    [userId, `sub_canceled_${userId}`, customerId, now, now - 1000]
  );
}

// Seeds an active Apple subscription for the given user (simulates a RevenueCat Apple row).
async function seedActiveAppleSubscription(userId) {
  const pool = getPool();
  const now  = Date.now();
  await pool.query(
    `INSERT INTO subscriptions
       (user_id, provider, provider_subscription_id,
        stripe_subscription_id, stripe_customer_id, status,
        current_period_start, current_period_end, trial_start, trial_end,
        cancel_at_period_end, cancel_at, canceled_at, trial_used, created_at, updated_at)
     VALUES ($1, 'apple', $2, null, null, 'active', $3, $4, null, null, false, null, null, false, $3, $3)
     ON CONFLICT (user_id, provider, provider_subscription_id) DO UPDATE SET status = 'active', updated_at = $3`,
    [userId, `apple_sub_${userId}`, now, now + 30 * 24 * 60 * 60 * 1000]
  );
}

// Seeds an active Google subscription for the given user.
async function seedActiveGoogleSubscription(userId) {
  const pool = getPool();
  const now  = Date.now();
  await pool.query(
    `INSERT INTO subscriptions
       (user_id, provider, provider_subscription_id,
        stripe_subscription_id, stripe_customer_id, status,
        current_period_start, current_period_end, trial_start, trial_end,
        cancel_at_period_end, cancel_at, canceled_at, trial_used, created_at, updated_at)
     VALUES ($1, 'google', $2, null, null, 'active', $3, $4, null, null, false, null, null, false, $3, $3)
     ON CONFLICT (user_id, provider, provider_subscription_id) DO UPDATE SET status = 'active', updated_at = $3`,
    [userId, `google_sub_${userId}`, now, now + 30 * 24 * 60 * 60 * 1000]
  );
}

// Seeds a canceled Apple subscription (expired period end) for the given user.
async function seedCanceledAppleSubscription(userId) {
  const pool = getPool();
  const now  = Date.now();
  await pool.query(
    `INSERT INTO subscriptions
       (user_id, provider, provider_subscription_id,
        stripe_subscription_id, stripe_customer_id, status,
        current_period_start, current_period_end, trial_start, trial_end,
        cancel_at_period_end, cancel_at, canceled_at, trial_used, created_at, updated_at)
     VALUES ($1, 'apple', $2, null, null, 'canceled', $3, $4, null, null, false, null, $3, false, $3, $3)
     ON CONFLICT (user_id, provider, provider_subscription_id) DO UPDATE SET status = 'canceled', updated_at = $3`,
    [userId, `apple_canceled_${userId}`, now, now - 1000]
  );
}

describe('DELETE /auth/account', () => {
  it('deletes account when no subscription exists', async () => {
    await register();
    const { body: { token } } = await login();
    const res = await request(app).delete('/auth/account').set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
  });

  it('blocks deletion with 409 when user has an active Stripe subscription', async () => {
    await register();
    const { body: { token } } = await login();
    const { body: { userId } } = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    await seedActiveSubscription(userId);
    const res = await request(app).delete('/auth/account').set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'active_subscription');
  });

  it('allows deletion when the only subscription is canceled', async () => {
    await register();
    const { body: { token } } = await login();
    const { body: { userId } } = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    await seedCanceledStripeSubscription(userId);
    const res = await request(app).delete('/auth/account').set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
  });

  it('blocks deletion when canceled Stripe row exists alongside active Apple row', async () => {
    await register();
    const { body: { token } } = await login();
    const { body: { userId } } = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    await seedCanceledStripeSubscription(userId);
    await seedActiveAppleSubscription(userId);
    const res = await request(app).delete('/auth/account').set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'active_subscription');
  });

  it('blocks deletion when canceled Apple row exists alongside active Google row', async () => {
    await register();
    const { body: { token } } = await login();
    const { body: { userId } } = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    await seedCanceledAppleSubscription(userId);
    await seedActiveGoogleSubscription(userId);
    const res = await request(app).delete('/auth/account').set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'active_subscription');
  });

  it('allows deletion when multiple subscription rows all have inactive status', async () => {
    await register();
    const { body: { token } } = await login();
    const { body: { userId } } = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    await seedCanceledStripeSubscription(userId);
    await seedCanceledAppleSubscription(userId);
    const res = await request(app).delete('/auth/account').set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).delete('/auth/account');
    assert.strictEqual(res.status, 401);
  });
});

// ── Auth on /api/generate ─────────────────────────────────────────────────────

describe('/api/generate auth enforcement', () => {
  it('returns 401 without a token when DISABLE_AUTH=false', async () => {
    const res = await request(app).post('/api/generate').send({ photoCount: '0' });
    assert.strictEqual(res.status, 401);
  });

  it('returns mock content for an authenticated request (no OPENAI_API_KEY in test env)', async () => {
    await register();
    const { body: { token } } = await login();
    const { body: { userId } } = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    await seedActiveSubscription(userId);
    const res = await request(app)
      .post('/api/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ photoCount: '0' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mock, true);
  });
});
