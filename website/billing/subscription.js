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

    showDashboard(data.subscription, data.hasAccess, data.entitlement, data.anyTrialUsed);
    showReturnBanner(returnStatus, data.hasAccess);

    // If returning from a successful checkout, subscription status may not have
    // been updated by the webhook yet. Poll until hasAccess is true or we give up.
    if (returnStatus === 'success' && !data.hasAccess) {
      await pollUntilAccess();
    }

    // Auto-sync stale IAP timestamps: status is active/trialing but hasAccess is false,
    // which means current_period_end is stale (missed/failed RC renewal webhook).
    // Re-fetch from the RC API to refresh the row, then reload.
    const sub = data.subscription;
    if (!data.hasAccess && sub?.provider && sub.provider !== 'stripe' &&
        (sub.status === 'active' || sub.status === 'trialing')) {
      const store = sub.provider === 'apple' ? 'APP_STORE' : 'PLAY_STORE';
      try {
        const syncRes = await apiFetch('/billing/rc-verify-purchase', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ store }),
        });
        if (syncRes.ok) {
          const syncData = await syncRes.json();
          if (syncData.hasAccess) await loadSubscription(null);
        }
      } catch { /* best-effort — silent on failure */ }
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
function showDashboard(sub, hasAccess, entitlement, anyTrialUsed) {
  document.getElementById('loadingView').classList.add('hidden');
  document.getElementById('dashboardView').classList.remove('hidden');

  renderStatus(sub, hasAccess);

  // Determine which sections to show based on subscription state.
  // Active/trialing/past_due users → manage billing via Stripe portal.
  // Canceled, deleted-customer, or never-subscribed → show subscribe offer.
  const isRecoverableViaPortal = hasAccess ||
    (sub && ['active', 'trialing', 'past_due'].includes(sub.status));

  if (isRecoverableViaPortal) {
    document.getElementById('manageBillingSection').classList.remove('hidden');
    document.getElementById('trialOfferSection').classList.add('hidden');
  } else {
    // No active subscription (canceled, expired, or never subscribed).
    // Show the subscribe offer; update text if the user previously subscribed.
    document.getElementById('trialOfferSection').classList.remove('hidden');
    document.getElementById('manageBillingSection').classList.add('hidden');

    const hadPriorSub = !!sub; // sub exists but is not active/trialing/past_due
    const trialBadge  = document.getElementById('trialBadge');
    const priceNote   = document.getElementById('trialPriceNote');
    const startBtn    = document.getElementById('startTrialBtn');

    if (hadPriorSub || anyTrialUsed) {
      // Resubscription: trial is not available; show a "Subscribe" call to action.
      if (trialBadge)  trialBadge.style.display = 'none';
      if (priceNote)   priceNote.textContent = '$19/month. Cancel anytime.';
      if (startBtn)    startBtn.textContent   = 'Subscribe Again';
    } else {
      // First-time subscriber: restore default trial offer UI.
      if (trialBadge)  trialBadge.style.display = '';
      if (priceNote)   priceNote.textContent = 'Free for 14 days, then $19/month. Cancel anytime.';
      if (startBtn)    startBtn.textContent   = 'Start free trial';
    }
  }

  // Show app download links for active/trialing subscribers.
  // Also show when status is active/trialing even if hasAccess is momentarily false
  // due to a stale current_period_end (RC renewal webhook delay).
  const subIsLive = sub && (sub.status === 'active' || sub.status === 'trialing');
  const showDownload = hasAccess || subIsLive;
  const downloadSection = document.getElementById('downloadSection');
  if (showDownload) {
    renderDownloadButtons();
    downloadSection.classList.remove('hidden');
  } else {
    downloadSection.classList.add('hidden');
  }
}

// ── Platform detection + download buttons ──────────────────────────────────────
function detectPlatform() {
  var ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

function renderDownloadButtons() {
  var container = document.getElementById('downloadBtnContainer');
  if (!container || container.children.length > 0) return;

  var iosHtml = '<a href="https://apps.apple.com/us/app/elmer-publish-everywhere/id6824199734" class="store-badge" target="_blank" rel="noopener noreferrer">' +
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>' +
    '<span class="store-badge-text"><span class="store-badge-sub">Download on the</span><span class="store-badge-name">App Store</span></span>' +
    '</a>';
  var androidHtml = '<a href="https://play.google.com/store/apps/details?id=com.clickfuzz.elmer" class="store-badge" target="_blank" rel="noopener noreferrer">' +
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.18 23.76c.3.17.65.19.98.08l13.12-7.37-2.84-2.84-11.26 10.13zM.54 1.73C.2 2.07 0 2.6 0 3.28v17.44c0 .68.2 1.21.55 1.55l.08.07 9.77-9.77v-.23L.62 1.65l-.08.08zM20.65 10.65l-2.83-1.59-3.17 3.17 3.17 3.17 2.84-1.6c.81-.46.81-1.21-.01-1.67v-.48zM3.18.24L16.3 7.61l-2.84 2.84L3.18.4a.95.95 0 0 1 0-.16z"/></svg>' +
    '<span class="store-badge-text"><span class="store-badge-sub">Get it on</span><span class="store-badge-name">Google Play</span></span>' +
    '</a>';

  var platform = detectPlatform();
  if (platform === 'ios') {
    container.innerHTML = iosHtml;
  } else if (platform === 'android') {
    container.innerHTML = androidHtml;
  } else {
    container.innerHTML = iosHtml + androidHtml;
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
          if (data.error === 'customer_not_found' || data.error === 'no_billing_account') {
            // Stripe customer is deleted or was never created. Any stale subscription
            // has been reconciled server-side. Reload the dashboard — it will now
            // show Subscribe Again instead of staying stuck on Manage billing.
            await loadSubscription(null);
            return;
          }
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
