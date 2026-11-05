'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let currentSubscription = null;
let currentHasAccess    = false;

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async function () {
  const session = requireAuth();
  if (!session) return;

  document.getElementById('accountEmail').textContent    = session.email || '';
  document.getElementById('accountEmailRow').textContent = session.email || '';

  document.getElementById('signOutBtn').addEventListener('click', signOut);

  // Handle Stripe return params before fetching subscription status.
  // Read and immediately clean the URL so params don't persist in history.
  const returnStatus = handleStripeReturn();

  await loadSubscription(returnStatus);

  wireButtons();
});

// ── Stripe return handling ─────────────────────────────────────────────────────
// Stripe redirects to /subscription?status=success&session_id=...
// or /subscription?status=cancel / ?status=portal_return
function handleStripeReturn() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('status');
  // Remove status and session_id from the URL immediately.
  // Keeps the URL clean and prevents the params from being shared or bookmarked.
  if (params.has('status') || params.has('session_id')) {
    window.history.replaceState(null, '', window.location.pathname);
  }
  return status || null;
}

// ── Load subscription ──────────────────────────────────────────────────────────
async function loadSubscription(returnStatus) {
  try {
    const res = await apiFetch('/billing/subscription');
    if (!res.ok) {
      showDashboard(null, false);
      return;
    }
    const data = await res.json();
    currentSubscription = data.subscription;
    currentHasAccess    = data.hasAccess;

    // Update greeting if business name is known
    if (data.businessName) {
      document.getElementById('greetingTitle').textContent = data.businessName;
    }

    showDashboard(data.subscription, data.hasAccess, data.entitlement);
    showReturnBanner(returnStatus, data.hasAccess);

    // If returning from a successful checkout, subscription status may not have
    // been updated by the webhook yet. Poll until hasAccess is true or we give up.
    if (returnStatus === 'success' && !data.hasAccess) {
      await pollUntilAccess();
    }
  } catch (err) {
    if (err.code !== 'auth') {
      showDashboard(null, false);
    }
  }
}

