'use strict';

process.env.DISABLE_AUTH        = 'false';
process.env.DISABLE_RATE_LIMIT  = 'true';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const { describe, it, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const request = require('supertest');

const { setupFreshTestDb } = require('./helpers');
const { closeDb }          = require('../db');
const { createApp }        = require('../app');

// ── Block 1: no CORS_ALLOWED_ORIGINS — open (backward-compatible default) ────

describe('CORS — no origin restriction configured', () => {
  let app;

  before(async () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    await setupFreshTestDb();
    app = createApp();
  });

  after(async () => closeDb());

  it('allows a browser request from any origin', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://any-origin.example.com');
    assert.ok(
      res.headers['access-control-allow-origin'],
      'CORS header should be present for any origin when no allowlist is set'
    );
  });

  it('allows a request from the billing portal origin', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://billing.getelmer.com');
    assert.ok(res.headers['access-control-allow-origin']);
  });

  it('allows requests without an Origin header (native mobile / server-to-server)', async () => {
    const res = await request(app).get('/health');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);
  });
});

// ── Block 2: CORS_ALLOWED_ORIGINS set — only listed origins receive headers ──

describe('CORS — allowlist active', () => {
  let app;

  before(async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://billing.getelmer.com,https://getelmer.com';
    await setupFreshTestDb();
    app = createApp();
  });

  after(async () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    await closeDb();
  });

  it('allows a request from an origin in the allowlist', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://billing.getelmer.com');
    assert.strictEqual(
      res.headers['access-control-allow-origin'],
      'https://billing.getelmer.com'
    );
  });

  it('allows a second listed origin', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://getelmer.com');
    assert.strictEqual(
      res.headers['access-control-allow-origin'],
      'https://getelmer.com'
    );
  });

  it('blocks an origin not in the allowlist (no CORS header returned)', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://evil.example.com');
    // Browser would block the response due to missing CORS header
    assert.ok(
      !res.headers['access-control-allow-origin'],
      'No CORS header should be set for a disallowed origin'
    );
  });

  it('blocks a subdomain not explicitly listed', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://app.getelmer.com');
    assert.ok(!res.headers['access-control-allow-origin']);
  });

  it('allows requests without an Origin header regardless of allowlist', async () => {
    const res = await request(app).get('/health');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);
  });

  it('handles CORS preflight for an allowed origin', async () => {
    const res = await request(app)
      .options('/auth/login')
      .set('Origin', 'https://billing.getelmer.com')
      .set('Access-Control-Request-Method', 'POST');
    // cors package responds 204 to preflight
    assert.ok([200, 204].includes(res.status), `Expected 200 or 204, got ${res.status}`);
    assert.strictEqual(
      res.headers['access-control-allow-origin'],
      'https://billing.getelmer.com'
    );
  });

  it('handles CORS preflight for a disallowed origin — no CORS header', async () => {
    const res = await request(app)
      .options('/auth/login')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    assert.ok(!res.headers['access-control-allow-origin']);
  });

  it('mobile auth endpoint responds normally without an Origin header', async () => {
    // Simulates a mobile client that sends no Origin header
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'cors-mobile@example.com', password: 'password123' });
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.token);
  });
});
