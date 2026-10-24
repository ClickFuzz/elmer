import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../constants/colors';
import {
  getBusinessProfile,
  saveBusinessProfile,
  getSettingsVersion,
  saveSettingsVersion,
} from '../storage/database';
import { Analytics } from '../services/analytics';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';

type PlatformState = {
  facebook: boolean;
  instagram: boolean;
  threads: boolean;
  google: boolean;
  wordpress: boolean;
};

type ConnectingPlatform = 'facebook' | 'instagram' | 'threads' | 'google' | 'wordpress' | null;

function PlatformRow({
  platform,
  label,
  connected,
  connecting,
  sessionToken,
  onConnect,
}: {
  platform: keyof PlatformState;
  label: string;
  connected: PlatformState;
  connecting: ConnectingPlatform;
  sessionToken: string | null;
  onConnect: () => void;
}) {
  const isConnected  = connected[platform];
  const isConnecting = connecting === platform;
  return (
    <View style={styles.platformRow}>
      <View style={[styles.dot, { backgroundColor: isConnected ? colors.success : colors.border }]} />
      <Text style={[styles.platformLabel, !isConnected && styles.platformLabelDim]}>{label}</Text>
      {isConnected ? (
        <View style={styles.connectedChip}>
          <Text style={styles.connectedChipText}>Connected</Text>
        </View>
      ) : (
        <TouchableOpacity
          style={[styles.connectBtn, (isConnecting || !sessionToken) && styles.connectBtnDisabled]}
          onPress={onConnect}
          disabled={isConnecting || !sessionToken}
          activeOpacity={0.7}
        >
          {isConnecting
            ? <ActivityIndicator color={colors.bg} size="small" />
            : <Text style={styles.connectBtnText}>Connect</Text>}
        </TouchableOpacity>
      )}
    </View>
  );
}

type Props = {
  sessionToken: string | null;
  onComplete: (platformConnectionsCount?: number) => void;
};

