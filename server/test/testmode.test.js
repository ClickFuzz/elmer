'use strict';

// Tests for STRIPE_TEST_MODE behavior:
//   - When STRIPE_TEST_MODE=true, DeviceCheck enforcement is bypassed so
//     developers can repeatedly create test accounts and test the free-post
//     flow on one physical iPhone without modifying production DeviceCheck bits.
//   - When STRIPE_TEST_MODE=false (production), DeviceCheck is enforced normally.

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const { describe, it, before, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');

const { setupFreshTestDb } = require('./helpers');
const { getPool, closeDb }  = require('../db');
const { createApp }         = require('../app');
const {
  _injectAppleApiForTesting,
  _clearAppleApiInjection,
} = require('../routes/device');
const { redeemFreePublication } = require('../routes/billing');

let app;

before(async () => {
  await setupFreshTestDb();
  app = createApp();
});

after(async () => {
  _clearAppleApiInjection();
  delete process.env.STRIPE_TEST_MODE;
  await closeDb();
});

beforeEach(async () => {
  await setupFreshTestDb();
  app = createApp();
  _clearAppleApiInjection();
  delete process.env.STRIPE_TEST_MODE;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function register(email = 'user@example.com', password = 'pass1234') {
  const res = await request(app).post('/auth/register').send({ email, password });
  assert.equal(res.status, 201, `register failed: ${JSON.stringify(res.body)}`);
  const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${res.body.token}`);
  return { token: res.body.token, userId: me.body.userId };
}

// ── STRIPE_TEST_MODE=true — DeviceCheck bypass ────────────────────────────────

describe('STRIPE_TEST_MODE=true', () => {
  it('requireGenerationAccess allows a free user even when Apple API marks device redeemed', async () => {
    process.env.STRIPE_TEST_MODE = 'true';

    // Inject Apple API that reports bit0=true (device previously redeemed)
    _injectAppleApiForTesting(
      async () => ({ bit0: true, bit1: false }),
      async () => {}
    );
    // Also inject DeviceCheck keys so isDeviceCheckConfigured() returns true
    process.env.APPLE_DEVICECHECK_KEY_ID      = 'TESTKEY';
    process.env.APPLE_DEVICECHECK_TEAM_ID     = 'TESTTEAM';
    process.env.APPLE_DEVICECHECK_PRIVATE_KEY = '--- fake ---';

    const { token } = await register();

    // In test mode the device token header is ignored and the request must proceed
    // (generation endpoint returns 503 because OPENAI_API_KEY is not set,
    //  NOT 402 SUBSCRIPTION_REQUIRED or DEVICE_REDEEMED).
    const res = await request(app)
      .post('/api/generate')
      .set('Authorization', `Bearer ${token}`)
      .set('X-DeviceCheck-Token', 'fake-device-token')
      .send({ photoCount: 0, platforms: ['social'] });

    assert.notEqual(res.status, 402, 'should not be blocked by DeviceCheck in test mode');

    delete process.env.APPLE_DEVICECHECK_KEY_ID;
    delete process.env.APPLE_DEVICECHECK_TEAM_ID;
    delete process.env.APPLE_DEVICECHECK_PRIVATE_KEY;
  });

  it('multiple test accounts on the same device can each get a free publication', async () => {
    process.env.STRIPE_TEST_MODE = 'true';

    const { userId: userAId } = await register('accounta@example.com');
    const { userId: userBId } = await register('accountb@example.com');

    // Redeem for account A with a device token
    await redeemFreePublication(userAId, 'job_a', 'fake-device-token');

    // Account B should still have free_available status (test mode did not set bit0)
    const { rows } = await getPool().query(
      'SELECT status FROM free_publications WHERE user_id = $1',
      [userBId]
    );
    assert.equal(rows[0].status, 'available', 'account B should still be available');
  });

  it('redeemFreePublication in test mode does not call Apple API (no queued update)', async () => {
    process.env.STRIPE_TEST_MODE = 'true';

    let updateCallCount = 0;
    _injectAppleApiForTesting(
      async () => ({ bit0: false, bit1: false }),
      async () => { updateCallCount++; }
    );

    const { userId } = await register();
    await redeemFreePublication(userId, 'job_test', 'some-device-token');

    // Give the async fire-and-forget a moment to complete if it were going to run
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(updateCallCount, 0, 'Apple update API must not be called in test mode');
  });

  it('still enforces per-account one-free-post limit in test mode', async () => {
    process.env.STRIPE_TEST_MODE = 'true';
    const { userId } = await register();

    // Reserve + redeem for the user's free slot
    const pool = getPool();
    const now  = Date.now();
    await pool.query(
      `UPDATE free_publications SET status='reserved', job_key='job_1', reserved_at=$2, updated_at=$2
       WHERE user_id=$1`,
      [userId, now]
    );
    await redeemFreePublication(userId, 'job_1', 'fake-token');

    const { rows } = await getPool().query(
      'SELECT status FROM free_publications WHERE user_id=$1',
      [userId]
    );
    assert.equal(rows[0].status, 'redeemed', 'free slot should be redeemed after use');
  });
});

// ── STRIPE_TEST_MODE=false (or unset) — production enforcement ────────────────

describe('STRIPE_TEST_MODE=false', () => {
  it('requireGenerationAccess blocks a free user when Apple API marks device redeemed', async () => {
    delete process.env.STRIPE_TEST_MODE; // unset = production mode

    // Inject Apple API that reports bit0=true
    _injectAppleApiForTesting(
      async () => ({ bit0: true, bit1: false }),
      async () => {}
    );
    process.env.APPLE_DEVICECHECK_KEY_ID      = 'TESTKEY';
    process.env.APPLE_DEVICECHECK_TEAM_ID     = 'TESTTEAM';
    process.env.APPLE_DEVICECHECK_PRIVATE_KEY = '--- fake ---';

    const { token } = await register();

    const res = await request(app)
      .post('/api/generate')
      .set('Authorization', `Bearer ${token}`)
      .set('X-DeviceCheck-Token', 'fake-device-token')
      .send({ photoCount: 0, platforms: ['social'] });

    assert.equal(res.status, 402, 'should be blocked when device bit0=true in production');
    assert.equal(res.body.detail, 'DEVICE_REDEEMED');

    delete process.env.APPLE_DEVICECHECK_KEY_ID;
    delete process.env.APPLE_DEVICECHECK_TEAM_ID;
    delete process.env.APPLE_DEVICECHECK_PRIVATE_KEY;
  });

  it('redeemFreePublication in production mode calls Apple update API', async () => {
    delete process.env.STRIPE_TEST_MODE;

    let updateCallCount = 0;
    _injectAppleApiForTesting(
      async () => ({ bit0: false, bit1: false }),
      async () => { updateCallCount++; }
    );
    process.env.APPLE_DEVICECHECK_KEY_ID      = 'TESTKEY';
    process.env.APPLE_DEVICECHECK_TEAM_ID     = 'TESTTEAM';
    process.env.APPLE_DEVICECHECK_PRIVATE_KEY = '--- fake ---';

    const { userId } = await register();
    await redeemFreePublication(userId, 'job_prod', 'real-device-token');

    // Fire-and-forget — give it time
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(updateCallCount, 1, 'Apple update API must be called in production mode');

    delete process.env.APPLE_DEVICECHECK_KEY_ID;
    delete process.env.APPLE_DEVICECHECK_TEAM_ID;
    delete process.env.APPLE_DEVICECHECK_PRIVATE_KEY;
  });
});
