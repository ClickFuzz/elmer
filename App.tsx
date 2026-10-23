import { DMSans_600SemiBold, DMSans_700Bold } from '@expo-google-fonts/dm-sans';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';
import { Ionicons } from '@expo/vector-icons';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from './constants/colors';
import { getPendingHomeState, savePendingHomeState, getJobPhotos, getSessionToken, getSetting, setSetting, runAutoCleanup, Job, clearSession } from './storage/database';
import HistoryScreen from './screens/HistoryScreen';
import HomeScreen from './screens/HomeScreen';
import ManageDataScreen from './screens/ManageDataScreen';
import OnboardingWizard from './screens/OnboardingWizard';
import ResultScreen from './screens/ResultScreen';
import SettingsScreen from './screens/SettingsScreen';
import SignInScreen from './screens/SignInScreen';
import SubscriptionScreen, { SubscriptionStatus } from './screens/SubscriptionScreen';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';

export type PhotoClassification = 'General' | 'Before' | 'After' | 'Team';

export type PhotoItem = {
  uri: string;
  classification: PhotoClassification;
  isFeatured?: boolean;
  gps?: { lat: number; lng: number };
};

export type GeneratePayload = {
  photos: PhotoItem[];
  audioUri: string | null;
};

export type HomeState = {
  photos: PhotoItem[];
  audioUri: string | null;
};

export type AppScreen = 'home' | 'result' | 'settings' | 'history' | 'managedata' | 'subscription';

// Entitlement access values that grant app use without a subscription
const FREE_ACCESS_VALUES = new Set(['free_available', 'free_reserved']);

type NavItemProps = {
  iconActive: React.ComponentProps<typeof Ionicons>['name'];
  iconInactive: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  active: boolean;
  onPress: () => void;
};

