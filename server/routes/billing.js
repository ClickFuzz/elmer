'use strict';

const express = require('express');
const { getPool } = require('../db');
const { requireAuth } = require('../auth');

// ── Configuration ─────────────────────────────────────────────────────────────

// Set STRIPE_TEST_MODE=true in Railway to use test keys instead of live keys.
const isTestMode = () => process.env.STRIPE_TEST_MODE === 'true';

const STRIPE_SECRET_KEY     = () => isTestMode()
  ? process.env.STRIPE_TEST_SECRET_KEY
  : process.env.STRIPE_SECRET_KEY;

const STRIPE_WEBHOOK_SECRET = () => isTestMode()
  ? process.env.STRIPE_TEST_WEBHOOK_SECRET
  : process.env.STRIPE_WEBHOOK_SECRET;

const STRIPE_PRICE_ID       = () => isTestMode()
  ? process.env.STRIPE_TEST_PRICE_ID
  : process.env.STRIPE_PRICE_ID;

const APP_URL              = () => process.env.APP_URL ?? 'https://api.getelmer.com';
const APP_SCHEME           = () => process.env.APP_SCHEME ?? 'elmer';

// Stripe statuses that grant full access
const ACCESS_STATUSES = new Set(['trialing', 'active']);
// Grace period for past_due before access is revoked (3 days)
const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

// ── Entitlement helpers ───────────────────────────────────────────────────────

function hasAccess(sub) {
  if (!sub || !sub.status) return false;
  if (ACCESS_STATUSES.has(sub.status)) return true;
  if (sub.status === 'past_due' && sub.current_period_end) {
    return Date.now() < Number(sub.current_period_end) + GRACE_PERIOD_MS;
  }
  return false;
}

