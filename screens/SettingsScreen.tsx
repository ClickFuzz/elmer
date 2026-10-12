import React, { useEffect, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../constants/colors';
import { getJobStats } from '../storage/database';

type Props = {
  onBack: () => void;
};

type JobStats = { total: number; drafts: number };

const CHANNELS = [
  { id: 'google', label: 'Google Business Profile', icon: 'G' },
  { id: 'facebook', label: 'Facebook Pages', icon: 'f' },
  { id: 'wordpress', label: 'WordPress', icon: 'W' },
] as const;

export default function SettingsScreen({ onBack }: Props) {
  const [stats, setStats] = useState<JobStats | null>(null);

  useEffect(() => {
    getJobStats()
      .then(setStats)
      .catch(() => setStats({ total: 0, drafts: 0 }));
  }, []);

  const handleConnect = (label: string) => {
    Alert.alert(
      'Coming Soon',
      `Connecting ${label} is not yet available. This will be set up in a future update.`,
      [{ text: 'OK' }]
    );
  };

  const handleSignIn = () => {
    Alert.alert(
      'Account',
      'Elmer account sign-in is coming in a future update. Your jobs are saved locally on this device.',
      [{ text: 'OK' }]
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={onBack}
          style={styles.backBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>

        {/* Elmer Account */}
        <Text style={styles.groupLabel}>Elmer Account</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.rowIcon}>
              <Text style={styles.rowIconText}>👤</Text>
            </View>
            <View style={styles.rowContent}>
              <Text style={styles.rowTitle}>Sign In</Text>
              <Text style={styles.rowSubtitle}>Sync jobs and settings across devices</Text>
            </View>
            <TouchableOpacity style={styles.actionBtn} onPress={handleSignIn} activeOpacity={0.8}>
              <Text style={styles.actionBtnText}>Sign In</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Connected Accounts */}
        <Text style={styles.groupLabel}>Connected Accounts</Text>
        <View style={styles.card}>
          {CHANNELS.map((channel, index) => (
            <View key={channel.id}>
              <View style={styles.row}>
                <View style={[styles.rowIcon, styles.channelIcon]}>
                  <Text style={styles.channelIconText}>{channel.icon}</Text>
                </View>
                <View style={styles.rowContent}>
                  <Text style={styles.rowTitle}>{channel.label}</Text>
                  <Text style={styles.rowSubtitle}>Not connected</Text>
                </View>
                <TouchableOpacity
                  style={[styles.actionBtn, styles.actionBtnDisabled]}
                  onPress={() => handleConnect(channel.label)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.actionBtnText, styles.actionBtnTextDisabled]}>Connect</Text>
                </TouchableOpacity>
              </View>
              {index < CHANNELS.length - 1 && <View style={styles.divider} />}
            </View>
          ))}
        </View>
        <Text style={styles.groupNote}>
          Publishing integrations will be available in an upcoming update.
        </Text>

        {/* Storage */}
        <Text style={styles.groupLabel}>Local Storage</Text>
        <View style={styles.card}>
          <View style={styles.storageRow}>
            <Text style={styles.storageKey}>Saved jobs</Text>
            <Text style={styles.storageVal}>{stats ? stats.total : '—'}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.storageRow}>
            <Text style={styles.storageKey}>Unpublished drafts</Text>
            <Text style={styles.storageVal}>{stats ? stats.drafts : '—'}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.storageRow}>
            <Text style={styles.storageKey}>Storage location</Text>
            <Text style={styles.storageVal}>On-device</Text>
          </View>
        </View>
        <Text style={styles.groupNote}>
          Photos and audio are stored in your app's private document directory. Published jobs older than 30 days have their media removed automatically. Unpublished jobs are never deleted automatically.
        </Text>

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.cream },
  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 20,
  },
  backBtn: { width: 80 },
  backBtnText: { color: colors.cream, fontSize: 16, fontWeight: '600' },
  headerTitle: { fontSize: 20, fontWeight: '800', color: colors.cream },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 40 },
  groupLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textLight,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
    marginLeft: 4,
  },
  groupNote: {
    fontSize: 12,
    color: colors.textLight,
    lineHeight: 17,
    marginTop: 8,
    marginBottom: 28,
    marginHorizontal: 4,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: colors.creamDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowIconText: { fontSize: 20 },
  channelIcon: { backgroundColor: colors.navy },
  channelIconText: { color: colors.cream, fontSize: 16, fontWeight: '800' },
  rowContent: { flex: 1 },
  rowTitle: { fontSize: 16, fontWeight: '600', color: colors.textDark },
  rowSubtitle: { fontSize: 13, color: colors.textLight, marginTop: 2 },
  actionBtn: {
    backgroundColor: colors.orange,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  actionBtnDisabled: { backgroundColor: colors.creamDark },
  actionBtnText: { fontSize: 14, fontWeight: '700', color: colors.white },
  actionBtnTextDisabled: { color: colors.textLight },
  divider: { height: 1, backgroundColor: colors.border, marginLeft: 68 },
  storageRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  storageKey: { fontSize: 15, color: colors.textDark },
  storageVal: { fontSize: 15, fontWeight: '600', color: colors.textMid },
});
