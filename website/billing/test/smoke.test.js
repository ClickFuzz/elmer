'use strict';

/**
 * Billing portal smoke tests.
 *
 * Runs entirely in Node.js with no browser or test server required.
 * Checks file presence, JS syntax, cross-file references, and required DOM elements.
 *
 * Run from repo root:
 *   node --test website/billing/test/smoke.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');
const cp       = require('node:child_process');

const PORTAL_DIR = path.join(__dirname, '..');

function portalFile(name) {
  return path.join(PORTAL_DIR, name);
}

function read(name) {
  return fs.readFileSync(portalFile(name), 'utf8');
}

function exists(name) {
  return fs.existsSync(portalFile(name));
}

// ── File presence ─────────────────────────────────────────────────────────────

const REQUIRED_FILES = [
  '.htaccess',
  'style.css',
  'common.js',
  'index.html',
  'index.js',
  'login.html',
  'login.js',
  'forgot-password.html',
  'forgot-password.js',
  'reset-password.html',
  'reset-password.js',
  'subscription.html',
  'subscription.js',
  'DEPLOY.md',
];

test('all required portal files exist', () => {
  for (const file of REQUIRED_FILES) {
    assert.ok(exists(file), `missing required file: ${file}`);
  }
});

// ── JS syntax ─────────────────────────────────────────────────────────────────

const JS_FILES = ['common.js', 'index.js', 'login.js', 'forgot-password.js',
                  'reset-password.js', 'subscription.js'];

for (const file of JS_FILES) {
  test(`${file} — valid JavaScript syntax`, () => {
    const result = cp.spawnSync(process.execPath, ['--check', portalFile(file)], {
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0,
      `${file} failed syntax check:\n${result.stderr}`);
  });
}

// ── Script references in HTML ─────────────────────────────────────────────────

const HTML_FILES = ['index.html', 'login.html', 'forgot-password.html',
                    'reset-password.html', 'subscription.html'];

for (const html of HTML_FILES) {
  test(`${html} — all <script src> targets exist`, () => {
    const content = read(html);
    const matches = [...content.matchAll(/<script\s+src="([^"]+)"/g)];
    assert.ok(matches.length > 0, `${html} has no <script src> tags`);
    for (const [, src] of matches) {
      assert.ok(exists(src), `${html} references missing script: ${src}`);
    }
  });

  test(`${html} — <link rel="stylesheet"> target exists`, () => {
    const content = read(html);
    const matches = [...content.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)];
    for (const [, href] of matches) {
      if (!href.startsWith('http')) {
        assert.ok(exists(href), `${html} references missing stylesheet: ${href}`);
      }
    }
  });
}

// ── common.js exports expected symbols ───────────────────────────────────────

test('common.js defines required functions', () => {
  const src = read('common.js');
  const required = [
    'getSession', 'saveSession', 'clearSession', 'isSessionValid',
    'requireAuth', 'redirectIfAuthed',
    'apiFetch', 'ApiError',
    'showAlert', 'hideAlert', 'setLoading', 'formatDate',
    'signOut',
  ];
  for (const name of required) {
    assert.ok(src.includes(`function ${name}`) || src.includes(`class ${name}`),
      `common.js is missing: ${name}`);
  }
});

test('common.js apiFetch extracts skipAuthRedirect before fetch call', () => {
  const src = read('common.js');
  assert.ok(src.includes('skipAuthRedirect'), 'skipAuthRedirect option missing from apiFetch');
  assert.ok(src.includes('fetchOpts'), 'fetchOpts destructuring missing (leaks option to fetch)');
  assert.ok(/skipAuthRedirect.*=.*false/.test(src), 'skipAuthRedirect default not set to false');
});

// ── login.js — email validation present ──────────────────────────────────────

test('login.js validates email format for login form', () => {
  const src = read('login.js');
  assert.ok(src.includes('skipAuthRedirect: true'),
    'login.js missing skipAuthRedirect:true on /auth/login call');
  assert.ok(/test\(email\)/.test(src),
    'login.js missing email format regex test');
});

test('login.js validates email format for signup form', () => {
  const src = read('login.js');
  const emailTests = [...src.matchAll(/test\(email\)/g)];
  assert.ok(emailTests.length >= 2,
    'login.js should validate email format in both login and signup forms');
});

// ── HTACCESS — required directives ───────────────────────────────────────────

test('.htaccess enforces HTTPS redirect', () => {
  const src = read('.htaccess');
  assert.ok(src.includes('HTTPS') && src.includes('R=301'),
    '.htaccess missing HTTPS redirect rule');
});

test('.htaccess sets Strict-Transport-Security header', () => {
  const src = read('.htaccess');
  assert.ok(src.includes('Strict-Transport-Security'), 'HSTS header missing');
});

test('.htaccess sets Content-Security-Policy header', () => {
  const src = read('.htaccess');
  assert.ok(src.includes('Content-Security-Policy'), 'CSP header missing');
  assert.ok(src.includes("script-src 'self'"), "CSP missing script-src 'self'");
  assert.ok(!src.includes("unsafe-inline"), "CSP must not include unsafe-inline");
  assert.ok(!src.includes("unsafe-eval"),   "CSP must not include unsafe-eval");
});

test('.htaccess sets no-cache headers for auth-sensitive pages', () => {
  const src = read('.htaccess');
  assert.ok(src.includes('no-store') || src.includes('no-cache'),
    '.htaccess missing Cache-Control: no-store');
});

test('.htaccess disables directory listing', () => {
  const src = read('.htaccess');
  assert.ok(src.includes('-Indexes'), 'Directory listing not disabled');
});

// ── Subscription HTML — required elements ────────────────────────────────────

test('subscription.html has required dashboard elements', () => {
  const src = read('subscription.html');
  const required = [
    'loadingView', 'dashboardView',
    'statusBadgeWrap', 'returnBanner',
    'trialOfferSection', 'manageBillingSection',
    'startTrialBtn', 'manageBtn',
    'signOutBtn', 'accountEmail',
    'deleteAccountBtn', 'confirmDeleteBtn', 'cancelDeleteBtn',
    'confirmDeleteBox', 'deleteAlert',
  ];
  for (const id of required) {
    assert.ok(src.includes(`id="${id}"`), `subscription.html missing element #${id}`);
  }
});

// ── login.html — required elements ───────────────────────────────────────────

test('login.html has required form elements', () => {
  const src = read('login.html');
  const required = [
    'tabLogin', 'tabSignup',
    'loginPanel', 'signupPanel',
    'loginForm', 'loginBtn', 'loginAlert',
    'loginEmail', 'loginPassword',
    'signupForm', 'signupBtn', 'signupAlert',
    'signupEmail', 'signupPassword', 'signupConfirm',
  ];
  for (const id of required) {
    assert.ok(src.includes(`id="${id}"`), `login.html missing element #${id}`);
  }
});

// ── reset-password.html — required elements ───────────────────────────────────

test('reset-password.html has required form elements', () => {
  const src = read('reset-password.html');
  const required = ['resetPanel', 'invalidPanel', 'resetForm', 'resetBtn',
                    'newPassword', 'confirmPassword', 'resetAlert'];
  for (const id of required) {
    assert.ok(src.includes(`id="${id}"`), `reset-password.html missing element #${id}`);
  }
});

// ── reset-password.js — token removed from URL ───────────────────────────────

test('reset-password.js removes token from URL bar immediately', () => {
  const src = read('reset-password.js');
  assert.ok(src.includes('replaceState'),
    'reset-password.js must remove token from URL via history.replaceState');
  assert.ok(src.includes('window.location.pathname'),
    'reset-password.js must replace URL with current pathname (no query string)');
});

// ── subscription.js — Stripe source:web ──────────────────────────────────────

test('subscription.js uses source:web for checkout session', () => {
  const src = read('subscription.js');
  assert.ok(src.includes("source: 'web'"),
    "subscription.js must pass source:'web' to checkout-session and portal-session");
});

test('subscription.js verifies entitlement via GET /billing/subscription (not URL param)', () => {
  const src = read('subscription.js');
  assert.ok(src.includes('/billing/subscription'),
    'subscription.js must call /billing/subscription to verify access');
  // The success banner should only show when hasAccess is confirmed from the API
  assert.ok(src.includes('data.hasAccess'),
    'subscription.js must check hasAccess from API response');
});

// ── subscription.js — no inline secrets ──────────────────────────────────────

test('subscription.js contains no Stripe secret key', () => {
  const src = read('subscription.js');
  assert.ok(!src.includes('sk_live_') && !src.includes('sk_test_'),
    'subscription.js must not contain Stripe secret keys');
});

test('common.js contains no API credentials', () => {
  const src = read('common.js');
  assert.ok(!src.includes('sk_live_') && !src.includes('sk_test_'),
    'common.js must not contain Stripe keys');
  assert.ok(!src.includes('re_') || src.includes('RESEND'),
    'common.js must not contain Resend API keys');
});

// ── DEPLOY.md — completeness ──────────────────────────────────────────────────

test('DEPLOY.md references all required env vars', () => {
  const src = read('DEPLOY.md');
  const vars = ['CORS_ALLOWED_ORIGINS', 'BILLING_PORTAL_URL', 'RESEND_API_KEY', 'EMAIL_FROM'];
  for (const v of vars) {
    assert.ok(src.includes(v), `DEPLOY.md missing env var: ${v}`);
  }
});

test('DEPLOY.md includes emailEnabled health check instruction', () => {
  const src = read('DEPLOY.md');
  assert.ok(src.includes('emailEnabled'), 'DEPLOY.md missing emailEnabled health check');
});
