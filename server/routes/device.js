'use strict';

// Apple DeviceCheck client and device-level eligibility service.
//
// DeviceCheck gives each iOS app two persistent bits per device, maintained by
// Apple.  Elmer uses bit0 to record that a free publication has been redeemed
// on this device — survives reinstalls and account changes.
//
// LIMITATION (documented per spec §4): Apple DeviceCheck does not expose a
// stable device identifier.  The device token is a short-lived, one-time-use
// opaque blob.  We can *query* and *update* the bits with a token, but we
// cannot derive a stable ID for cross-account locking *before* redemption.
// Concurrent new accounts on the same device could both query bit0=0 and both
// proceed before either sets bit0=1.  The existing PostgreSQL per-account
// reservation (free_publications) limits each account to one free publication,
// so the worst case is two accounts on the same device each redeeming once
// during a narrow race window.  This limitation is inherent to the Apple API.
//
// Android: Play Integrity Device Recall is a beta program requiring explicit
// Google enrollment.  It is not implemented here.  The account-level
// free_publications system continues to enforce the per-account limit on
// Android.  See §6 of the Phase 8 spec for steps to request beta access.

const crypto    = require('crypto');
const { getPool } = require('../db');

// ── Configuration ─────────────────────────────────────────────────────────────

function getAppleConfig() {
  const keyId      = process.env.APPLE_DEVICECHECK_KEY_ID;
  const teamId     = process.env.APPLE_DEVICECHECK_TEAM_ID;
  let   privateKey = process.env.APPLE_DEVICECHECK_PRIVATE_KEY;

  if (!keyId || !teamId || !privateKey) return null;

  // Railway env vars may store newlines as the literal two-char sequence \n.
  // Normalise so the crypto module receives a valid PEM key.
  if (privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }
  // Strip leading/trailing whitespace to tolerate accidental padding.
  privateKey = privateKey.trim();

  const useSandbox = process.env.APPLE_DEVICECHECK_USE_SANDBOX === 'true';
  const baseUrl = useSandbox
    ? 'https://api.development.devicecheck.apple.com/v1'
    : 'https://api.devicecheck.apple.com/v1';

  return { keyId, teamId, privateKey, baseUrl };
}

// ── ES256 JWT for Apple API auth ──────────────────────────────────────────────

