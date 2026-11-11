'use strict';

document.addEventListener('DOMContentLoaded', function () {
  redirectIfAuthed();

  const tabLogin   = document.getElementById('tabLogin');
  const tabSignup  = document.getElementById('tabSignup');
  const loginPanel  = document.getElementById('loginPanel');
  const signupPanel = document.getElementById('signupPanel');

  // ── Tab switching ───────────────────────────────────────────────────────────
  tabLogin.addEventListener('click', function () {
    tabLogin.classList.add('active');
    tabSignup.classList.remove('active');
    loginPanel.classList.remove('hidden');
    signupPanel.classList.add('hidden');
  });

  tabSignup.addEventListener('click', function () {
    tabSignup.classList.add('active');
    tabLogin.classList.remove('active');
    signupPanel.classList.remove('hidden');
    loginPanel.classList.add('hidden');
  });

  // ── Login form ──────────────────────────────────────────────────────────────
  const loginForm  = document.getElementById('loginForm');
  const loginBtn   = document.getElementById('loginBtn');
  const loginAlert = document.getElementById('loginAlert');

  loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    hideAlert(loginAlert);

    const email    = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    if (!email || !password) {
      showAlert(loginAlert, 'Please enter your email and password.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showAlert(loginAlert, 'Please enter a valid email address.');
      return;
    }

    setLoading(loginBtn, true);
    try {
      // skipAuthRedirect: 401 here means wrong credentials, not expired session.
      const res  = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
        skipAuthRedirect: true,
      });
      const data = await res.json();

      if (res.status === 401) {
        showAlert(loginAlert, 'Invalid email or password.');
        return;
      }
      if (!res.ok) {
        showAlert(loginAlert, data.error || 'Login failed. Please try again.');
        return;
      }

      saveSession({ token: data.token, expiresAt: data.expiresAt, userId: data.userId, email });
      window.location.replace('subscription.html');
    } catch (err) {
      if (err.code !== 'auth') {
        showAlert(loginAlert, err.message || 'Network error. Please try again.');
      }
    } finally {
      setLoading(loginBtn, false);
    }
  });

  // ── Signup form ─────────────────────────────────────────────────────────────
  const signupForm  = document.getElementById('signupForm');
  const signupBtn   = document.getElementById('signupBtn');
  const signupAlert = document.getElementById('signupAlert');

  signupForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    hideAlert(signupAlert);

    const email    = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    const confirm  = document.getElementById('signupConfirm').value;

    if (!email || !password) {
      showAlert(signupAlert, 'Please fill in all fields.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showAlert(signupAlert, 'Please enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      showAlert(signupAlert, 'Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      showAlert(signupAlert, 'Passwords do not match.');
      return;
    }

    setLoading(signupBtn, true);
    try {
      const res  = await apiFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (res.status === 409) {
        showAlert(signupAlert, 'An account with that email already exists. Try logging in.');
        return;
      }
      if (res.status === 400) {
        showAlert(signupAlert, data.error || 'Invalid email or password.');
        return;
      }
      if (!res.ok) {
        showAlert(signupAlert, data.error || 'Registration failed. Please try again.');
        return;
      }

      saveSession({ token: data.token, expiresAt: data.expiresAt, userId: data.userId, email });
      window.location.replace('subscription.html');
    } catch (err) {
      if (err.code !== 'auth') {
        showAlert(signupAlert, err.message || 'Network error. Please try again.');
      }
    } finally {
      setLoading(signupBtn, false);
    }
  });
});
