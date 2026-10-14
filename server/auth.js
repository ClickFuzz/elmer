'use strict';

const { getPool } = require('./db');

// 30-day session lifetime. Override with SESSION_TTL_DAYS env var.
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_DAYS ?? '30', 10) * 24 * 60 * 60 * 1000;

const TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * Express middleware — requires a valid Bearer token.
 * Attaches req.userId and req.userEmail on success.
 */
async function requireAuth(req, res, next) {
  const header = req.headers['authorization'] ?? '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = header.slice(7);
  if (!TOKEN_RE.test(token)) {
    return res.status(401).json({ error: 'Invalid session token' });
  }
  try {
    const now = Date.now();
    const { rows } = await getPool().query(
      `SELECT s.user_id, u.email
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = $1 AND s.expires_at > $2`,
      [token, now]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    req.userId    = rows[0].user_id;
    req.userEmail = rows[0].email;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Express middleware — attaches user info if a valid token is present,
 * but does not reject unauthenticated requests.
 */
async function optionalAuth(req, res, next) {
  const header = req.headers['authorization'] ?? '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7);
    if (TOKEN_RE.test(token)) {
      try {
        const now = Date.now();
        const { rows } = await getPool().query(
          `SELECT s.user_id, u.email
           FROM sessions s
           JOIN users u ON s.user_id = u.id
           WHERE s.token = $1 AND s.expires_at > $2`,
          [token, now]
        );
        if (rows.length > 0) {
          req.userId    = rows[0].user_id;
          req.userEmail = rows[0].email;
        }
      } catch {
        // Non-fatal — continue without attaching user
      }
    }
  }
  next();
}

module.exports = { requireAuth, optionalAuth, SESSION_TTL_MS };
