import React, { useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Keyboard,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { colors } from '../constants/colors';
import {
  getJobStats,
  getBusinessProfile,
  saveBusinessProfile,
  DEFAULT_BUSINESS_PROFILE,
  BusinessProfile,
  getSessionToken,
  getSessionEmail,
  setSession,
  clearSession,
  fetchFacebookPages,
  FacebookPage,
  getMultiPageWarningShown,
  setMultiPageWarningShown,
  setInstagramConnected,
  getInstagramExplanationShown,
  setInstagramExplanationShown,
  calculateStorageUsage,
} from '../storage/database';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';

type Props = { onBack: () => void; onAuthChange?: (authed: boolean) => void; onManageData?: () => void };
type JobStats = { total: number; drafts: number };

const CATEGORIES = [
  'Roofing', 'Plumbing', 'Electrical', 'HVAC', 'Landscaping & Lawn Care',
  'Painting', 'Remodeling & Renovation', 'General Contracting', 'Handyman Services',
  'Cleaning Services', 'Junk Removal', 'Moving Services', 'Pest Control',
  'Tree Services', 'Fencing & Decking', 'Flooring & Tile', 'Concrete & Masonry',
  'Windows & Doors', 'Siding & Gutters', 'Pool & Spa Services',
  'Restoration & Water Damage', 'Insulation', 'Garage Door Services',
  'Pressure Washing', 'Other',
];

const WRITING_STYLES = [
  'Professional',
  'Casual / Professional',
  'Friendly & Conversational',
  'Straightforward',
  'Confident & Bold',
  'Storytelling',
  'Playful & Lighthearted',
];

function showPicker(title: string, options: string[], onSelect: (v: string) => void) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: [...options, 'Cancel'], cancelButtonIndex: options.length },
      (i) => { if (i < options.length) onSelect(options[i]); }
    );
  } else {
    Alert.alert(title, undefined, [
      ...options.map(opt => ({ text: opt, onPress: () => onSelect(opt) })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }
}

export default function SettingsScreen({ onBack, onAuthChange, onManageData }: Props) {
  const [stats, setStats] = useState<JobStats | null>(null);
  const [storageBytes, setStorageBytes] = useState<number | null>(null);
  const [profile, setProfile] = useState<BusinessProfile>(DEFAULT_BUSINESS_PROFILE);
  const [saved, setSaved] = useState(false);
  const [savedStyle, setSavedStyle] = useState(false);
  const [bizExpanded, setBizExpanded] = useState(false);

  // ── Auth state ─────────────────────────────────────────────────────────────
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [sessionEmail, setSessionEmailState] = useState<string | null>(null);
  const [authExpanded, setAuthExpanded] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);

  // ── Facebook state ─────────────────────────────────────────────────────────
  const [fbPages, setFbPages] = useState<FacebookPage[]>([]);
  const [selectedPageIds, setSelectedPageIds] = useState<number[]>([]);
  const [fbConnecting, setFbConnecting] = useState(false);
  const [fbDisconnecting, setFbDisconnecting] = useState(false);
  const [managePagesOpen, setManagePagesOpen] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<number[]>([]);
  const [savingSelection, setSavingSelection] = useState(false);

  // ── Instagram state ────────────────────────────────────────────────────────
  const [igAccount, setIgAccount] = useState<{ id: number; account_name: string; account_id: string; token_expires_at: number | null } | null>(null);
  const [igConnecting, setIgConnecting] = useState(false);
  const [igDisconnecting, setIgDisconnecting] = useState(false);

  // ── Threads state ──────────────────────────────────────────────────────────
  const [thAccount, setThAccount] = useState<{ id: number; account_name: string; account_id: string; token_expires_at: number | null } | null>(null);
  const [thConnecting, setThConnecting] = useState(false);
  const [thDisconnecting, setThDisconnecting] = useState(false);

  // ── WordPress state ────────────────────────────────────────────────────────
  type WpSite = { id: number; account_name: string; account_id: string; connected_at: number };
  const [wpSites, setWpSites] = useState<WpSite[]>([]);
  const [wpConnecting, setWpConnecting] = useState(false);
  const [wpDisconnecting, setWpDisconnecting] = useState<number | null>(null);
  const [wpConnectOpen, setWpConnectOpen] = useState(false);
  const [wpUrl, setWpUrl] = useState('');

  // ── Platform manage panel ──────────────────────────────────────────────────
  const [expandedPlatform, setExpandedPlatform] = useState<string | null>(null);

  const togglePlatformPanel = (platform: string) => {
    setExpandedPlatform(prev => {
      const next = prev === platform ? null : platform;
      if (next !== 'facebook') setManagePagesOpen(false);
      return next;
    });
  };

  const refreshFbPages = async (token: string) => {
    const pages = await fetchFacebookPages(token, API_URL);
    setFbPages(pages);
    setSelectedPageIds(pages.filter(p => p.selected).map(p => p.id));
  };

  const refreshIgAccount = async (token: string) => {
    try {
      const res = await fetch(`${API_URL}/instagram/account`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setIgAccount(data.account ?? null);
      await setInstagramConnected(!!data.account);
    } catch { /* ignore */ }
  };

  const refreshThAccount = async (token: string) => {
    try {
      const res = await fetch(`${API_URL}/threads/account`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setThAccount(data.account ?? null);
    } catch { /* ignore */ }
  };

  const refreshWpSites = async (token: string) => {
    try {
      const res = await fetch(`${API_URL}/wordpress/sites`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setWpSites(data.sites ?? []);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    getJobStats().then(setStats).catch(() => setStats({ total: 0, drafts: 0 }));
    calculateStorageUsage().then(u => setStorageBytes(u.totalBytes)).catch(() => setStorageBytes(0));
    getBusinessProfile().then(p => {
      setProfile(p);
      setBizExpanded(!p.name || !p.category);
    }).catch(() => setBizExpanded(true));

    Promise.all([getSessionToken(), getSessionEmail()]).then(
      ([tok, email]) => {
        setSessionToken(tok);
        setSessionEmailState(email);
        if (tok) {
          refreshFbPages(tok);
          refreshIgAccount(tok);
          refreshThAccount(tok);
          refreshWpSites(tok);
        }
      }
    ).catch(() => {});
  }, []);

  const update = (patch: Partial<BusinessProfile>) =>
    setProfile(prev => ({ ...prev, ...patch }));

  const handleSave = () => {
    Keyboard.dismiss();
    saveBusinessProfile(profile)
      .then(() => { setSaved(true); setTimeout(() => setSaved(false), 2000); })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        Alert.alert('Save failed', msg);
      });
  };

  const handleSaveStyle = () => {
    Keyboard.dismiss();
    saveBusinessProfile(profile)
      .then(() => { setSavedStyle(true); setTimeout(() => setSavedStyle(false), 2000); })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        Alert.alert('Save failed', msg);
      });
  };

  // ── Auth handlers ──────────────────────────────────────────────────────────

  const handleAuth = async (mode: 'login' | 'register') => {
    const emailTrimmed = authEmail.trim().toLowerCase();
    const pass = authPassword;
    if (!emailTrimmed || !pass) {
      setAuthError('Email and password are required.');
      return;
    }
    if (pass.length < 8) {
      setAuthError('Password must be at least 8 characters.');
      return;
    }
    setAuthLoading(true);
    setAuthError(null);
    try {
      const endpoint = mode === 'register' ? '/auth/register' : '/auth/login';
      const res = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailTrimmed, password: pass }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error ?? 'Sign-in failed. Check your credentials and try again.');
        return;
      }
      await setSession(data.token, emailTrimmed);
      setSessionToken(data.token);
      setSessionEmailState(emailTrimmed);
      setAuthExpanded(false);
      setAuthEmail('');
      setAuthPassword('');
      await refreshFbPages(data.token);
      await refreshIgAccount(data.token);
      await refreshThAccount(data.token);
      await refreshWpSites(data.token);
      onAuthChange?.(true);
    } catch {
      setAuthError('Could not reach the server. Check your connection.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Sign out of your Elmer account? Your locally saved jobs will remain on this device.', [
      { text: 'Sign Out', style: 'destructive', onPress: async () => {
        if (sessionToken) {
          fetch(`${API_URL}/auth/logout`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${sessionToken}` },
          }).catch(() => {});
        }
        await clearSession();
        setSessionToken(null);
        setSessionEmailState(null);
        setFbPages([]);
        setSelectedPageIds([]);
        setIgAccount(null);
        setThAccount(null);
        setWpSites([]);
        setProfile(DEFAULT_BUSINESS_PROFILE);
        onAuthChange?.(false);
      }},
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  // ── Facebook OAuth handlers ────────────────────────────────────────────────

  const handleConnectFacebook = async () => {
    if (!sessionToken) {
      Alert.alert('Sign In Required', 'Sign in to your Elmer account to connect Facebook.', [{ text: 'OK' }]);
      return;
    }

    setFbConnecting(true);
    try {
      const res = await fetch(`${API_URL}/facebook/connect-url`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      const data = await res.json();
      if (!res.ok) {
        Alert.alert('Connection failed', data.error ?? 'Could not start Facebook authorization.');
        return;
      }

      const result = await WebBrowser.openAuthSessionAsync(data.authUrl, 'elmer://oauth/callback');
      console.log('[fb-oauth] result.type:', result.type, result.type === 'success' ? '| url: ' + result.url : '');

      if (result.type === 'success') {
        const url = result.url;
        const params = new URLSearchParams((url.split('?')[1] ?? '').split('#')[0]);
        const error = params.get('error');

        if (error) {
          if (error === 'no_manageable_pages' || error === 'insufficient_permissions') {
            Alert.alert(
              'No Facebook Pages found',
              "Facebook didn't return any Pages you can manage. If your Page belongs to a Meta Business Portfolio, make sure you select both the Facebook Page and the business that owns or manages it when connecting.",
              [
                { text: 'Reconnect Facebook', onPress: () => { setFbConnecting(false); handleConnectFacebook(); } },
                { text: 'OK', style: 'cancel' },
              ]
            );
            return;
          }
          Alert.alert('Connection failed', `Facebook returned: ${error}`);
          return;
        }

        if (params.get('success') === 'true') {
          const count = parseInt(params.get('page_count') ?? '1', 10);
          if (count > 1) {
            const warned = await getMultiPageWarningShown();
            if (!warned) {
              await setMultiPageWarningShown();
              Alert.alert(
                'Publishing to multiple Pages',
                "You've selected multiple Facebook Pages. Elmer will publish your posts to all selected Pages. You can change this anytime under Manage Pages.",
                [{ text: 'OK' }]
              );
            }
          }
          Alert.alert(
            'Facebook connected!',
            `${count} page${count !== 1 ? 's' : ''} connected.${count > 1 ? ' Tap Manage Pages to adjust which pages receive your posts.' : ''}`,
            [{ text: 'OK' }]
          );
        }
      }

      await refreshFbPages(sessionToken);
    } catch (err) {
      Alert.alert('Connection failed', err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setFbConnecting(false);
    }
  };

  const handleOpenManagePages = () => {
    setPendingSelection([...selectedPageIds]);
    setManagePagesOpen(true);
  };

  const handleTogglePage = (pageId: number) => {
    setPendingSelection(prev =>
      prev.includes(pageId) ? prev.filter(id => id !== pageId) : [...prev, pageId]
    );
  };

  const handleSavePageSelection = async () => {
    if (!sessionToken) return;
    setSavingSelection(true);
    try {
      await fetch(`${API_URL}/facebook/pages/selection`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_ids: pendingSelection }),
      });
      setSelectedPageIds(pendingSelection);

      if (pendingSelection.length > 1) {
        const warned = await getMultiPageWarningShown();
        if (!warned) {
          await setMultiPageWarningShown();
          Alert.alert(
            'Publishing to multiple Pages',
            "You've selected multiple Facebook Pages. Elmer will publish your posts to all selected Pages. You can change this anytime under Manage Pages.",
            [{ text: 'OK' }]
          );
        }
      }

      setManagePagesOpen(false);
    } catch {
      Alert.alert('Error', 'Could not save page selections. Check your connection.');
    } finally {
      setSavingSelection(false);
    }
  };

  const handleDisconnectFacebook = () => {
    Alert.alert(
      'Disconnect Facebook',
      'Remove your Facebook Page connections? You can reconnect at any time.',
      [
        { text: 'Disconnect', style: 'destructive', onPress: async () => {
          if (!sessionToken) return;
          setFbDisconnecting(true);
          try {
            for (const page of fbPages) {
              await fetch(`${API_URL}/platforms/${page.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${sessionToken}` },
              });
            }
            setFbPages([]);
            setSelectedPageIds([]);
            setManagePagesOpen(false);
            setExpandedPlatform(null);
          } catch {
            Alert.alert('Error', 'Could not disconnect. Try again.');
          } finally {
            setFbDisconnecting(false);
          }
        }},
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  // ── Instagram OAuth handlers ──────────────────────────────────────────────

  const handleConnectInstagram = async () => {
    if (!sessionToken) {
      Alert.alert('Sign In Required', 'Sign in to your Elmer account to connect Instagram.', [{ text: 'OK' }]);
      return;
    }

    setIgConnecting(true);
    try {
      const res = await fetch(`${API_URL}/instagram/connect-url`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      const data = await res.json();
      if (!res.ok) {
        Alert.alert('Connection failed', data.error ?? 'Could not start Instagram authorization.');
        return;
      }

      const result = await WebBrowser.openAuthSessionAsync(data.authUrl, 'elmer://oauth/callback');
      console.log('[ig-oauth] result.type:', result.type, result.type === 'success' ? '| url: ' + result.url : '');

      if (result.type === 'success') {
        const url = result.url;
        const params = new URLSearchParams((url.split('?')[1] ?? '').split('#')[0]);
        const error = params.get('error');

        if (error) {
          if (error === 'personal_account_not_supported') {
            Alert.alert(
              'Professional Instagram Account Required',
              'Instagram requires a Business or Creator account to publish through Elmer. Switching is free, and you can keep your existing followers and posts.',
              [
                {
                  text: 'Try Again',
                  onPress: () => handleConnectInstagram(),
                },
                {
                  text: 'How to Switch',
                  onPress: () => Linking.openURL('https://help.instagram.com/502981923235522'),
                },
                { text: 'Cancel', style: 'cancel' },
              ]
            );
            return;
          }
          Alert.alert('Connection failed', `Instagram returned: ${error}`);
          return;
        }

        if (params.get('success') === 'true') {
          await refreshIgAccount(sessionToken);
          const shown = await getInstagramExplanationShown();
          if (!shown) {
            await setInstagramExplanationShown();
            Alert.alert(
              'Instagram photos',
              "Your photos will be shared across all connected platforms by default. Want a photo to appear only on Instagram? Tap the photo and select Instagram Only.\n\nInstagram will receive only photos marked Instagram. Other platforms will receive only photos marked All Platforms.",
              [{ text: 'Got it' }]
            );
          } else {
            Alert.alert('Instagram connected!', 'Your Instagram account has been connected.', [{ text: 'OK' }]);
          }
        }
      }

      await refreshIgAccount(sessionToken);
    } catch (err) {
      Alert.alert('Connection failed', err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setIgConnecting(false);
    }
  };

  const handleDisconnectInstagram = () => {
    Alert.alert(
      'Disconnect Instagram',
      'Remove your Instagram account connection? You can reconnect at any time.',
      [
        { text: 'Disconnect', style: 'destructive', onPress: async () => {
          if (!sessionToken || !igAccount) return;
          setIgDisconnecting(true);
          try {
            await fetch(`${API_URL}/platforms/${igAccount.id}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${sessionToken}` },
            });
            setIgAccount(null);
            setExpandedPlatform(null);
            await setInstagramConnected(false);
          } catch {
            Alert.alert('Error', 'Could not disconnect. Try again.');
          } finally {
            setIgDisconnecting(false);
          }
        }},
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  // ── Threads OAuth handlers ────────────────────────────────────────────────

  const handleConnectThreads = async () => {
    if (!sessionToken) {
      Alert.alert('Sign In Required', 'Sign in to your Elmer account to connect Threads.', [{ text: 'OK' }]);
      return;
    }

    setThConnecting(true);
    try {
      const res = await fetch(`${API_URL}/threads/connect-url`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      const data = await res.json();
      if (!res.ok) {
        Alert.alert('Connection failed', data.error ?? 'Could not start Threads authorization.');
        return;
      }

      const result = await WebBrowser.openAuthSessionAsync(data.authUrl, 'elmer://oauth/callback');
      console.log('[threads-oauth] result.type:', result.type, result.type === 'success' ? '| url: ' + result.url : '');

      if (result.type === 'success') {
        const url = result.url;
        const params = new URLSearchParams((url.split('?')[1] ?? '').split('#')[0]);
        const error = params.get('error');

        if (error) {
          Alert.alert('Connection failed', `Threads returned: ${error}`);
          return;
        }

        if (params.get('success') === 'true') {
          await refreshThAccount(sessionToken);
          Alert.alert('Threads connected!', 'Your Threads account has been connected.', [{ text: 'OK' }]);
        }
      }

      await refreshThAccount(sessionToken);
    } catch (err) {
      Alert.alert('Connection failed', err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setThConnecting(false);
    }
  };

  const handleDisconnectThreads = () => {
    Alert.alert(
      'Disconnect Threads',
      'Remove your Threads account connection? You can reconnect at any time.',
      [
        { text: 'Disconnect', style: 'destructive', onPress: async () => {
          if (!sessionToken || !thAccount) return;
          setThDisconnecting(true);
          try {
            await fetch(`${API_URL}/platforms/${thAccount.id}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${sessionToken}` },
            });
            setThAccount(null);
            setExpandedPlatform(null);
          } catch {
            Alert.alert('Error', 'Could not disconnect. Try again.');
          } finally {
            setThDisconnecting(false);
          }
        }},
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  // ── WordPress handlers ─────────────────────────────────────────────────────

  const handleConnectWordPress = async () => {
    if (!sessionToken) {
      Alert.alert('Sign In Required', 'Sign in to your Elmer account to connect WordPress.', [{ text: 'OK' }]);
      return;
    }
    const url = wpUrl.trim();
    if (!url) {
      Alert.alert('Website URL Required', 'Enter your WordPress website URL to continue.', [{ text: 'OK' }]);
      return;
    }

    setWpConnecting(true);
    try {
      const res = await fetch(`${API_URL}/wordpress/connect-url`, {
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
      console.log('[wp-oauth] result.type:', result.type, result.type === 'success' ? '| url: ' + result.url : '');

      if (result.type === 'success') {
        const params = new URLSearchParams((result.url.split('?')[1] ?? '').split('#')[0]);
        const error  = params.get('error');
        if (error) {
          if (error === 'rejected') {
            Alert.alert('Authorization cancelled', 'You cancelled the WordPress authorization. Try again when ready.', [{ text: 'OK' }]);
          } else {
            Alert.alert('Connection failed', `WordPress returned: ${error}`);
          }
          return;
        }
        if (params.get('success') === 'true') {
          const siteName = params.get('site_name') ?? url;
          await refreshWpSites(sessionToken);
          setWpUrl('');
          setWpConnectOpen(false);
          Alert.alert('WordPress connected!', `"${siteName}" has been connected.`, [{ text: 'OK' }]);
        }
      }

      await refreshWpSites(sessionToken);
    } catch (err) {
      Alert.alert('Connection failed', err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setWpConnecting(false);
    }
  };

  const handleDisconnectWordPress = (site: { id: number; account_name: string }) => {
    Alert.alert(
      'Disconnect WordPress',
      `Remove "${site.account_name}"? Previously published articles will remain on your site.`,
      [
        { text: 'Disconnect', style: 'destructive', onPress: async () => {
          if (!sessionToken) return;
          setWpDisconnecting(site.id);
          try {
            await fetch(`${API_URL}/wordpress/sites/${site.id}`, {
              method:  'DELETE',
              headers: { Authorization: `Bearer ${sessionToken}` },
            });
            setWpSites(prev => prev.filter(s => s.id !== site.id));
            if (wpSites.length <= 1) setExpandedPlatform(null);
          } catch {
            Alert.alert('Error', 'Could not disconnect. Try again.');
          } finally {
            setWpDisconnecting(null);
          }
        }},
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  const effectiveCategory = profile.category === 'Other' ? profile.categoryCustom : profile.category;
  const isFbConnected = fbPages.length > 0;
  const selectedCount = selectedPageIds.length;
  const isIgConnected = igAccount !== null;
  const isWpConnected = wpSites.length > 0;
  const now = Date.now();
  const EXPIRY_WARN_MS = 7 * 24 * 60 * 60 * 1000;
  const igTokenExpiringSoon = igAccount?.token_expires_at != null
    && igAccount.token_expires_at < now + EXPIRY_WARN_MS;

  // 'connected' | 'warning' (expiring ≤7d) | 'error' (expired) | 'disconnected'
  const fbDot  = isFbConnected ? '#52D6A4' : colors.textMuted;
  const igDot  = !isIgConnected ? colors.textMuted
    : igAccount!.token_expires_at != null && igAccount!.token_expires_at < now ? '#FF5050'
    : igTokenExpiringSoon ? '#C8A040'
    : '#52D6A4';
  const thDot  = thAccount === null ? colors.textMuted
    : thAccount.token_expires_at != null && thAccount.token_expires_at < now ? '#FF5050'
    : thAccount.token_expires_at != null && thAccount.token_expires_at < now + EXPIRY_WARN_MS ? '#C8A040'
    : '#52D6A4';
  const wpDot  = isWpConnected ? '#52D6A4' : colors.textMuted;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">

        {/* ── Business Details ── */}
        <Text style={styles.groupLabel}>Business Details</Text>
        <View style={styles.card}>
          <TouchableOpacity
            style={styles.cardToggleRow}
            onPress={() => setBizExpanded(v => !v)}
            activeOpacity={0.7}
          >
            <View style={styles.cardToggleLeft}>
              <Text style={styles.cardToggleTitle}>{profile.name || 'Your business info'}</Text>
              {!bizExpanded && (
                <Text style={styles.cardToggleSub} numberOfLines={1}>
                  {effectiveCategory || 'Tap to fill in your details'}
                </Text>
              )}
            </View>
            <Text style={styles.cardToggleChevron}>{bizExpanded ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {bizExpanded && <>
            <View style={styles.divider} />
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>Business Name</Text>
              <TextInput style={styles.fieldInput} value={profile.name} onChangeText={name => update({ name })} placeholder="Your company name" placeholderTextColor={colors.textMuted} autoCorrect={false} returnKeyType="next" />
            </View>
            <View style={styles.divider} />
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>Website</Text>
              <TextInput style={styles.fieldInput} value={profile.website} onChangeText={website => update({ website })} placeholder="yoursite.com" placeholderTextColor={colors.textMuted} autoCorrect={false} autoCapitalize="none" keyboardType="url" returnKeyType="next" />
            </View>
            <View style={styles.divider} />
            <View style={styles.fieldRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>Inquiry URL</Text>
                <Text style={styles.fieldSubLabel}>Quote form, booking page, or contact page</Text>
              </View>
              <TextInput style={[styles.fieldInput, { flex: 0.55 }]} value={profile.inquiryUrl ?? ''} onChangeText={inquiryUrl => update({ inquiryUrl })} placeholder="optional" placeholderTextColor={colors.textMuted} autoCorrect={false} autoCapitalize="none" keyboardType="url" returnKeyType="next" />
            </View>
            <View style={styles.divider} />
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>Location</Text>
              <TextInput style={styles.fieldInput} value={profile.location} onChangeText={location => update({ location })} placeholder="City, State" placeholderTextColor={colors.textMuted} autoCorrect={false} returnKeyType="next" />
            </View>
            <View style={styles.divider} />
            <TouchableOpacity style={styles.fieldRow} onPress={() => showPicker('Business Category', CATEGORIES, category => update({ category }))} activeOpacity={0.7}>
              <Text style={styles.fieldLabel}>Category</Text>
              <View style={styles.selectorRight}>
                <Text style={[styles.fieldInput, !profile.category && styles.placeholder]}>{effectiveCategory || 'Select…'}</Text>
                <Text style={styles.chevron}>›</Text>
              </View>
            </TouchableOpacity>
            {profile.category === 'Other' && <>
              <View style={styles.divider} />
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Custom Category</Text>
                <TextInput style={styles.fieldInput} value={profile.categoryCustom} onChangeText={categoryCustom => update({ categoryCustom })} placeholder="Describe your trade" placeholderTextColor={colors.textMuted} autoCorrect={false} returnKeyType="next" />
              </View>
            </>}
            <View style={styles.divider} />
            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabelAbove}>Services Offered</Text>
              <TagInput tags={profile.services} onChange={services => update({ services })} placeholder="e.g. Roof Replacement  —  press Return to add" />
            </View>
            <View style={styles.divider} />
            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabelAbove}>Service Areas</Text>
              <TagInput tags={profile.serviceAreas} onChange={serviceAreas => update({ serviceAreas })} placeholder="e.g. Denver CO  —  press Return to add" />
            </View>
            <View style={styles.divider} />
            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabelAbove}>Business Description</Text>
              <TextInput style={styles.descInput} value={profile.description} onChangeText={description => update({ description })} placeholder="Describe your company, specialties, or what sets you apart…" placeholderTextColor={colors.textMuted} multiline textAlignVertical="top" autoCorrect />
            </View>
          </>}
        </View>

        {bizExpanded && <>
          <TouchableOpacity style={styles.saveBtn} onPress={handleSave} activeOpacity={0.8}>
            <Text style={styles.saveBtnText}>{saved ? 'Saved!' : 'Save Business Details'}</Text>
          </TouchableOpacity>
          <Text style={styles.groupNote}>
            Business details are stored on-device and used to write more relevant posts.
          </Text>
        </>}

        {/* ── Writing Style ── */}
        <Text style={styles.groupLabel}>Writing Style</Text>
        <View style={styles.card}>
          <TouchableOpacity
            style={styles.fieldRow}
            onPress={() => showPicker('Writing Style', WRITING_STYLES, writingStyle => update({ writingStyle }))}
            activeOpacity={0.7}
          >
            <Text style={styles.fieldLabel}>Tone</Text>
            <View style={styles.selectorRight}>
              <Text style={styles.fieldInput}>{profile.writingStyle || 'Casual / Professional'}</Text>
              <Text style={styles.chevron}>›</Text>
            </View>
          </TouchableOpacity>
          <View style={styles.divider} />
          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabelAbove}>Custom Instructions</Text>
            <TextInput
              style={styles.descInput}
              value={profile.customWritingInstructions}
              onChangeText={customWritingInstructions => update({ customWritingInstructions })}
              placeholder={"No emojis. Avoid exclamation points. Write in a grounded, confident tone — like a tradesperson who takes pride in the work, not a marketer. Here's an example of how I write: \"Came in, assessed the situation, did what needed doing. Customer was happy. That's the job.\""}
              placeholderTextColor={colors.textMuted}
              multiline
              textAlignVertical="top"
              autoCorrect
            />
          </View>
        </View>
        <TouchableOpacity style={styles.saveBtn} onPress={handleSaveStyle} activeOpacity={0.8}>
          <Text style={styles.saveBtnText}>{savedStyle ? 'Saved!' : 'Save Writing Style'}</Text>
        </TouchableOpacity>
        <Text style={styles.groupNote}>
          These instructions are sent to the AI every time you generate a post. Be specific — the more detail you provide, the better the output.
        </Text>

        {/* ── Connected Accounts ── */}
        <Text style={styles.groupLabel}>Connected Accounts</Text>
        <View style={styles.card}>

          {/* Google Business Profile */}
          <View style={styles.platformRow}>
            <View style={[styles.statusDot, { backgroundColor: colors.textMuted }]} />
            <View style={styles.platformInfo}>
              <Text style={[styles.platformName, styles.platformNameDim]}>Google Business Profile</Text>
            </View>
            <TouchableOpacity
              style={[styles.actionBtn, styles.actionBtnDisabled]}
              onPress={() => Alert.alert('Coming Soon', 'Google Business Profile connection is awaiting API approval.', [{ text: 'OK' }])}
              activeOpacity={0.7}
            >
              <Text style={[styles.actionBtnText, styles.actionBtnTextDisabled]}>Connect</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.rowDivider} />

          {/* Facebook Pages */}
          <View style={styles.platformRow}>
            <View style={[styles.statusDot, { backgroundColor: fbDot }]} />
            <View style={styles.platformInfo}>
              <Text style={[styles.platformName, !isFbConnected && styles.platformNameDim]}>Facebook Pages</Text>
              {isFbConnected && (
                <Text style={styles.platformSub}>
                  {selectedCount === 0 ? 'No pages selected' : `${selectedCount} page${selectedCount !== 1 ? 's' : ''} selected`}
                </Text>
              )}
            </View>
            {isFbConnected ? (
              <TouchableOpacity style={styles.manageBtn} onPress={() => togglePlatformPanel('facebook')} activeOpacity={0.7}>
                <Text style={styles.manageBtnText}>Manage</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.actionBtn, (!sessionToken || fbConnecting) && styles.actionBtnDisabled]}
                onPress={handleConnectFacebook}
                disabled={!sessionToken || fbConnecting}
                activeOpacity={0.7}
              >
                {fbConnecting
                  ? <ActivityIndicator color={colors.bg} size="small" />
                  : <Text style={[styles.actionBtnText, !sessionToken && styles.actionBtnTextDisabled]}>Connect</Text>}
              </TouchableOpacity>
            )}
          </View>
          {expandedPlatform === 'facebook' && (
            <View style={styles.managePanelInner}>
              <View style={styles.divider} />
              <TouchableOpacity style={styles.managePanelRow} onPress={handleOpenManagePages} activeOpacity={0.7}>
                <Text style={styles.managePanelSubText}>Pages</Text>
                <TouchableOpacity style={styles.manageBtn} onPress={handleOpenManagePages} activeOpacity={0.7}>
                  <Text style={styles.manageBtnText}>Select Pages</Text>
                </TouchableOpacity>
              </TouchableOpacity>
              {managePagesOpen && (
                <View>
                  {fbPages.map(page => {
                    const isChecked = pendingSelection.includes(page.id);
                    return (
                      <TouchableOpacity key={page.id} style={styles.pageRow} onPress={() => handleTogglePage(page.id)} activeOpacity={0.7}>
                        <Text style={styles.pageRowName} numberOfLines={1}>{page.account_name}</Text>
                        <View style={[styles.checkbox, isChecked && styles.checkboxChecked]}>
                          {isChecked && <Text style={styles.checkmark}>✓</Text>}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                  <View style={styles.managePagesActions}>
                    <TouchableOpacity style={[styles.savePagesBtn, savingSelection && styles.authBtnDisabled]} onPress={handleSavePageSelection} disabled={savingSelection} activeOpacity={0.8}>
                      {savingSelection ? <ActivityIndicator color={colors.bg} size="small" /> : <Text style={styles.savePagesBtnText}>Save</Text>}
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.cancelPagesBtn} onPress={() => setManagePagesOpen(false)} activeOpacity={0.8}>
                      <Text style={styles.cancelPagesBtnText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              <View style={styles.fbActionsRow}>
                <TouchableOpacity style={styles.fbReconnectBtn} onPress={handleConnectFacebook} disabled={fbConnecting} activeOpacity={0.8}>
                  {fbConnecting ? <ActivityIndicator color={colors.cyan} size="small" /> : <Text style={styles.fbReconnectBtnText}>Reconnect</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={styles.fbDisconnectBtn} onPress={handleDisconnectFacebook} disabled={fbDisconnecting} activeOpacity={0.8}>
                  {fbDisconnecting ? <ActivityIndicator color={colors.textMuted} size="small" /> : <Text style={styles.fbDisconnectBtnText}>Disconnect</Text>}
                </TouchableOpacity>
              </View>
            </View>
          )}

          <View style={styles.rowDivider} />

          {/* Instagram */}
          <View style={styles.platformRow}>
            <View style={[styles.statusDot, { backgroundColor: igDot }]} />
            <View style={styles.platformInfo}>
              <Text style={[styles.platformName, !isIgConnected && styles.platformNameDim]}>Instagram</Text>
              {isIgConnected && (
                <Text style={[styles.platformSub, igDot !== '#52D6A4' && { color: igDot }]}>
                  {igDot === '#FF5050' ? 'Token expired — reconnect'
                    : igDot === '#C8A040' ? 'Token expiring soon'
                    : igAccount!.account_name}
                </Text>
              )}
            </View>
            {isIgConnected ? (
              <TouchableOpacity style={styles.manageBtn} onPress={() => togglePlatformPanel('instagram')} activeOpacity={0.7}>
                <Text style={styles.manageBtnText}>Manage</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.actionBtn, (!sessionToken || igConnecting) && styles.actionBtnDisabled]}
                onPress={handleConnectInstagram}
                disabled={!sessionToken || igConnecting}
                activeOpacity={0.7}
              >
                {igConnecting ? <ActivityIndicator color={colors.bg} size="small" /> : <Text style={[styles.actionBtnText, !sessionToken && styles.actionBtnTextDisabled]}>Connect</Text>}
              </TouchableOpacity>
            )}
          </View>
          {expandedPlatform === 'instagram' && (
            <View style={styles.managePanelInner}>
              <View style={styles.divider} />
              <View style={styles.managePanelRow}>
                <Text style={styles.managePanelSubText}>{igAccount?.account_name}</Text>
              </View>
              <View style={styles.fbActionsRow}>
                <TouchableOpacity style={styles.fbReconnectBtn} onPress={handleConnectInstagram} disabled={igConnecting} activeOpacity={0.8}>
                  {igConnecting ? <ActivityIndicator color={colors.cyan} size="small" /> : <Text style={styles.fbReconnectBtnText}>Reconnect</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={styles.fbDisconnectBtn} onPress={handleDisconnectInstagram} disabled={igDisconnecting} activeOpacity={0.8}>
                  {igDisconnecting ? <ActivityIndicator color={colors.textMuted} size="small" /> : <Text style={styles.fbDisconnectBtnText}>Disconnect</Text>}
                </TouchableOpacity>
              </View>
            </View>
          )}

          <View style={styles.rowDivider} />

          {/* Threads */}
          <View style={styles.platformRow}>
            <View style={[styles.statusDot, { backgroundColor: thDot }]} />
            <View style={styles.platformInfo}>
              <Text style={[styles.platformName, thAccount === null && styles.platformNameDim]}>Threads</Text>
              {thAccount !== null && (
                <Text style={[styles.platformSub, thDot !== '#52D6A4' && { color: thDot }]}>
                  {thDot === '#FF5050' ? 'Token expired — reconnect'
                    : thDot === '#C8A040' ? 'Token expiring soon'
                    : thAccount.account_name}
                </Text>
              )}
            </View>
            {thAccount !== null ? (
              <TouchableOpacity style={styles.manageBtn} onPress={() => togglePlatformPanel('threads')} activeOpacity={0.7}>
                <Text style={styles.manageBtnText}>Manage</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.actionBtn, (!sessionToken || thConnecting) && styles.actionBtnDisabled]}
                onPress={handleConnectThreads}
                disabled={!sessionToken || thConnecting}
                activeOpacity={0.7}
              >
                {thConnecting ? <ActivityIndicator color={colors.bg} size="small" /> : <Text style={[styles.actionBtnText, !sessionToken && styles.actionBtnTextDisabled]}>Connect</Text>}
              </TouchableOpacity>
            )}
          </View>
          {expandedPlatform === 'threads' && (
            <View style={styles.managePanelInner}>
              <View style={styles.divider} />
              <View style={styles.managePanelRow}>
                <Text style={styles.managePanelSubText}>{thAccount?.account_name}</Text>
              </View>
              <View style={styles.fbActionsRow}>
                <TouchableOpacity style={styles.fbReconnectBtn} onPress={handleConnectThreads} disabled={thConnecting} activeOpacity={0.8}>
                  {thConnecting ? <ActivityIndicator color={colors.cyan} size="small" /> : <Text style={styles.fbReconnectBtnText}>Reconnect</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={styles.fbDisconnectBtn} onPress={handleDisconnectThreads} disabled={thDisconnecting} activeOpacity={0.8}>
                  {thDisconnecting ? <ActivityIndicator color={colors.textMuted} size="small" /> : <Text style={styles.fbDisconnectBtnText}>Disconnect</Text>}
                </TouchableOpacity>
              </View>
            </View>
          )}

          <View style={styles.rowDivider} />

          {/* WordPress */}
          <View style={styles.platformRow}>
            <View style={[styles.statusDot, { backgroundColor: wpDot }]} />
            <View style={styles.platformInfo}>
              <Text style={[styles.platformName, !isWpConnected && styles.platformNameDim]}>WordPress</Text>
              {isWpConnected && (
                <Text style={styles.platformSub}>
                  {wpSites.length === 1 ? wpSites[0].account_name : `${wpSites.length} sites connected`}
                </Text>
              )}
            </View>
            {isWpConnected ? (
              <TouchableOpacity style={styles.manageBtn} onPress={() => togglePlatformPanel('wordpress')} activeOpacity={0.7}>
                <Text style={styles.manageBtnText}>Manage</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.actionBtn, (!sessionToken || wpConnecting) && styles.actionBtnDisabled]}
                onPress={() => {
                  if (!sessionToken) {
                    Alert.alert('Sign In Required', 'Sign in to your Elmer account to connect WordPress.', [{ text: 'OK' }]);
                    return;
                  }
                  setWpConnectOpen(v => !v);
                }}
                disabled={wpConnecting}
                activeOpacity={0.7}
              >
                {wpConnecting
                  ? <ActivityIndicator color={colors.bg} size="small" />
                  : <Text style={[styles.actionBtnText, !sessionToken && styles.actionBtnTextDisabled]}>Connect</Text>}
              </TouchableOpacity>
            )}
          </View>
          {/* WordPress connect form — shown when not yet connected */}
          {!isWpConnected && wpConnectOpen && (
            <View style={styles.managePanelInner}>
              <View style={styles.divider} />
              <View style={styles.fieldBlock}>
                <Text style={styles.fieldLabelAbove}>Website URL</Text>
                <TextInput
                  style={[styles.descInput, { minHeight: 0, paddingVertical: 10 }]}
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
              </View>
              <View style={styles.managePagesActions}>
                <TouchableOpacity
                  style={[styles.savePagesBtn, (wpConnecting || !wpUrl.trim()) && styles.authBtnDisabled]}
                  onPress={handleConnectWordPress}
                  disabled={wpConnecting || !wpUrl.trim()}
                  activeOpacity={0.8}
                >
                  {wpConnecting
                    ? <ActivityIndicator color={colors.bg} size="small" />
                    : <Text style={styles.savePagesBtnText}>Connect Website</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={styles.cancelPagesBtn} onPress={() => { setWpConnectOpen(false); setWpUrl(''); }} activeOpacity={0.8}>
                  <Text style={styles.cancelPagesBtnText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          {/* WordPress manage panel — shown when connected */}
          {expandedPlatform === 'wordpress' && isWpConnected && (
            <View style={styles.managePanelInner}>
              <View style={styles.divider} />
              {wpSites.map(site => (
                <View key={site.id} style={[styles.managePanelRow, { borderBottomWidth: 0 }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.managePanelSubText, { color: colors.textPrimary }]} numberOfLines={1}>{site.account_name}</Text>
                    <Text style={[styles.platformSub, { marginTop: 2 }]} numberOfLines={1}>{site.account_id}</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.fbDisconnectBtn}
                    onPress={() => handleDisconnectWordPress(site)}
                    disabled={wpDisconnecting === site.id}
                    activeOpacity={0.8}
                  >
                    {wpDisconnecting === site.id
                      ? <ActivityIndicator color={colors.textMuted} size="small" />
                      : <Text style={styles.fbDisconnectBtnText}>Disconnect</Text>}
                  </TouchableOpacity>
                </View>
              ))}
              {/* Add another site */}
              <View style={styles.managePagesActions}>
                <TouchableOpacity
                  style={[styles.savePagesBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.cyan }]}
                  onPress={() => {
                    setExpandedPlatform(null);
                    setWpConnectOpen(true);
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.savePagesBtnText, { color: colors.cyan }]}>Add Another Site</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

        </View>
        <Text style={styles.groupNote}>
          {sessionToken
            ? 'Posts are published to your selected accounts when you tap Post Everywhere.'
            : 'Sign in to connect publishing accounts.'}
        </Text>

        {/* ── Data & Privacy ── */}
        <Text style={styles.groupLabel}>Data &amp; Privacy</Text>
        <View style={styles.card}>
          <TouchableOpacity
            style={styles.row}
            onPress={onManageData}
            activeOpacity={0.7}
          >
            <Text style={styles.rowTitle}>Manage Data</Text>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.groupNote}>
          {storageBytes !== null
            ? `${storageBytes < 1024 * 1024
                ? `${(storageBytes / 1024).toFixed(1)} KB`
                : `${(storageBytes / (1024 * 1024)).toFixed(1)} MB`} stored on this device · `
            : ''}Completed jobs automatically deleted after 30 days.
        </Text>

        {/* ── Elmer Account ── */}
        <Text style={styles.groupLabel}>Elmer Account</Text>
        <View style={styles.card}>
          {sessionToken ? (
            <View style={styles.row}>
              <View style={styles.rowContent}>
                <Text style={styles.rowTitle}>Signed in</Text>
                <Text style={styles.rowSubtitle}>{sessionEmail}</Text>
              </View>
              <TouchableOpacity style={[styles.actionBtn, styles.actionBtnDanger]} onPress={handleSignOut} activeOpacity={0.8}>
                <Text style={[styles.actionBtnText, styles.actionBtnTextDanger]}>Sign Out</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <TouchableOpacity
                style={styles.cardToggleRow}
                onPress={() => { setAuthExpanded(v => !v); setAuthError(null); }}
                activeOpacity={0.7}
              >
                <View style={styles.cardToggleLeft}>
                  <Text style={styles.cardToggleTitle}>Sign In</Text>
                  {!authExpanded && <Text style={styles.cardToggleSub}>Sync jobs across devices</Text>}
                </View>
                <Text style={styles.cardToggleChevron}>{authExpanded ? '▲' : '▼'}</Text>
              </TouchableOpacity>

              {authExpanded && <>
                <View style={styles.divider} />
                <View style={styles.fieldRow}>
                  <Text style={styles.fieldLabel}>Email</Text>
                  <TextInput
                    style={styles.fieldInput}
                    value={authEmail}
                    onChangeText={setAuthEmail}
                    placeholder="you@example.com"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    autoCorrect={false}
                    returnKeyType="next"
                    onSubmitEditing={() => passwordRef.current?.focus()}
                  />
                </View>
                <View style={styles.divider} />
                <View style={styles.fieldRow}>
                  <Text style={styles.fieldLabel}>Password</Text>
                  <TextInput
                    ref={passwordRef}
                    style={styles.fieldInput}
                    value={authPassword}
                    onChangeText={setAuthPassword}
                    placeholder="8+ characters"
                    placeholderTextColor={colors.textMuted}
                    secureTextEntry
                    returnKeyType="done"
                    onSubmitEditing={() => handleAuth('login')}
                  />
                </View>
                {authError && <Text style={styles.authError}>{authError}</Text>}
                <View style={styles.authButtons}>
                  <TouchableOpacity
                    style={[styles.authBtn, authLoading && styles.authBtnDisabled]}
                    onPress={() => handleAuth('login')}
                    disabled={authLoading}
                    activeOpacity={0.8}
                  >
                    {authLoading
                      ? <ActivityIndicator color={colors.bg} />
                      : <Text style={styles.authBtnText}>Sign In</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.authBtnSecondary, authLoading && styles.authBtnDisabled]}
                    onPress={() => handleAuth('register')}
                    disabled={authLoading}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.authBtnSecondaryText}>Create Account</Text>
                  </TouchableOpacity>
                </View>
              </>}
            </>
          )}
        </View>

        <TouchableOpacity
          style={styles.supportLink}
          onPress={() => Linking.openURL('mailto:help@getelmer.com')}
          activeOpacity={0.7}
        >
          <Text style={styles.supportLinkText}>Need help? Email help@getelmer.com</Text>
        </TouchableOpacity>

      </ScrollView>
    </View>
  );
}

// ── TagInput ──────────────────────────────────────────────────────────────────

function TagInput({ tags, onChange, placeholder }: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const t = draft.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setDraft('');
  };
  return (
    <View>
      {tags.length > 0 && (
        <View style={tagStyles.wrap}>
          {tags.map((tag, i) => (
            <View key={i} style={tagStyles.chip}>
              <Text style={tagStyles.chipText}>{tag}</Text>
              <TouchableOpacity onPress={() => onChange(tags.filter((_, j) => j !== i))} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Text style={tagStyles.chipRemove}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}
      <TextInput style={tagStyles.input} value={draft} onChangeText={setDraft} placeholder={placeholder} placeholderTextColor={colors.textMuted} returnKeyType="done" onSubmitEditing={commit} onBlur={commit} blurOnSubmit={false} autoCorrect={false} />
    </View>
  );
}

const tagStyles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, gap: 6 },
  chipText: { fontSize: 13, color: colors.textPrimary },
  chipRemove: { fontSize: 16, color: colors.textMuted, lineHeight: 18 },
  input: { fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg, borderRadius: 8, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 9 },
});

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    backgroundColor: colors.bg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: { width: 80 },
  backBtnText: { color: colors.cyan, fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  headerTitle: { fontSize: 20, fontFamily: 'DMSans_600SemiBold', color: colors.textPrimary },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 40 },

  groupLabel: { fontSize: 12, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 28, marginBottom: 8, marginLeft: 4 },
  groupNote: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: 8, marginBottom: 28, marginHorizontal: 4 },

  card: { backgroundColor: colors.surface, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },

  cardToggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14 },
  cardToggleLeft: { flex: 1, marginRight: 12 },
  cardToggleTitle: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  cardToggleSub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  cardToggleChevron: { fontSize: 13, color: colors.textMuted },

  fieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 13, gap: 12 },
  fieldBlock: { paddingHorizontal: 16, paddingVertical: 13 },
  fieldLabel: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, flexShrink: 0 },
  fieldSubLabel: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  fieldLabelAbove: { fontSize: 12, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
  fieldInput: { flex: 1, fontSize: 14, color: colors.textSecondary, textAlign: 'right' },
  placeholder: { color: colors.textMuted },
  selectorRight: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1, justifyContent: 'flex-end' },
  chevron: { fontSize: 18, color: colors.textMuted, lineHeight: 22 },

  descInput: { fontSize: 14, color: colors.textPrimary, backgroundColor: colors.bg, borderRadius: 8, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 9, minHeight: 90, textAlignVertical: 'top' },

  divider: { height: 1, backgroundColor: colors.border, marginHorizontal: 16 },

  saveBtn: { backgroundColor: colors.cyan, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 12 },
  saveBtnText: { fontSize: 16, fontFamily: 'Inter_600SemiBold', color: colors.bg },

  // Auth form
  authError: { fontSize: 13, color: colors.error, paddingHorizontal: 16, paddingBottom: 8 },
  authButtons: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingVertical: 14 },
  authBtn: { flex: 1, backgroundColor: colors.cyan, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  authBtnDisabled: { opacity: 0.5 },
  authBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: colors.bg },
  authBtnSecondary: { flex: 1, backgroundColor: colors.border, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  authBtnSecondaryText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: colors.textSecondary },

  // Rows
  row: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 },
  rowContent: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  rowSubtitle: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  rowDivider: { height: 1, backgroundColor: colors.border, marginLeft: 16 },

  actionBtn: { backgroundColor: colors.cyan, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14 },
  actionBtnDisabled: { backgroundColor: colors.border },
  actionBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: colors.bg },
  actionBtnTextDisabled: { color: colors.textMuted },
  actionBtnDanger: { backgroundColor: 'rgba(255,80,80,0.12)', borderWidth: 1, borderColor: 'rgba(255,80,80,0.3)' },
  actionBtnTextDanger: { color: '#FF5050' },

  // Manage pages panel
  managePagesPanel: { paddingBottom: 4 },
  pageRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 13 },
  pageRowName: { flex: 1, fontSize: 14, color: colors.textPrimary, marginRight: 12 },
  checkbox: {
    width: 22, height: 22, borderRadius: 5,
    borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: colors.cyan, borderColor: colors.cyan },
  checkmark: { fontSize: 13, color: colors.bg, fontWeight: '700', lineHeight: 16 },
  managePagesActions: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14 },
  savePagesBtn: { flex: 1, backgroundColor: colors.cyan, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  savePagesBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: colors.bg },
  cancelPagesBtn: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  cancelPagesBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: colors.textMuted },

  // Facebook action buttons
  fbActionsRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingBottom: 14, paddingTop: 4 },
  fbReconnectBtn: { flex: 1, borderWidth: 1, borderColor: colors.cyan, borderRadius: 10, paddingVertical: 8, alignItems: 'center' },
  fbReconnectBtnText: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: colors.cyan },
  fbDisconnectBtn: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingVertical: 8, alignItems: 'center' },
  fbDisconnectBtnText: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: colors.textMuted },

  connectedChipInline: {
    backgroundColor: 'rgba(82,214,164,0.15)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  connectedChipInlineText: { fontSize: 11, fontWeight: '700', color: '#52D6A4' },

  // Platform rows
  platformRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginTop: 1, flexShrink: 0 },
  platformInfo: { flex: 1 },
  platformName: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  platformNameDim: { color: colors.textMuted },
  platformSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  manageBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  manageBtnText: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: colors.cyan },

  // Expand panel
  managePanelInner: { backgroundColor: 'rgba(0,0,0,0.15)', paddingBottom: 2 },
  managePanelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  managePanelSubText: { fontSize: 13, color: colors.textMuted },
  tokenWarnText: { fontSize: 12, fontWeight: '600', color: '#C8A040' },

  storageRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  storageKey: { fontSize: 15, color: colors.textPrimary },
  storageVal: { fontSize: 15, fontWeight: '600', color: colors.textSecondary },
  supportLink: { alignItems: 'center', paddingVertical: 20, marginBottom: 8 },
  supportLinkText: { fontSize: 13, color: colors.textMuted, textDecorationLine: 'underline' },
});
