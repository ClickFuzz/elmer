'use strict';

const { Router }      = require('express');
const { randomBytes } = require('crypto');
const { getPool }     = require('../db');
const { requireAuth } = require('../auth');

const router = Router();

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const VALID_PLATFORMS    = new Set(['google', 'facebook', 'wordpress']);

const wrap = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// All /platforms routes require authentication.
router.use(requireAuth);

// ── GET /platforms ─────────────────────────────────────────────────────────
router.get('/', wrap(async (req, res) => {
  const { rows: platforms } = await getPool().query(
    `SELECT id, platform, account_name, account_id, selected, token_expires_at, connected_at
     FROM connected_platforms
     WHERE user_id = $1
     ORDER BY connected_at DESC`,
    [req.userId]
  );
  return res.json({ platforms });
}));

// ── DELETE /platforms/:platformId ──────────────────────────────────────────
router.delete('/:platformId', wrap(async (req, res) => {
  const platformId = parseInt(req.params.platformId, 10);
  if (!Number.isInteger(platformId) || platformId < 1) {
    return res.status(400).json({ error: 'Invalid platform ID' });
  }

  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id FROM connected_platforms WHERE id = $1 AND user_id = $2',
    [platformId, req.userId]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'Platform connection not found' });
  }

  await pool.query('DELETE FROM connected_platforms WHERE id = $1', [platformId]);
  return res.json({ ok: true });
}));

// ── POST /platforms/oauth/state ────────────────────────────────────────────
router.post('/oauth/state', wrap(async (req, res) => {
  const { platform } = req.body ?? {};
  if (!platform || !VALID_PLATFORMS.has(platform)) {
    return res.status(400).json({
      error: `platform must be one of: ${[...VALID_PLATFORMS].join(', ')}`,
    });
  }

  const state = randomBytes(24).toString('hex');
  const now   = Date.now();
  await getPool().query(
    `INSERT INTO oauth_states (state, user_id, platform, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [state, req.userId, platform, now, now + OAUTH_STATE_TTL_MS]
  );

  return res.status(201).json({ state, expiresAt: now + OAUTH_STATE_TTL_MS });
}));

// ── POST /platforms/oauth/state/validate ───────────────────────────────────
router.post('/oauth/state/validate', wrap(async (req, res) => {
  const { state } = req.body ?? {};
  if (!state || typeof state !== 'string') {
    return res.status(400).json({ error: 'state is required' });
  }

  const pool = getPool();
  const now  = Date.now();
  const { rows } = await pool.query(
    `SELECT id, user_id, platform, expires_at, used_at
     FROM oauth_states WHERE state = $1`,
    [state]
  );
  const row = rows[0];

  if (!row)              return res.status(400).json({ error: 'Invalid OAuth state' });
  if (row.used_at)       return res.status(400).json({ error: 'OAuth state already used' });
  if (row.expires_at < now) return res.status(400).json({ error: 'OAuth state expired' });

  await pool.query('UPDATE oauth_states SET used_at = $1 WHERE id = $2', [now, row.id]);

  return res.json({ userId: row.user_id, platform: row.platform });
}));

module.exports = router;
