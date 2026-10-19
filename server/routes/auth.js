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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [user] } = await client.query(
      'INSERT INTO users (email, password_hash, created_at, updated_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [normalizedEmail, hash, now, now]
    );

    await client.query(
      'INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES ($1, $2, $3, $4)',
      [user.id, token, now, now + SESSION_TTL_MS]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return res.status(201).json({ token, expiresAt: now + SESSION_TTL_MS });
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

  return res.json({ token, expiresAt: now + SESSION_TTL_MS });
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