export default function OnboardingWizard({ sessionToken, onComplete }: Props) {
  const [step, setStep] = useState(1);

  // Step 1: business info
  const [businessName, setBusinessName] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [businessLocation, setBusinessLocation] = useState('');
  const [nameError, setNameError] = useState(false);
  const [step1Saving, setStep1Saving] = useState(false);
  const [step1SaveError, setStep1SaveError] = useState<string | null>(null);
  const typeRef = useRef<TextInput>(null);
  const locationRef = useRef<TextInput>(null);

  // Step 2: platform connections
  const [connected, setConnected] = useState<PlatformState>({
    facebook: false,
    instagram: false,
    threads: false,
    google: false,
    wordpress: false,
  });
  const [connecting, setConnecting] = useState<ConnectingPlatform>(null);
  const [wpFormOpen, setWpFormOpen] = useState(false);
  const [wpUrl, setWpUrl] = useState('');
  const [platformsLoaded, setPlatformsLoaded] = useState(false);

  // Step 3: completing
  const [completing, setCompleting] = useState(false);

  // Fire onboarding_started once when wizard first mounts
  const startedRef = useRef(false);
  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      Analytics.onboarding_started();
    }
  }, []);

  // Pre-populate from saved business profile
  useEffect(() => {
    getBusinessProfile().then(p => {
      if (p.name)     setBusinessName(p.name);
      if (p.categoryCustom || (p.category && p.category !== 'Other')) {
        setBusinessType(p.category === 'Other' ? p.categoryCustom : p.category);
      }
      if (p.location) setBusinessLocation(p.location);
    }).catch(() => {});
  }, []);

  // Load existing platform connections when entering step 2
  useEffect(() => {
    if (step !== 2 || !sessionToken || platformsLoaded) return;
    fetch(`${API_URL}/platforms`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    }).then(r => r.ok ? r.json() : { platforms: [] })
      .then(data => {
        const platforms: { platform: string }[] = data.platforms ?? [];
        setConnected({
          facebook:  platforms.some(p => p.platform === 'facebook'),
          instagram: platforms.some(p => p.platform === 'instagram'),
          threads:   platforms.some(p => p.platform === 'threads'),
          google:    platforms.some(p => p.platform === 'google'),
          wordpress: platforms.some(p => p.platform === 'wordpress'),
        });
        setPlatformsLoaded(true);
      })
      .catch(() => { setPlatformsLoaded(true); });
  }, [step, sessionToken, platformsLoaded]);

  // ── Step 1 handlers ──────────────────────────────────────────────────────

  const handleStep1Continue = async () => {
    if (!businessName.trim()) {
      setNameError(true);
      return;
    }
    setNameError(false);
    setStep1SaveError(null);
    setStep1Saving(true);

    try {
      const current = await getBusinessProfile();
      const updatedProfile = {
        ...current,
        name:           businessName.trim(),
        category:       businessType.trim() ? 'Other' : current.category,
        categoryCustom: businessType.trim() || current.categoryCustom,
        location:       businessLocation.trim() || current.location,
      };
      await saveBusinessProfile(updatedProfile);

      // The business name MUST reach Railway before onboarding is considered complete.
      // Without a server-confirmed name, a second device login would show onboarding again.
      if (!sessionToken) {
        setStep1SaveError('Not signed in. Please go back and sign in to continue.');
        return;
      }

      let version = await getSettingsVersion();
      let savedToServer = false;

      for (let attempt = 0; attempt < 2 && !savedToServer; attempt++) {
        const res = await fetch(`${API_URL}/auth/settings`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
          body:    JSON.stringify({ settings: updatedProfile, version }),
        });

        if (res.ok) {
          const data = await res.json();
          await saveSettingsVersion(data.version ?? version + 1);
          savedToServer = true;
        } else if (res.status === 409) {
          // Another device set a version — accept the server version and retry once.
          const data = await res.json();
          version = data.current?.version ?? version;
          await saveSettingsVersion(version);
          // Loop continues for one retry
        } else {
          // Non-retryable server error
          break;
        }
      }

      if (!savedToServer) {
        setStep1SaveError('Could not save to your account. Check your connection and try again.');
        return;
      }

      Analytics.onboarding_step_completed(1, 'business_info');
      setStep(2);
    } catch {
      setStep1SaveError('Could not reach the server. Check your connection and try again.');
    } finally {
      setStep1Saving(false);
    }
  };

  // ── Step 2 OAuth handlers ────────────────────────────────────────────────

  const openOAuth = async (
    platform: ConnectingPlatform,
    connectUrlPath: string,
    successFn: (params: URLSearchParams) => void,
    errorFn: (error: string) => void,
  ) => {
    if (!sessionToken || !platform) return;
    setConnecting(platform);
    Analytics.platform_connection_started(platform);
    try {
      const res  = await fetch(`${API_URL}${connectUrlPath}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      const data = await res.json();
      if (!res.ok) {
        Analytics.platform_connection_failed(platform, 'server_error');
        Alert.alert('Connection failed', data.error ?? 'Could not start authorization.');
        return;
      }
      const result = await WebBrowser.openAuthSessionAsync(data.authUrl, 'elmer://oauth/callback');
      if (result.type === 'success') {
        const params = new URLSearchParams((result.url.split('?')[1] ?? '').split('#')[0]);
        const error  = params.get('error');
        if (error) { errorFn(error); return; }
        successFn(params);
      } else if (result.type === 'cancel' || result.type === 'dismiss') {
        Analytics.platform_connection_failed(platform, 'user_cancelled');
      }
    } catch (err) {
      Analytics.platform_connection_failed(platform, 'unexpected_error');
      Alert.alert('Connection failed', err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setConnecting(null);
    }
  };

  const handleConnectFacebook = () =>
    openOAuth('facebook', '/facebook/connect-url',
      (params) => {
        if (params.get('success') === 'true') {
          setConnected(c => ({ ...c, facebook: true }));
          Analytics.platform_connection_succeeded('facebook');
        }
      },
      (error) => {
        if (error === 'no_manageable_pages' || error === 'insufficient_permissions') {
          Alert.alert(
            'No Pages found',
            "Facebook didn't return any Pages you can manage. If your Page belongs to a Meta Business Portfolio, select both the Page and the business that owns it when connecting.",
            [
              { text: 'Try Again', onPress: handleConnectFacebook },
              { text: 'Skip', style: 'cancel' },
            ]
          );
        } else {
          Alert.alert('Connection failed', `Facebook returned: ${error}`);
        }
      }
    );

  const handleConnectInstagram = () =>
    openOAuth('instagram', '/instagram/connect-url',
      (params) => {
        if (params.get('success') === 'true') {
          setConnected(c => ({ ...c, instagram: true }));
          Analytics.platform_connection_succeeded('instagram');
        }
      },
      (error) => {
        if (error === 'personal_account_not_supported') {
          Alert.alert(
            'Professional Account Required',
            'Instagram requires a Business or Creator account. Switching is free and keeps your followers.',
            [
              { text: 'Try Again', onPress: handleConnectInstagram },
              { text: 'Skip', style: 'cancel' },
            ]
          );
        } else {
          Alert.alert('Connection failed', `Instagram returned: ${error}`);
        }
      }
    );

  const handleConnectThreads = () =>
    openOAuth('threads', '/threads/connect-url',
      (params) => {
        if (params.get('success') === 'true') {
          setConnected(c => ({ ...c, threads: true }));
          Analytics.platform_connection_succeeded('threads');
        }
      },
      (error) => Alert.alert('Connection failed', `Threads returned: ${error}`)
    );

  const handleConnectGoogle = () =>
    openOAuth('google', '/google/connect-url',
      (params) => {
        if (params.get('success') === 'true') {
          setConnected(c => ({ ...c, google: true }));
          Analytics.platform_connection_succeeded('google');
        }
      },
      (error) => {
        if (error === 'no_business_accounts') {
          Alert.alert('No accounts found', 'No Google Business accounts were found. Make sure you have a verified Google Business Profile.');
        } else if (error === 'no_locations') {
          Alert.alert('No locations found', 'No business locations found. Add one in Google Business Profile Manager first.');
        } else {
          Alert.alert('Connection failed', `Google returned: ${error}`);
        }
      }
    );

  const handleConnectWordPress = async () => {
    const url = wpUrl.trim();
    if (!url) {
      Alert.alert('URL required', 'Enter your WordPress website URL to continue.', [{ text: 'OK' }]);
      return;
    }
    if (!sessionToken) return;
    setConnecting('wordpress');
    try {
      const res  = await fetch(`${API_URL}/wordpress/connect-url`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ siteUrl: url }),
      });
      const data = await res.json();
      if (!res.ok) {
        Alert.alert('Connection failed', data.error ?? 'Could not reach your WordPress site.');
        return;
      }
      const result = await WebBrowser.openAuthSessionAsync(data.authUrl, 'elmer://oauth/callback');
      if (result.type === 'success') {
        const params = new URLSearchParams((result.url.split('?')[1] ?? '').split('#')[0]);
        const error  = params.get('error');
        if (error) {
          if (error === 'rejected') {
            Alert.alert('Cancelled', 'WordPress authorization was cancelled. You can connect later in Settings.', [{ text: 'OK' }]);
          } else {
            Alert.alert('Connection failed', `WordPress returned: ${error}`);
          }
          return;
        }
        if (params.get('success') === 'true') {
          setConnected(c => ({ ...c, wordpress: true }));
          Analytics.platform_connection_succeeded('wordpress');
          setWpUrl('');
          setWpFormOpen(false);
        }
      }
    } catch (err) {
      Alert.alert('Connection failed', err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setConnecting(null);
    }
  };

  // ── Step 3 handler ────────────────────────────────────────────────────────

  const handleFinish = async () => {
    setCompleting(true);
    Analytics.onboarding_step_completed(3, 'create_first_post');
    onComplete(connectedCount); // App.tsx handles local save + server call
  };

  const connectedCount = Object.values(connected).filter(Boolean).length;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Progress */}
      <View style={styles.progressRow}>
        {[1, 2, 3].map(n => (
          <View
            key={n}
            style={[styles.progressDot, step >= n && styles.progressDotActive]}
          />
        ))}
      </View>
      <Text style={styles.stepLabel}>Step {step} of 3</Text>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >

        {/* ── STEP 1: Your Business ── */}
        {step === 1 && (
          <View style={styles.stepContainer}>
            <Text style={styles.title}>Tell us about your business</Text>
            <Text style={styles.subtitle}>
              This helps Elmer write posts that sound like your business.
            </Text>

            <View style={styles.card}>
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Business Name</Text>
                <TextInput
                  style={[styles.fieldInput, nameError && styles.fieldInputError]}
                  value={businessName}
                  onChangeText={v => { setBusinessName(v); setNameError(false); }}
                  placeholder="Your company name"
                  placeholderTextColor={colors.textMuted}
                  autoCorrect={false}
                  returnKeyType="next"
                  onSubmitEditing={() => typeRef.current?.focus()}
                  autoFocus
                />
              </View>
              {nameError && (
                <Text style={styles.fieldError}>Business name is required.</Text>
              )}
              <View style={styles.divider} />
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Industry / Type</Text>
                <TextInput
                  ref={typeRef}
                  style={styles.fieldInput}
                  value={businessType}
                  onChangeText={setBusinessType}
                  placeholder="e.g. Plumbing, Real Estate…"
                  placeholderTextColor={colors.textMuted}
                  autoCorrect={false}
                  returnKeyType="next"
                  onSubmitEditing={() => locationRef.current?.focus()}
                />
              </View>
              <View style={styles.divider} />
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Location</Text>
                <TextInput
                  ref={locationRef}
                  style={styles.fieldInput}
                  value={businessLocation}
                  onChangeText={setBusinessLocation}
                  placeholder="City, State"
                  placeholderTextColor={colors.textMuted}
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={handleStep1Continue}
                />
              </View>
            </View>

            {step1SaveError ? (
              <Text style={styles.saveError}>{step1SaveError}</Text>
            ) : null}
            <TouchableOpacity
              style={[styles.primaryBtn, step1Saving && styles.primaryBtnDisabled]}
              onPress={handleStep1Continue}
              disabled={step1Saving}
              activeOpacity={0.8}
            >
              {step1Saving
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.primaryBtnText}>Continue</Text>
              }
            </TouchableOpacity>
          </View>
        )}

        {/* ── STEP 2: Connect Platforms ── */}
        {step === 2 && (
          <View style={styles.stepContainer}>
            <Text style={styles.title}>Where would you like to post?</Text>
            <Text style={styles.subtitle}>
              {"Connect the accounts where you'd like Elmer to share your updates."}
            </Text>

            <View style={styles.card}>
              <PlatformRow platform="google"    label="Google Business Profile" connected={connected} connecting={connecting} sessionToken={sessionToken} onConnect={handleConnectGoogle} />
              <View style={styles.rowDivider} />
              <PlatformRow platform="facebook"  label="Facebook Pages"          connected={connected} connecting={connecting} sessionToken={sessionToken} onConnect={handleConnectFacebook} />
              <View style={styles.rowDivider} />
              <PlatformRow platform="instagram" label="Instagram"               connected={connected} connecting={connecting} sessionToken={sessionToken} onConnect={handleConnectInstagram} />
              <View style={styles.rowDivider} />
              <PlatformRow platform="threads"   label="Threads"                 connected={connected} connecting={connecting} sessionToken={sessionToken} onConnect={handleConnectThreads} />
              <View style={styles.rowDivider} />
              {/* WordPress has an inline URL form */}
              <View style={styles.platformRow}>
                <View style={[styles.dot, { backgroundColor: connected.wordpress ? colors.success : colors.border }]} />
                <Text style={[styles.platformLabel, !connected.wordpress && styles.platformLabelDim]}>WordPress</Text>
                {connected.wordpress ? (
                  <View style={styles.connectedChip}>
                    <Text style={styles.connectedChipText}>Connected</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[styles.connectBtn, !sessionToken && styles.connectBtnDisabled]}
                    onPress={() => setWpFormOpen(v => !v)}
                    disabled={!sessionToken}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.connectBtnText}>Connect</Text>
                  </TouchableOpacity>
                )}
              </View>
              {wpFormOpen && !connected.wordpress && (
                <View style={styles.wpForm}>
                  <View style={styles.divider} />
                  <TextInput
                    style={styles.wpInput}
                    value={wpUrl}
                    onChangeText={setWpUrl}
                    placeholder="https://yoursite.com"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    returnKeyType="done"
                    onSubmitEditing={handleConnectWordPress}
                  />
                  <View style={styles.wpActions}>
                    <TouchableOpacity
                      style={[styles.wpConnectBtn, (connecting === 'wordpress' || !wpUrl.trim()) && styles.connectBtnDisabled]}
                      onPress={handleConnectWordPress}
                      disabled={connecting === 'wordpress' || !wpUrl.trim()}
                      activeOpacity={0.8}
                    >
                      {connecting === 'wordpress'
                        ? <ActivityIndicator color={colors.bg} size="small" />
                        : <Text style={styles.wpConnectBtnText}>Connect Website</Text>}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.wpCancelBtn}
                      onPress={() => { setWpFormOpen(false); setWpUrl(''); }}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.wpCancelBtnText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>

            <TouchableOpacity style={styles.primaryBtn} onPress={() => { Analytics.onboarding_step_completed(2, 'platform_connections'); setStep(3); }} activeOpacity={0.8}>
              <Text style={styles.primaryBtnText}>Continue</Text>
            </TouchableOpacity>

            {connectedCount === 0 && (
              <TouchableOpacity style={styles.skipBtn} onPress={() => { Analytics.onboarding_step_completed(2, 'platform_connections'); setStep(3); }} activeOpacity={0.8}>
                <Text style={styles.skipBtnText}>{"I'll Connect Later"}</Text>
              </TouchableOpacity>
            )}

            <Text style={styles.stepNote}>
              You can add or change connections anytime in Settings.
            </Text>
          </View>
        )}

        {/* ── STEP 3: Create First Post ── */}
        {step === 3 && (
          <View style={styles.stepContainer}>
            <Text style={styles.title}>{"Let's create your first post"}</Text>
            <Text style={styles.subtitle}>
              {"Add a few photos, then tell Elmer what you did. We'll turn it into a post you can share."}
            </Text>

            <View style={styles.stepsCard}>
              <StepItem number={1} text="Add photos from your job" />
              <StepItem number={2} text="Record a quick voice update" />
              <StepItem number={3} text="Generate your preview" />
            </View>

            <View style={styles.freeCard}>
              <Ionicons name="checkmark-circle" size={20} color={colors.success} />
              <Text style={styles.freeText}>
                <Text style={styles.freeBold}>Your first post is free.</Text>
                {'  '}No credit card required.
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.primaryBtn, completing && styles.primaryBtnDisabled]}
              onPress={handleFinish}
              disabled={completing}
              activeOpacity={0.8}
            >
              {completing
                ? <ActivityIndicator color={colors.bg} />
                : <Text style={styles.primaryBtnText}>Create My First Post</Text>}
            </TouchableOpacity>
          </View>
        )}

      </ScrollView>

      {/* Back button (steps 2 and 3) */}
      {step > 1 && (
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => setStep(s => s - 1)}
          activeOpacity={0.7}
        >
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
      )}
    </KeyboardAvoidingView>
  );
}

function StepItem({ number, text }: { number: number; text: string }) {
  return (
    <View style={styles.stepItemRow}>
      <View style={styles.stepItemNum}>
        <Text style={styles.stepItemNumText}>{number}</Text>
      </View>
      <Text style={styles.stepItemText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  progressRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    paddingTop: 24,
    paddingBottom: 4,
  },
  progressDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.border,
  },
  progressDotActive: {
    backgroundColor: colors.cyan,
  },
  stepLabel: {
    textAlign: 'center',
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: colors.textMuted,
    marginBottom: 8,
  },

  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 40,
  },

  stepContainer: { gap: 0 },

  title: {
    fontSize: 26,
    fontFamily: 'DMSans_700Bold',
    color: colors.textPrimary,
    marginBottom: 8,
    lineHeight: 32,
  },
  subtitle: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: colors.textSecondary,
    lineHeight: 22,
    marginBottom: 24,
  },

  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    marginBottom: 16,
  },

  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  fieldLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    flexShrink: 0,
  },
  fieldInput: {
    flex: 1,
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: 'right',
  },
  fieldInputError: {
    color: colors.error,
  },
  fieldError: {
    fontSize: 12,
    color: colors.error,
    paddingHorizontal: 16,
    paddingBottom: 8,
    marginTop: -4,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: 16,
  },
  rowDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: 16,
  },

  primaryBtn: {
    backgroundColor: colors.cyan,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryBtnDisabled: {
    opacity: 0.6,
  },
  primaryBtnText: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    color: colors.bg,
  },
  saveError: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: colors.error,
    textAlign: 'center',
    marginBottom: 8,
    paddingHorizontal: 8,
  },

  skipBtn: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  skipBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_500Medium',
    color: colors.textMuted,
  },

  stepNote: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 17,
    marginTop: 4,
  },

  backBtn: {
    paddingHorizontal: 24,
    paddingVertical: 14,
    paddingBottom: Platform.OS === 'ios' ? 8 : 14,
  },
  backBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: colors.cyan,
  },

  // Platform rows
  platformRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
  },
  platformLabel: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  platformLabelDim: {
    color: colors.textMuted,
  },
  connectBtn: {
    backgroundColor: colors.cyan,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    minWidth: 78,
    alignItems: 'center',
  },
  connectBtnDisabled: {
    backgroundColor: colors.border,
  },
  connectBtnText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: colors.bg,
  },
  connectedChip: {
    backgroundColor: 'rgba(82,214,164,0.15)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  connectedChipText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: colors.success,
  },

  // WordPress form
  wpForm: {
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  wpInput: {
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 12,
  },
  wpActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  wpConnectBtn: {
    flex: 1,
    backgroundColor: colors.cyan,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  wpConnectBtnText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: colors.bg,
  },
  wpCancelBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  wpCancelBtnText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: colors.textMuted,
  },

  // Step 3
  stepsCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    gap: 16,
    marginBottom: 16,
  },
  stepItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  stepItemNum: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  stepItemNumText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: colors.cyan,
  },
  stepItemText: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: colors.textPrimary,
  },

  freeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(82,214,164,0.08)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(82,214,164,0.2)',
    padding: 14,
    marginBottom: 20,
  },
  freeText: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: colors.textSecondary,
    lineHeight: 20,
  },
  freeBold: {
    fontFamily: 'Inter_600SemiBold',
    color: colors.textPrimary,
  },
});