function toBase64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function buildAppleJwt(config) {
  const header  = toBase64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const payload = toBase64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(Date.now() / 1000) }));
  const data    = `${header}.${payload}`;

  const sign = crypto.createSign('SHA256');
  sign.update(data);
  sign.end();

  // ES256 requires IEEE P1363 encoding (raw 64-byte r||s), not DER.
  // Node.js supports dsaEncoding: 'ieee-p1363' since v13.
  const sig = sign.sign({ key: config.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${toBase64url(sig)}`;
}

// ── Apple API calls ───────────────────────────────────────────────────────────

// Test injection: replace these with mock functions in device.test.js.
let _testQueryFn  = null;
let _testUpdateFn = null;

function _injectAppleApiForTesting(queryFn, updateFn) {
  _testQueryFn  = queryFn;
  _testUpdateFn = updateFn;
}
function _clearAppleApiInjection() {
  _testQueryFn  = null;
  _testUpdateFn = null;
}

// Returns { bit0: bool, bit1: bool }.
// Throws on API errors (caller decides fail-open vs fail-closed).
async function queryDeviceBits(deviceToken) {
  if (_testQueryFn) return _testQueryFn(deviceToken);

  const config = getAppleConfig();
  if (!config) throw new Error('DeviceCheck not configured');

  const jwt = buildAppleJwt(config);

  const res = await fetch(`${config.baseUrl}/query_two_bits`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      device_token:   deviceToken,
      transaction_id: crypto.randomUUID(),
      timestamp:      Date.now(),
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (res.status === 200) {
    const text = await res.text();
    // 200 with empty body = device never queried; bits default to false.
    if (!text.trim()) return { bit0: false, bit1: false };
    const data = JSON.parse(text);
    return { bit0: !!data.bit0, bit1: !!data.bit1 };
  }

  // 400 = invalid or simulator token — treat as ineligible device.
  if (res.status === 400) {
    const err = new Error('DeviceCheck: invalid token (simulator or expired)');
    err.code  = 'INVALID_TOKEN';
    throw err;
  }

  const body = await res.text().catch(() => '');
  const err  = new Error(`Apple DeviceCheck query HTTP ${res.status}: ${body}`);
  err.code   = 'APPLE_API_ERROR';
  throw err;
}

// Sets bit0=true for the device associated with the token.
// Throws on API errors.
async function updateDeviceBit0(deviceToken) {
  if (_testUpdateFn) return _testUpdateFn(deviceToken);

  const config = getAppleConfig();
  if (!config) throw new Error('DeviceCheck not configured');

  const jwt = buildAppleJwt(config);

  const res = await fetch(`${config.baseUrl}/update_two_bits`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      device_token:   deviceToken,
      transaction_id: crypto.randomUUID(),
      timestamp:      Date.now(),
      bit0:           true,
      bit1:           false,
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (res.status === 200) return;

  const body = await res.text().catch(() => '');
  const err  = new Error(`Apple DeviceCheck update HTTP ${res.status}: ${body}`);
  err.code   = 'APPLE_API_ERROR';
  throw err;
}

// ── Device eligibility ────────────────────────────────────────────────────────

// Returns { eligible: true } or { eligible: false, reason: 'device_redeemed' }.
// Throws on Apple API errors — callers must decide the failure policy:
//   - fail-open (allow): for transient errors (network, Apple outage)
//   - fail-closed (deny): only appropriate when misconfiguration is certain
async function checkDeviceEligibility(deviceToken) {
  const { bit0 } = await queryDeviceBits(deviceToken);
  return bit0
    ? { eligible: false, reason: 'device_redeemed' }
    : { eligible: true };
}

// ── Retry queue ───────────────────────────────────────────────────────────────

// Record an unfulfilled Apple bit-update obligation.
// Called when updateDeviceBit0 fails after a confirmed free publication.
// The device token is NOT stored — it has already expired.  The obligation is
// fulfilled the next time this user makes a request with a fresh device token.
async function queueDeviceUpdate(userId, jobKey) {
  const now = Date.now();
  await getPool().query(
    `INSERT INTO device_update_queue (user_id, job_key, platform, attempt_count, created_at, updated_at)
     VALUES ($1, $2, 'ios', 0, $3, $3)
     ON CONFLICT (user_id, job_key) DO NOTHING`,
    [userId, jobKey, now]
  );
}

// Try to fulfill any pending Apple bit-update obligation for this user using
// the fresh device token from the current request.
// Fire-and-forget: failure leaves the obligation in the queue for next time.
async function processQueuedDeviceUpdate(userId, deviceToken) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, job_key FROM device_update_queue WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [userId]
  );
  if (rows.length === 0) return;

  const entry = rows[0];
  try {
    await updateDeviceBit0(deviceToken);
    await pool.query('DELETE FROM device_update_queue WHERE id = $1', [entry.id]);
    console.log(`[elmer] device queue: fulfilled obligation for user ${userId} job ${entry.job_key}`);
  } catch (err) {
    const now = Date.now();
    await pool.query(
      `UPDATE device_update_queue
       SET attempt_count = attempt_count + 1, last_error = $1, updated_at = $2
       WHERE id = $3`,
      [err.message.slice(0, 500), now, entry.id]
    );
    console.warn(`[elmer] device queue: retry failed for user ${userId}: ${err.message}`);
  }
}

// Log any pending queue entries at startup (informational; cannot retry without
// a fresh device token from the device itself).
async function logPendingDeviceUpdates() {
  try {
    const { rows } = await getPool().query(
      `SELECT COUNT(*) AS cnt FROM device_update_queue`
    );
    const cnt = parseInt(rows[0].cnt, 10);
    if (cnt > 0) {
      console.log(`[elmer] device queue: ${cnt} pending Apple DeviceCheck update(s) — will retry on next user request`);
    }
  } catch {
    // Non-fatal; table may not exist yet on first boot before migration runs.
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  checkDeviceEligibility,
  updateDeviceBit0,
  queueDeviceUpdate,
  processQueuedDeviceUpdate,
  logPendingDeviceUpdates,
  isDeviceCheckConfigured: () => !!getAppleConfig(),
  // Test seam — never call in production code.
  _injectAppleApiForTesting,
  _clearAppleApiInjection,
};
