import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  AppStateStatus,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../constants/colors';
import { getSessionToken } from '../storage/database';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';

// Deep-link prefix the app uses to return from Stripe Checkout / Portal
const BILLING_RETURN_PREFIX = 'elmer://billing/return';

export type SubscriptionStatus = {
  hasAccess: boolean;
  subscription: {
    status: string;
    currentPeriodStart: number | null;
    currentPeriodEnd: number | null;
    trialStart: number | null;
    trialEnd: number | null;
    cancelAtPeriodEnd: boolean;
    cancelAt: number | null;
    canceledAt: number | null;
    trialUsed: boolean;
  } | null;
};

type Props = {
  /** Called once the user has an active subscription (trial or paid) */
  onSubscribed: () => void;
  /** Called when the user taps Sign Out */
  onSignOut: () => void;
  /** Pre-loaded subscription data (avoids an extra fetch on first render) */
  initialStatus?: SubscriptionStatus | null;
};

export default function SubscriptionScreen({ onSubscribed, onSignOut, initialStatus }: Props) {
  const [status, setStatus] = useState<SubscriptionStatus | null>(initialStatus ?? null);
  const [loading, setLoading] = useState(!initialStatus);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [checkoutStarted, setCheckoutStarted] = useState(false);
  const [pollingMessage, setPollingMessage] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAttemptsRef = useRef(0);

  // ── Fetch subscription status from server ──────────────────────────────────

  const fetchStatus = useCallback(async (): Promise<SubscriptionStatus | null> => {
    try {
      const token = await getSessionToken();
      if (!token) return null;
      const res = await fetch(`${API_URL}/billing/subscription`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (initialStatus) return;
    fetchStatus().then(s => {
      setStatus(s);
      setLoading(false);
    });
  }, [fetchStatus, initialStatus]);

  // If we already have access, hand off immediately
  useEffect(() => {
    if (status?.hasAccess) onSubscribed();
  }, [status, onSubscribed]);

  // ── Poll for subscription activation after checkout ────────────────────────

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollAttemptsRef.current = 0;
    setPollingMessage(null);
  }, []);

  const pollForActivation = useCallback(async () => {
    const MAX_ATTEMPTS = 15;
    const INTERVAL_MS  = 2000;

    setPollingMessage('Confirming your subscription…');
    pollAttemptsRef.current = 0;

    const attempt = async () => {
      pollAttemptsRef.current += 1;
      const s = await fetchStatus();
      if (s?.hasAccess) {
        stopPolling();
        setStatus(s);
        setCheckoutLoading(false);
        setCheckoutStarted(false);
        onSubscribed();
        return;
      }
      if (pollAttemptsRef.current >= MAX_ATTEMPTS) {
        stopPolling();
        setCheckoutLoading(false);
        setCheckoutStarted(false);
        setPollingMessage(null);
        // Subscription may still be activating — let the user continue anyway
        Alert.alert(
          'Almost there',
          'Your subscription is still activating. Please check back in a moment — all features will be available once confirmed.',
          [{ text: 'OK' }]
        );
        return;
      }
      pollTimerRef.current = setTimeout(attempt, INTERVAL_MS);
    };

    await attempt();
  }, [fetchStatus, onSubscribed, stopPolling]);

  // Resume polling / refresh when app returns to foreground after checkout
  useEffect(() => {
    if (!checkoutStarted) return;

    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        pollForActivation();
      }
    });

    return () => sub.remove();
  }, [checkoutStarted, pollForActivation]);

  // Handle deep-link return from Stripe Checkout or Portal
  useEffect(() => {
    const handleUrl = ({ url }: { url: string }) => {
      if (!url.startsWith(BILLING_RETURN_PREFIX)) return;
      const params = new URLSearchParams(url.split('?')[1] ?? '');
      const returnStatus = params.get('status');

      if (returnStatus === 'success') {
        setCheckoutLoading(true);
        pollForActivation();
      } else if (returnStatus === 'portal_return') {
        // Refresh subscription status after portal visit
        fetchStatus().then(s => {
          setStatus(s);
          if (s?.hasAccess) onSubscribed();
        });
      }
    };

    const linkingSub = Linking.addEventListener('url', handleUrl);
    // Also handle cold-start return
    Linking.getInitialURL().then(url => {
      if (url && url.startsWith(BILLING_RETURN_PREFIX)) handleUrl({ url });
    });

    return () => {
      linkingSub.remove();
      stopPolling();
    };
  }, [fetchStatus, onSubscribed, pollForActivation, stopPolling]);

  // ── Checkout flow ──────────────────────────────────────────────────────────

  const handleStartTrial = async () => {
    // iOS External Purchase Link disclosure — required before leaving the app.
    // Apple requires this disclosure when linking to an external purchase website.
    if (Platform.OS === 'ios') {
      const proceed = await new Promise<boolean>(resolve => {
        Alert.alert(
          "You're leaving Elmer",
          "You'll be taken to an external website to set up your subscription. Apple is not responsible for the privacy or security of purchases made on the web.",
          [
            { text: 'Continue', onPress: () => resolve(true) },
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          ]
        );
      });
      if (!proceed) return;
    }

    setCheckoutLoading(true);
    try {
      const token = await getSessionToken();
      if (!token) throw new Error('Not signed in');

      const res = await fetch(`${API_URL}/billing/checkout-session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await res.json();

      if (!res.ok) {
        if (data.error === 'active_subscription_exists') {
          const refreshed = await fetchStatus();
          setStatus(refreshed);
          if (refreshed?.hasAccess) { onSubscribed(); return; }
        }
        throw new Error(data.error ?? 'Failed to start checkout');
      }

      setCheckoutStarted(true);
      await Linking.openURL(data.checkoutUrl);
      // Activation is confirmed via AppState / Linking listener above
    } catch (err) {
      setCheckoutLoading(false);
      setCheckoutStarted(false);
      Alert.alert('Checkout error', err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  };

  const handleManageSubscription = async () => {
    setPortalLoading(true);
    try {
      const token = await getSessionToken();
      if (!token) throw new Error('Not signed in');

      const res = await fetch(`${API_URL}/billing/portal-session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not open billing portal');
      await Linking.openURL(data.portalUrl);
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setPortalLoading(false);
    }
  };

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Sign out of your Elmer account?', [
      { text: 'Sign Out', style: 'destructive', onPress: onSignOut },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  // ── Render helpers ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.root}>
        <ActivityIndicator color={colors.cyan} size="large" />
      </View>
    );
  }

  const sub = status?.subscription ?? null;
  const isSubscribed = sub !== null;
  const isTrialing   = sub?.status === 'trialing';
  const isActive     = sub?.status === 'active';
  const isCanceled   = sub?.status === 'canceled' || sub?.status === 'unpaid' || sub?.status === 'paused';
  const trialUsed    = sub?.trialUsed ?? false;

  const formatDate = (ms: number | null) => {
    if (!ms) return '';
    return new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const statusLabel = () => {
    if (!sub) return null;
    if (isTrialing && sub.trialEnd) return `Free trial — ends ${formatDate(sub.trialEnd)}`;
    if (isActive && sub.cancelAtPeriodEnd && sub.currentPeriodEnd) return `Cancels ${formatDate(sub.currentPeriodEnd)}`;
    if (isActive && sub.currentPeriodEnd) return `Renews ${formatDate(sub.currentPeriodEnd)}`;
    if (isCanceled) return 'Subscription ended';
    if (sub.status === 'past_due') return 'Payment past due — update billing info';
    return sub.status.charAt(0).toUpperCase() + sub.status.slice(1);
  };

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* Logo */}
      <View style={styles.logoRow}>
        <Text style={styles.logoText}>elmer</Text>
        <Text style={styles.logoPeriod}>.</Text>
      </View>

      {/* Offer card */}
      {!isSubscribed || isCanceled ? (
        <View style={styles.offerCard}>
          <Text style={styles.offerHeadline}>
            14 days free, then $19/month.
          </Text>
          <Text style={styles.offerBody}>
            Create and publish content across your connected platforms. All features included. Cancel anytime.
          </Text>

          {checkoutLoading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={colors.cyan} />
              <Text style={styles.loadingText}>
                {pollingMessage ?? 'Opening checkout…'}
              </Text>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.ctaBtn}
              onPress={handleStartTrial}
              activeOpacity={0.85}
            >
              <Text style={styles.ctaBtnText}>
                {trialUsed ? 'Subscribe — $19/month' : 'Start 14-Day Free Trial'}
              </Text>
            </TouchableOpacity>
          )}

          <Text style={styles.disclosure}>
            {trialUsed
              ? 'Your payment method will be charged $19 when you subscribe. The subscription renews monthly and can be canceled anytime.'
              : 'Payment information is required. You will not be charged during the 14-day trial. After the trial, your payment method will be billed $19/month unless you cancel before the trial ends. The subscription renews automatically each month.'}
          </Text>

          <View style={styles.legalRow}>
            <TouchableOpacity onPress={() => Linking.openURL('https://getelmer.com/terms')} activeOpacity={0.7}>
              <Text style={styles.legalLink}>Terms of Service</Text>
            </TouchableOpacity>
            <Text style={styles.legalDot}>·</Text>
            <TouchableOpacity onPress={() => Linking.openURL('https://getelmer.com/privacy')} activeOpacity={0.7}>
              <Text style={styles.legalLink}>Privacy Policy</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        /* Existing subscriber — show status + portal */
        <View style={styles.statusCard}>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: isTrialing || isActive ? colors.success : colors.error }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.statusPlan}>Elmer — $19/month</Text>
              {statusLabel() && <Text style={styles.statusSub}>{statusLabel()}</Text>}
            </View>
          </View>

          {portalLoading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={colors.cyan} />
              <Text style={styles.loadingText}>Opening billing portal…</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.manageBtn}
              onPress={handleManageSubscription}
              activeOpacity={0.85}
            >
              <Text style={styles.manageBtnText}>Manage Subscription</Text>
            </TouchableOpacity>
          )}

          <Text style={styles.manageNote}>
            Update your payment method, view invoices, or cancel your subscription.
          </Text>
        </View>
      )}

      <TouchableOpacity style={styles.signOutBtn} onPress={handleSignOut} activeOpacity={0.7}>
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 48,
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    marginBottom: 36,
  },
  logoText: {
    fontSize: 42,
    fontFamily: 'DMSans_700Bold',
    color: colors.textPrimary,
    letterSpacing: -1,
  },
  logoPeriod: {
    fontSize: 42,
    fontFamily: 'DMSans_700Bold',
    color: colors.cyan,
    letterSpacing: -1,
  },

  // Offer card
  offerCard: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 24,
    gap: 16,
  },
  offerHeadline: {
    fontSize: 22,
    fontFamily: 'DMSans_700Bold',
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  offerBody: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: colors.textSecondary,
    lineHeight: 22,
  },
  ctaBtn: {
    backgroundColor: colors.cyan,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  ctaBtnText: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    color: colors.bg,
  },
  disclosure: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: colors.textMuted,
    lineHeight: 17,
  },
  legalRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  legalLink: {
    fontSize: 12,
    color: colors.textMuted,
    textDecorationLine: 'underline',
  },
  legalDot: {
    fontSize: 12,
    color: colors.textMuted,
  },

  // Status card
  statusCard: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 24,
    gap: 16,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    flexShrink: 0,
  },
  statusPlan: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    color: colors.textPrimary,
  },
  statusSub: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: colors.textMuted,
    marginTop: 2,
  },
  manageBtn: {
    borderWidth: 1,
    borderColor: colors.cyan,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  manageBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: colors.cyan,
  },
  manageNote: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 17,
  },

  // Loading
  loadingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 16,
  },
  loadingText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: colors.textMuted,
  },

  // Sign out
  signOutBtn: {
    alignItems: 'center',
    paddingVertical: 20,
    marginTop: 8,
  },
  signOutText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: colors.textMuted,
    textDecorationLine: 'underline',
  },
});
