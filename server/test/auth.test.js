'use strict';

process.env.DISABLE_AUTH              = 'false';
process.env.DISABLE_RATE_LIMIT        = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const { describe, it, before, after, beforeEach } = require('node:test');
const assert   = require('node:assert/strict');
const request  = require('supertest');

const { setupFreshTestDb, seedActiveSubscription } = require('./helpers');
const { closeDb, getPool }  = require('../db');
const { createApp }         = require('../app');

let app;

before(async () => {
  await setupFreshTestDb();
  app = createApp();
});

after(async () => closeDb());

beforeEach(async () => {
  await setupFreshTestDb();
  app = createApp();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function register(email = 'user@example.com', password = 'password123') {
  return request(app).post('/auth/register').send({ email, password });
}

async function login(email = 'user@example.com', password = 'password123') {
  return request(app).post('/auth/login').send({ email, password });
}

// ── Registration ─────────────────────────────────────────────────────────────

describe('POST /auth/register', () => {
  it('returns 201 and a token for valid credentials', async () => {
    const res = await register();
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.token, 'should return token');
    assert.ok(res.body.expiresAt > Date.now(), 'expiresAt should be in the future');
    assert.match(res.body.token, /^[0-9a-f]{64}$/);
  });

  it('returns 409 for a duplicate email', async () => {
    await register();
    const res = await register();
    assert.strictEqual(res.status, 409);
  });

  it('is case-insensitive for email — duplicate detected across cases', async () => {
    await register('User@Example.com');
    const res = await register('user@example.com');
    assert.strictEqual(res.status, 409);
  });

  it('returns 400 for an invalid email', async () => {
    const res = await register('not-an-email');
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 for a missing email', async () => {
    const res = await request(app).post('/auth/register').send({ password: 'password123' });
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 when password is fewer than 8 characters', async () => {
    const res = await register('user@example.com', 'short');
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 when password is missing', async () => {
    const res = await request(app).post('/auth/register').send({ email: 'user@example.com' });
    assert.strictEqual(res.status, 400);
  });
});

// ── Login ─────────────────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
  beforeEach(async () => { await register(); });

  it('returns 200 and a token for correct credentials', async () => {
    const res = await login();
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.token);
    assert.match(res.body.token, /^[0-9a-f]{64}$/);
  });

  it('returns 401 for a wrong password', async () => {
    const res = await login('user@example.com', 'wrongpassword');
    assert.strictEqual(res.status, 401);
  });

  it('returns 401 for an unknown email', async () => {
    const res = await login('nobody@example.com', 'password123');
    assert.strictEqual(res.status, 401);
  });

  it('returns 400 when body is missing', async () => {
    const res = await request(app).post('/auth/login').send({});
    assert.strictEqual(res.status, 400);
  });

  it('does not distinguish between wrong password and unknown email (same error)', async () => {
    const wrongPw = await login('user@example.com', 'wrongpassword');
    const noUser  = await login('nobody@example.com', 'password123');
    assert.strictEqual(wrongPw.body.error, noUser.body.error);
  });
});

// ── Session / GET /auth/me ─────────────────────────────────────────────────

describe('GET /auth/me', () => {
  it('returns user info for a valid token', async () => {
    await register();
    const { body: { token } } = await login();
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.email, 'user@example.com');
    assert.ok(res.body.userId);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/auth/me');
    assert.strictEqual(res.status, 401);
  });

  it('returns 401 for a malformed token', async () => {
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', 'Bearer notavalidtoken');
    assert.strictEqual(res.status, 401);
  });

  it('returns 401 for a fabricated token that does not exist in the DB', async () => {
    const fakeToken = 'a'.repeat(64);
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${fakeToken}`);
    assert.strictEqual(res.status, 401);
  });
});

// ── Logout ────────────────────────────────────────────────────────────────────

describe('POST /auth/logout', () => {
  it('invalidates the session token', async () => {
    await register();
    const { body: { token } } = await login();

    const logoutRes = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(logoutRes.status, 200);
    assert.ok(logoutRes.body.ok);

    const meRes = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(meRes.status, 401);
  });

  it('returns 401 when called without a token', async () => {
    const res = await request(app).post('/auth/logout');
    assert.strictEqual(res.status, 401);
  });
});

// ── Auth on /api/generate ─────────────────────────────────────────────────────

describe('/api/generate auth enforcement', () => {
  it('returns 401 without a token when DISABLE_AUTH=false', async () => {
    const res = await request(app).post('/api/generate').send({ photoCount: '0' });
    assert.strictEqual(res.status, 401);
  });

  it('returns mock content for an authenticated request (no OPENAI_API_KEY in test env)', async () => {
    await register();
    const { body: { token } } = await login();
    const { body: { userId } } = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    await seedActiveSubscription(userId);
    const res = await request(app)
      .post('/api/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ photoCount: '0' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mock, true);
  });
});
