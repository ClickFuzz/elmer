'use strict';

const { Router }    = require('express');
const { randomBytes } = require('crypto');
const bcrypt        = require('bcryptjs');
const { getDb }     = require('../db');
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

  const db = getDb();
  const normalizedEmail = email.toLowerCase().trim();

  if (db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail)) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const hash  = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const now   = Date.now();
  const token = randomBytes(32).toString('hex');

  const insertUser = db.transaction(() => {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users (email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(normalizedEmail, hash, now, now);

    db.prepare(
      'INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).run(lastInsertRowid, token, now, now + SESSION_TTL_MS);

    return lastInsertRowid;
  });

  insertUser();
  return res.status(201).json({ token, expiresAt: now + SESSION_TTL_MS });
}));

// ── POST /auth/login ───────────────────────────────────────────────────────
router.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?')
                 .get(email.toLowerCase().trim());

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
  db.prepare(
    'INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(user.id, token, now, now + SESSION_TTL_MS);

  return res.json({ token, expiresAt: now + SESSION_TTL_MS });
}));

// ── POST /auth/logout ──────────────────────────────────────────────────────
router.post('/logout', requireAuth, (req, res) => {
  const token = req.headers['authorization'].slice(7);
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return res.json({ ok: true });
});

// ── GET /auth/me ───────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  return res.json({ userId: req.userId, email: req.userEmail });
});

module.exports = router;
