'use strict';

// Tests for free-publication eligibility, reservation, redemption, and the
// getEntitlement / tryReserveFreePublication / redeemFreePublication /
// releaseFreePublicationIfNoSuccess functions in billing.js.

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const { describe, it, before, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');

const { setupFreshTestDb, seedActiveSubscription } = require('./helpers');
const { getPool, closeDb }  = require('../db');
const { createApp }         = require('../app');
const {
  getEntitlement,
  tryReserveFreePublication,
  redeemFreePublication,
  releaseFreePublicationIfNoSuccess,
  hasAccess,
} = require('../routes/billing');

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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function register(email = 'user@example.com', password = 'pass1234') {
  const res = await request(app).post('/auth/register').send({ email, password });
  assert.equal(res.status, 201, `register failed: ${JSON.stringify(res.body)}`);
  const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${res.body.token}`);
  return { token: res.body.token, userId: me.body.userId };
}

async function getFreePub(userId) {
  const { rows } = await getPool().query(
    'SELECT * FROM free_publications WHERE user_id = $1',
    [userId]
  );
  return rows[0] ?? null;
}

async function seedPublishedRecord(userId, platform, jobId) {
  const now = Date.now();
  await getPool().query(
    `INSERT INTO publishing_records
       (user_id, platform, job_ref, client_job_id, status, published_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'published', $5, $5, $5)`,
    [userId, platform, `${platform}_${userId}_${jobId}`, jobId, now]
  );
}

// ── Section 1: New account eligibility ───────────────────────────────────────

describe('new account with no publications', () => {
  it('gets free_publications row with status=available on registration', async () => {
    const { userId } = await register();
    const fp = await getFreePub(userId);
    assert.ok(fp, 'free_publications row should exist');
    assert.equal(fp.status, 'available');
    assert.equal(fp.job_key, null);
  });

  it('getEntitlement returns free_available for a new user', async () => {
    const { userId } = await register();
    const ent = await getEntitlement(userId);
    assert.equal(ent.access, 'free_available');
  });

  it('GET /billing/entitlement returns free_available for a new user', async () => {
    const { token } = await register();
    const res = await request(app)
      .get('/billing/entitlement')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.access, 'free_available');
  });

  it('GET /billing/subscription includes entitlement field', async () => {
    const { token } = await register();
    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok('entitlement' in res.body, 'entitlement field missing');
    assert.equal(res.body.entitlement.access, 'free_available');
  });
});

// ── Section 2: tryReserveFreePublication ─────────────────────────────────────

describe('tryReserveFreePublication', () => {
  it('reserves an available slot and returns true', async () => {
    const { userId } = await register();
    const result = await tryReserveFreePublication(userId, 'job1');
    assert.equal(result, true);
    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'reserved');
    assert.equal(fp.job_key, 'job1');
    assert.ok(fp.reserved_at != null);
  });

  it('is idempotent: re-reserving the same jobKey returns true', async () => {
    const { userId } = await register();
    await tryReserveFreePublication(userId, 'job1');
    const result = await tryReserveFreePublication(userId, 'job1');
    assert.equal(result, true);
    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'reserved');
    assert.equal(fp.job_key, 'job1');
  });

  it('returns false when slot is already reserved for a different job', async () => {
    const { userId } = await register();
    await tryReserveFreePublication(userId, 'job1');
    const result = await tryReserveFreePublication(userId, 'job2');
    assert.equal(result, false);
    // Original reservation unchanged
    const fp = await getFreePub(userId);
    assert.equal(fp.job_key, 'job1');
  });

  it('returns false when slot is already redeemed', async () => {
    const { userId } = await register();
    await tryReserveFreePublication(userId, 'job1');
    await redeemFreePublication(userId, 'job1');
    const result = await tryReserveFreePublication(userId, 'job2');
    assert.equal(result, false);
  });

  it('returns false for active subscribers (no reservation needed)', async () => {
    const { userId } = await register();
    await seedActiveSubscription(userId);
    const result = await tryReserveFreePublication(userId, 'job1');
    assert.equal(result, false);
    // free_publications row is untouched
    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'available');
  });

  it('simultaneous calls for the same jobKey both return true (idempotent)', async () => {
    const { userId } = await register();
    const [r1, r2] = await Promise.all([
      tryReserveFreePublication(userId, 'job1'),
      tryReserveFreePublication(userId, 'job1'),
    ]);
    // Both should return true (idempotent reservation for same job)
    assert.equal(r1, true);
    assert.equal(r2, true);
    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'reserved');
  });

  it('after one job reserves, a different job cannot reserve (sequential)', async () => {
    // Verifies the atomic reservation invariant: once job1 holds the slot,
    // job2 is rejected. Real-PostgreSQL FOR UPDATE enforces this concurrently too.
    const { userId } = await register();
    const r1 = await tryReserveFreePublication(userId, 'job1');
    const r2 = await tryReserveFreePublication(userId, 'job2');
    assert.equal(r1, true,  'job1 should reserve first');
    assert.equal(r2, false, 'job2 should be rejected');
    const fp = await getFreePub(userId);
    assert.equal(fp.job_key, 'job1');
  });
});

// ── Section 3: redeemFreePublication ─────────────────────────────────────────

describe('redeemFreePublication', () => {
  it('transitions reserved→redeemed for the matching jobKey', async () => {
    const { userId } = await register();
    await tryReserveFreePublication(userId, 'job1');
    await redeemFreePublication(userId, 'job1');
    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'redeemed');
    assert.ok(fp.redeemed_at != null);
  });

  it('does not affect other jobKey reservations', async () => {
    const { userId } = await register();
    await tryReserveFreePublication(userId, 'job1');
    await redeemFreePublication(userId, 'job2'); // wrong jobKey
    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'reserved'); // unchanged
  });

  it('calling twice is safe (second call is a no-op)', async () => {
    const { userId } = await register();
    await tryReserveFreePublication(userId, 'job1');
    await redeemFreePublication(userId, 'job1');
    await redeemFreePublication(userId, 'job1'); // idempotent
    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'redeemed');
  });

  it('getEntitlement returns free_redeemed after redemption', async () => {
    const { userId } = await register();
    await tryReserveFreePublication(userId, 'job1');
    await redeemFreePublication(userId, 'job1');
    const ent = await getEntitlement(userId);
    assert.equal(ent.access, 'free_redeemed');
  });
});

// ── Section 4: releaseFreePublicationIfNoSuccess ──────────────────────────────

describe('releaseFreePublicationIfNoSuccess', () => {
  it('releases reserved→available when no platform succeeded', async () => {
    const { userId } = await register();
    await tryReserveFreePublication(userId, 'job1');
    await releaseFreePublicationIfNoSuccess(userId, 'job1');
    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'available');
    assert.equal(fp.job_key, null);
    assert.equal(fp.reserved_at, null);
  });

  it('does NOT release when another platform already published successfully', async () => {
    const { userId } = await register();
    await tryReserveFreePublication(userId, 'job1');
    // Simulate Facebook succeeded
    await seedPublishedRecord(userId, 'facebook', 'job1');
    // Instagram fails — tries to release
    await releaseFreePublicationIfNoSuccess(userId, 'job1');
    const fp = await getFreePub(userId);
    // Should be redeemed (Facebook succeeded), not available
    assert.equal(fp.status, 'redeemed');
  });

  it('is a no-op when status is already redeemed', async () => {
    const { userId } = await register();
    await tryReserveFreePublication(userId, 'job1');
    await redeemFreePublication(userId, 'job1');
    await releaseFreePublicationIfNoSuccess(userId, 'job1');
    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'redeemed'); // unchanged
  });

  it('is a no-op when called with the wrong jobKey', async () => {
    const { userId } = await register();
    await tryReserveFreePublication(userId, 'job1');
    await releaseFreePublicationIfNoSuccess(userId, 'job2'); // wrong key
    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'reserved'); // unchanged
  });
});

// ── Section 5: Full publish job lifecycle ─────────────────────────────────────

describe('one successful free publication', () => {
  it('consumes the free publication slot', async () => {
    const { userId } = await register();

    // Reserve + publish to one platform
    await tryReserveFreePublication(userId, 'job1');
    await seedPublishedRecord(userId, 'facebook', 'job1');
    await redeemFreePublication(userId, 'job1');

    const ent = await getEntitlement(userId);
    assert.equal(ent.access, 'free_redeemed');
  });

  it('multiple platforms in one job consume only one free publication', async () => {
    const { userId } = await register();

    // Simulate all three platforms reserving for the same job
    await tryReserveFreePublication(userId, 'job1');
    await tryReserveFreePublication(userId, 'job1'); // idempotent
    await tryReserveFreePublication(userId, 'job1'); // idempotent

    // All three publish successfully
    await seedPublishedRecord(userId, 'facebook',  'job1');
    await seedPublishedRecord(userId, 'instagram', 'job1');
    await seedPublishedRecord(userId, 'google',    'job1');

    // First platform to redeem wins
    await redeemFreePublication(userId, 'job1');

    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'redeemed');

    // Subsequent calls are no-ops
    await redeemFreePublication(userId, 'job1');
    const fp2 = await getFreePub(userId);
    assert.equal(fp2.status, 'redeemed');
  });
});

describe('all destinations fail', () => {
  it('releases the free publication slot after all-fail', async () => {
    const { userId } = await register();

    await tryReserveFreePublication(userId, 'job1');
    // No platform publishes successfully
    await releaseFreePublicationIfNoSuccess(userId, 'job1');

    const ent = await getEntitlement(userId);
    assert.equal(ent.access, 'free_available');
  });

  it('user can retry (new job) after all-fail', async () => {
    const { userId } = await register();

    // First attempt fails entirely
    await tryReserveFreePublication(userId, 'job1');
    await releaseFreePublicationIfNoSuccess(userId, 'job1');

    // Second attempt (new job) can reserve
    const result = await tryReserveFreePublication(userId, 'job2');
    assert.equal(result, true);
  });
});

describe('partial success', () => {
  it('consumes the slot when at least one platform succeeds', async () => {
    const { userId } = await register();

    await tryReserveFreePublication(userId, 'job1');

    // Facebook succeeds
    await seedPublishedRecord(userId, 'facebook', 'job1');
    await redeemFreePublication(userId, 'job1');

    // Instagram fails — tries to release but finds success
    await releaseFreePublicationIfNoSuccess(userId, 'job1');

    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'redeemed');
  });

  it('getEntitlement shows free_reserved while job is in-flight', async () => {
    const { userId } = await register();
    await tryReserveFreePublication(userId, 'job1');

    const ent = await getEntitlement(userId);
    assert.equal(ent.access, 'free_reserved');
    assert.equal(ent.jobKey, 'job1');
  });

  it('retry of failed platforms within the same job is allowed', async () => {
    const { userId } = await register();

    // Facebook succeeds first → slot redeemed
    await tryReserveFreePublication(userId, 'job1');
    await seedPublishedRecord(userId, 'facebook', 'job1');
    await redeemFreePublication(userId, 'job1');

    // Instagram failed; retry same job_id → tryReserve returns false (already redeemed)
    // but the route should still allow publishing (no gate yet)
    const reserveResult = await tryReserveFreePublication(userId, 'job1');
    assert.equal(reserveResult, false); // slot redeemed — no new reservation

    // Entitlement reflects redeemed, but publish is not blocked in this phase
    const ent = await getEntitlement(userId);
    assert.equal(ent.access, 'free_redeemed');
  });
});

describe('duplicate publishing requests', () => {
  it('does not consume an additional entitlement for the same job', async () => {
    const { userId } = await register();

    // First attempt: reserve + redeem
    await tryReserveFreePublication(userId, 'job1');
    await seedPublishedRecord(userId, 'facebook', 'job1');
    await redeemFreePublication(userId, 'job1');

    // Duplicate attempt (same job_id, same platform)
    const reserveResult = await tryReserveFreePublication(userId, 'job1');
    assert.equal(reserveResult, false);

    // Status stays redeemed
    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'redeemed');
  });
});

// ── Section 6: Existing subscriber behavior ───────────────────────────────────

describe('existing active subscribers', () => {
  it('getEntitlement returns subscription for trialing users', async () => {
    const { userId } = await register();
    await seedActiveSubscription(userId);
    const ent = await getEntitlement(userId);
    assert.equal(ent.access, 'subscription');
  });

  it('tryReserveFreePublication returns false for subscribers', async () => {
    const { userId } = await register();
    await seedActiveSubscription(userId);
    const result = await tryReserveFreePublication(userId, 'job1');
    assert.equal(result, false);
  });

  it('free_publications slot is unaffected for subscribers', async () => {
    const { userId } = await register();
    await seedActiveSubscription(userId);
    await tryReserveFreePublication(userId, 'job1');
    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'available'); // untouched
  });
});

// ── Section 7: V6 migration — existing accounts with publishing history ───────

describe('V6 migration: existing accounts', () => {
  it('seeds redeemed status for users with prior published records', async () => {
    // Simulate user with existing publishing history by manually setting up
    // the scenario the migration handles: create user, add published record,
    // then run migration logic (simulated by inserting directly).
    const now  = Date.now();
    const pool = getPool();

    // Create user directly (bypasses registration handler which would create free_pub row)
    const bcrypt = require('bcryptjs');
    const hash   = await bcrypt.hash('pass1234', 1);
    const { rows: [user] } = await pool.query(
      'INSERT INTO users (email, password_hash, created_at, updated_at) VALUES ($1, $2, $3, $3) RETURNING id',
      ['hist@example.com', hash, now]
    );

    // Add a published record for this user
    await pool.query(
      `INSERT INTO publishing_records
         (user_id, platform, job_ref, status, published_at, created_at, updated_at)
       VALUES ($1, 'facebook', 'fb_1_old', 'published', $2, $2, $2)`,
      [user.id, now]
    );

    // Run the migration seeding logic directly (two-step, pg-mem compatible)
    await pool.query(
      `INSERT INTO free_publications (user_id, status, created_at, updated_at)
       VALUES ($1, 'available', $2, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id, now]
    );
    await pool.query(
      `UPDATE free_publications
       SET status = 'redeemed', redeemed_at = $2, updated_at = $2
       WHERE status = 'available'
         AND user_id IN (
           SELECT DISTINCT user_id FROM publishing_records WHERE status = 'published'
         )`,
      [user.id, now]
    );

    const fp = await getFreePub(user.id);
    assert.ok(fp, 'free_publications row should exist');
    assert.equal(fp.status, 'redeemed', 'user with prior published records should be redeemed');
  });

  it('seeds available status for users with no prior published records', async () => {
    const now  = Date.now();
    const pool = getPool();

    const bcrypt = require('bcryptjs');
    const hash   = await bcrypt.hash('pass1234', 1);
    const { rows: [user] } = await pool.query(
      'INSERT INTO users (email, password_hash, created_at, updated_at) VALUES ($1, $2, $3, $3) RETURNING id',
      ['fresh@example.com', hash, now]
    );

    await pool.query(
      `INSERT INTO free_publications (user_id, status, created_at, updated_at)
       VALUES ($1, 'available', $2, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id, now]
    );
    // Step 2: flip users with published records (none here, so no change expected)
    await pool.query(
      `UPDATE free_publications
       SET status = 'redeemed', redeemed_at = $1, updated_at = $1
       WHERE status = 'available'
         AND user_id IN (
           SELECT DISTINCT user_id FROM publishing_records WHERE status = 'published'
         )`,
      [now]
    );

    const fp = await getFreePub(user.id);
    assert.equal(fp.status, 'available', 'user with no published records should be available');
  });

  it('does not disturb existing free_publications rows (ON CONFLICT DO NOTHING)', async () => {
    const { userId } = await register();

    // Manually set user as redeemed
    await getPool().query(
      `UPDATE free_publications SET status = 'redeemed', redeemed_at = $2, updated_at = $2
       WHERE user_id = $1`,
      [userId, Date.now()]
    );

    // Re-run seed (simulates re-applying migration)
    await getPool().query(
      `INSERT INTO free_publications (user_id, status, created_at, updated_at)
       VALUES ($1, 'available', $2, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, Date.now()]
    );

    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'redeemed'); // unchanged
  });
});

// ── Section 8: DB / external failure resilience ───────────────────────────────

describe('resilience: DB failure during reservation', () => {
  it('tryReserveFreePublication handles missing free_pub row gracefully', async () => {
    const { userId } = await register();

    // Delete the free_publications row to simulate missing row
    await getPool().query('DELETE FROM free_publications WHERE user_id = $1', [userId]);

    const result = await tryReserveFreePublication(userId, 'job1');
    assert.equal(result, false); // no row — returns false
  });

  it('releaseFreePublicationIfNoSuccess handles missing row gracefully', async () => {
    const { userId } = await register();
    await getPool().query('DELETE FROM free_publications WHERE user_id = $1', [userId]);
    // Should not throw
    await assert.doesNotReject(() => releaseFreePublicationIfNoSuccess(userId, 'job1'));
  });

  it('redeemFreePublication handles missing or wrong-state row gracefully', async () => {
    const { userId } = await register();
    // Attempt to redeem without reserving — should not throw
    await assert.doesNotReject(() => redeemFreePublication(userId, 'job1'));
    const fp = await getFreePub(userId);
    assert.equal(fp.status, 'available'); // unchanged
  });
});
