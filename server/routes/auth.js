'use strict';

const { Router }               = require('express');
const { randomBytes, createHash } = require('crypto');
const bcrypt                   = require('bcryptjs');
const rateLimit                = require('express-rate-limit');
const { getPool }              = require('../db');
const { requireAuth, SESSION_TTL_MS } = require('../auth');
const { hasAccess }            = require('./billing');
const { sendPasswordResetEmail } = require('../services/email');

// Tighter rate limit for the forgot-password endpoint to limit email-bomb
// and user-enumeration-via-timing attacks.  Disabled in tests via DISABLE_RATE_LIMIT.
const forgotPasswordLimit = (() => {
  if (process.env.DISABLE_RATE_LIMIT === 'true') return (_req, _res, next) => next();
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max:      5,
    standardHeaders: true,
    legacyHeaders:   false,
    message: { error: 'Too many password reset requests, please try again later.' },
  });
})();

const router = Router();
const BCRYPT_ROUNDS = 12;
const EMAIL_RE      = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const wrap = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ── POST /auth/register ────────────────────────────────────────────────────
router.post('/register', wrap(async (req, res) => {
  const { email, password } = req.body ?? {};

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const pool           = getPool();
  const normalizedEmail = email.toLowerCase().trim();

  const { rows: existing } = await pool.query(
    'SELECT id FROM users WHERE email = $1',
    [normalizedEmail]
  );
  if (existing.length > 0) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const hash  = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const now   = Date.now();
  const token = randomBytes(32).toString('hex');

  let newUserId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [user] } = await client.query(
      'INSERT INTO users (email, password_hash, created_at, updated_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [normalizedEmail, hash, now, now]
    );
    newUserId = user.id;

    await client.query(
      'INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES ($1, $2, $3, $4)',
      [user.id, token, now, now + SESSION_TTL_MS]
    );

    await client.query(
      `INSERT INTO free_publications (user_id, status, created_at, updated_at)
       VALUES ($1, 'available', $2, $2)`,
      [user.id, now]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return res.status(201).json({ token, expiresAt: now + SESSION_TTL_MS, userId: newUserId });
}));

// ── POST /auth/login ───────────────────────────────────────────────────────
router.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE email = $1',
    [email.toLowerCase().trim()]
  );
  const user = rows[0];

  if (!user) {
    // Consume the same time as a real comparison to prevent user-enumeration via timing.
    await bcrypt.hash(password, BCRYPT_ROUNDS);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const now   = Date.now();
  const token = randomBytes(32).toString('hex');
  await pool.query(
    'INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES ($1, $2, $3, $4)',
    [user.id, token, now, now + SESSION_TTL_MS]
  );

  return res.json({ token, expiresAt: now + SESSION_TTL_MS, userId: user.id });
}));

// ── POST /auth/logout ──────────────────────────────────────────────────────
router.post('/logout', requireAuth, wrap(async (req, res) => {
  const token = req.headers['authorization'].slice(7);
  await getPool().query('DELETE FROM sessions WHERE token = $1', [token]);
  return res.json({ ok: true });
}));

// ── GET /auth/me ───────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  return res.json({ userId: req.userId, email: req.userEmail });
});

// ── POST /auth/onboarding/complete ─────────────────────────────────────────
router.post('/onboarding/complete', requireAuth, wrap(async (req, res) => {
  const pool = getPool();
  const now  = Date.now();
  const { rows } = await pool.query(
    'SELECT settings_json FROM business_settings WHERE user_id = $1',
    [req.userId]
  );
  let settings = {};
  if (rows.length > 0) {
    try { settings = JSON.parse(rows[0].settings_json || '{}'); } catch { /* ignore */ }
  }
  settings.onboarding_completed = true;
  await pool.query(
    `INSERT INTO business_settings (user_id, settings_json, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET settings_json = $2, updated_at = $3`,
    [req.userId, JSON.stringify(settings), now]
  );
  return res.json({ ok: true });
}));

// ── GET /auth/settings ─────────────────────────────────────────────────────
// Returns the caller's business settings (profile fields) and the current
// settings_version.  The mobile app uses this to sync settings to a new device
// and to detect concurrent updates before issuing a PATCH.
router.get('/settings', requireAuth, wrap(async (req, res) => {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT settings_json, settings_version FROM business_settings WHERE user_id = $1',
    [req.userId]
  );
  if (rows.length === 0) {
    return res.json({ settings: {}, version: 0 });
  }
  let settings = {};
  try { settings = JSON.parse(rows[0].settings_json || '{}'); } catch { /* ignore */ }
  return res.json({ settings, version: rows[0].settings_version ?? 0 });
}));

