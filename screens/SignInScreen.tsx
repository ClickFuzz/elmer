import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../constants/colors';
import { setSession } from '../storage/database';
import { Analytics } from '../services/analytics';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';

type Props = { onSignIn: () => void };

export default function SignInScreen({ onSignIn }: Props) {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const passwordRef             = useRef<TextInput>(null);

  const handleAuth = async (mode: 'login' | 'register') => {
    const emailTrimmed = email.trim().toLowerCase();
    if (!emailTrimmed || !password) {
      setError('Email and password are required.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setLoading(true);
    setError(null);

    // ── Network request ────────────────────────────────────────────────────────
    let res: Response;
    let data: { token?: string; userId?: number; expiresAt?: number; error?: string };
    try {
      const endpoint = mode === 'register' ? '/auth/register' : '/auth/login';
      res  = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailTrimmed, password }),
      });
      data = await res.json();
    } catch {
      setError('Could not reach the server. Check your connection.');
      setLoading(false);
      return;
    }

    // ── Server-side error ──────────────────────────────────────────────────────
    if (!res.ok) {
      // If the account already exists and we tried to register, the server
      // created it on a prior attempt whose response was lost (e.g. device
      // storage failure). Silently retry as a login so the user gets in.
      if (mode === 'register' && res.status === 409) {
        setLoading(false);
        handleAuth('login');
        return;
      }
      setError(data.error ?? 'Sign-in failed. Check your credentials and try again.');
      setLoading(false);
      return;
    }

    // ── Save session locally ───────────────────────────────────────────────────
    try {
      await setSession(data.token!, emailTrimmed, data.userId ?? undefined);
    } catch {
      // Local storage failed — registration/login succeeded on the server.
      setError('Signed in but could not save session. Please try again.');
      setLoading(false);
      return;
    }

    if (data.userId) Analytics.identify(data.userId);
    if (mode === 'register') {
      Analytics.signup_completed({ signup_method: 'email', platform: 'mobile' });
    }
    setLoading(false);
    onSignIn();
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.inner}>
        <View style={styles.logoRow}>
          <Image source={require('../assets/logo.png')} style={styles.logoImage} resizeMode="contain" />
        </View>
        <Text style={styles.tagline}>Sign in to get started</Text>

        <View style={styles.card}>
          <View style={styles.fieldRow}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
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
            <Text style={styles.label}>Password</Text>
            <TextInput
              ref={passwordRef}
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="8+ characters"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              returnKeyType="done"
              onSubmitEditing={() => handleAuth('login')}
            />
          </View>
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        <View style={styles.buttons}>
          <TouchableOpacity
            style={[styles.btnPrimary, loading && styles.btnDisabled]}
            onPress={() => handleAuth('login')}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading
              ? <ActivityIndicator color={colors.bg} />
              : <Text style={styles.btnPrimaryText}>Sign In</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btnSecondary, loading && styles.btnDisabled]}
            onPress={() => handleAuth('register')}
            disabled={loading}
            activeOpacity={0.8}
          >
            <Text style={styles.btnSecondaryText}>Create Account</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
  },
  inner: {
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  logoRow: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  logoImage: { height: 36, width: 160 },
  tagline: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: 32,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 12,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    flexShrink: 0,
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'right',
  },
  error: {
    fontSize: 13,
    color: colors.error,
    textAlign: 'center',
    marginTop: 12,
  },
  buttons: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
  },
  btnPrimary: {
    flex: 1,
    backgroundColor: colors.cyan,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnPrimaryText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: colors.bg,
  },
  btnSecondary: {
    flex: 1,
    backgroundColor: colors.border,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnSecondaryText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: colors.textSecondary,
  },
  btnDisabled: {
    opacity: 0.5,
  },
});
