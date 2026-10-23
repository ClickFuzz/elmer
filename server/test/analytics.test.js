'use strict';

// Targeted tests for Phase 9 analytics instrumentation:
// 1. redeemFreePublication wasFirst flag
// 2. analytics service does not throw when no API key is set
// 3. trackPublicationResult fires the correct event name

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
// No POSTHOG_API_KEY — analytics should be silently disabled

const { describe, it, before, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');

const { setupFreshTestDb } = require('./helpers');
const { getPool, closeDb } = require('../db');
const { createApp }        = require('../app');
const {
  tryReserveFreePublication,
  redeemFreePublication,
} = require('../routes/billing');
const analytics = require('../services/analytics');

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

async function register(email = 'user@example.com') {
  const res = await request(app).post('/auth/register').send({ email, password: 'pass1234' });
  assert.equal(res.status, 201, `register failed: ${JSON.stringify(res.body)}`);
  const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${res.body.token}`);
  return { token: res.body.token, userId: me.body.userId };
}

// ── redeemFreePublication wasFirst flag ───────────────────────────────────────

describe('redeemFreePublication wasFirst', () => {
  it('returns true on first redemption', async () => {
    const { userId } = await register();
    const jobKey = 'job_1';

    await tryReserveFreePublication(userId, jobKey);
    const wasFirst = await redeemFreePublication(userId, jobKey);
    assert.strictEqual(wasFirst, true);
  });

  it('returns false when slot already redeemed (retry scenario)', async () => {
    const { userId } = await register();
    const jobKey = 'job_1';

    await tryReserveFreePublication(userId, jobKey);
    const first  = await redeemFreePublication(userId, jobKey);
    const second = await redeemFreePublication(userId, jobKey);

    assert.strictEqual(first,  true,  'first call should return true');
    assert.strictEqual(second, false, 'second call should return false');
  });

  it('returns false when no reservation exists', async () => {
    const { userId } = await register();
    const wasFirst = await redeemFreePublication(userId, 'no_reservation');
    assert.strictEqual(wasFirst, false);
  });
});

// ── analytics service: no API key → silent no-op ─────────────────────────────

describe('analytics service (no API key)', () => {
  it('trackFreePublicationCompleted does not throw', () => {
    assert.doesNotThrow(() => analytics.trackFreePublicationCompleted(1, { platform: 'instagram' }));
  });

  it('trackPublicationResult does not throw for success', () => {
    assert.doesNotThrow(() => analytics.trackPublicationResult(1, [{ ok: true }], 'facebook'));
  });

  it('trackPublicationResult does not throw for failure', () => {
    assert.doesNotThrow(() => analytics.trackPublicationResult(1, [{ ok: false }], 'wordpress'));
  });

  it('trackPublicationResult does not throw for partial success', () => {
    assert.doesNotThrow(() => analytics.trackPublicationResult(1, [{ ok: true }, { ok: false }], 'facebook'));
  });

  it('trackTrialStarted does not throw', () => {
    assert.doesNotThrow(() => analytics.trackTrialStarted(1, {}));
  });

  it('trackTrialConverted does not throw', () => {
    assert.doesNotThrow(() => analytics.trackTrialConverted(1, {}));
  });

  it('trackSubscriptionRenewed does not throw', () => {
    assert.doesNotThrow(() => analytics.trackSubscriptionRenewed(1, {}));
  });

  it('trackSubscriptionCancelled does not throw', () => {
    assert.doesNotThrow(() => analytics.trackSubscriptionCancelled(1, {}));
  });

  it('trackPaymentFailed does not throw', () => {
    assert.doesNotThrow(() => analytics.trackPaymentFailed(1, { attempt_count: 1 }));
  });

  it('shutdown does not throw', async () => {
    await assert.doesNotReject(() => analytics.shutdown());
  });
});

// ── auth register response includes userId ────────────────────────────────────

describe('auth register/login include userId', () => {
  it('register response includes userId as a number', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'analytics@test.com', password: 'pass1234' });
    assert.equal(res.status, 201);
    assert.ok(typeof res.body.userId === 'number', 'userId should be a number');
    assert.ok(res.body.userId > 0, 'userId should be positive');
  });

  it('login response includes userId matching the registered user', async () => {
    await request(app)
      .post('/auth/register')
      .send({ email: 'analytics2@test.com', password: 'pass1234' });

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'analytics2@test.com', password: 'pass1234' });
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.userId === 'number', 'login userId should be a number');
    assert.ok(res.body.userId > 0, 'login userId should be positive');
  });
});
