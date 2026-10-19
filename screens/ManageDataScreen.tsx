import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { colors } from '../constants/colors';
import {
  calculateStorageUsage,
  clearSession,
  deleteAllJobsForCurrentUser,
  getJobStats,
  getSessionToken,
} from '../storage/database';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

type Props = {
  onBack: () => void;
  onAccountDeleted: () => void;
};

export default function ManageDataScreen({ onBack, onAccountDeleted }: Props) {
  const [storageLoading, setStorageLoading] = useState(true);
  const [totalBytes, setTotalBytes] = useState(0);
  const [stats, setStats] = useState<{ total: number; drafts: number } | null>(null);
  const [historyDeleting, setHistoryDeleting] = useState(false);
  const [accountDeleting, setAccountDeleting] = useState(false);

  const loadData = useCallback(async () => {
    setStorageLoading(true);
    try {
      const [usage, jobStats] = await Promise.all([
        calculateStorageUsage(),
        getJobStats(),
      ]);
      setTotalBytes(usage.totalBytes);
      setStats(jobStats);
    } catch {
      setStats({ total: 0, drafts: 0 });
    } finally {
      setStorageLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleDeleteHistory = () => {
    Alert.alert(
      'Delete Publishing History',
      'This will permanently remove all saved jobs, drafts, photos, and recordings from this device, and delete your publishing history from Elmer\'s servers. Posts already published to Facebook, Instagram, Threads, and other platforms will remain there.\n\nThis action cannot be undone.',
      [
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setHistoryDeleting(true);
            try {
              // Delete server-side publishing records
              const token = await getSessionToken();
              if (token) {
                try {
                  await fetch(`${API_URL}/auth/history`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${token}` },
                  });
                } catch { /* offline — local deletion still proceeds */ }
              }

              // Delete all local jobs, photos, and recordings
              await deleteAllJobsForCurrentUser();

              await loadData();
              Alert.alert('Done', 'Your publishing history has been deleted.', [{ text: 'OK' }]);
            } catch (err) {
              Alert.alert(
                'Deletion incomplete',
                'Some data could not be deleted. You can try again.',
                [{ text: 'OK' }]
              );
              await loadData();
            } finally {
              setHistoryDeleting(false);
            }
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'This will permanently delete your Elmer account and all associated data — including connected platform credentials, publishing history, jobs, photos, and recordings. Posts already published to your connected platforms will remain there.\n\nYou will be signed out immediately. This action cannot be undone.',
      [
        {
          text: 'Delete My Account',
          style: 'destructive',
          onPress: async () => {
            setAccountDeleting(true);
            try {
              const token = await getSessionToken();
              if (!token) {
                Alert.alert('Sign In Required', 'Sign in to delete your account.', [{ text: 'OK' }]);
                return;
              }

              const res = await fetch(`${API_URL}/auth/account`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
              });

              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                Alert.alert('Deletion failed', data.error ?? 'Could not delete account. Try again.', [{ text: 'OK' }]);
                return;
              }

              // Clean up local data after confirmed server deletion
              await deleteAllJobsForCurrentUser().catch(() => {});
              await clearSession();

              onAccountDeleted();
            } catch {
              Alert.alert(
                'Connection error',
                'Could not reach the server. Your account has not been deleted. Check your connection and try again.',
                [{ text: 'OK' }]
              );
            } finally {
              setAccountDeleting(false);
            }
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Manage Data</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.screenDesc}>Control your saved content and account information.</Text>

        {/* Storage Overview */}
        <Text style={styles.groupLabel}>Storage Overview</Text>
        <View style={styles.card}>
          <View style={styles.storageRow}>
            <Text style={styles.storageKey}>Device storage used</Text>
            {storageLoading
              ? <ActivityIndicator size="small" color={colors.textMuted} />
              : <Text style={styles.storageVal}>{formatBytes(totalBytes)}</Text>}
          </View>
          <View style={styles.divider} />
          <View style={styles.storageRow}>
            <Text style={styles.storageKey}>Saved jobs</Text>
            <Text style={styles.storageVal}>{stats ? stats.total : '—'}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.storageRow}>
            <Text style={styles.storageKey}>Unpublished drafts</Text>
            <Text style={styles.storageVal}>{stats ? stats.drafts : '—'}</Text>
          </View>
        </View>

        {/* Automatic Cleanup */}
        <Text style={styles.groupLabel}>Automatic Cleanup</Text>
        <View style={styles.infoCard}>
          <Text style={styles.infoText}>
            Completed jobs, photos, and recordings are automatically deleted 30 days after successful publishing. Unpublished drafts and unresolved posts are kept until you delete them manually.
          </Text>
        </View>

        {/* Delete Publishing History */}
        <Text style={styles.groupLabel}>Delete Publishing History</Text>
        <View style={styles.card}>
          <Text style={styles.actionDesc}>
            Permanently remove your saved jobs, drafts, photos, recordings, and publishing history from Elmer. Posts already published to connected platforms will remain available there.
          </Text>
          <View style={styles.divider} />
          <TouchableOpacity
            style={[styles.dangerBtn, historyDeleting && styles.btnDisabled]}
            onPress={handleDeleteHistory}
            disabled={historyDeleting || accountDeleting}
            activeOpacity={0.8}
          >
            {historyDeleting
              ? <ActivityIndicator color={colors.error} size="small" />
              : <Text style={styles.dangerBtnText}>Delete Publishing History</Text>}
          </TouchableOpacity>
        </View>

        {/* Delete Account */}
        <Text style={styles.groupLabel}>Delete Account</Text>
        <View style={styles.card}>
          <Text style={styles.actionDesc}>
            Permanently delete your Elmer account and all associated data, including connected platform credentials and publishing history.
          </Text>
          <View style={styles.divider} />
          <TouchableOpacity
            style={[styles.deleteAccountBtn, accountDeleting && styles.btnDisabled]}
            onPress={handleDeleteAccount}
            disabled={historyDeleting || accountDeleting}
            activeOpacity={0.8}
          >
            {accountDeleting
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.deleteAccountBtnText}>Delete Account</Text>}
          </TouchableOpacity>
        </View>

        <View style={styles.bottomPad} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
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
  scrollContent: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 40 },

  screenDesc: { fontSize: 14, color: colors.textMuted, lineHeight: 20, marginBottom: 24 },

  groupLabel: {
    fontSize: 12, fontWeight: '700', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8,
    marginTop: 8, marginBottom: 8, marginLeft: 4,
  },

  card: {
    backgroundColor: colors.surface, borderRadius: 16,
    overflow: 'hidden', borderWidth: 1, borderColor: colors.border,
    marginBottom: 8,
  },
  infoCard: {
    backgroundColor: colors.surface, borderRadius: 16,
    borderWidth: 1, borderColor: colors.border,
    padding: 16, marginBottom: 8,
  },
  infoText: { fontSize: 14, color: colors.textMuted, lineHeight: 20 },

  divider: { height: 1, backgroundColor: colors.border, marginHorizontal: 16 },

  storageRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', padding: 16,
  },
  storageKey: { fontSize: 15, color: colors.textPrimary },
  storageVal: { fontSize: 15, fontWeight: '600', color: colors.textSecondary },

  actionDesc: {
    fontSize: 14, color: colors.textMuted, lineHeight: 20,
    paddingHorizontal: 16, paddingVertical: 14,
  },

  dangerBtn: {
    margin: 16,
    borderWidth: 1, borderColor: colors.error, borderRadius: 12,
    paddingVertical: 13, alignItems: 'center',
  },
  dangerBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: colors.error },

  deleteAccountBtn: {
    margin: 16,
    backgroundColor: colors.error, borderRadius: 12,
    paddingVertical: 13, alignItems: 'center',
  },
  deleteAccountBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: '#fff' },

  btnDisabled: { opacity: 0.5 },
  bottomPad: { height: 20 },
});