// Middleware: require active subscription (always expects req.userId from requireAuth)
async function requireSubscription(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const { rows } = await getPool().query(
      'SELECT status, current_period_end FROM subscriptions WHERE user_id = $1',
      [req.userId]
    );
    if (!hasAccess(rows[0])) {
      return res.status(402).json({
        error: 'subscription_required',
        message: 'An active subscription is required.',
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Middleware: allow generation for subscribers OR users with an unused free publication.
// Sets nothing on req — generation does not reserve the free slot.
async function requireGenerationAccess(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const { access } = await getEntitlement(req.userId);
    if (access === 'subscription' || access === 'free_available' || access === 'free_reserved') {
      return next();
    }
    return res.status(402).json({
      error: 'SUBSCRIPTION_REQUIRED',
      message: 'Your free post has been used. Start a trial to keep posting.',
    });
  } catch (err) {
    next(err);
  }
}

// Middleware: preliminary access check for publish endpoints (fires before multer).
// Sets req.publishIsSubscribed = true for paying users, false for free-publication users.
// Blocked users (free slot redeemed, no subscription) receive 402 immediately.
async function requirePublishPreliminaryAccess(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  try {
    const { access } = await getEntitlement(req.userId);
    if (access === 'subscription') {
      req.publishIsSubscribed = true;
      return next();
    }
    if (access === 'free_available' || access === 'free_reserved') {
      req.publishIsSubscribed = false;
      return next();
    }
    return res.status(402).json({
      error: 'SUBSCRIPTION_REQUIRED',
      message: 'Your free post has been used. Start a trial to keep posting.',
    });
  } catch (err) {
    next(err);
  }
}

// ── Free-publication entitlement ──────────────────────────────────────────────

// Returns a structured entitlement for a user, checking subscription first.
// access values:
//   'subscription'         — active trial or paid subscription
//   'free_available'       — no subscription, free publication slot available
//   'free_reserved'        — free slot is in-flight for a job
//   'free_redeemed'        — free slot has been used; subscription required
//   'subscription_required'— no subscription, no free slot
async function getEntitlement(userId) {
  const pool = getPool();

  const { rows: subRows } = await pool.query(
    'SELECT status, current_period_end FROM subscriptions WHERE user_id = $1',
    [userId]
  );
  if (hasAccess(subRows[0])) return { access: 'subscription' };

  const { rows: fpRows } = await pool.query(
    'SELECT status, job_key FROM free_publications WHERE user_id = $1',
    [userId]
  );
  if (fpRows.length === 0) return { access: 'free_available' }; // safe default for new users

  switch (fpRows[0].status) {
    case 'available': return { access: 'free_available' };
    case 'reserved':  return { access: 'free_reserved', jobKey: fpRows[0].job_key };
    case 'redeemed':  return { access: 'free_redeemed' };
    default:          return { access: 'subscription_required' };
  }
}

// Atomically reserve the free publication for a job.
// Returns true if reservation is now held for this jobKey (new or idempotent).
// Returns false if the user has an active subscription (no reservation needed),
// the slot is already redeemed, or no slot exists.
async function tryReserveFreePublication(userId, jobKey) {
  const pool = getPool();

  // Paying users don't consume the free slot
  const { rows: subRows } = await pool.query(
    'SELECT status, current_period_end FROM subscriptions WHERE user_id = $1',
    [userId]
  );
  if (hasAccess(subRows[0])) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT id, status, job_key FROM free_publications WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const fp = rows[0];
    if (!fp) { await client.query('COMMIT'); return false; }

    // Idempotent: already reserved for this exact job
    if (fp.status === 'reserved' && fp.job_key === jobKey) {
      await client.query('COMMIT');
      return true;
    }

    if (fp.status !== 'available') { await client.query('COMMIT'); return false; }

    const now = Date.now();
    await client.query(
      `UPDATE free_publications
       SET status = 'reserved', job_key = $1, reserved_at = $2, updated_at = $2
       WHERE user_id = $3`,
      [jobKey, now, userId]
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Redeem the free publication after a successful publish.
// Only transitions reserved→redeemed for the matching jobKey.
async function redeemFreePublication(userId, jobKey) {
  const now = Date.now();
  await getPool().query(
    `UPDATE free_publications
     SET status = 'redeemed', redeemed_at = $3, updated_at = $3
     WHERE user_id = $1 AND status = 'reserved' AND job_key = $2`,
    [userId, jobKey, now]
  );
}

// Release the reservation if no platform has published successfully for this job.
// Uses a transaction to avoid releasing when a concurrent platform just succeeded.
async function releaseFreePublicationIfNoSuccess(userId, jobKey) {
  const pool   = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT id, status, job_key FROM free_publications WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const fp = rows[0];
    if (!fp || fp.status !== 'reserved' || fp.job_key !== jobKey) {
      await client.query('COMMIT');
      return;
    }

    // Check if any platform succeeded for this job via client_job_id
    const { rows: successRows } = await client.query(
      `SELECT 1 FROM publishing_records
       WHERE user_id = $1 AND status = 'published' AND client_job_id = $2 LIMIT 1`,
      [userId, jobKey]
    );

    const now = Date.now();
    if (successRows.length > 0) {
      // Another platform succeeded — redeem instead of releasing
      await client.query(
        `UPDATE free_publications
         SET status = 'redeemed', redeemed_at = $2, updated_at = $2
         WHERE user_id = $1`,
        [userId, now]
      );
    } else {
      // All platforms failed — release back to available
      await client.query(
        `UPDATE free_publications
         SET status = 'available', job_key = null, reserved_at = null, updated_at = $2
         WHERE user_id = $1`,
        [userId, now]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Stripe helpers ────────────────────────────────────────────────────────────

function getStripe() {
  const key = STRIPE_SECRET_KEY();
  if (!key) throw new Error('[billing] STRIPE_SECRET_KEY is not set');
  // Require Stripe only when used so that tests without the key can still load the module
  return require('stripe')(key);
}

async function getOrCreateStripeCustomer(userId, userEmail) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT customer_id FROM stripe_customers WHERE user_id = $1',
    [userId]
  );
  if (rows.length > 0) return rows[0].customer_id;

  const stripe = getStripe();
  const customer = await stripe.customers.create(
    { email: userEmail, metadata: { elmer_user_id: String(userId) } },
    { idempotencyKey: `create_customer_${userId}` }
  );

  const now = Date.now();
  await pool.query(
    `INSERT INTO stripe_customers (user_id, customer_id, created_at, updated_at)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (user_id) DO UPDATE SET customer_id = $2, updated_at = $3`,
    [userId, customer.id, now]
  );
  return customer.id;
}

// Upsert subscription state from a Stripe subscription object.
// trial_used is sticky — once true it stays true.
async function upsertSubscriptionFromStripe(stripeSub) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT user_id FROM stripe_customers WHERE customer_id = $1',
    [stripeSub.customer]
  );
  if (rows.length === 0) {
    console.warn('[billing] webhook: no user found for Stripe customer', stripeSub.customer);
    return;
  }
  const userId = rows[0].user_id;
  const now    = Date.now();

  await pool.query(
    `INSERT INTO subscriptions
       (user_id, stripe_subscription_id, stripe_customer_id, status,
        current_period_start, current_period_end, trial_start, trial_end,
        cancel_at_period_end, cancel_at, canceled_at, trial_used, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
     ON CONFLICT (user_id) DO UPDATE SET
       stripe_subscription_id = $2,
       stripe_customer_id     = $3,
       status                 = $4,
       current_period_start   = $5,
       current_period_end     = $6,
       trial_start            = $7,
       trial_end              = $8,
       cancel_at_period_end   = $9,
       cancel_at              = $10,
       canceled_at            = $11,
       trial_used             = CASE WHEN $12 THEN true ELSE subscriptions.trial_used END,
       updated_at             = $13`,
    [
      userId,
      stripeSub.id,
      stripeSub.customer,
      stripeSub.status,
      stripeSub.current_period_start ? stripeSub.current_period_start * 1000 : null,
      stripeSub.current_period_end   ? stripeSub.current_period_end   * 1000 : null,
      stripeSub.trial_start          ? stripeSub.trial_start          * 1000 : null,
      stripeSub.trial_end            ? stripeSub.trial_end            * 1000 : null,
      stripeSub.cancel_at_period_end ?? false,
      stripeSub.cancel_at   ? stripeSub.cancel_at   * 1000 : null,
      stripeSub.canceled_at ? stripeSub.canceled_at * 1000 : null,
      stripeSub.trial_start != null, // trial_used = true when a trial was ever started
      now,
    ]
  );
}

// ── Webhook event handler ─────────────────────────────────────────────────────

async function handleWebhookEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'subscription' || !session.subscription) break;

      // US-only restriction: cancel if billing address is outside the US
      const country = session.customer_details?.address?.country;
      if (country && country !== 'US') {
        console.warn('[billing] Non-US checkout rejected, canceling subscription:', country);
        try {
          await getStripe().subscriptions.cancel(session.subscription);
          await getPool().query(
            `UPDATE subscriptions SET status = 'canceled', canceled_at = $2, updated_at = $3
             WHERE stripe_subscription_id = $1`,
            [session.subscription, Date.now(), Date.now()]
          );
        } catch (err) {
          console.error('[billing] Failed to cancel non-US subscription:', err.message);
        }
        break;
      }

      // Fetch fresh subscription state from Stripe (not stale event snapshot)
      const sub = await getStripe().subscriptions.retrieve(session.subscription);
      await upsertSubscriptionFromStripe(sub);
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      // Always re-fetch to avoid out-of-order event data
      const sub = await getStripe().subscriptions.retrieve(event.data.object.id);
      await upsertSubscriptionFromStripe(sub);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const now = Date.now();
      await getPool().query(
        `UPDATE subscriptions
         SET status = 'canceled', canceled_at = $2, updated_at = $3
         WHERE stripe_subscription_id = $1`,
        [sub.id, sub.canceled_at ? sub.canceled_at * 1000 : now, now]
      );
      break;
    }

    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      if (invoice.subscription) {
        const sub = await getStripe().subscriptions.retrieve(invoice.subscription);
        await upsertSubscriptionFromStripe(sub);
      }
      break;
    }

    default:
      // Unhandled event type — safe to ignore
      break;
  }
}