function NavItem({ iconActive, iconInactive, label, active, onPress }: NavItemProps) {
  return (
    <TouchableOpacity style={navStyles.item} onPress={onPress} activeOpacity={0.7}>
      <Ionicons name={active ? iconActive : iconInactive} size={24} color={active ? colors.cyan : colors.textMuted} />
      <Text style={[navStyles.label, active && navStyles.labelActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function AppShell() {
  const { bottom: bottomInset } = useSafeAreaInsets();
  const [screen, setScreen] = useState<AppScreen>('home');
  const [payload, setPayload] = useState<GeneratePayload | null>(null);
  const [savedHomeState, setSavedHomeState] = useState<HomeState | null>(null);
  const [draftJob, setDraftJob] = useState<Job | null>(null);
  const [isAuthed, setIsAuthed] = useState<boolean | null>(null); // null = loading
  const [authToken, setAuthToken] = useState<string | null>(null);
  // null = not yet checked; SubscriptionStatus | false = checked
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null | false>(null);
  // null = loading; true/false = resolved
  const [isOnboarded, setIsOnboarded] = useState<boolean | null>(null);
  const [settingsReturnToResult, setSettingsReturnToResult] = useState(false);
  // True when ResultScreen received a 402 and the user needs to subscribe before generation can proceed.
  // handleSubscribed navigates back to 'result' (with the existing payload) instead of 'home'.
  const [pendingGenerationAfterSubscription, setPendingGenerationAfterSubscription] = useState(false);

  const fetchSubscriptionStatus = async (token: string): Promise<SubscriptionStatus | false> => {
    try {
      const res = await fetch(`${API_URL}/billing/subscription`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false;
      return await res.json();
    } catch {
      return false;
    }
  };

  useEffect(() => {
    (async () => {
      const tok = await getSessionToken();
      if (!tok) {
        setIsAuthed(false);
        setIsOnboarded(false);
        return;
      }
      setIsAuthed(true);
      setAuthToken(tok);
      const [status, localFlag] = await Promise.all([
        fetchSubscriptionStatus(tok),
        getSetting('onboarding_completed'),
      ]);
      setSubscriptionStatus(status);
      const serverOnboarded = (status as SubscriptionStatus | false)
        ? (status as SubscriptionStatus).onboardingCompleted === true
        : false;
      setIsOnboarded(localFlag === '1' || serverOnboarded);
    })();
    getPendingHomeState().then(state => {
      if (state) setSavedHomeState(state as HomeState);
    });
    runAutoCleanup().catch(() => {});
  }, []);

  const handleAuthChange = async (authed: boolean) => {
    setIsAuthed(authed);
    if (authed) {
      const tok = await getSessionToken();
      if (tok) {
        setAuthToken(tok);
        const [status, localFlag] = await Promise.all([
          fetchSubscriptionStatus(tok),
          getSetting('onboarding_completed'),
        ]);
        const serverOnboarded = (status as SubscriptionStatus | false)
          ? (status as SubscriptionStatus).onboardingCompleted === true
          : false;
        setSubscriptionStatus(status);
        setIsOnboarded(localFlag === '1' || serverOnboarded);
      }
      setScreen('home');
    } else {
      setAuthToken(null);
      setSubscriptionStatus(null);
      setIsOnboarded(null);
      setSavedHomeState(null);
      savePendingHomeState(null);
    }
  };

  const handleSubscribed = () => {
    getSessionToken().then(async tok => {
      if (tok) {
        setAuthToken(tok);
        const [status, localFlag] = await Promise.all([
          fetchSubscriptionStatus(tok),
          getSetting('onboarding_completed'),
        ]);
        const serverOnboarded = (status as SubscriptionStatus | false)
          ? (status as SubscriptionStatus).onboardingCompleted === true
          : false;
        setSubscriptionStatus(status);
        setIsOnboarded(localFlag === '1' || serverOnboarded);
      }
      // If the user was paywalled mid-generation, return to result screen so it auto-generates.
      if (pendingGenerationAfterSubscription && payload) {
        setPendingGenerationAfterSubscription(false);
        setScreen('result');
      } else {
        setPendingGenerationAfterSubscription(false);
        setScreen('home');
      }
    });
  };

  const handleSubscriptionSignOut = async () => {
    const tok = await getSessionToken();
    if (tok) {
      fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}` },
      }).catch(() => {});
    }
    await clearSession();
    setIsAuthed(false);
    setAuthToken(null);
    setSubscriptionStatus(null);
    setIsOnboarded(null);
    setSavedHomeState(null);
    savePendingHomeState(null);
    setPendingGenerationAfterSubscription(false);
  };

  const handleOnboardingComplete = async () => {
    // Persist locally so the wizard is bypassed even if the server call fails
    await setSetting('onboarding_completed', '1');
    setIsOnboarded(true);
    setScreen('home');
    // Best-effort server persist (fire and forget)
    if (authToken) {
      fetch(`${API_URL}/auth/onboarding/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      }).catch(() => {});
    }
  };

  const handleGenerate = (data: GeneratePayload) => {
    // Preserve photos + audio so Back from ResultScreen restores them.
    // State is cleared only after a successful publish via handlePublishComplete.
    const newState: HomeState = { photos: data.photos, audioUri: data.audioUri };
    setSavedHomeState(newState);
    savePendingHomeState(newState);
    setDraftJob(null);
    setPayload(data);
    // Fresh generation replaces any prior pending intent from a paywalled attempt.
    setPendingGenerationAfterSubscription(false);
    setScreen('result');
  };

  const handlePublishComplete = () => {
    // Don't clear home state when publishing a history draft — that flow
    // returns to history, not home, and the user may have a new job in progress.
    if (draftJob) return;
    savePendingHomeState(null);
    setSavedHomeState(null);
  };

  const handlePublishSuccess = () => {
    // Refresh entitlement so hasFreePublicationAvailable reflects the redeemed state.
    if (authToken) {
      fetchSubscriptionStatus(authToken).then(status => {
        if (status) setSubscriptionStatus(status);
      }).catch(() => {});
    }
  };

  const handlePublishDraft = async (job: Job) => {
    const photos = await getJobPhotos(job.id);
    const syntheticPayload: GeneratePayload = {
      photos: photos.map(p => ({
        uri: p.localUri,
        classification: p.classification as PhotoClassification,
        isFeatured: p.isFeatured,
      })),
      audioUri: null,
    };
    setDraftJob(job);
    setPayload(syntheticPayload);
    setScreen('result');
  };

  // Blank while SecureStore resolves on first render, or while subscription / onboarding state is being fetched
  if (isAuthed === null || (isAuthed && (subscriptionStatus === null || isOnboarded === null))) {
    return <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}><StatusBar style="light" /></SafeAreaView>;
  }

  if (!isAuthed) {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
        <StatusBar style="light" />
        <SignInScreen onSignIn={() => handleAuthChange(true)} />
      </SafeAreaView>
    );
  }

  // Subscription gate: show offer / management screen when user has no access
  // Users with a free publication available or reserved can use the app without a subscription.
  const subStatus = subscriptionStatus as SubscriptionStatus | false;
  const hasSubscriptionAccess = subStatus && subStatus.hasAccess;
  const hasFreeAccess = subStatus && FREE_ACCESS_VALUES.has((subStatus as any).entitlement?.access);
  const hasFreePublicationAvailable = subStatus !== false && (subStatus as any)?.entitlement?.access === 'free_available';
  if ((!hasSubscriptionAccess && !hasFreeAccess) || screen === 'subscription') {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
        <StatusBar style="light" />
        <SubscriptionScreen
          onSubscribed={handleSubscribed}
          onSignOut={handleSubscriptionSignOut}
          initialStatus={subStatus || undefined}
        />
      </SafeAreaView>
    );
  }

  // Onboarding wizard for first-time users
  if (!isOnboarded) {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
        <StatusBar style="light" />
        <OnboardingWizard
          sessionToken={authToken}
          onComplete={handleOnboardingComplete}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />
      <View style={styles.content}>
        {screen === 'home' && (
          <HomeScreen
            onGenerate={handleGenerate}
            initialState={savedHomeState}
          />
        )}
        {screen === 'result' && payload && (
          <ResultScreen
            payload={payload}
            draftJob={draftJob}
            onBack={() => { setDraftJob(null); setScreen(draftJob ? 'history' : 'home'); }}
            onPublishComplete={handlePublishComplete}
            onPublishSuccess={handlePublishSuccess}
            onShowSettings={() => { setSettingsReturnToResult(true); setScreen('settings'); }}
            onShowSubscription={() => {
              setPendingGenerationAfterSubscription(true);
              setScreen('subscription');
            }}
            hasFreePublicationAvailable={hasFreePublicationAvailable}
          />
        )}
        {screen === 'settings' && (
          <SettingsScreen
            onBack={() => {
              if (settingsReturnToResult) {
                setSettingsReturnToResult(false);
                setScreen('result');
              } else {
                setScreen('home');
              }
            }}
            onAuthChange={handleAuthChange}
            onManageData={() => setScreen('managedata')}
            onManageSubscription={() => setScreen('subscription')}
            returnToPost={settingsReturnToResult}
          />
        )}
        {screen === 'managedata' && (
          <ManageDataScreen
            onBack={() => setScreen('settings')}
            onAccountDeleted={() => handleAuthChange(false)}
          />
        )}
        {screen === 'history' && (
          <HistoryScreen
            onBack={() => setScreen('home')}
            onPublishDraft={handlePublishDraft}
          />
        )}
      </View>
      <View style={[navStyles.bar, { paddingBottom: Math.max(bottomInset, 10) }]}>
        <NavItem
          iconActive="home"
          iconInactive="home-outline"
          label="Home"
          active={screen === 'home' || screen === 'result'}
          onPress={() => setScreen('home')}
        />
        <NavItem
          iconActive="time"
          iconInactive="time-outline"
          label="History"
          active={screen === 'history'}
          onPress={() => setScreen('history')}
        />
        <NavItem
          iconActive="settings-sharp"
          iconInactive="settings-outline"
          label="Settings"
          active={screen === 'settings'}
          onPress={() => { setSettingsReturnToResult(false); setScreen('settings'); }}
        />
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({
    DMSans_700Bold,
    DMSans_600SemiBold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
  });

  if (!fontsLoaded) {
    return <SafeAreaProvider><View style={styles.root} /></SafeAreaProvider>;
  }

  return (
    <SafeAreaProvider>
      <AppShell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1 },
});

const navStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 10,
    paddingHorizontal: 8,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 2,
  },
  label: { fontSize: 11, fontFamily: 'Inter_500Medium', color: colors.textMuted },
  labelActive: { color: colors.cyan },
});
