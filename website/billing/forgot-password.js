'use strict';

document.addEventListener('DOMContentLoaded', function () {
  const forgotForm    = document.getElementById('forgotForm');
  const forgotBtn     = document.getElementById('forgotBtn');
  const forgotAlert   = document.getElementById('forgotAlert');
  const requestPanel  = document.getElementById('requestPanel');
  const successPanel  = document.getElementById('successPanel');

  forgotForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    hideAlert(forgotAlert);

    const email = document.getElementById('forgotEmail').value.trim();
    if (!email) {
      showAlert(forgotAlert, 'Please enter your email address.');
      return;
    }

    setLoading(forgotBtn, true);
    try {
      // The API always returns {ok:true} regardless of whether the email exists
      // to prevent user enumeration. We show the same success message either way.
      await apiFetch('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });

      requestPanel.classList.add('hidden');
      successPanel.classList.remove('hidden');
    } catch (err) {
      if (err.code !== 'auth') {
        showAlert(forgotAlert, err.message || 'Network error. Please try again.');
      }
    } finally {
      setLoading(forgotBtn, false);
    }
  });
});
