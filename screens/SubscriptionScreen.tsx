import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
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
import { Analytics } from '../services/analytics';
import { purchaseSubscription, restorePurchases, getMonthlyPackage, type PackageInfo } from '../services/purchases';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';

// Deep-link prefix used to detect returns from the Stripe Customer Portal.
const BILLING_RETURN_PREFIX = `${process.env.EXPO_PUBLIC_APP_SCHEME ?? 'elmer'}://billing/return`;

export type SubscriptionStatus = {
  hasAccess: boolean;
  entitlement?: { access: string };
  onboardingCompleted?: boolean;
  testMode?: boolean;
  subscription: {
    status: string;
    provider: string;
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
  /** Called when the user taps Sign Out (only shown in gate/offer mode) */
  onSignOut: () => void;
  /** Pre-loaded subscription data (avoids an extra fetch on first render) */
  initialStatus?: SubscriptionStatus | null;
  /** When provided the screen is in "manage" mode: back button at top, no sign-out/dismiss */
  onBack?: () => void;
};

export default function SubscriptionScreen({ onSubscribed, onSignOut, initialStatus, onBack }: Props) {
  const isManageMode = !!onBack;
  const [status, setStatus] = useState<SubscriptionStatus | null>(initialStatus ?? null);
  const [loading, setLoading] = useState(!initialStatus);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [pollingMessage, setPollingMessage] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAttemptsRef = useRef(0);
  const paywallTrackedRef = useRef(false);
  const [packageInfo, setPackageInfo] = useState<PackageInfo | null | undefined>(undefined);

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

  useEffect(() => {
    getMonthlyPackage().then(setPackageInfo);
  }, []);

  // In gate mode, hand off immediately once access is confirmed.
  // In manage mode (onBack provided) the user already has access — don't auto-dismiss.
  useEffect(() => {
    if (!isManageMode && status?.hasAccess) onSubscribed();
  }, [isManageMode, status, onSubscribed]);

  // Track paywall_viewed once when the screen mounts without access
  useEffect(() => {
    if (!loading && !status?.hasAccess && !paywallTrackedRef.current) {
      paywallTrackedRef.current = true;
      const access = (status as SubscriptionStatus | null)?.entitlement?.access ?? 'none';
      Analytics.paywall_viewed(
        'second_preview',
        access === 'free_redeemed',
        (status as SubscriptionStatus | null)?.subscription?.status ?? 'none'
      );
    }
  }, [loading, status]);

  // ── Poll for subscription activation after purchase ────────────────────────

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
        onSubscribed();
        return;
      }
      if (pollAttemptsRef.current >= MAX_ATTEMPTS) {
        stopPolling();
        setCheckoutLoading(false);
        setPollingMessage(null);
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

  // Handle deep-link return from Stripe Customer Portal
  useEffect(() => {
    const handleUrl = ({ url }: { url: string }) => {
      if (!url.startsWith(BILLING_RETURN_PREFIX)) return;
      const params = new URLSearchParams(url.split('?')[1] ?? '');
      const returnStatus = params.get('status');
      if (returnStatus === 'portal_return') {
        fetchStatus().then(s => {
          setStatus(s);
          if (s?.hasAccess) onSubscribed();
        });
      }
    };
    const linkingSub = Linking.addEventListener('url', handleUrl);
    Linking.getInitialURL().then(url => {
      if (url && url.startsWith(BILLING_RETURN_PREFIX)) handleUrl({ url });
    });
    return () => {
      linkingSub.remove();
      stopPolling();
    };
  }, [fetchStatus, onSubscribed, stopPolling]);

  // ── Purchase flow (RevenueCat) ─────────────────────────────────────────────

  // Calls the server's rc-verify-purchase endpoint immediately after a successful
  // native purchase. This syncs RC subscriber state before the webhook fires so
  // the user gets access in seconds instead of waiting for the polling loop.
  const verifyPurchaseWithServer = useCallback(async (): Promise<boolean> => {
    try {
      const token = await getSessionToken();
      if (!token) return false;
      const store = Platform.OS === 'ios' ? 'APP_STORE' : 'PLAY_STORE';
      const res = await fetch(`${API_URL}/billing/rc-verify-purchase`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ store }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return !!(data.hasAccess);
    } catch {
      return false;
    }
  }, []);

  const handleStartTrial = async () => {
    setCheckoutLoading(true);
    try {
      Analytics.checkout_started(!(status?.subscription?.trialUsed ?? false));
      const result = await purchaseSubscription();

      if (!result.success) {
        setCheckoutLoading(false);
        if ('cancelled' in result && result.cancelled) return; // user dismissed the native sheet
        Alert.alert('Purchase error', result.error ?? 'Something went wrong. Please try again.');
        return;
      }

      // Fast path: immediately sync RC subscriber state with the server.
      // If confirmed, refresh full status and hand off — no polling needed.
      const immediateAccess = await verifyPurchaseWithServer();
      if (immediateAccess) {
        const s = await fetchStatus();
        stopPolling();
        setStatus(s);
        setCheckoutLoading(false);
        onSubscribed();
        return;
      }

      // Fallback: RC API may be briefly delayed — poll until the webhook fires.
      await pollForActivation();
    } catch {
      setCheckoutLoading(false);
      Alert.alert('Purchase error', 'Something went wrong. Please try again.');
    }
  };

  // ── Restore purchases ──────────────────────────────────────────────────────

  const handleRestore = async () => {
    setRestoreLoading(true);
    try {
      const result = await restorePurchases();
      if (!result.success) {
        Alert.alert('Restore failed', result.error);
        return;
      }
      if (result.hasEntitlement) {
        // RC found an active entitlement — poll server to sync it
        setCheckoutLoading(true);
        await pollForActivation();
      } else {
        // Refresh server status anyway — maybe a Stripe sub is active
        const s = await fetchStatus();
        setStatus(s);
        if (s?.hasAccess) {
          onSubscribed();
        } else {
          Alert.alert('No subscription found', 'No prior subscription was found for this Apple ID / Google account. If you subscribed with a different account, sign in with that account first.');
        }
      }
    } finally {
      setRestoreLoading(false);
    }
  };

  // ── Manage subscription (provider-aware) ──────────────────────────────────

  const handleManageSubscription = async () => {
    const provider = status?.subscription?.provider ?? 'stripe';

    if (provider === 'apple') {
      await Linking.openURL('https://apps.apple.com/account/subscriptions');
      return;
    }
    if (provider === 'google') {
      await Linking.openURL('https://play.google.com/store/account/subscriptions');
      return;
    }

    // Stripe — open the Customer Portal
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
  const isSubscribed   = sub !== null;
  const isTrialing     = sub?.status === 'trialing';
  const isActive       = sub?.status === 'active';
  const isCanceled     = sub?.status === 'canceled' || sub?.status === 'unpaid' || sub?.status === 'paused';
  const trialUsed      = sub?.trialUsed ?? false;
  const freePostUsed   = status?.entitlement?.access === 'free_redeemed';

  const priceString = packageInfo?.priceString ?? null;
  const packageHasFreeTrial = packageInfo?.hasFreeTrial ?? false;
  const showFreeTrial = !trialUsed && packageHasFreeTrial;
  const trialAdj = (packageInfo?.hasFreeTrial && packageInfo.trialPeriodUnits)
    ? `${packageInfo.trialPeriodUnits}-${packageInfo.trialPeriodUnit}`
    : '14-day';
  const trialNoun = (packageInfo?.hasFreeTrial && packageInfo.trialPeriodUnits)
    ? (packageInfo.trialPeriodUnits === 1
        ? `1 ${packageInfo.trialPeriodUnit}`
        : `${packageInfo.trialPeriodUnits} ${packageInfo.trialPeriodUnit}s`)
    : '14 days';

  const offerHeadline = freePostUsed
    ? 'Keep posting with Elmer.'
    : packageInfo === undefined
      ? 'Loading pricing…'
      : packageInfo === null
        ? 'Subscription unavailable.'
        : showFreeTrial
          ? `${trialNoun} free, then ${priceString}/month.`
          : `${priceString}/month.`;

  const offerBody = packageInfo === null
    ? 'Subscription pricing is currently unavailable. Please check your connection and try again later.'
    : freePostUsed
      ? showFreeTrial
        ? `Your first post was free. Start your ${trialAdj} free trial to keep sharing your updates.`
        : 'Your first post was free. Subscribe to keep sharing your updates.'
      : 'Create and publish content across your connected platforms. All features included. Cancel anytime.';

  const formatDate = (ms: number | null) => {
    if (!ms) return '';
    const d = new Date(Number(ms));
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
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

  const isAppleOrGoogle = sub?.provider === 'apple' || sub?.provider === 'google';

  const disclosureText = showFreeTrial
    ? Platform.OS === 'ios'
      ? `A ${trialAdj} free trial is available to new subscribers. Payment will be charged to your Apple ID account when the trial ends (${priceString ?? ''}/month). Subscription automatically renews unless canceled at least 24 hours before the end of the trial period. Manage subscriptions in your Account Settings.`
      : `A ${trialAdj} free trial is available to new subscribers. Payment will be charged to your Google Play account when the trial ends (${priceString ?? ''}/month). Subscription automatically renews unless canceled at least 24 hours before the end of the trial period. Manage your subscription in Google Play.`
    : Platform.OS === 'ios'
      ? 'Payment will be charged to your Apple ID account at confirmation of purchase. Subscription automatically renews unless canceled at least 24 hours before the end of the current period. Manage subscriptions in your Account Settings after purchase.'
      : 'Payment will be charged to your Google Play account at confirmation of purchase. Subscription automatically renews unless canceled at least 24 hours before the end of the current period. Manage your subscription in Google Play.';

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, isManageMode && styles.contentManage]}
      keyboardShouldPersistTaps="handled"
    >
      {/* Back button header (manage mode only) */}
      {isManageMode && (
        <View style={styles.manageHeader}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.backBtnText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.manageHeaderTitle}>Subscription</Text>
          <View style={styles.backBtn} />
        </View>
      )}

      {/* Logo (gate mode only) */}
      {!isManageMode && (
        <View style={styles.logoRow}>
          <Image source={require('../assets/logo.png')} style={styles.logoImage} resizeMode="contain" />
        </View>
      )}

      {/* Offer card */}
      {!isSubscribed || isCanceled ? (
        <View style={styles.offerCard}>
          <Text style={styles.offerHeadline}>{offerHeadline}</Text>
          <Text style={styles.offerBody}>{offerBody}</Text>

          {packageInfo === undefined ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={colors.cyan} />
              <Text style={styles.loadingText}>Loading pricing…</Text>
            </View>
          ) : packageInfo === null ? (
            <TouchableOpacity style={[styles.ctaBtn, styles.ctaBtnDisabled]} disabled activeOpacity={1}>
              <Text style={styles.ctaBtnText}>Pricing unavailable — try again later</Text>
            </TouchableOpacity>
          ) : checkoutLoading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={colors.cyan} />
              <Text style={styles.loadingText}>
                {pollingMessage ?? 'Processing…'}
              </Text>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.ctaBtn}
              onPress={handleStartTrial}
              activeOpacity={0.85}
            >
              <Text style={styles.ctaBtnText}>
                {showFreeTrial ? 'Start My Free Trial' : `Subscribe — ${priceString ?? ''}/month`}
              </Text>
            </TouchableOpacity>
          )}

          <Text style={styles.disclosure}>{disclosureText}</Text>

          <View style={styles.legalRow}>
            <TouchableOpacity onPress={() => Linking.openURL('https://getelmer.com/terms')} activeOpacity={0.7}>
              <Text style={styles.legalLink}>Terms of Service</Text>
            </TouchableOpacity>
            <Text style={styles.legalDot}>·</Text>
            <TouchableOpacity onPress={() => Linking.openURL('https://getelmer.com/privacy')} activeOpacity={0.7}>
              <Text style={styles.legalLink}>Privacy Policy</Text>
            </TouchableOpacity>
          </View>

          {/* Restore Purchases — required by Apple App Store guidelines */}
          {restoreLoading ? (
            <View style={styles.restoreLoadingRow}>
              <ActivityIndicator color={colors.textMuted} size="small" />
              <Text style={styles.restoreText}>Restoring…</Text>
            </View>
          ) : (
            <TouchableOpacity onPress={handleRestore} activeOpacity={0.7} style={styles.restoreBtn}>
              <Text style={styles.restoreText}>Restore Purchases</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        /* Existing subscriber — show status + management */
        <View style={styles.statusCard}>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: isTrialing || isActive ? colors.success : colors.error }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.statusPlan}>
                {priceString ? `Elmer — ${priceString}/month` : 'Elmer'}
              </Text>
              {statusLabel() && <Text style={styles.statusSub}>{statusLabel()}</Text>}
            </View>
          </View>

          {portalLoading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={colors.cyan} />
              <Text style={styles.loadingText}>Opening subscription management…</Text>
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
            {isAppleOrGoogle
              ? 'Manage your subscription in your device account settings.'
              : 'Update your payment method, view invoices, or cancel your subscription.'}
          </Text>
        </View>
      )}

      {!isManageMode && (
        <TouchableOpacity style={styles.signOutBtn} onPress={handleSignOut} activeOpacity={0.7}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      )}
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
  contentManage: {
    justifyContent: 'flex-start',
    paddingTop: 0,
    paddingVertical: 0,
  },
  manageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 16,
    marginBottom: 24,
  },
  backBtn: { width: 80 },
  backBtnText: { color: colors.cyan, fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  manageHeaderTitle: {
    fontSize: 18,
    fontFamily: 'DMSans_600SemiBold',
    color: colors.textPrimary,
  },
  logoRow: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 36,
  },
  logoImage: { height: 40, width: 152 },

  // Offer card
  offerCard: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#EEF0F3',
    padding: 24,
    gap: 16,
    shadowColor: '#101828',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
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
    color: '#FFFFFF',
  },
  ctaBtnDisabled: {
    opacity: 0.5,
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
  restoreBtn: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  restoreLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  restoreText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: colors.textMuted,
    textDecorationLine: 'underline',
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

  dismissBtn: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  dismissText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: colors.textMuted,
  },
});

