'use strict';

// Tests for RC sandbox policy (isSandboxAllowed) and its enforcement in
// handleRcWebhookEvent and POST /billing/rc-verify-purchase.
//
// STRIPE_TEST_MODE is intentionally left unset (defaults to false) so these
// tests exercise the production-mode code paths.

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
// Intentionally NOT setting STRIPE_TEST_MODE — tests run in production mode.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');

const { setupFreshTestDb } = require('./helpers');
const { getPool, closeDb } = require('../db');
const { createApp }        = require('../app');
const {
  isSandboxAllowed,
  handleRcWebhookEvent,
  _setRcVerifyFetchForTest,
  _clearRcVerifyFetchForTest,
} = require('../routes/billing');

let app;

before(async () => {
  await setupFreshTestDb();
  app = createApp();
});

after(async () => closeDb());

beforeEach(async () => {
  // Clear any env overrides left by previous tests
  delete process.env.RC_ALLOW_SANDBOX;
  delete process.env.RC_SANDBOX_USER_IDS;
  _clearRcVerifyFetchForTest();
  await setupFreshTestDb();
  app = createApp();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function register(email = 'user@example.com', password = 'password123') {
  const res = await request(app).post('/auth/register').send({ email, password });
  assert.equal(res.status, 201, `register failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, userId: res.body.userId ?? null };
}

async function getUserId(email) {
  const { rows } = await getPool().query('SELECT id FROM users WHERE email = $1', [email]);
  return rows[0]?.id;
}

function makeFutureMs(daysAhead = 30) {
  return Date.now() + daysAhead * 24 * 60 * 60 * 1000;
}

function makeRcResponse({ store_transaction_id = 'txn_sandbox_1', period_type = 'normal',
  expires_date = null, is_sandbox = false } = {}) {
  return {
    subscriber: {
      subscriptions: {
        'com.elmer.monthly': {
          store_transaction_id,
          period_type,
          expires_date,
          unsubscribe_detected_at: null,
          grace_period_expires_date: null,
          refunded_at: null,
          original_purchase_date: null,
          is_sandbox,
        },
      },
    },
  };
}

function makeWebhookEvent({ app_user_id, id = null, type = 'INITIAL_PURCHASE',
  store = 'APP_STORE', original_transaction_id = 'txn_sandbox_1' } = {}) {
  return { id, type, app_user_id, store, original_transaction_id };
}

async function getSubscriptionRows(userId) {
  const { rows } = await getPool().query(
    'SELECT status, provider FROM subscriptions WHERE user_id = $1', [userId]
  );
  return rows;
}

// ── isSandboxAllowed unit tests ───────────────────────────────────────────────

describe('isSandboxAllowed()', () => {
  it('returns false by default in production mode (no env vars set)', () => {
    assert.equal(isSandboxAllowed(null), false);
    assert.equal(isSandboxAllowed(1), false);
    assert.equal(isSandboxAllowed(999), false);
  });

  it('returns true for all users when RC_ALLOW_SANDBOX=true (staging)', () => {
    process.env.RC_ALLOW_SANDBOX = 'true';
    assert.equal(isSandboxAllowed(null), true);
    assert.equal(isSandboxAllowed(1), true);
    assert.equal(isSandboxAllowed(999), true);
  });

  it('is case-insensitive for RC_ALLOW_SANDBOX', () => {
    process.env.RC_ALLOW_SANDBOX = 'TRUE';
    assert.equal(isSandboxAllowed(1), true);
    process.env.RC_ALLOW_SANDBOX = 'True';
    assert.equal(isSandboxAllowed(1), true);
  });

  it('returns false when RC_ALLOW_SANDBOX is not "true"', () => {
    process.env.RC_ALLOW_SANDBOX = 'false';
    assert.equal(isSandboxAllowed(1), false);
    process.env.RC_ALLOW_SANDBOX = '1';
    assert.equal(isSandboxAllowed(1), false);
    process.env.RC_ALLOW_SANDBOX = 'yes';
    assert.equal(isSandboxAllowed(1), false);
  });

  it('returns true for listed user IDs in RC_SANDBOX_USER_IDS', () => {
    process.env.RC_SANDBOX_USER_IDS = '1,2,10';
    assert.equal(isSandboxAllowed(1), true);
    assert.equal(isSandboxAllowed(2), true);
    assert.equal(isSandboxAllowed(10), true);
  });

  it('returns false for user IDs not in RC_SANDBOX_USER_IDS', () => {
    process.env.RC_SANDBOX_USER_IDS = '1,2';
    assert.equal(isSandboxAllowed(3), false);
    assert.equal(isSandboxAllowed(99), false);
    assert.equal(isSandboxAllowed(null), false);
  });

  it('ignores invalid entries in RC_SANDBOX_USER_IDS', () => {
    // "1, abc, -5, 0, 7" → parseInt → [1, NaN, -5, 0, 7]
    // filter (isFinite && > 0) → {1, 7}
    process.env.RC_SANDBOX_USER_IDS = '1, abc, -5, 0, 7';
    assert.equal(isSandboxAllowed(1), true,  'valid positive ID must be allowed');
    assert.equal(isSandboxAllowed(7), true,  'valid positive ID must be allowed');
    assert.equal(isSandboxAllowed(5), false, 'ID not in list must be rejected');
    // abc → NaN → filtered; -5 and 0 → not > 0 → filtered
    assert.equal(isSandboxAllowed(null), false, 'null userId must be rejected');
  });

  it('STRIPE_TEST_MODE=true overrides everything (backward compat)', () => {
    const orig = process.env.STRIPE_TEST_MODE;
    process.env.STRIPE_TEST_MODE = 'true';
    try {
      assert.equal(isSandboxAllowed(null), true);
      assert.equal(isSandboxAllowed(999), true);
    } finally {
      if (orig === undefined) delete process.env.STRIPE_TEST_MODE;
      else process.env.STRIPE_TEST_MODE = orig;
    }
  });

  it('RC_ALLOW_SANDBOX does not affect non-sandbox purchases (not relevant to allow check)', () => {
    // isSandboxAllowed gates sandbox receipts; non-sandbox receipts bypass the check entirely.
    // Here we confirm isSandboxAllowed=true when RC_ALLOW_SANDBOX is set — the caller
    // only consults it when mappedRow.isSandbox is true.
    process.env.RC_ALLOW_SANDBOX = 'true';
    assert.equal(isSandboxAllowed(1), true);
  });
});

// ── handleRcWebhookEvent sandbox policy ──────────────────────────────────────

describe('handleRcWebhookEvent() sandbox policy', () => {
  it('blocks sandbox event by default in production mode (no env vars)', async () => {
    await register('wh_blocked@example.com');
    const userId = await getUserId('wh_blocked@example.com');
    const future = new Date(makeFutureMs(30)).toISOString();

    const stubFetch = async () => makeRcResponse({ expires_date: future, is_sandbox: true });
    await handleRcWebhookEvent(
      makeWebhookEvent({ app_user_id: String(userId) }),
      { _fetchSubscriber: stubFetch }
    );

    const rows = await getSubscriptionRows(userId);
    assert.equal(rows.length, 0, 'sandbox webhook must not insert row in production mode');
  });

  it('allows sandbox event when RC_ALLOW_SANDBOX=true (staging)', async () => {
    process.env.RC_ALLOW_SANDBOX = 'true';
    await register('wh_staging@example.com');
    const userId = await getUserId('wh_staging@example.com');
    const future = new Date(makeFutureMs(30)).toISOString();

    const stubFetch = async () => makeRcResponse({ expires_date: future, is_sandbox: true });
    await handleRcWebhookEvent(
      makeWebhookEvent({ app_user_id: String(userId) }),
      { _fetchSubscriber: stubFetch }
    );

    const rows = await getSubscriptionRows(userId);
    assert.equal(rows.length, 1, 'sandbox webhook must insert row when RC_ALLOW_SANDBOX=true');
    assert.equal(rows[0].provider, 'apple');
  });

  it('allows sandbox event for allowlisted user (RC_SANDBOX_USER_IDS)', async () => {
    await register('wh_allowlisted@example.com');
    const userId = await getUserId('wh_allowlisted@example.com');
    process.env.RC_SANDBOX_USER_IDS = String(userId);
    const future = new Date(makeFutureMs(30)).toISOString();

    const stubFetch = async () => makeRcResponse({ expires_date: future, is_sandbox: true });
    await handleRcWebhookEvent(
      makeWebhookEvent({ app_user_id: String(userId) }),
      { _fetchSubscriber: stubFetch }
    );

    const rows = await getSubscriptionRows(userId);
    assert.equal(rows.length, 1, 'sandbox webhook must insert row for allowlisted user');
  });

  it('blocks sandbox event for non-allowlisted user even when list is non-empty', async () => {
    await register('wh_notlisted@example.com');
    const userId = await getUserId('wh_notlisted@example.com');

    await register('wh_other@example.com');
    const otherId = await getUserId('wh_other@example.com');
    // otherId is on the list, userId is not
    process.env.RC_SANDBOX_USER_IDS = String(otherId);
    const future = new Date(makeFutureMs(30)).toISOString();

    const stubFetch = async () => makeRcResponse({ expires_date: future, is_sandbox: true });
    await handleRcWebhookEvent(
      makeWebhookEvent({ app_user_id: String(userId) }),
      { _fetchSubscriber: stubFetch }
    );

    const rows = await getSubscriptionRows(userId);
    assert.equal(rows.length, 0, 'sandbox webhook must not insert row for non-allowlisted user');
  });

  it('always processes non-sandbox events regardless of sandbox policy', async () => {
    // RC_ALLOW_SANDBOX is NOT set — production defaults. Non-sandbox receipt must still work.
    await register('wh_prod@example.com');
    const userId = await getUserId('wh_prod@example.com');
    const future = new Date(makeFutureMs(30)).toISOString();

    const stubFetch = async () => makeRcResponse({ expires_date: future, is_sandbox: false });
    await handleRcWebhookEvent(
      makeWebhookEvent({ app_user_id: String(userId) }),
      { _fetchSubscriber: stubFetch }
    );

    const rows = await getSubscriptionRows(userId);
    assert.equal(rows.length, 1, 'production receipt must always be processed');
    assert.equal(rows[0].provider, 'apple');
  });

  it('sandbox allowlist is per-user — a sandbox event for user A cannot unlock user B', async () => {
    await register('wh_victimA@example.com');
    const victimId = await getUserId('wh_victimA@example.com');

    await register('wh_attackerB@example.com');
    const attackerId = await getUserId('wh_attackerB@example.com');

    // attacker is on the allowlist, victim is NOT
    process.env.RC_SANDBOX_USER_IDS = String(attackerId);
    const future = new Date(makeFutureMs(30)).toISOString();

    // Webhook event claims to be for the victim's user ID
    const stubFetch = async () => makeRcResponse({ expires_date: future, is_sandbox: true });
    await handleRcWebhookEvent(
      makeWebhookEvent({ app_user_id: String(victimId) }),
      { _fetchSubscriber: stubFetch }
    );

    const victimRows   = await getSubscriptionRows(victimId);
    const attackerRows = await getSubscriptionRows(attackerId);
    assert.equal(victimRows.length, 0, 'sandbox event must not unlock non-allowlisted victim');
    assert.equal(attackerRows.length, 0, 'attacker account must not receive victim subscription');
  });
});

// ── POST /billing/rc-verify-purchase sandbox policy ──────────────────────────

describe('POST /billing/rc-verify-purchase sandbox policy', () => {
  it('returns hasAccess=false for sandbox purchase in production mode (no env vars)', async () => {
    const { token } = await register('vp_blocked@example.com');
    const userId = await getUserId('vp_blocked@example.com');
    const future = new Date(makeFutureMs(30)).toISOString();

    process.env.REVENUECAT_SECRET_KEY = 'rc_test_key';
    _setRcVerifyFetchForTest(async () => makeRcResponse({ expires_date: future, is_sandbox: true }));

    const res = await request(app)
      .post('/billing/rc-verify-purchase')
      .set('Authorization', `Bearer ${token}`)
      .send({ store: 'APP_STORE' });

    assert.equal(res.status, 200);
    assert.equal(res.body.hasAccess, false, 'sandbox purchase must return hasAccess=false');

    const rows = await getSubscriptionRows(userId);
    assert.equal(rows.length, 0, 'sandbox verify-purchase must not insert row');

    delete process.env.REVENUECAT_SECRET_KEY;
  });

  it('returns hasAccess=true for sandbox purchase when RC_ALLOW_SANDBOX=true (staging)', async () => {
    process.env.RC_ALLOW_SANDBOX = 'true';
    const { token } = await register('vp_staging@example.com');
    const userId = await getUserId('vp_staging@example.com');
    const future = new Date(makeFutureMs(30)).toISOString();

    process.env.REVENUECAT_SECRET_KEY = 'rc_test_key';
    _setRcVerifyFetchForTest(async () => makeRcResponse({ expires_date: future, is_sandbox: true }));

    const res = await request(app)
      .post('/billing/rc-verify-purchase')
      .set('Authorization', `Bearer ${token}`)
      .send({ store: 'APP_STORE' });

    assert.equal(res.status, 200);
    assert.equal(res.body.hasAccess, true, 'sandbox purchase must succeed when RC_ALLOW_SANDBOX=true');

    const rows = await getSubscriptionRows(userId);
    assert.equal(rows.length, 1, 'row must be inserted');

    delete process.env.REVENUECAT_SECRET_KEY;
  });

  it('returns hasAccess=true for sandbox purchase when user is in RC_SANDBOX_USER_IDS', async () => {
    const { token } = await register('vp_allowlisted@example.com');
    const userId = await getUserId('vp_allowlisted@example.com');
    process.env.RC_SANDBOX_USER_IDS = String(userId);
    const future = new Date(makeFutureMs(30)).toISOString();

    process.env.REVENUECAT_SECRET_KEY = 'rc_test_key';
    _setRcVerifyFetchForTest(async () => makeRcResponse({ expires_date: future, is_sandbox: true }));

    const res = await request(app)
      .post('/billing/rc-verify-purchase')
      .set('Authorization', `Bearer ${token}`)
      .send({ store: 'APP_STORE' });

    assert.equal(res.status, 200);
    assert.equal(res.body.hasAccess, true, 'allowlisted user must receive access');

    const rows = await getSubscriptionRows(userId);
    assert.equal(rows.length, 1, 'row must be inserted for allowlisted user');

    delete process.env.REVENUECAT_SECRET_KEY;
  });

  it('returns hasAccess=false for sandbox when user is not in allowlist', async () => {
    const { token } = await register('vp_notlisted@example.com');
    const userId = await getUserId('vp_notlisted@example.com');

    await register('vp_other@example.com');
    const otherId = await getUserId('vp_other@example.com');
    process.env.RC_SANDBOX_USER_IDS = String(otherId); // only otherId listed, not userId

    const future = new Date(makeFutureMs(30)).toISOString();
    process.env.REVENUECAT_SECRET_KEY = 'rc_test_key';
    _setRcVerifyFetchForTest(async () => makeRcResponse({ expires_date: future, is_sandbox: true }));

    const res = await request(app)
      .post('/billing/rc-verify-purchase')
      .set('Authorization', `Bearer ${token}`)
      .send({ store: 'APP_STORE' });

    assert.equal(res.status, 200);
    assert.equal(res.body.hasAccess, false);

    const rows = await getSubscriptionRows(userId);
    assert.equal(rows.length, 0, 'row must not be inserted for non-allowlisted user');

    delete process.env.REVENUECAT_SECRET_KEY;
  });

  it('always processes non-sandbox (production) purchase regardless of sandbox policy', async () => {
    // No RC_ALLOW_SANDBOX, no RC_SANDBOX_USER_IDS — production defaults
    const { token } = await register('vp_prod@example.com');
    const userId = await getUserId('vp_prod@example.com');
    const future = new Date(makeFutureMs(30)).toISOString();

    process.env.REVENUECAT_SECRET_KEY = 'rc_test_key';
    _setRcVerifyFetchForTest(async () => makeRcResponse({ expires_date: future, is_sandbox: false }));

    const res = await request(app)
      .post('/billing/rc-verify-purchase')
      .set('Authorization', `Bearer ${token}`)
      .send({ store: 'APP_STORE' });

    assert.equal(res.status, 200);
    assert.equal(res.body.hasAccess, true);

    const rows = await getSubscriptionRows(userId);
    assert.equal(rows.length, 1);

    delete process.env.REVENUECAT_SECRET_KEY;
  });

  it('verify-purchase uses authenticated session — cannot unlock a different account', async () => {
    // User A is authenticated. The RC subscriber response (which could theoretically be
    // tampered with) contains a purchase. Verify-purchase always uses req.userId (session)
    // for both the sandbox policy check AND the DB upsert.
    const { token: tokenA } = await register('vp_sessionA@example.com');
    const userAId = await getUserId('vp_sessionA@example.com');

    await register('vp_sessionB@example.com');
    const userBId = await getUserId('vp_sessionB@example.com');

    // userBId is allowlisted; userAId is not
    process.env.RC_SANDBOX_USER_IDS = String(userBId);
    const future = new Date(makeFutureMs(30)).toISOString();

    process.env.REVENUECAT_SECRET_KEY = 'rc_test_key';
    // RC returns a subscription — but user A's session is what authenticated the request
    _setRcVerifyFetchForTest(async () => makeRcResponse({ expires_date: future, is_sandbox: true }));

    const res = await request(app)
      .post('/billing/rc-verify-purchase')
      .set('Authorization', `Bearer ${tokenA}`) // user A's token
      .send({ store: 'APP_STORE' });

    // User A is not allowlisted → sandbox rejected
    assert.equal(res.status, 200);
    assert.equal(res.body.hasAccess, false, 'non-allowlisted session must be rejected');

    // Neither account should have a subscription row
    const rowsA = await getSubscriptionRows(userAId);
    const rowsB = await getSubscriptionRows(userBId);
    assert.equal(rowsA.length, 0, 'user A must not receive access');
    assert.equal(rowsB.length, 0, 'user B must not receive access via user A session');

    delete process.env.REVENUECAT_SECRET_KEY;
  });
});
