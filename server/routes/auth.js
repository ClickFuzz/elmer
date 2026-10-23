'use strict';

const { Router }      = require('express');
const { randomBytes } = require('crypto');
const bcrypt          = require('bcryptjs');
const { getPool }     = require('../db');
const { requireAuth, SESSION_TTL_MS } = require('../auth');

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
  const result = await pool.query(
    'DELETE FROM users WHERE id = $1',
    [req.userId]
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Account not found' });
  }
  return res.json({ ok: true });
}));

module.exports = router;