// ── Router factory ────────────────────────────────────────────────────────────

function createBillingRouter() {
  const router = express.Router();

  // GET /billing/subscription — current subscription status for authenticated user
  router.get('/subscription', requireAuth, async (req, res) => {
    try {
      const { rows } = await getPool().query(
        `SELECT status, current_period_start, current_period_end,
                trial_start, trial_end, cancel_at_period_end,
                cancel_at, canceled_at, trial_used
         FROM subscriptions WHERE user_id = $1`,
        [req.userId]
      );
      const sub        = rows[0] ?? null;
      const entitlement = await getEntitlement(req.userId);
      res.json({
        hasAccess: hasAccess(sub),
        entitlement,
        subscription: sub ? {
          status:             sub.status,
          currentPeriodStart: sub.current_period_start,
          currentPeriodEnd:   sub.current_period_end,
          trialStart:         sub.trial_start,
          trialEnd:           sub.trial_end,
          cancelAtPeriodEnd:  sub.cancel_at_period_end,
          cancelAt:           sub.cancel_at,
          canceledAt:         sub.canceled_at,
          trialUsed:          sub.trial_used,
        } : null,
      });
    } catch (err) {
      console.error('[billing] subscription status error:', err);
      res.status(500).json({ error: 'Failed to load subscription status' });
    }
  });

  // GET /billing/entitlement — lightweight entitlement check for authenticated user
  router.get('/entitlement', requireAuth, async (req, res) => {
    try {
      const entitlement = await getEntitlement(req.userId);
      res.json(entitlement);
    } catch (err) {
      console.error('[billing] entitlement error:', err);
      res.status(500).json({ error: 'Failed to load entitlement' });
    }
  });

  // POST /billing/checkout-session — create a Stripe Checkout session
  router.post('/checkout-session', requireAuth, async (req, res) => {
    const secretKey = STRIPE_SECRET_KEY();
    const priceId   = STRIPE_PRICE_ID();
    if (!secretKey) return res.status(503).json({ error: 'billing_not_configured' });
    if (!priceId)   return res.status(503).json({ error: 'stripe_price_not_configured' });

    try {
      // Prevent creating a new checkout if an active subscription already exists
      const { rows: activeSubs } = await getPool().query(
        `SELECT status FROM subscriptions
         WHERE user_id = $1 AND status IN ('trialing','active','past_due')`,
        [req.userId]
      );
      if (activeSubs.length > 0) {
        return res.status(409).json({
          error: 'active_subscription_exists',
          message: 'You already have an active subscription.',
        });
      }

      const customerId = await getOrCreateStripeCustomer(req.userId, req.userEmail);

      // Determine trial eligibility — trial is blocked if one was previously used
      const { rows: subRows } = await getPool().query(
        'SELECT trial_used FROM subscriptions WHERE user_id = $1',
        [req.userId]
      );
      const trialUsed    = subRows[0]?.trial_used ?? false;
      const appUrl       = APP_URL();

      const session = await getStripe().checkout.sessions.create({
        customer:                   customerId,
        mode:                       'subscription',
        line_items:                 [{ price: priceId, quantity: 1 }],
        success_url:                `${appUrl}/billing/checkout-return?status=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:                 `${appUrl}/billing/checkout-return?status=cancel`,
        payment_method_collection:  'always',
        billing_address_collection: 'required',
        subscription_data: {
          metadata:         { elmer_user_id: String(req.userId) },
          ...(trialUsed ? {} : { trial_period_days: 14 }),
        },
        metadata:        { elmer_user_id: String(req.userId) },
        locale:          'en',
        customer_update: { address: 'auto' },
      }, { idempotencyKey: `checkout_${req.userId}_${Date.now()}` });

      res.json({ checkoutUrl: session.url, sessionId: session.id, trialEligible: !trialUsed });
    } catch (err) {
      console.error('[billing] checkout-session error:', err);
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  // POST /billing/portal-session — create a Stripe Customer Portal session
  router.post('/portal-session', requireAuth, async (req, res) => {
    if (!STRIPE_SECRET_KEY()) return res.status(503).json({ error: 'billing_not_configured' });

    try {
      const { rows } = await getPool().query(
        'SELECT customer_id FROM stripe_customers WHERE user_id = $1',
        [req.userId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'no_billing_account' });
      }

      const appUrl  = APP_URL();
      const session = await getStripe().billingPortal.sessions.create({
        customer:   rows[0].customer_id,
        return_url: `${appUrl}/billing/checkout-return?status=portal_return`,
      });

      res.json({ portalUrl: session.url });
    } catch (err) {
      console.error('[billing] portal-session error:', err);
      res.status(500).json({ error: 'Failed to create portal session' });
    }
  });

  // GET /billing/checkout-return — redirects back to the app's deep link
  // Called by Stripe after checkout success/cancel, and by portal return
  router.get('/checkout-return', (req, res) => {
    const status = req.query.status ?? 'unknown';
    const scheme = APP_SCHEME();
    res.redirect(`${scheme}://billing/return?status=${status}`);
  });

  // POST /billing/webhook — Stripe webhook event receiver
  // MUST be mounted with express.raw() in app.js (before express.json())
  router.post('/webhook', async (req, res) => {
    const webhookSecret = STRIPE_WEBHOOK_SECRET();
    let event;

    if (webhookSecret) {
      try {
        event = getStripe().webhooks.constructEvent(
          req.body,
          req.headers['stripe-signature'],
          webhookSecret
        );
      } catch (err) {
        console.error('[billing] webhook signature invalid:', err.message);
        return res.status(400).json({ error: 'Invalid webhook signature' });
      }
    } else {
      // Dev mode only: accept unsigned events; never allowed in production
      if (process.env.NODE_ENV === 'production') {
        return res.status(400).json({ error: 'Webhook secret required in production' });
      }
      try {
        const raw = req.body;
        event = Buffer.isBuffer(raw) ? JSON.parse(raw.toString())
              : typeof raw === 'string' ? JSON.parse(raw)
              : raw;
      } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
      }
      console.warn('[billing] STRIPE_WEBHOOK_SECRET not set — signature check skipped (dev only)');
    }

    try {
      await handleWebhookEvent(event);
      res.json({ received: true });
    } catch (err) {
      console.error('[billing] webhook handler error:', err);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return router;
}

module.exports = {
  createBillingRouter,
  requireSubscription,
  requireGenerationAccess,
  requirePublishPreliminaryAccess,
  hasAccess,
  getEntitlement,
  tryReserveFreePublication,
  redeemFreePublication,
  releaseFreePublicationIfNoSuccess,
};
