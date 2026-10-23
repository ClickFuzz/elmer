'use strict';

const { PostHog } = require('posthog-node');

const API_KEY = process.env.POSTHOG_API_KEY ?? '';
const HOST    = process.env.POSTHOG_HOST    ?? 'https://us.i.posthog.com';

let _client = null;

function client() {
  if (!API_KEY) return null;
  if (!_client) {
    _client = new PostHog(API_KEY, {
      host:           HOST,
      flushAt:        20,
      flushInterval:  10000,
      disableGeoip:   true,
    });
  }
  return _client;
}

function track(userId, event, properties = {}) {
  try {
    const ph = client();
    if (!ph) return;
    ph.capture({ distinctId: String(userId), event, properties });
  } catch { /* PostHog failures must not affect the server */ }
}

async function shutdown() {
  try {
    if (_client) await _client.shutdown();
  } catch { /* ignore */ }
}

// ── Free publication ──────────────────────────────────────────────────────────

function trackFreePublicationCompleted(userId, props) {
  track(userId, 'free_publication_completed', props);
}

// ── General publishing ────────────────────────────────────────────────────────

function trackPublicationResult(userId, results, platform) {
  const total   = results.length;
  const ok      = results.filter(r => r.ok).length;
  const failed  = total - ok;
  const props   = {
    publishing_platforms:         [platform],
    destination_count:            total,
    successful_destination_count: ok,
    failed_destination_count:     failed,
  };
  if (ok > 0 && failed === 0) {
    track(userId, 'publication_completed', props);
  } else if (ok > 0) {
    track(userId, 'publication_partially_completed', props);
  } else {
    track(userId, 'publication_failed', props);
  }
}

// ── Subscription lifecycle ────────────────────────────────────────────────────

function trackTrialStarted(userId, props) {
  track(userId, 'trial_started', props);
}

function trackTrialConverted(userId, props) {
  track(userId, 'trial_converted_to_paid', props);
}

function trackSubscriptionRenewed(userId, props) {
  track(userId, 'subscription_renewed', props);
}

function trackSubscriptionCancelled(userId, props) {
  track(userId, 'subscription_cancelled', props);
}

function trackPaymentFailed(userId, props) {
  track(userId, 'payment_failed', props);
}

module.exports = {
  trackFreePublicationCompleted,
  trackPublicationResult,
  trackTrialStarted,
  trackTrialConverted,
  trackSubscriptionRenewed,
  trackSubscriptionCancelled,
  trackPaymentFailed,
  shutdown,
};