// ── Poll for subscription access ───────────────────────────────────────────────
// Called after a successful Stripe checkout when access isn't reflected yet.
// Stripe webhooks can take a few seconds. Polls up to 10x with 2s delay.
async function pollUntilAccess() {
  for (let i = 0; i < 10; i++) {
    await delay(2000);
    try {
      const res = await apiFetch('/billing/subscription');
      if (!res.ok) break;
      const data = await res.json();
      if (data.hasAccess) {
        currentSubscription = data.subscription;
        currentHasAccess    = true;
        showDashboard(data.subscription, true, data.entitlement);
        showReturnBanner('success', true);
        return;
      }
    } catch { break; }
  }
  // After 10 attempts, subscription may still be processing. Show a note.
  const banner = document.getElementById('returnBanner');
  showAlert(banner,
    'Payment confirmed. Your subscription is being activated — refresh in a moment if it doesn\'t appear.',
    'info'
  );
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ── Render dashboard ───────────────────────────────────────────────────────────
function showDashboard(sub, hasAccess, entitlement) {
  document.getElementById('loadingView').classList.add('hidden');
  document.getElementById('dashboardView').classList.remove('hidden');

  renderStatus(sub, hasAccess);

  if (hasAccess || sub) {
    // Show manage billing for any user who has / had a subscription
    document.getElementById('manageBillingSection').classList.remove('hidden');
    document.getElementById('trialOfferSection').classList.add('hidden');
  } else {
    // No subscription at all — show trial / subscribe offer
    document.getElementById('trialOfferSection').classList.remove('hidden');
    document.getElementById('manageBillingSection').classList.add('hidden');
  }
}

function renderStatus(sub, hasAccess) {
  const badgeWrap  = document.getElementById('statusBadgeWrap');
  const periodRow  = document.getElementById('periodRow');
  const trialRow   = document.getElementById('trialRow');
  const cancelRow  = document.getElementById('cancelRow');

  if (!sub) {
    badgeWrap.innerHTML = '<span class="badge badge-inactive">No subscription</span>';
    return;
  }

  const status = sub.status;

  if (status === 'trialing') {
    badgeWrap.innerHTML = '<span class="badge badge-trialing">Trial active</span>';
    if (sub.trialEnd) {
      trialRow.classList.remove('hidden');
      document.getElementById('trialValue').textContent = formatDate(sub.trialEnd);
    }
  } else if (status === 'active') {
    badgeWrap.innerHTML = '<span class="badge badge-active">Active</span>';
    if (sub.currentPeriodEnd) {
      periodRow.classList.remove('hidden');
      document.getElementById('periodLabel').textContent = sub.cancelAtPeriodEnd
        ? 'Access until' : 'Renews on';
      document.getElementById('periodValue').textContent = formatDate(sub.currentPeriodEnd);
    }
    if (sub.cancelAtPeriodEnd && sub.cancelAt) {
      cancelRow.classList.remove('hidden');
      document.getElementById('cancelValue').textContent = formatDate(sub.cancelAt);
    }
  } else if (status === 'past_due') {
    badgeWrap.innerHTML = '<span class="badge badge-warning">Payment issue</span>';
  } else if (status === 'canceled' || status === 'cancelled') {
    badgeWrap.innerHTML = '<span class="badge badge-inactive">Cancelled</span>';
    if (sub.canceledAt) {
      periodRow.classList.remove('hidden');
      document.getElementById('periodLabel').textContent = 'Cancelled on';
      document.getElementById('periodValue').textContent = formatDate(sub.canceledAt);
    }
  } else {
    badgeWrap.innerHTML = '<span class="badge badge-inactive">' + (status || 'Unknown') + '</span>';
  }
}

// ── Stripe return banner ───────────────────────────────────────────────────────
function showReturnBanner(status, hasAccess) {
  const banner = document.getElementById('returnBanner');
  if (!status) { hideAlert(banner); return; }

  if (status === 'success' && hasAccess) {
    showAlert(banner, '🎉 You\'re subscribed! Welcome to Elmer.', 'success');
  } else if (status === 'cancel') {
    showAlert(banner, 'Checkout cancelled. No charge was made.', 'info');
  } else if (status === 'portal_return') {
    showAlert(banner, 'Your billing settings have been updated.', 'success');
  }
}

// ── Button wiring ──────────────────────────────────────────────────────────────
function wireButtons() {
  // Start trial / subscribe
  const startBtn = document.getElementById('startTrialBtn');
  if (startBtn) {
    startBtn.addEventListener('click', async function () {
      const checkoutAlert = document.getElementById('checkoutAlert');
      hideAlert(checkoutAlert);
      setLoading(startBtn, true);
      try {
        const res  = await apiFetch('/billing/checkout-session', {
          method: 'POST',
          body: JSON.stringify({ source: 'web' }),
        });
        const data = await res.json();

        if (res.status === 409) {
          // Already subscribed — reload to sync status
          await loadSubscription(null);
          return;
        }
        if (!res.ok) {
          showAlert(checkoutAlert, data.error === 'billing_not_configured'
            ? 'Billing is not configured yet. Please try again later.'
            : (data.error || 'Failed to start checkout. Please try again.'));
          return;
        }
        if (data.checkoutUrl) {
          window.location.href = data.checkoutUrl;
        }
      } catch (err) {
        if (err.code !== 'auth') {
          showAlert(checkoutAlert, err.message || 'Network error. Please try again.');
        }
      } finally {
        setLoading(startBtn, false);
      }
    });
  }

  // Manage billing (Stripe Customer Portal)
  const manageBtn = document.getElementById('manageBtn');
  if (manageBtn) {
    manageBtn.addEventListener('click', async function () {
      const portalAlert = document.getElementById('portalAlert');
      hideAlert(portalAlert);
      setLoading(manageBtn, true);
      try {
        const res  = await apiFetch('/billing/portal-session', {
          method: 'POST',
          body: JSON.stringify({ source: 'web' }),
        });
        const data = await res.json();

        if (res.status === 404) {
          showAlert(portalAlert,
            'No billing account found. Start a subscription to access billing management.',
            'info');
          return;
        }
        if (!res.ok) {
          showAlert(portalAlert, data.error || 'Failed to open billing portal. Please try again.');
          return;
        }
        if (data.portalUrl) {
          window.location.href = data.portalUrl;
        }
      } catch (err) {
        if (err.code !== 'auth') {
          showAlert(portalAlert, err.message || 'Network error. Please try again.');
        }
      } finally {
        setLoading(manageBtn, false);
      }
    });
  }

  // Delete account — first click shows confirmation, second click submits
  const deleteBtn     = document.getElementById('deleteAccountBtn');
  const confirmBox    = document.getElementById('confirmDeleteBox');
  const confirmBtn    = document.getElementById('confirmDeleteBtn');
  const cancelDelBtn  = document.getElementById('cancelDeleteBtn');
  const deleteAlert   = document.getElementById('deleteAlert');
  const confirmMsg    = document.getElementById('confirmDeleteMsg');

  deleteBtn.addEventListener('click', function () {
    hideAlert(deleteAlert);

    // Block deletion if subscription is currently active
    if (currentHasAccess) {
      confirmMsg.textContent = '';
      showAlert(deleteAlert,
        'You have an active subscription. Cancel your subscription through billing management before deleting your account.',
        'warning');
      confirmBox.classList.add('visible');
      confirmBtn.classList.add('hidden');
      return;
    }

    confirmMsg.textContent = 'This permanently deletes your account and cannot be undone. All your publishing history will be removed.';
    confirmBtn.classList.remove('hidden');
    confirmBox.classList.add('visible');
  });

  cancelDelBtn.addEventListener('click', function () {
    confirmBox.classList.remove('visible');
    hideAlert(deleteAlert);
  });

  confirmBtn.addEventListener('click', async function () {
    hideAlert(deleteAlert);
    setLoading(confirmBtn, true);
    try {
      const res  = await apiFetch('/auth/account', { method: 'DELETE' });
      const data = await res.json();

      if (res.status === 409) {
        confirmBox.classList.remove('visible');
        showAlert(deleteAlert,
          'Your subscription is still active. Cancel it in Stripe before deleting your account.',
          'warning');
        return;
      }
      if (!res.ok) {
        showAlert(deleteAlert, data.error || 'Could not delete account. Please try again.');
        return;
      }

      clearSession();
      window.location.replace('login.html');
    } catch (err) {
      if (err.code !== 'auth') {
        showAlert(deleteAlert, err.message || 'Network error. Please try again.');
      }
    } finally {
      setLoading(confirmBtn, false);
    }
  });
}
