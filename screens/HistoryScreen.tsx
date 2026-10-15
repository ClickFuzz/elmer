import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { colors } from '../constants/colors';
import { getAllJobs, deleteJob, Job } from '../storage/database';

type Props = {
  onBack: () => void;
  onPublishDraft: (job: Job) => void;
};

export default function HistoryScreen({ onBack, onPublishDraft }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showWebId, setShowWebId] = useState<number | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getAllJobs()
      .then(setJobs)
      .catch(() => setJobs([]))
      .finally(() => setLoading(false));
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const copy = (key: string, text: string) => {
    Clipboard.setStringAsync(text);
    if (timerRef.current) clearTimeout(timerRef.current);
    setCopiedKey(key);
    timerRef.current = setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleDeleteDraft = (job: Job) => {
    Alert.alert(
      'Delete Draft',
      'This will permanently remove this draft. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteJob(job.id).catch(() => {});
            setJobs(prev => prev.filter(j => j.id !== job.id));
            if (expandedId === job.id) setExpandedId(null);
          },
        },
      ]
    );
  };

  const toggleExpand = (id: number) => {
    const closing = expandedId === id;
    setExpandedId(closing ? null : id);
    if (closing) setShowWebId(null);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Job History</Text>
        <View style={styles.backBtn} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.cyan} />
        </View>
      ) : jobs.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No jobs yet</Text>
          <Text style={styles.emptySub}>Generate your first post from the home screen.</Text>
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {jobs.map(job => {
            const isExpanded = expandedId === job.id;
            const showWeb = showWebId === job.id;
            const socialKey = `s-${job.id}`;
            const webKey = `w-${job.id}`;

            return (
              <View key={job.id} style={styles.card}>
                {/* Top row: photo thumb + meta */}
                <View style={styles.cardTop}>
                  {job.firstPhotoUri ? (
                    <Image source={{ uri: job.firstPhotoUri }} style={styles.thumb} />
                  ) : (
                    <View style={styles.thumbPlaceholder} />
                  )}
                  <View style={styles.cardMeta}>
                    <View style={styles.cardMetaRow}>
                      <Text style={styles.cardDate}>{formatDate(job.createdAt)}</Text>
                      <View style={[styles.badge, job.status === 'published' && styles.badgePublished]}>
                        <Text style={[styles.badgeText, job.status === 'published' && styles.badgeTextPublished]}>
                          {job.status === 'published' ? 'Published' : 'Draft'}
                        </Text>
                      </View>
                    </View>
                    {job.jobLocation ? (
                      <Text style={styles.cardLocation}>{job.jobLocation}</Text>
                    ) : null}
                    {!isExpanded && job.socialContent ? (
                      <Text style={styles.preview} numberOfLines={2}>{job.socialContent}</Text>
                    ) : null}
                  </View>
                </View>

                <TouchableOpacity
                  style={styles.toggleRow}
                  onPress={() => toggleExpand(job.id)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.toggleText}>
                    {isExpanded ? 'Collapse ▲' : 'View post ▼'}
                  </Text>
                </TouchableOpacity>

                {isExpanded && (
                  <View style={styles.expandBody}>
                    {job.socialContent ? (
                      <View style={styles.section}>
                        <View style={styles.sectionHeader}>
                          <Text style={styles.sectionLabel}>Your Post</Text>
                          <TouchableOpacity onPress={() => copy(socialKey, job.socialContent!)} hitSlop={{ top: 8, bottom: 8, left: 12, right: 4 }}>
                            <Text style={styles.copyBtn}>{copiedKey === socialKey ? '✓ Copied!' : 'Copy'}</Text>
                          </TouchableOpacity>
                        </View>
                        <Text style={styles.postText}>{job.socialContent}</Text>
                      </View>
                    ) : null}

                    {job.webContent ? (
                      <View style={styles.section}>
                        <TouchableOpacity
                          style={styles.sectionHeader}
                          onPress={() => setShowWebId(showWeb ? null : job.id)}
                          activeOpacity={0.7}
                        >
                          <View>
                            <Text style={styles.sectionLabel}>Website Article</Text>
                            <Text style={styles.wordCount}>{wordCount(job.webContent)} words</Text>
                          </View>
                          <Text style={styles.toggleText}>{showWeb ? 'Hide ▲' : 'Preview ▼'}</Text>
                        </TouchableOpacity>
                        {showWeb && (
                          <>
                            <Text style={styles.articleText}>{job.webContent}</Text>
                            <TouchableOpacity onPress={() => copy(webKey, job.webContent!)} style={styles.copyRow} hitSlop={{ top: 8, bottom: 8, left: 12, right: 4 }}>
                              <Text style={styles.copyBtn}>{copiedKey === webKey ? '✓ Copied!' : 'Copy Article'}</Text>
                            </TouchableOpacity>
                          </>
                        )}
                      </View>
                    ) : null}

                    {job.status === 'draft' && (
                      <View style={styles.draftActions}>
                        <TouchableOpacity
                          style={styles.publishBtn}
                          onPress={() => onPublishDraft(job)}
                          activeOpacity={0.8}
                        >
                          <Text style={styles.publishBtnText}>Publish</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.deleteBtn}
                          onPress={() => handleDeleteDraft(job)}
                          activeOpacity={0.8}
                        >
                          <Text style={styles.deleteBtnText}>Delete Draft</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (diffDays === 0) return `Today, ${time}`;
  if (diffDays === 1) return `Yesterday, ${time}`;
  if (diffDays < 7) return `${d.toLocaleDateString('en-US', { weekday: 'short' })}, ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function wordCount(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  header: {
    backgroundColor: colors.bg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: { width: 80 },
  backBtnText: { color: colors.cyan, fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  headerTitle: { fontSize: 20, fontFamily: 'DMSans_600SemiBold', color: colors.textPrimary },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyTitle: { fontSize: 20, fontFamily: 'DMSans_600SemiBold', color: colors.textPrimary, marginBottom: 8 },
  emptySub: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },

  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 32 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    marginBottom: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },

  cardTop: {
    flexDirection: 'row',
    padding: 14,
    gap: 12,
  },
  thumb: {
    width: 60,
    height: 60,
    borderRadius: 8,
    flexShrink: 0,
  },
  thumbPlaceholder: {
    width: 60,
    height: 60,
    borderRadius: 8,
    backgroundColor: colors.border,
    flexShrink: 0,
  },
  cardMeta: { flex: 1 },
  cardMetaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  cardDate: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  cardLocation: { fontSize: 12, color: colors.textMuted, marginBottom: 4 },
  preview: { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },

  badge: {
    backgroundColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgePublished: { backgroundColor: 'rgba(82,214,164,0.15)' },
  badgeText: { fontSize: 11, fontWeight: '700', color: colors.textMuted },
  badgeTextPublished: { color: colors.success },

  toggleRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'flex-end',
  },
  toggleText: { fontSize: 13, fontWeight: '700', color: colors.cyan },

  expandBody: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  section: {
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  wordCount: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  copyBtn: { fontSize: 13, fontWeight: '700', color: colors.cyan },
  postText: { fontSize: 14, color: colors.textPrimary, lineHeight: 21 },
  articleText: { fontSize: 13, color: colors.textSecondary, lineHeight: 20, marginBottom: 10 },
  copyRow: { alignItems: 'flex-end' },
  draftActions: {
    flexDirection: 'row',
    gap: 10,
    padding: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  publishBtn: {
    flex: 1,
    backgroundColor: colors.cyan,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  publishBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: colors.bg },
  deleteBtn: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  deleteBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: colors.textMuted },
});
