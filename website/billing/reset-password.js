'use strict';

document.addEventListener('DOMContentLoaded', function () {
  const invalidPanel = document.getElementById('invalidPanel');
  const resetPanel   = document.getElementById('resetPanel');
  const resetForm    = document.getElementById('resetForm');
  const resetBtn     = document.getElementById('resetBtn');
  const resetAlert   = document.getElementById('resetAlert');

  // Read the reset token from the URL and immediately remove it from the
  // address bar so it doesn't linger in browser history or be accidentally shared.
  const params = new URLSearchParams(window.location.search);
  const token  = params.get('token');
  window.history.replaceState(null, '', window.location.pathname);

  if (!token) {
    invalidPanel.classList.remove('hidden');
    return;
  }

  resetPanel.classList.remove('hidden');

  resetForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    hideAlert(resetAlert);

    const newPassword = document.getElementById('newPassword').value;
    const confirm     = document.getElementById('confirmPassword').value;

    if (!newPassword) {
      showAlert(resetAlert, 'Please enter a new password.');
      return;
    }
    if (newPassword.length < 8) {
      showAlert(resetAlert, 'Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirm) {
      showAlert(resetAlert, 'Passwords do not match.');
      return;
    }

    setLoading(resetBtn, true);
    try {
      const res  = await apiFetch('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword }),
      });
      const data = await res.json();

      if (res.status === 400) {
        // Token invalid or expired — show the invalid panel
        resetPanel.classList.add('hidden');
        invalidPanel.classList.remove('hidden');
        return;
      }
      if (!res.ok) {
        showAlert(resetAlert, data.error || 'Password reset failed. Please try again.');
        return;
      }

      // The API issues a new session token on success — log the user in automatically.
      saveSession({
        token:     data.token,
        expiresAt: data.expiresAt,
        userId:    data.userId,
        email:     data.email || '',
      });
      window.location.replace('subscription.html');
    } catch (err) {
      if (err.code !== 'auth') {
        showAlert(resetAlert, err.message || 'Network error. Please try again.');
      }
    } finally {
      setLoading(resetBtn, false);
    }
  });
});
