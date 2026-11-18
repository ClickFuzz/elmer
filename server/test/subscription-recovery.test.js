'use strict';

// Tests for subscription recovery flows:
//   - deleted Stripe customer (missed or handled customer.deleted webhook)
//   - portal-session resource_missing → clean recovery
//   - checkout-session retry on stale customer
//   - canceled subscription resubscription
//   - past_due recovery path
//   - duplicate subscription prevention
//   - Apple / Google subscription management and resubscription
//   - preservation of historical billing records

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
// Fake Stripe keys so the billing router doesn't return 503 before reaching mock logic.
// The _setStripeForTest() hook intercepts all actual Stripe SDK calls.
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_recovery_tests';
process.env.STRIPE_PRICE_ID   = 'price_fake_for_recovery_tests';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');

const { setupFreshTestDb } = require('./helpers');
const { getPool, closeDb } = require('../db');
const { createApp }        = require('../app');
const {
  handleWebhookEvent,
  hasAccess,
  _setStripeForTest,
  _clearStripeForTest,
} = require('../routes/billing');

let app;

before(async () => {
  await setupFreshTestDb();
  app = createApp();
});

after(async () => {
  _clearStripeForTest();
  closeDb();
});

beforeEach(async () => {
  await setupFreshTestDb();
  app = createApp();
  _clearStripeForTest();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function register(email = 'user@example.com', password = 'password123') {
  const res = await request(app).post('/auth/register').send({ email, password });
  return res.body.token;
}

async function getUserId(email = 'user@example.com') {
  const { rows } = await getPool().query('SELECT id FROM users WHERE email = $1', [email]);
  return rows[0]?.id;
}

async function seedStripeCustomer(userId, customerId = 'cus_test123') {
  const now = Date.now();
  await getPool().query(
    `INSERT INTO stripe_customers (user_id, customer_id, created_at, updated_at)
     VALUES ($1, $2, $3, $3)`,
    [userId, customerId, now]
  );
  return customerId;
}

async function seedSubscription(userId, customerId, overrides = {}) {
  const now = Date.now();
  const stripeSubId = overrides.stripe_subscription_id ?? 'sub_test123';
  const defaults = {
    provider:                 'stripe',
    provider_subscription_id: stripeSubId,
    stripe_subscription_id:   stripeSubId,
    stripe_customer_id:       customerId,
    status:                   'active',
    current_period_start:     now,
    current_period_end:       now + 30 * 24 * 60 * 60 * 1000,
    trial_start:              null,
    trial_end:                null,
    cancel_at_period_end:     false,
    cancel_at:                null,
    canceled_at:              null,
    trial_used:               true,
  };
  const s = { ...defaults, ...overrides };
  await getPool().query(
    `INSERT INTO subscriptions
       (user_id, provider, provider_subscription_id,
        stripe_subscription_id, stripe_customer_id, status,
        current_period_start, current_period_end, trial_start, trial_end,
        cancel_at_period_end, cancel_at, canceled_at, trial_used, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
    [
      userId, s.provider, s.provider_subscription_id,
      s.stripe_subscription_id, s.stripe_customer_id, s.status,
      s.current_period_start, s.current_period_end,
      s.trial_start, s.trial_end,
      s.cancel_at_period_end, s.cancel_at, s.canceled_at,
      s.trial_used, now,
    ]
  );
}

async function getStripeCustomerRow(userId) {
  const { rows } = await getPool().query(
    'SELECT customer_id FROM stripe_customers WHERE user_id = $1', [userId]
  );
  return rows[0] ?? null;
}

async function getSubscriptionRows(userId) {
  const { rows } = await getPool().query(
    'SELECT status, provider FROM subscriptions WHERE user_id = $1', [userId]
  );
  return rows;
}

function makeStripeError(code, message) {
  const err = new Error(message ?? `Stripe error: ${code}`);
  err.code = code;
  err.type = 'StripeInvalidRequestError';
  return err;
}

// ── 1. customer.deleted webhook removes stripe_customers row ──────────────────

describe('customer.deleted webhook', () => {
  it('removes stripe_customers row for the deleted customer', async () => {
    const token  = await register('webhook_del@example.com');
    const userId = await getUserId('webhook_del@example.com');
    await seedStripeCustomer(userId, 'cus_deleted_abc');

    // Verify row exists before the event
    const before = await getStripeCustomerRow(userId);
    assert.ok(before, 'stripe_customers row should exist before event');

    await handleWebhookEvent({
      id:   'evt_test_customer_deleted',
      type: 'customer.deleted',
      data: { object: { id: 'cus_deleted_abc' } },
    });

    const after = await getStripeCustomerRow(userId);
    assert.strictEqual(after, null, 'stripe_customers row should be removed after customer.deleted');
  });

  it('leaves other users stripe_customers rows untouched', async () => {
    const token1  = await register('del_user1@example.com');
    const userId1 = await getUserId('del_user1@example.com');
    const token2  = await register('del_user2@example.com');
    const userId2 = await getUserId('del_user2@example.com');

    await seedStripeCustomer(userId1, 'cus_to_delete');
    await seedStripeCustomer(userId2, 'cus_to_keep');

    await handleWebhookEvent({
      id:   'evt_test_cust_del_isolation',
      type: 'customer.deleted',
      data: { object: { id: 'cus_to_delete' } },
    });

    const row1 = await getStripeCustomerRow(userId1);
    const row2 = await getStripeCustomerRow(userId2);
    assert.strictEqual(row1, null, 'deleted user row should be gone');
    assert.ok(row2, 'other user row should remain');
  });

  it('is idempotent — repeated customer.deleted events do not error', async () => {
    const token  = await register('idempotent_del@example.com');
    const userId = await getUserId('idempotent_del@example.com');
    await seedStripeCustomer(userId, 'cus_idempotent');

    const event = {
      id:   'evt_idempotent_del',
      type: 'customer.deleted',
      data: { object: { id: 'cus_idempotent' } },
    };

    await handleWebhookEvent(event);
    // Second call: no row exists, DELETE WHERE should be a no-op
    await assert.doesNotReject(handleWebhookEvent(event));
  });
});

// ── 2. portal-session: resource_missing (deleted customer) ────────────────────

describe('POST /billing/portal-session — deleted customer', () => {
  it('returns 404 customer_not_found and removes stale row when Stripe throws resource_missing', async () => {
    const token  = await register('portal_deleted@example.com');
    const userId = await getUserId('portal_deleted@example.com');
    await seedStripeCustomer(userId, 'cus_stale_portal');
    await seedSubscription(userId, 'cus_stale_portal', { status: 'canceled' });

    _setStripeForTest({
      billingPortal: {
        sessions: {
          create: async () => { throw makeStripeError('resource_missing', 'No such customer: cus_stale_portal'); },
        },
      },
    });

    const res = await request(app)
      .post('/billing/portal-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, 'customer_not_found');

    // Stale row must be removed so next checkout creates a fresh customer
    const row = await getStripeCustomerRow(userId);
    assert.strictEqual(row, null, 'stale stripe_customers row should be removed');
  });

  it('returns 404 customer_not_found when user has no stripe_customers row (gap fix)', async () => {
    // After the gap fix, a missing stripe_customers row returns customer_not_found
    // (not no_billing_account) so the frontend calls loadSubscription() and re-renders.
    const token = await register('portal_no_cust@example.com');

    const res = await request(app)
      .post('/billing/portal-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, 'customer_not_found');
  });

  it('returns portalUrl on success', async () => {
    const token  = await register('portal_ok@example.com');
    const userId = await getUserId('portal_ok@example.com');
    await seedStripeCustomer(userId, 'cus_active_ok');

    _setStripeForTest({
      billingPortal: {
        sessions: {
          create: async () => ({ url: 'https://billing.stripe.com/session/test123' }),
        },
      },
    });

    const res = await request(app)
      .post('/billing/portal-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.portalUrl, 'should return portalUrl');
  });

  it('preserves subscription history rows after stale customer is cleaned up', async () => {
    const token  = await register('portal_history@example.com');
    const userId = await getUserId('portal_history@example.com');
    await seedStripeCustomer(userId, 'cus_stale_history');
    await seedSubscription(userId, 'cus_stale_history', { status: 'canceled' });

    _setStripeForTest({
      billingPortal: {
        sessions: {
          create: async () => { throw makeStripeError('resource_missing'); },
        },
      },
    });

    await request(app)
      .post('/billing/portal-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    // Historical subscription row must be preserved
    const subs = await getSubscriptionRows(userId);
    assert.strictEqual(subs.length, 1, 'historical subscription row must be preserved');
    assert.strictEqual(subs[0].status, 'canceled');
  });
});

// ── 3. checkout-session: retry on stale customer ──────────────────────────────

describe('POST /billing/checkout-session — stale customer retry', () => {
  it('retries with a new customer when first attempt throws resource_missing', async () => {
    const token  = await register('checkout_stale@example.com');
    const userId = await getUserId('checkout_stale@example.com');
    await seedStripeCustomer(userId, 'cus_stale_checkout');

    let callCount = 0;
    _setStripeForTest({
      customers: {
        create: async () => ({ id: 'cus_fresh_checkout' }),
      },
      checkout: {
        sessions: {
          create: async (params) => {
            callCount++;
            if (callCount === 1) {
              throw makeStripeError('resource_missing', 'No such customer: cus_stale_checkout');
            }
            return { url: 'https://checkout.stripe.com/pay/cs_test', id: 'cs_test' };
          },
        },
      },
    });

    const res = await request(app)
      .post('/billing/checkout-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.checkoutUrl, 'should return checkoutUrl after retry');
    assert.strictEqual(callCount, 2, 'should have called Stripe checkout.sessions.create twice');

    // Old stale row removed and new customer row created
    const row = await getStripeCustomerRow(userId);
    assert.strictEqual(row?.customer_id, 'cus_fresh_checkout', 'new customer should be stored');
  });

  it('blocks checkout for user with an active subscription (duplicate prevention)', async () => {
    const token  = await register('checkout_dup@example.com');
    const userId = await getUserId('checkout_dup@example.com');
    await seedStripeCustomer(userId, 'cus_active_dup');
    await seedSubscription(userId, 'cus_active_dup', { status: 'active' });

    const res = await request(app)
      .post('/billing/checkout-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'active_subscription_exists');
  });

  it('allows checkout for user with a canceled subscription', async () => {
    const token  = await register('checkout_resubscribe@example.com');
    const userId = await getUserId('checkout_resubscribe@example.com');
    await seedStripeCustomer(userId, 'cus_canceled');
    await seedSubscription(userId, 'cus_canceled', { status: 'canceled' });

    _setStripeForTest({
      customers: { create: async () => ({ id: 'cus_canceled' }) },
      checkout: {
        sessions: {
          create: async () => ({ url: 'https://checkout.stripe.com/pay/cs_resubscribe', id: 'cs_resubscribe' }),
        },
      },
    });

    const res = await request(app)
      .post('/billing/checkout-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.checkoutUrl);
    assert.strictEqual(res.body.trialEligible, false, 'trial should not be offered when trial_used=true');
  });
});

// ── 4. Canceled subscription — subscription status endpoint ───────────────────

describe('GET /billing/subscription — canceled subscription', () => {
  it('returns canceled status with hasAccess=false', async () => {
    const token  = await register('sub_canceled@example.com');
    const userId = await getUserId('sub_canceled@example.com');
    const now    = Date.now();
    await seedSubscription(userId, 'cus_cancel_check', {
      status:      'canceled',
      canceled_at: now - 1000,
    });

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, false);
    assert.strictEqual(res.body.subscription?.status, 'canceled');
  });

  it('returns past_due status with hasAccess=true within grace period', async () => {
    const token  = await register('sub_past_due@example.com');
    const userId = await getUserId('sub_past_due@example.com');
    const now    = Date.now();
    // current_period_end is 1 day in the past — within 3-day grace period
    await seedSubscription(userId, 'cus_past_due_check', {
      status:              'past_due',
      current_period_end:  now - 24 * 60 * 60 * 1000,
    });

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, true, 'past_due within grace period should have access');
    assert.strictEqual(res.body.subscription?.status, 'past_due');
  });

  it('returns past_due with hasAccess=false outside grace period', async () => {
    const token  = await register('sub_past_due_expired@example.com');
    const userId = await getUserId('sub_past_due_expired@example.com');
    const now    = Date.now();
    // current_period_end is 5 days in the past — beyond the 3-day grace window
    await seedSubscription(userId, 'cus_past_due_exp', {
      status:              'past_due',
      current_period_end:  now - 5 * 24 * 60 * 60 * 1000,
    });

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, false, 'past_due outside grace should not have access');
  });
});

// ── 5. Apple subscription management and resubscription ───────────────────────

describe('Apple / Google subscription status', () => {
  it('Apple active subscription: hasAccess=true, provider=apple', async () => {
    const token  = await register('apple_active@example.com');
    const userId = await getUserId('apple_active@example.com');
    const now    = Date.now();
    await getPool().query(
      `INSERT INTO subscriptions
         (user_id, provider, provider_subscription_id, status,
          current_period_start, current_period_end, trial_used, created_at, updated_at)
       VALUES ($1,'apple','apple_txn_001','active',$2,$3,true,$4,$4)`,
      [userId, now, now + 30 * 24 * 60 * 60 * 1000, now]
    );

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, true);
    assert.strictEqual(res.body.subscription?.provider, 'apple');
    assert.strictEqual(res.body.subscription?.status, 'active');
  });

  it('Apple expired subscription: hasAccess=false', async () => {
    const token  = await register('apple_expired@example.com');
    const userId = await getUserId('apple_expired@example.com');
    const now    = Date.now();
    await getPool().query(
      `INSERT INTO subscriptions
         (user_id, provider, provider_subscription_id, status,
          current_period_start, current_period_end, trial_used, created_at, updated_at)
       VALUES ($1,'apple','apple_txn_exp','active',$2,$3,true,$4,$4)`,
      // current_period_end well in the past (beyond the 24-hour RC notification buffer)
      [userId, now - 50 * 24 * 60 * 60 * 1000, now - 2 * 24 * 60 * 60 * 1000, now]
    );

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, false, 'expired Apple sub should not have access');
  });

  it('Google active subscription: hasAccess=true, provider=google', async () => {
    const token  = await register('google_active@example.com');
    const userId = await getUserId('google_active@example.com');
    const now    = Date.now();
    await getPool().query(
      `INSERT INTO subscriptions
         (user_id, provider, provider_subscription_id, status,
          current_period_start, current_period_end, trial_used, created_at, updated_at)
       VALUES ($1,'google','google_sub_001','active',$2,$3,true,$4,$4)`,
      [userId, now, now + 30 * 24 * 60 * 60 * 1000, now]
    );

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, true);
    assert.strictEqual(res.body.subscription?.provider, 'google');
  });

  it('Google expired subscription: hasAccess=false', async () => {
    const token  = await register('google_expired@example.com');
    const userId = await getUserId('google_expired@example.com');
    const now    = Date.now();
    await getPool().query(
      `INSERT INTO subscriptions
         (user_id, provider, provider_subscription_id, status,
          current_period_start, current_period_end, trial_used, created_at, updated_at)
       VALUES ($1,'google','google_sub_exp','active',$2,$3,true,$4,$4)`,
      [userId, now - 40 * 24 * 60 * 60 * 1000, now - 2 * 24 * 60 * 60 * 1000, now]
    );

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, false);
  });
});

// ── 6. Historical records preserved; Stripe cancellation does not block IAP ───

describe('Multi-provider entitlement isolation', () => {
  it('expired Stripe subscription does not block an active Apple subscription', async () => {
    const token  = await register('multi_provider@example.com');
    const userId = await getUserId('multi_provider@example.com');
    const now    = Date.now();

    // Old canceled Stripe sub
    await seedSubscription(userId, 'cus_old', {
      status:      'canceled',
      canceled_at: now - 10 * 24 * 60 * 60 * 1000,
      trial_used:  true,
    });

    // Active Apple sub (concurrent row — V15 allows multiple rows per user)
    await getPool().query(
      `INSERT INTO subscriptions
         (user_id, provider, provider_subscription_id, status,
          current_period_start, current_period_end, trial_used, created_at, updated_at)
       VALUES ($1,'apple','apple_concurrent','active',$2,$3,false,$4,$4)`,
      [userId, now, now + 30 * 24 * 60 * 60 * 1000, now]
    );

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, true, 'active Apple sub should grant access despite canceled Stripe sub');
  });

  it('canceled Apple sub does not block a valid Stripe active subscription', async () => {
    const token  = await register('multi_apple_stripe@example.com');
    const userId = await getUserId('multi_apple_stripe@example.com');
    const now    = Date.now();

    // Expired Apple sub
    await getPool().query(
      `INSERT INTO subscriptions
         (user_id, provider, provider_subscription_id, status,
          current_period_start, current_period_end, trial_used, created_at, updated_at)
       VALUES ($1,'apple','apple_expired_check','active',$2,$3,true,$4,$4)`,
      [userId, now - 40 * 24 * 60 * 60 * 1000, now - 2 * 24 * 60 * 60 * 1000, now]
    );

    // Active Stripe sub
    await seedStripeCustomer(userId, 'cus_stripe_active');
    await seedSubscription(userId, 'cus_stripe_active', { status: 'active', trial_used: false,
      provider_subscription_id: 'sub_stripe_new', stripe_subscription_id: 'sub_stripe_new' });

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, true, 'active Stripe sub should grant access despite expired Apple sub');
  });

  it('stripe_customers row is preserved after customer.deleted; subscription history is not deleted', async () => {
    // After customer.deleted: stripe_customers row removed but subscriptions row stays
    const token  = await register('preserve_history@example.com');
    const userId = await getUserId('preserve_history@example.com');
    await seedStripeCustomer(userId, 'cus_preserve_history');
    await seedSubscription(userId, 'cus_preserve_history', { status: 'canceled' });

    await handleWebhookEvent({
      id:   'evt_preserve_history',
      type: 'customer.deleted',
      data: { object: { id: 'cus_preserve_history' } },
    });

    const customerRow = await getStripeCustomerRow(userId);
    assert.strictEqual(customerRow, null, 'stripe_customers row should be removed');

    const subs = await getSubscriptionRows(userId);
    assert.strictEqual(subs.length, 1, 'subscription history should be preserved');
    assert.strictEqual(subs[0].status, 'canceled');
  });
});

// ── 7. Successful resubscription ─────────────────────────────────────────────

describe('Successful resubscription after expiry', () => {
  it('webhook upserts new active row for previously canceled user', async () => {
    const token  = await register('resub_webhook@example.com');
    const userId = await getUserId('resub_webhook@example.com');
    const now    = Date.now();

    // Seed an old canceled subscription
    await seedStripeCustomer(userId, 'cus_resub');
    await seedSubscription(userId, 'cus_resub', {
      status:                  'canceled',
      stripe_subscription_id:  'sub_old_canceled',
      provider_subscription_id:'sub_old_canceled',
    });

    // Mock Stripe to return the new subscription on retrieve (called by webhook handler)
    const freshSub = {
      id:                   'sub_new_active',
      customer:             'cus_resub',
      status:               'active',
      current_period_start: Math.floor(now / 1000),
      current_period_end:   Math.floor((now + 30 * 24 * 60 * 60 * 1000) / 1000),
      trial_start:          null,
      trial_end:            null,
      cancel_at_period_end: false,
      cancel_at:            null,
      canceled_at:          null,
    };
    _setStripeForTest({ subscriptions: { retrieve: async () => freshSub } });

    // Simulate a new checkout completing: webhook fires customer.subscription.created
    await handleWebhookEvent({
      id:   'evt_resub_created',
      type: 'customer.subscription.created',
      data: { object: freshSub },
    });

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    // The best row (active) should be shown over the old canceled row
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, true, 'new active sub should grant access');
    assert.strictEqual(res.body.subscription?.status, 'active');
  });
});

// ── 8. Stale-active-subscription loop regression ──────────────────────────────
//
// Scenario: Stripe customer deleted from dashboard, both customer.deleted and
// customer.subscription.deleted webhooks were missed. Local DB has:
//   stripe_customers row: cus_stale
//   subscriptions row: status='active' (stale)
//
// Expected behaviour when user opens billing portal (Manage):
//   1. portal-session receives resource_missing from Stripe
//   2. stripe_customers row removed
//   3. subscription row updated to 'canceled'   ← the loop-breaking fix
//   4. Next GET /billing/subscription returns hasAccess=false, status='canceled'
//   5. showDashboard renders Subscribe section (not Manage) → no loop
//   6. Checkout session succeeds for a genuinely unsubscribed user
//   7. No duplicate active subscription is possible from the stale row

describe('Stale active subscription loop prevention', () => {
  it('portal-session resource_missing also cancels the stale active subscription', async () => {
    const token  = await register('looptest@example.com');
    const userId = await getUserId('looptest@example.com');
    const cusId  = 'cus_stale_loop';

    // Seed the stale state: active subscription + stripe_customers row
    await seedStripeCustomer(userId, cusId);
    await seedSubscription(userId, cusId, { status: 'active' });

    // Confirm access is true before the fix fires (query the row and pass to hasAccess)
    const { rows: preRows } = await getPool().query(
      'SELECT status, provider, current_period_end FROM subscriptions WHERE user_id = $1', [userId]
    );
    assert.ok(preRows.some(r => hasAccess(r)), 'stale active sub grants access before fix');

    // Mock Stripe portal.sessions.create to throw resource_missing (customer was deleted)
    _setStripeForTest({
      billingPortal: {
        sessions: {
          create: async () => { throw makeStripeError('resource_missing', 'No such customer: cus_stale_loop'); },
        },
      },
    });

    const portalRes = await request(app)
      .post('/billing/portal-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    assert.strictEqual(portalRes.status, 404, 'portal-session should return 404');
    assert.strictEqual(portalRes.body.error, 'customer_not_found');

    // stripe_customers row must be gone
    const customerRow = await getStripeCustomerRow(userId);
    assert.strictEqual(customerRow, null, 'stripe_customers row should be removed');

    // Subscription row must now be canceled (the loop-breaking change)
    const subs = await getSubscriptionRows(userId);
    assert.strictEqual(subs.length, 1, 'subscription row still exists (history preserved)');
    assert.strictEqual(subs[0].status, 'canceled', 'stale active subscription canceled by portal-session fix');

    // hasAccess must be false after the fix (re-query the now-canceled row)
    const { rows: postRows } = await getPool().query(
      'SELECT status, provider, current_period_end FROM subscriptions WHERE user_id = $1', [userId]
    );
    assert.strictEqual(postRows.some(r => hasAccess(r)), false, 'access revoked after stale customer detected');
  });

  it('after stale-customer detection, GET /billing/subscription returns hasAccess=false', async () => {
    const token  = await register('loopcheck@example.com');
    const userId = await getUserId('loopcheck@example.com');
    const cusId  = 'cus_stale_check';

    await seedStripeCustomer(userId, cusId);
    await seedSubscription(userId, cusId, { status: 'active' });

    // Apply the fix by calling portal-session with a resource_missing mock
    _setStripeForTest({
      billingPortal: {
        sessions: {
          create: async () => { throw makeStripeError('resource_missing'); },
        },
      },
    });

    await request(app)
      .post('/billing/portal-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    _clearStripeForTest();

    // Now fetch subscription status — this is what the dashboard calls after
    // receiving customer_not_found and re-loading.
    const subRes = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(subRes.status, 200);
    assert.strictEqual(subRes.body.hasAccess, false, 'dashboard re-load must not grant access');
    assert.strictEqual(subRes.body.subscription?.status, 'canceled');
    // Dashboard should now show Subscribe, not Manage → no loop
  });

  it('after stale-customer detection, checkout-session creates a fresh customer (resubscription works)', async () => {
    const token  = await register('loopresub@example.com');
    const userId = await getUserId('loopresub@example.com');
    const cusId  = 'cus_stale_resub';

    await seedStripeCustomer(userId, cusId);
    await seedSubscription(userId, cusId, { status: 'active' });

    // Step 1: portal-session fires, stale customer detected and cleaned up
    _setStripeForTest({
      billingPortal: {
        sessions: {
          create: async () => { throw makeStripeError('resource_missing'); },
        },
      },
    });

    await request(app)
      .post('/billing/portal-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    // Step 2: mock Stripe for a fresh checkout (new customer created)
    const freshCusId = 'cus_fresh_after_cleanup';
    _setStripeForTest({
      customers: {
        create: async () => ({ id: freshCusId }),
      },
      checkout: {
        sessions: {
          create: async (params) => {
            // Guard: must NOT use the stale customer id
            assert.notStrictEqual(
              params.customer, cusId,
              'checkout must not reuse the deleted customer'
            );
            return { url: 'https://checkout.stripe.com/fake' };
          },
        },
      },
    });

    const checkoutRes = await request(app)
      .post('/billing/checkout-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    // The checkout guard rejects users with active/trialing/past_due Stripe subscriptions.
    // After the fix the sub is 'canceled', so checkout MUST succeed (200 or 201, not 409).
    assert.notStrictEqual(checkoutRes.status, 409, 'canceled subscription must not block checkout');
    assert.strictEqual(checkoutRes.status, 200, 'fresh checkout should succeed');
    assert.ok(checkoutRes.body.checkoutUrl, 'checkoutUrl must be present');
  });
});

// ── 9. Missing stripe_customers row with stale active subscription (the gap) ───
//
// Scenario: Stripe customer was deleted → customer.deleted webhook handler
// removed the stripe_customers row BUT did not cancel the subscription row
// (because the old handler relied on customer.subscription.deleted).
// Now portal-session hits the rows.length === 0 early-exit path.
// Without the fix this returned no_billing_account without touching the
// subscription, leaving the dashboard permanently stuck on Active/Manage.

describe('Missing stripe_customers row + stale active subscription (production gap)', () => {
  it('portal-session reconciles stale subscription and returns customer_not_found when stripe_customers row is missing', async () => {
    const token  = await register('gap_test@example.com');
    const userId = await getUserId('gap_test@example.com');
    const cusId  = 'cus_gap_deleted';

    // Seed only a subscription row — no stripe_customers row (simulates customer.deleted
    // webhook ran and deleted the row but did not cancel the subscription).
    await seedSubscription(userId, cusId, { status: 'active' });
    // Confirm no stripe_customers row exists.
    const preCustomer = await getStripeCustomerRow(userId);
    assert.strictEqual(preCustomer, null, 'stripe_customers row should be absent');

    // Confirm the subscription is active before the fix fires.
    const { rows: preRows } = await getPool().query(
      'SELECT status FROM subscriptions WHERE user_id = $1', [userId]
    );
    assert.strictEqual(preRows[0].status, 'active', 'subscription should be active before fix');

    // No Stripe mock needed — the route should not reach the Stripe API.
    const res = await request(app)
      .post('/billing/portal-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    assert.strictEqual(res.status, 404, 'should return 404');
    assert.strictEqual(res.body.error, 'customer_not_found',
      'should return customer_not_found (not no_billing_account) so frontend reloads');

    // Subscription row must now be canceled.
    const { rows: postRows } = await getPool().query(
      'SELECT status FROM subscriptions WHERE user_id = $1', [userId]
    );
    assert.strictEqual(postRows[0].status, 'canceled',
      'stale active subscription should be canceled by portal-session fix');
  });

  it('after reconciliation, GET /billing/subscription returns hasAccess=false (Subscribe Again)', async () => {
    const token  = await register('gap_reload@example.com');
    const userId = await getUserId('gap_reload@example.com');
    const cusId  = 'cus_gap_reload';

    // Stale state: active subscription, no stripe_customers row.
    await seedSubscription(userId, cusId, { status: 'active' });

    // Trigger portal-session to reconcile.
    await request(app)
      .post('/billing/portal-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    // Simulate frontend reloading subscription state.
    const subRes = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(subRes.status, 200);
    assert.strictEqual(subRes.body.hasAccess, false,
      'hasAccess must be false after reconciliation — dashboard should show Subscribe Again');
    assert.strictEqual(subRes.body.subscription?.status, 'canceled');
  });

  it('customer.deleted webhook now also cancels stale subscriptions', async () => {
    const token  = await register('webhook_cancel@example.com');
    const userId = await getUserId('webhook_cancel@example.com');
    const cusId  = 'cus_webhook_cancel';

    await seedStripeCustomer(userId, cusId);
    await seedSubscription(userId, cusId, { status: 'active' });

    // Fire customer.deleted — previously only deleted stripe_customers, left subscription active.
    await handleWebhookEvent({
      id:   'evt_customer_deleted_cancel',
      type: 'customer.deleted',
      data: { object: { id: cusId } },
    });

    // stripe_customers row must be gone.
    const customerRow = await getStripeCustomerRow(userId);
    assert.strictEqual(customerRow, null, 'stripe_customers row should be removed');

    // Subscription must now be canceled — no longer reliant on customer.subscription.deleted.
    const { rows } = await getPool().query(
      'SELECT status FROM subscriptions WHERE user_id = $1', [userId]
    );
    assert.strictEqual(rows[0].status, 'canceled',
      'subscription should be canceled by customer.deleted webhook (not waiting for subscription.deleted)');
  });

  it('Apple/Google subscriptions are NOT canceled by portal-session stripe_customers gap fix', async () => {
    const token  = await register('gap_apple@example.com');
    const userId = await getUserId('gap_apple@example.com');
    const now    = Date.now();

    // Stale Stripe subscription with no stripe_customers row.
    await seedSubscription(userId, 'cus_gap_apple', { status: 'active', provider: 'stripe' });
    // Active Apple subscription (should be untouched).
    await seedSubscription(userId, null, {
      provider:                 'apple',
      provider_subscription_id: 'apple_sub_123',
      stripe_subscription_id:   null,
      stripe_customer_id:       null,
      status:                   'active',
      current_period_end:       now + 30 * 24 * 60 * 60 * 1000,
    });

    await request(app)
      .post('/billing/portal-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    const { rows } = await getPool().query(
      'SELECT status, provider FROM subscriptions WHERE user_id = $1 ORDER BY provider',
      [userId]
    );
    const apple  = rows.find(r => r.provider === 'apple');
    const stripe = rows.find(r => r.provider === 'stripe');

    assert.strictEqual(apple?.status, 'active',
      'Apple subscription must NOT be canceled by the Stripe gap fix');
    assert.strictEqual(stripe?.status, 'canceled',
      'stale Stripe subscription should be canceled');
  });
});

// ── 10. GET /billing/subscription auto-reconcile on page load ──────────────────
//
// Design correction: stale Stripe subscriptions should be reconciled automatically
// on page load (GET /billing/subscription), not click-triggered.
// If a user has an active/trialing/past_due Stripe subscription but no
// stripe_customers row, the Stripe customer was deleted without us receiving the
// webhook. Cancel those rows immediately so the dashboard shows Subscribe Again.
//
// This covers the exact production scenario for clgsplace@gmail.com and
// joe@homesincda.com: status='active', current_period_end past, no stripe_customers.

describe('GET /billing/subscription — auto-reconcile stale Stripe subscription on page load', () => {
  it('auto-cancels a stale active Stripe subscription when stripe_customers row is absent', async () => {
    const token  = await register('autoreconcile@example.com');
    const userId = await getUserId('autoreconcile@example.com');

    // Stale state: active subscription, NO stripe_customers row.
    await seedSubscription(userId, 'cus_autoreconcile', { status: 'active' });
    assert.strictEqual(await getStripeCustomerRow(userId), null, 'no stripe_customers row');

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, false,
      'stale Stripe sub must be auto-canceled → hasAccess false');
    assert.strictEqual(res.body.subscription?.status, 'canceled');
  });

  it('auto-reconcile also applies to stale trialing subscriptions', async () => {
    const token  = await register('autoreconcile_trial@example.com');
    const userId = await getUserId('autoreconcile_trial@example.com');

    await seedSubscription(userId, 'cus_trial_stale', { status: 'trialing' });

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, false);
    assert.strictEqual(res.body.subscription?.status, 'canceled');
  });

  it('auto-reconcile does NOT fire when stripe_customers row is present', async () => {
    const token  = await register('autoreconcile_valid@example.com');
    const userId = await getUserId('autoreconcile_valid@example.com');

    await seedStripeCustomer(userId, 'cus_valid_present');
    await seedSubscription(userId, 'cus_valid_present', { status: 'active' });

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, true,
      'subscription must remain active when stripe_customers row is present');
    assert.strictEqual(res.body.subscription?.status, 'active');
  });

  it('auto-reconcile does NOT cancel Apple/Google subscriptions', async () => {
    const token  = await register('autoreconcile_apple@example.com');
    const userId = await getUserId('autoreconcile_apple@example.com');
    const now    = Date.now();

    // Active Apple subscription, no Stripe rows, no stripe_customers row.
    await getPool().query(
      `INSERT INTO subscriptions
         (user_id, provider, provider_subscription_id, status,
          current_period_start, current_period_end, trial_used, created_at, updated_at)
       VALUES ($1,'apple','apple_autoreconcile_sub','active',$2,$3,true,$4,$4)`,
      [userId, now, now + 30 * 24 * 60 * 60 * 1000, now]
    );

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, true, 'Apple subscription should grant access');
    assert.strictEqual(res.body.subscription?.status, 'active');
    assert.strictEqual(res.body.subscription?.provider, 'apple');
  });

  it('auto-reconcile cancels stale Stripe row but preserves concurrent active Apple row', async () => {
    const token  = await register('autoreconcile_dual@example.com');
    const userId = await getUserId('autoreconcile_dual@example.com');
    const now    = Date.now();

    // Stale Stripe sub: no stripe_customers row
    await seedSubscription(userId, 'cus_stale_dual', { status: 'active', provider: 'stripe' });
    // Valid Apple sub (concurrent — V15 allows multiple rows per user)
    await getPool().query(
      `INSERT INTO subscriptions
         (user_id, provider, provider_subscription_id, status,
          current_period_start, current_period_end, trial_used, created_at, updated_at)
       VALUES ($1,'apple','apple_dual_sub','active',$2,$3,false,$4,$4)`,
      [userId, now, now + 30 * 24 * 60 * 60 * 1000, now]
    );

    const res = await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.hasAccess, true, 'Apple sub should still grant access');
    assert.strictEqual(res.body.subscription?.provider, 'apple');

    const { rows } = await getPool().query(
      'SELECT status, provider FROM subscriptions WHERE user_id = $1 ORDER BY provider',
      [userId]
    );
    const appleRow  = rows.find(r => r.provider === 'apple');
    const stripeRow = rows.find(r => r.provider === 'stripe');
    assert.strictEqual(appleRow?.status,  'active',   'Apple row must remain active');
    assert.strictEqual(stripeRow?.status, 'canceled', 'stale Stripe row must be canceled');
  });

  it('after auto-reconcile, checkout-session opens without an active_subscription_exists error', async () => {
    const token  = await register('autoreconcile_checkout@example.com');
    const userId = await getUserId('autoreconcile_checkout@example.com');

    // Stale Stripe sub, no customer row
    await seedSubscription(userId, 'cus_stale_checkout2', { status: 'active' });

    // Page load reconciles the subscription
    await request(app)
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    // Subscription is now canceled — checkout must be allowed
    _setStripeForTest({
      customers: { create: async () => ({ id: 'cus_fresh_ar' }) },
      checkout: {
        sessions: {
          create: async () => ({ url: 'https://checkout.stripe.com/fake_ar', id: 'cs_ar' }),
        },
      },
    });

    const checkoutRes = await request(app)
      .post('/billing/checkout-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'web' });

    assert.notStrictEqual(checkoutRes.status, 409,
      'canceled subscription must not block new checkout');
    assert.strictEqual(checkoutRes.status, 200);
    assert.ok(checkoutRes.body.checkoutUrl);
  });
});
