'use strict';

// Provides an in-memory PostgreSQL backend (pg-mem) for tests.
// Each call to setupFreshTestDb() creates a completely fresh database and
// runs migrations, isolating tests from one another without needing a real
// PostgreSQL server.

const { newDb }                = require('pg-mem');
const { initDb, closeDb, _setPoolForTesting, getPool } = require('../db');

async function setupFreshTestDb() {
  await closeDb();
  const mem    = newDb();
  const { Pool } = mem.adapters.createPg();
  _setPoolForTesting(new Pool());
  await initDb();
}

// Seed an active trialing subscription for a user so that tests that exercise
// paid endpoints (publish, generate) pass the subscription entitlement check.
async function seedActiveSubscription(userId) {
  const pool = getPool();
  const now  = Date.now();
  const customerId = `cus_test_${userId}`;

  await pool.query(
    `INSERT INTO stripe_customers (user_id, customer_id, created_at, updated_at)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (user_id) DO UPDATE SET customer_id = $2, updated_at = $3`,
    [userId, customerId, now]
  );
  await pool.query(
    `INSERT INTO subscriptions
       (user_id, stripe_subscription_id, stripe_customer_id, status,
        current_period_start, current_period_end, trial_start, trial_end,
        cancel_at_period_end, cancel_at, canceled_at, trial_used, created_at, updated_at)
     VALUES ($1, $2, $3, 'trialing', $4, $5, $4, $5, false, null, null, true, $4, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       stripe_customer_id = $3, status = 'trialing', updated_at = $4`,
    [userId, `sub_test_${userId}`, customerId, now, now + 14 * 24 * 60 * 60 * 1000]
  );
}

module.exports = { setupFreshTestDb, seedActiveSubscription };
