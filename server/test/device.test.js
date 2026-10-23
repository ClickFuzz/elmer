'use strict';

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
// No APPLE_DEVICECHECK_* env vars set — real Apple API is never called.
// All Apple interactions are replaced with injected mock functions.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupFreshTestDb } = require('./helpers');
const { getPool, closeDb } = require('../db');
const {
  checkDeviceEligibility,
  updateDeviceBit0,
  queueDeviceUpdate,
  processQueuedDeviceUpdate,
  isDeviceCheckConfigured,
  _injectAppleApiForTesting,
  _clearAppleApiInjection,
} = require('../routes/device');

before(async () => {
  await setupFreshTestDb();
});

after(async () => closeDb());

beforeEach(async () => {
  await setupFreshTestDb();
  _clearAppleApiInjection();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedUser(email = 'user@example.com') {
  const now = Date.now();
  const { rows } = await getPool().query(
    `INSERT INTO users (email, password_hash, created_at, updated_at)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [email, 'hash', now]
  );
  return rows[0].id;
}

// ── isDeviceCheckConfigured ───────────────────────────────────────────────────

describe('isDeviceCheckConfigured', () => {
  it('returns false when no env vars set', () => {
    assert.strictEqual(isDeviceCheckConfigured(), false);
  });
});

// ── checkDeviceEligibility ────────────────────────────────────────────────────

describe('checkDeviceEligibility', () => {
  it('returns eligible when bit0 is false', async () => {
    _injectAppleApiForTesting(
      async () => ({ bit0: false, bit1: false }),
      async () => {}
    );
    const result = await checkDeviceEligibility('fake-token');
    assert.deepStrictEqual(result, { eligible: true });
  });

  it('returns ineligible when bit0 is true', async () => {
    _injectAppleApiForTesting(
      async () => ({ bit0: true, bit1: false }),
      async () => {}
    );
    const result = await checkDeviceEligibility('fake-token');
    assert.deepStrictEqual(result, { eligible: false, reason: 'device_redeemed' });
  });

  it('propagates INVALID_TOKEN error from query', async () => {
    const err = new Error('invalid token');
    err.code = 'INVALID_TOKEN';
    _injectAppleApiForTesting(async () => { throw err; }, async () => {});
    await assert.rejects(() => checkDeviceEligibility('bad-token'), /invalid token/);
  });

  it('propagates APPLE_API_ERROR from query', async () => {
    const err = new Error('Apple DeviceCheck query HTTP 500');
    err.code = 'APPLE_API_ERROR';
    _injectAppleApiForTesting(async () => { throw err; }, async () => {});
    await assert.rejects(() => checkDeviceEligibility('token'), /Apple DeviceCheck/);
  });
});

// ── updateDeviceBit0 ──────────────────────────────────────────────────────────

describe('updateDeviceBit0', () => {
  it('calls the update function with the token', async () => {
    let called = false;
    _injectAppleApiForTesting(async () => ({ bit0: false, bit1: false }), async (token) => {
      assert.strictEqual(token, 'my-token');
      called = true;
    });
    await updateDeviceBit0('my-token');
    assert.ok(called);
  });

  it('propagates errors from the update function', async () => {
    _injectAppleApiForTesting(async () => ({}), async () => {
      throw new Error('update failed');
    });
    await assert.rejects(() => updateDeviceBit0('token'), /update failed/);
  });
});

// ── queueDeviceUpdate ─────────────────────────────────────────────────────────

describe('queueDeviceUpdate', () => {
  it('inserts a queue entry', async () => {
    const userId = await seedUser('q1@example.com');
    await queueDeviceUpdate(userId, 'job-key-1');
    const { rows } = await getPool().query(
      'SELECT job_key, platform FROM device_update_queue WHERE user_id = $1',
      [userId]
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].job_key, 'job-key-1');
    assert.strictEqual(rows[0].platform, 'ios');
  });

  it('ignores duplicate (user_id, job_key)', async () => {
    const userId = await seedUser('q2@example.com');
    await queueDeviceUpdate(userId, 'dup-key');
    await queueDeviceUpdate(userId, 'dup-key');
    const { rows } = await getPool().query(
      'SELECT COUNT(*) AS cnt FROM device_update_queue WHERE user_id = $1',
      [userId]
    );
    assert.strictEqual(parseInt(rows[0].cnt, 10), 1);
  });

  it('allows different job_keys for the same user', async () => {
    const userId = await seedUser('q3@example.com');
    await queueDeviceUpdate(userId, 'key-a');
    await queueDeviceUpdate(userId, 'key-b');
    const { rows } = await getPool().query(
      'SELECT COUNT(*) AS cnt FROM device_update_queue WHERE user_id = $1',
      [userId]
    );
    assert.strictEqual(parseInt(rows[0].cnt, 10), 2);
  });
});

// ── processQueuedDeviceUpdate ─────────────────────────────────────────────────

describe('processQueuedDeviceUpdate', () => {
  it('does nothing when queue is empty', async () => {
    const userId = await seedUser('pq0@example.com');
    let updateCalled = false;
    _injectAppleApiForTesting(async () => ({}), async () => { updateCalled = true; });
    await processQueuedDeviceUpdate(userId, 'token');
    assert.strictEqual(updateCalled, false);
  });

  it('deletes entry on successful Apple update', async () => {
    const userId = await seedUser('pq1@example.com');
    await queueDeviceUpdate(userId, 'job-abc');
    _injectAppleApiForTesting(async () => ({}), async () => {});
    await processQueuedDeviceUpdate(userId, 'fresh-token');
    const { rows } = await getPool().query(
      'SELECT COUNT(*) AS cnt FROM device_update_queue WHERE user_id = $1',
      [userId]
    );
    assert.strictEqual(parseInt(rows[0].cnt, 10), 0);
  });

  it('increments attempt_count and keeps entry on Apple update failure', async () => {
    const userId = await seedUser('pq2@example.com');
    await queueDeviceUpdate(userId, 'job-fail');
    _injectAppleApiForTesting(async () => ({}), async () => { throw new Error('network error'); });
    await processQueuedDeviceUpdate(userId, 'token');
    const { rows } = await getPool().query(
      'SELECT attempt_count, last_error FROM device_update_queue WHERE user_id = $1',
      [userId]
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].attempt_count, 1);
    assert.ok(rows[0].last_error.includes('network error'));
  });

  it('processes the oldest entry first when multiple entries exist', async () => {
    const userId = await seedUser('pq3@example.com');
    // Insert two entries; the first created should be processed.
    const now = Date.now();
    await getPool().query(
      `INSERT INTO device_update_queue (user_id, job_key, platform, attempt_count, created_at, updated_at)
       VALUES ($1, 'first', 'ios', 0, $2, $2)`,
      [userId, now - 1000]
    );
    await getPool().query(
      `INSERT INTO device_update_queue (user_id, job_key, platform, attempt_count, created_at, updated_at)
       VALUES ($1, 'second', 'ios', 0, $2, $2)`,
      [userId, now]
    );

    _injectAppleApiForTesting(async () => ({}), async () => {});
    await processQueuedDeviceUpdate(userId, 'token');

    const { rows } = await getPool().query(
      'SELECT job_key FROM device_update_queue WHERE user_id = $1',
      [userId]
    );
    // Only 'second' should remain.
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].job_key, 'second');
  });

  it('does not process another user\'s queue entry', async () => {
    const u1 = await seedUser('pq4a@example.com');
    const u2 = await seedUser('pq4b@example.com');
    await queueDeviceUpdate(u1, 'u1-job');
    let updateCalled = false;
    _injectAppleApiForTesting(async () => ({}), async () => { updateCalled = true; });
    await processQueuedDeviceUpdate(u2, 'token');
    assert.strictEqual(updateCalled, false);
    const { rows } = await getPool().query(
      'SELECT COUNT(*) AS cnt FROM device_update_queue WHERE user_id = $1', [u1]
    );
    assert.strictEqual(parseInt(rows[0].cnt, 10), 1);
  });
});