// ── PATCH /auth/settings ───────────────────────────────────────────────────
// Partially updates business settings with optimistic concurrency control.
// Body: { settings: {...partial fields...}, version: N }
//   - If version matches (or row doesn't exist yet): merge fields, increment
//     version, return { settings, version }.
//   - If version mismatches: 409 with { error: 'version_conflict', current: {settings, version} }.
// Unrecognised keys in settings are accepted (forward-compat for older servers).
// Internal-only key "onboarding_completed" is preserved when present.
router.patch('/settings', requireAuth, wrap(async (req, res) => {
  const { settings: incoming, version: clientVersion } = req.body ?? {};
  if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'settings must be an object' });
  }
  if (typeof clientVersion !== 'number') {
    return res.status(400).json({ error: 'version must be a number' });
  }

  const pool   = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT settings_json, settings_version FROM business_settings WHERE user_id = $1 FOR UPDATE',
      [req.userId]
    );

    const now            = Date.now();
    let   existing       = {};
    let   currentVersion = 0;

    if (rows.length > 0) {
      try { existing = JSON.parse(rows[0].settings_json || '{}'); } catch { /* ignore */ }
      currentVersion = rows[0].settings_version ?? 0;
    }

    if (currentVersion !== clientVersion) {
      await client.query('COMMIT');
      return res.status(409).json({
        error:   'version_conflict',
        current: { settings: existing, version: currentVersion },
      });
    }

    const merged      = { ...existing, ...incoming };
    const newVersion  = currentVersion + 1;

    await client.query(
      `INSERT INTO business_settings (user_id, settings_json, settings_version, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET settings_json    = $2,
             settings_version = $3,
             updated_at       = $4`,
      [req.userId, JSON.stringify(merged), newVersion, now]
    );

    await client.query('COMMIT');
    return res.json({ settings: merged, version: newVersion });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── DELETE /auth/history ───────────────────────────────────────────────────
// Deletes the caller's publishing records. Local job data is managed client-side.
router.delete('/history', requireAuth, wrap(async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    'DELETE FROM publishing_records WHERE user_id = $1',
    [req.userId]
  );
  return res.json({ ok: true, deleted: result.rowCount });
}));

// ── DELETE /auth/account ───────────────────────────────────────────────────
// Permanently deletes the account. Cascades to sessions, business_settings,
// connected_platforms, oauth_states, and publishing_records via ON DELETE CASCADE.
router.delete('/account', requireAuth, wrap(async (req, res) => {
  const pool = getPool();

  const { rows: subRows } = await pool.query(
    'SELECT status, current_period_end FROM subscriptions WHERE user_id = $1',
    [req.userId]
  );
  if (hasAccess(subRows[0])) {
    return res.status(409).json({
      error: 'active_subscription',
      message: 'This account has an active subscription. Cancel your subscription before deleting your account.',
    });
  }

  const result = await pool.query(
    'DELETE FROM users WHERE id = $1',
    [req.userId]
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Account not found' });
  }
  return res.json({ ok: true });
}));

// ── POST /auth/forgot-password ─────────────────────────────────────────────
// Initiates the password reset flow by emailing a one-time reset link.
// Always returns 200 regardless of whether the email address is registered,
// to prevent user enumeration.  The raw token is never logged.
router.post('/forgot-password', forgotPasswordLimit, wrap(async (req, res) => {
  const { email } = req.body ?? {};

  // Return early for obviously invalid input — still 200 to avoid enumeration.
  if (!email || typeof email !== 'string') {
    return res.json({ ok: true });
  }

  const pool            = getPool();
  const normalizedEmail = email.toLowerCase().trim();

  const { rows } = await pool.query(
    'SELECT id FROM users WHERE email = $1',
    [normalizedEmail]
  );

  if (rows.length === 0) {
    return res.json({ ok: true }); // unknown email — silent no-op
  }

  const userId = rows[0].id;
  const now    = Date.now();

  // Invalidate any existing unused tokens for this user so older links stop
  // working immediately — avoids confusion when a user requests multiple times.
  await pool.query(
    'DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL',
    [userId]
  );

  const rawToken   = randomBytes(32).toString('hex');
  const tokenHash  = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt  = now + 60 * 60 * 1000; // 1 hour

  await pool.query(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt]
  );

  const portalUrl  = process.env.BILLING_PORTAL_URL ?? 'https://billing.getelmer.com';
  const resetUrl   = `${portalUrl}/reset-password?token=${rawToken}`;

  // sendPasswordResetEmail is a no-op when RESEND_API_KEY is absent (dev/test).
  await sendPasswordResetEmail(normalizedEmail, resetUrl);

  return res.json({ ok: true });
}));

// ── POST /auth/reset-password ──────────────────────────────────────────────
// Consumes a one-time reset token, updates the password, and invalidates all
// existing sessions.  Returns a fresh session token so the portal can
// auto-sign-in the user without an extra round trip.
router.post('/reset-password', wrap(async (req, res) => {
  const { token, newPassword } = req.body ?? {};

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'invalid_or_expired_token' });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const now       = Date.now();
  const pool      = getPool();
  const client    = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock the row to prevent concurrent redemptions.
    const { rows } = await client.query(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND expires_at > $2 AND used_at IS NULL
       FOR UPDATE`,
      [tokenHash, now]
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return res.status(400).json({ error: 'invalid_or_expired_token' });
    }

    const { id: tokenId, user_id: userId } = rows[0];

    // Mark token used — prevents replay even if someone retains the raw token.
    await client.query(
      'UPDATE password_reset_tokens SET used_at = $1 WHERE id = $2',
      [now, tokenId]
    );

    // Update password.
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await client.query(
      'UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3',
      [passwordHash, now, userId]
    );

    // Invalidate all existing sessions (compromised credentials are revoked).
    await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

    // Issue a new session so the portal can auto-sign-in.
    const newToken = randomBytes(32).toString('hex');
    await client.query(
      'INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES ($1, $2, $3, $4)',
      [userId, newToken, now, now + SESSION_TTL_MS]
    );

    await client.query('COMMIT');

    return res.json({ ok: true, token: newToken, expiresAt: now + SESSION_TTL_MS });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
