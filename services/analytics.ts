import PostHog from 'posthog-react-native';

const API_KEY = process.env.EXPO_PUBLIC_POSTHOG_API_KEY ?? '';
const HOST    = process.env.EXPO_PUBLIC_POSTHOG_HOST    ?? 'https://us.i.posthog.com';

// Singleton client — disabled when no API key is configured
const posthog = new PostHog(API_KEY || 'placeholder', {
  host:                             HOST,
  disabled:                         !API_KEY,
  captureAppLifecycleEvents:        false,
  disableGeoip:                     true,
  personProfiles:                   'identified_only',
  sendFeatureFlagEvent:             false,
  preloadFeatureFlags:              false,
  enableSessionReplay:              false,
});

function safe(fn: () => void): void {
  try { fn(); } catch { /* PostHog failures must not affect the app */ }
}

export const Analytics = {
  identify(userId: number): void {
    safe(() => posthog.identify(String(userId)));
  },

  reset(): void {
    safe(() => posthog.reset());
  },

  // ── Registration ─────────────────────────────────────────────────────────────

  signup_completed(props: { signup_method: string; platform: string; app_version?: string }): void {
    safe(() => posthog.capture('signup_completed', props));
  },

  // ── Onboarding ───────────────────────────────────────────────────────────────

  onboarding_started(): void {
    safe(() => posthog.capture('onboarding_started'));
  },

  onboarding_step_completed(step_number: number, step_name: string): void {
    safe(() => posthog.capture('onboarding_step_completed', { step_number, step_name }));
  },

  onboarding_completed(platform_connections_count: number): void {
    safe(() => posthog.capture('onboarding_completed', { platform_connections_count }));
  },

  // ── Platform connections ──────────────────────────────────────────────────────

  platform_connection_started(platform_name: string): void {
    safe(() => posthog.capture('platform_connection_started', { platform_name }));
  },

  platform_connection_succeeded(platform_name: string): void {
    safe(() => posthog.capture('platform_connection_succeeded', { platform_name }));
  },

  platform_connection_failed(platform_name: string, safe_error_category: string): void {
    safe(() => posthog.capture('platform_connection_failed', { platform_name, safe_error_category }));
  },

  // ── AI generation ─────────────────────────────────────────────────────────────

  preview_generation_started(generation_type: 'first_preview' | 'regeneration', platform_count: number): void {
    safe(() => posthog.capture('preview_generation_started', { generation_type, platform_count }));
  },

  preview_generation_succeeded(generation_type: 'first_preview' | 'regeneration', platform_count: number, duration_ms: number): void {
    safe(() => posthog.capture('preview_generation_succeeded', { generation_type, platform_count, duration_ms }));
  },

  preview_generation_failed(generation_type: 'first_preview' | 'regeneration', safe_error_category: string): void {
    safe(() => posthog.capture('preview_generation_failed', { generation_type, safe_error_category }));
  },

  preview_regenerated(platform_count: number): void {
    safe(() => posthog.capture('preview_regenerated', { generation_type: 'regeneration', platform_count }));
  },

  // ── Paywall & subscription ────────────────────────────────────────────────────

  second_preview_attempted(has_used_free_post: boolean, subscription_state: string): void {
    safe(() => posthog.capture('second_preview_attempted', { has_used_free_post, subscription_state }));
  },

  paywall_viewed(trigger_source: string, has_used_free_post: boolean, subscription_state: string): void {
    safe(() => posthog.capture('paywall_viewed', { trigger_source, has_used_free_post, subscription_state }));
  },

  checkout_started(trial_eligible: boolean): void {
    safe(() => posthog.capture('checkout_started', { trial_eligible }));
  },

  checkout_cancelled(): void {
    safe(() => posthog.capture('checkout_cancelled'));
  },

  // ── Post creation ─────────────────────────────────────────────────────────────

  post_creation_started(): void {
    safe(() => posthog.capture('post_creation_started'));
  },

  // ── Settings / customization ──────────────────────────────────────────────────

  writing_style_updated(): void {
    safe(() => posthog.capture('writing_style_updated'));
  },

  writing_examples_updated(): void {
    safe(() => posthog.capture('writing_examples_updated'));
  },

  // ── Publishing retries ────────────────────────────────────────────────────────

  publishing_retry_attempted(platform: string): void {
    safe(() => posthog.capture('publishing_retry_attempted', { platform }));
  },
};
