'use strict';

process.env.DISABLE_AUTH        = 'false';
process.env.DISABLE_RATE_LIMIT  = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const { describe, it, before, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');

const { setupFreshTestDb } = require('./helpers');
const { getPool, closeDb } = require('../db');
const { createApp }        = require('../app');
const {
  _setEmailSenderForTest,
  _clearEmailSenderForTest,
} = require('../services/email');

let app;

before(async () => {
  await setupFreshTestDb();
  app = createApp();
});

after(async () => {
  _clearEmailSenderForTest();
  await closeDb();
});

beforeEach(async () => {
  _clearEmailSenderForTest();
  await setupFreshTestDb();
  app = createApp();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function register(email, password = 'password123') {
  const res = await request(app).post('/auth/register').send({ email, password });
  assert.strictEqual(res.status, 201, `register failed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function forgotPassword(email) {
  return request(app).post('/auth/forgot-password').send({ email });
}

async function resetPassword(token, newPassword) {
  return request(app).post('/auth/reset-password').send({ token, newPassword });
}

/** Installs a test hook and returns a promise that resolves with { email, url }
 *  when sendPasswordResetEmail is called. */
function captureNextEmail() {
  return new Promise(resolve => {
    _setEmailSenderForTest((toEmail, resetUrl) => {
      resolve({ email: toEmail, url: resetUrl });
    });
  });
}

/** Extracts the raw reset token from a reset URL. */
function tokenFromUrl(url) {
  return new URL(url).searchParams.get('token');
}

// ── POST /auth/forgot-password ────────────────────────────────────────────────

describe('POST /auth/forgot-password', () => {
  it('returns 200 ok:true for a registered email', async () => {
    await register('fp-registered@example.com');
    const res = await forgotPassword('fp-registered@example.com');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true });
  });

  it('returns 200 ok:true for an unregistered email (no enumeration)', async () => {
    const res = await forgotPassword('fp-nobody@example.com');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true });
  });

  it('returns 200 ok:true when email is missing (no enumeration)', async () => {
    const res = await request(app).post('/auth/forgot-password').send({});
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true });
  });

  it('calls sendPasswordResetEmail with the user email and a reset URL', async () => {
    await register('fp-email@example.com');

    const capture = captureNextEmail();
    await forgotPassword('fp-email@example.com');
    const { email, url } = await capture;

    assert.strictEqual(email, 'fp-email@example.com');
    assert.ok(url.includes('/reset-password?token='), `Unexpected URL format: ${url}`);
  });

  it('reset URL points to BILLING_PORTAL_URL when configured', async () => {
    process.env.BILLING_PORTAL_URL = 'https://billing.example.com';
    await register('fp-portalurl@example.com');

    const capture = captureNextEmail();
    await forgotPassword('fp-portalurl@example.com');
    const { url } = await capture;

    assert.ok(url.startsWith('https://billing.example.com'), `URL should start with portal URL: ${url}`);
    delete process.env.BILLING_PORTAL_URL;
  });

  it('stores a token hash (not the raw token) in the database', async () => {
    await register('fp-hash@example.com');

    const capture = captureNextEmail();
    await forgotPassword('fp-hash@example.com');
    const { url } = await capture;

    const rawToken = tokenFromUrl(url);
    assert.ok(rawToken, 'raw token missing from URL');

    // DB should contain the hash, not the raw token
    const { rows } = await getPool().query(
      'SELECT token_hash FROM password_reset_tokens WHERE token_hash != $1',
      [rawToken]
    );
    // There should be a row — it won't be the raw token
    const { rows: allRows } = await getPool().query('SELECT token_hash FROM password_reset_tokens');
    assert.ok(allRows.length > 0, 'No token stored in DB');
    assert.ok(
      allRows.every(r => r.token_hash !== rawToken),
      'Raw token was stored in DB (hash should be stored instead)'
    );
  });

  it('invalidates previous unused tokens when a new request is made', async () => {
    await register('fp-invalidate@example.com');

    // First request
    const cap1 = captureNextEmail();
    await forgotPassword('fp-invalidate@example.com');
    const { url: url1 } = await cap1;
    const token1 = tokenFromUrl(url1);

    // Second request — should invalidate the first token
    _clearEmailSenderForTest();
    const cap2 = captureNextEmail();
    await forgotPassword('fp-invalidate@example.com');
    const { url: url2 } = await cap2;
    const token2 = tokenFromUrl(url2);

    // token1 should now be invalid
    const r1 = await resetPassword(token1, 'NewPassword1!');
    assert.strictEqual(r1.status, 400, 'First token should be invalidated after second request');

    // token2 should still work
    const r2 = await resetPassword(token2, 'NewPassword2!');
    assert.strictEqual(r2.status, 200, 'Second token should still be valid');
  });

  it('does not call email sender for unregistered address', async () => {
    let called = false;
    _setEmailSenderForTest(() => { called = true; });
    await forgotPassword('fp-unregistered@example.com');
    assert.strictEqual(called, false, 'Email sender should not be called for unknown address');
  });
});

// ── POST /auth/reset-password ─────────────────────────────────────────────────

describe('POST /auth/reset-password', () => {
  it('resets the password and returns a new session token', async () => {
    await register('rp-success@example.com', 'OldPass123!');

    const capture = captureNextEmail();
    await forgotPassword('rp-success@example.com');
    const { url } = await capture;
    const rawToken = tokenFromUrl(url);

    const res = await resetPassword(rawToken, 'NewPass456!');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);
    assert.ok(res.body.token, 'New session token should be returned');
    assert.ok(res.body.expiresAt > Date.now(), 'expiresAt should be in the future');
  });

  it('allows login with the new password after reset', async () => {
    await register('rp-login@example.com', 'OldPass123!');

    const capture = captureNextEmail();
    await forgotPassword('rp-login@example.com');
    const { url } = await capture;
    const rawToken = tokenFromUrl(url);

    await resetPassword(rawToken, 'NewPass456!');

    // Old password should fail
    const oldRes = await request(app)
      .post('/auth/login')
      .send({ email: 'rp-login@example.com', password: 'OldPass123!' });
    assert.strictEqual(oldRes.status, 401);

    // New password should succeed
    const newRes = await request(app)
      .post('/auth/login')
      .send({ email: 'rp-login@example.com', password: 'NewPass456!' });
    assert.strictEqual(newRes.status, 200);
    assert.ok(newRes.body.token);
  });

  it('invalidates all existing sessions on reset', async () => {
    const oldToken = await register('rp-sessions@example.com', 'OldPass123!');

    const capture = captureNextEmail();
    await forgotPassword('rp-sessions@example.com');
    const { url } = await capture;
    const rawToken = tokenFromUrl(url);

    await resetPassword(rawToken, 'NewPass456!');

    // Old session token should be rejected
    const meRes = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${oldToken}`);
    assert.strictEqual(meRes.status, 401, 'Old session should be invalidated after password reset');
  });

  it('marks the token as used (single-use enforcement)', async () => {
    await register('rp-singleuse@example.com', 'OldPass123!');

    const capture = captureNextEmail();
    await forgotPassword('rp-singleuse@example.com');
    const { url } = await capture;
    const rawToken = tokenFromUrl(url);

    // First use — should succeed
    const r1 = await resetPassword(rawToken, 'NewPass456!');
    assert.strictEqual(r1.status, 200);

    // Second use — should fail
    const r2 = await resetPassword(rawToken, 'AnotherPass789!');
    assert.strictEqual(r2.status, 400);
    assert.ok(r2.body.error.includes('invalid_or_expired_token'));
  });

  it('rejects an invalid token', async () => {
    const res = await resetPassword('0'.repeat(64), 'NewPass123!');
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('invalid_or_expired_token'));
  });

  it('rejects a missing token', async () => {
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ newPassword: 'NewPass123!' });
    assert.strictEqual(res.status, 400);
  });

  it('rejects a password shorter than 8 characters', async () => {
    await register('rp-short@example.com', 'OldPass123!');

    const capture = captureNextEmail();
    await forgotPassword('rp-short@example.com');
    const { url } = await capture;
    const rawToken = tokenFromUrl(url);

    const res = await resetPassword(rawToken, 'short');
    assert.strictEqual(res.status, 400);
  });

  it('rejects an expired token', async () => {
    await register('rp-expired@example.com', 'OldPass123!');

    // Insert a token that is already expired
    const { rows } = await getPool().query(
      'SELECT id FROM users WHERE email = $1',
      ['rp-expired@example.com']
    );
    const userId = rows[0].id;
    const rawToken = 'deadbeef'.repeat(8); // 64 hex chars
    const { createHash } = require('crypto');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiredAt = Date.now() - 1; // already expired

    await getPool().query(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [userId, tokenHash, expiredAt]
    );

    const res = await resetPassword(rawToken, 'NewPass123!');
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('invalid_or_expired_token'));
  });

  it('the new session token from reset is immediately usable', async () => {
    await register('rp-newtoken@example.com', 'OldPass123!');

    const capture = captureNextEmail();
    await forgotPassword('rp-newtoken@example.com');
    const { url } = await capture;
    const rawToken = tokenFromUrl(url);

    const resetRes = await resetPassword(rawToken, 'NewPass456!');
    assert.strictEqual(resetRes.status, 200);
    const newSessionToken = resetRes.body.token;

    const meRes = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${newSessionToken}`);
    assert.strictEqual(meRes.status, 200);
    assert.strictEqual(meRes.body.email, 'rp-newtoken@example.com');
  });
});
