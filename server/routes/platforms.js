'use strict';

const { Router }    = require('express');
const { randomBytes } = require('crypto');
const { getDb }     = require('../db');
const { requireAuth } = require('../auth');

const router = Router();

const OAUTH_STATE_TTL_MS  = 10 * 60 * 1000; // 10 minutes
const VALID_PLATFORMS     = new Set(['google', 'facebook', 'wordpress']);

// All /platforms routes require authentication.
router.use(requireAuth);

// ── GET /platforms ─────────────────────────────────────────────────────────
// Returns connected platforms for the authenticated user.
// Credentials are never included in the response.
router.get('/', (req, res) => {
  const platforms = getDb().prepare(
    `SELECT id, platform, account_name, account_id, token_expires_at, connected_at
     FROM connected_platforms
     WHERE user_id = ?
     ORDER BY connected_at DESC`
  ).all(req.userId);
  return res.json({ platforms });
});

// ── DELETE /platforms/:platformId ──────────────────────────────────────────
// Disconnects a platform. Verifies ownership before deleting.
router.delete('/:platformId', (req, res) => {
  const platformId = parseInt(req.params.platformId, 10);
  if (!Number.isInteger(platformId) || platformId < 1) {
    return res.status(400).json({ error: 'Invalid platform ID' });
  }

  const db  = getDb();
  const row = db.prepare(
    'SELECT id FROM connected_platforms WHERE id = ? AND user_id = ?'
  ).get(platformId, req.userId);

  if (!row) {
    return res.status(404).json({ error: 'Platform connection not found' });
  }

  db.prepare('DELETE FROM connected_platforms WHERE id = ?').run(platformId);
  return res.json({ ok: true });
});

// ── POST /platforms/oauth/state ────────────────────────────────────────────
// Creates a single-use CSRF state token for an OAuth flow.
router.post('/oauth/state', (req, res) => {
  const { platform } = req.body ?? {};
  if (!platform || !VALID_PLATFORMS.has(platform)) {
    return res.status(400).json({
      error: `platform must be one of: ${[...VALID_PLATFORMS].join(', ')}`,
    });
  }

  const state = randomBytes(24).toString('hex');
  const now   = Date.now();
  getDb().prepare(
    `INSERT INTO oauth_states (state, user_id, platform, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(state, req.userId, platform, now, now + OAUTH_STATE_TTL_MS);

  return res.status(201).json({ state, expiresAt: now + OAUTH_STATE_TTL_MS });
});

// ── POST /platforms/oauth/state/validate ───────────────────────────────────
// Validates and atomically consumes an OAuth state token.
// Called by the OAuth callback handler once the provider redirects back.
router.post('/oauth/state/validate', (req, res) => {
  const { state } = req.body ?? {};
  if (!state || typeof state !== 'string') {
    return res.status(400).json({ error: 'state is required' });
  }

  const db  = getDb();
  const now = Date.now();
  const row = db.prepare(
    `SELECT id, user_id, platform, expires_at, used_at
     FROM oauth_states WHERE state = ?`
  ).get(state);

  if (!row)         return res.status(400).json({ error: 'Invalid OAuth state' });
  if (row.used_at)  return res.status(400).json({ error: 'OAuth state already used' });
  if (row.expires_at < now) return res.status(400).json({ error: 'OAuth state expired' });

  db.prepare('UPDATE oauth_states SET used_at = ? WHERE id = ?').run(now, row.id);

  return res.json({ userId: row.user_id, platform: row.platform });
});

module.exports = router;
