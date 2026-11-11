'use strict';

// ── Configuration ─────────────────────────────────────────────────────────────
const API_BASE = 'https://api.getelmer.com';
const SESSION_KEY = 'elmer_session';

// ── Session management ────────────────────────────────────────────────────────
// Sessions live in sessionStorage: cleared when the tab is closed, never put in
// localStorage or URLs.

function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession({ token, expiresAt, userId, email }) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, expiresAt, userId, email }));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

function isSessionValid(session) {
  return !!(session && session.token && session.expiresAt && Date.now() < session.expiresAt);
}

// ── Auth guards ───────────────────────────────────────────────────────────────

// Call on protected pages (subscription.html).
// If no valid session exists, redirect to login immediately.
function requireAuth() {
  const session = getSession();
  if (!isSessionValid(session)) {
    clearSession();
    window.location.replace('login.html');
    return null;
  }
  return session;
}

// Call on auth pages (login.html, signup.html).
// If a valid session exists, redirect to subscription dashboard.
function redirectIfAuthed() {
  const session = getSession();
  if (isSessionValid(session)) {
    window.location.replace('subscription.html');
  }
}

// ── API client ────────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  // skipAuthRedirect: true disables the automatic 401 → login redirect.
  // Use it on auth endpoints (login, register) where 401 means wrong credentials,
  // not an expired session, so the caller can show the error inline.
  const { skipAuthRedirect = false, ...fetchOpts } = options;

  const session = getSession();
  const headers = { 'Content-Type': 'application/json', ...(fetchOpts.headers || {}) };
  if (session && session.token) {
    headers['Authorization'] = 'Bearer ' + session.token;
  }

  let res;
  try {
    res = await fetch(API_BASE + path, { ...fetchOpts, headers });
  } catch (err) {
    throw new ApiError('network', 'Network error — check your connection and try again.', 0);
  }

  if (res.status === 401 && !skipAuthRedirect) {
    clearSession();
    window.location.replace('login.html');
    throw new ApiError('auth', 'Session expired. Please log in again.', 401);
  }

  return res;
}

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code   = code;
    this.status = status;
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function showAlert(el, message, type = 'error') {
  if (!el) return;
  el.textContent = message;
  el.className = 'alert alert-' + type;
  el.classList.remove('alert-hidden');
}

function hideAlert(el) {
  if (!el) return;
  el.textContent = '';
  el.className = 'alert alert-hidden';
}

function setLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn._origText = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-inline"></span> ' + (btn.dataset.loadingText || 'Loading…');
  } else if (btn._origText !== undefined) {
    btn.innerHTML = btn._origText;
  }
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

// ── Sign out ──────────────────────────────────────────────────────────────────

async function signOut() {
  const session = getSession();
  if (session && session.token) {
    // Best-effort server logout; ignore errors (session cleared client-side regardless)
    apiFetch('/auth/logout', { method: 'POST' }).catch(() => {});
  }
  clearSession();
  window.location.replace('login.html');
}
