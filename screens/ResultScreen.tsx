import * as FileSystem from 'expo-file-system/legacy';
import React, { useState, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../constants/colors';
import { GeneratePayload } from '../App';
import { saveJob, SeoMetadata } from '../storage/database';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';

type Tab = 'google' | 'social' | 'wordpress';

type Props = {
  payload: GeneratePayload;
  onBack: () => void;
};

type SuccessData = {
  googlePost: string;
  socialPost: string;
  webContent: string;
  transcription: string;
  location: string;
  seoMetadata: SeoMetadata | null;
  isMock: boolean;
};

type State =
  | { status: 'loading' }
  | ({ status: 'success' } & SuccessData)
  | { status: 'error'; message: string };

export default function ResultScreen({ payload, onBack }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [activeTab, setActiveTab] = useState<Tab>('google');

  // Editable content — initialized from server response, user can change
  const [editedGoogle, setEditedGoogle] = useState('');
  const [editedSocial, setEditedSocial] = useState('');
  const [editedWordpress, setEditedWordpress] = useState('');
  const [editedLocation, setEditedLocation] = useState('');

  const [showSeo, setShowSeo] = useState(false);
  const isGenerating = useRef(false);

  useEffect(() => {
    generate();
  }, []);

  const generate = async () => {
    if (isGenerating.current) return;
    isGenerating.current = true;
    setState({ status: 'loading' });

    try {
      const classifications = payload.photos.map(p => p.classification);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any;

      if (payload.audioUri) {
        const result = await FileSystem.uploadAsync(
          `${API_URL}/api/generate`,
          payload.audioUri,
          {
            httpMethod: 'POST',
            uploadType: FileSystem.FileSystemUploadType.MULTIPART,
            fieldName: 'audio',
            mimeType: 'audio/m4a',
            parameters: {
              photoCount: String(payload.photos.length),
              classifications: JSON.stringify(classifications),
            },
          }
        );
        if (result.status < 200 || result.status >= 300) {
          throw new Error(`Server error ${result.status}: ${result.body}`);
        }
        data = JSON.parse(result.body);
      } else {
        const response = await fetch(`${API_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photoCount: payload.photos.length, classifications }),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Server error ${response.status}: ${text}`);
        }
        data = await response.json();
      }

      const loc = data.location
        ? `${data.location.city}, ${data.location.state}`
        : '';

      setState({
        status: 'success',
        googlePost: data.googlePost ?? '',
        socialPost: data.socialPost ?? '',
        webContent: data.webContent ?? '',
        transcription: data.transcription ?? '',
        location: loc,
        seoMetadata: data.seoMetadata ?? null,
        isMock: data.mock === true,
      });
      setEditedGoogle(data.googlePost ?? '');
      setEditedSocial(data.socialPost ?? '');
      setEditedWordpress(data.webContent ?? '');
      setEditedLocation(loc);

      saveJob({
        audioSourceUri: payload.audioUri,
        transcription: data.transcription ?? '',
        googlePost: data.googlePost ?? '',
        socialPost: data.socialPost ?? '',
        webContent: data.webContent ?? '',
        location: loc,
        seoMetadata: data.seoMetadata ?? null,
        isMock: data.mock === true,
        photos: payload.photos.map(p => ({ uri: p.uri, classification: p.classification })),
      }).catch(err => console.warn('DB save failed:', err));
    } catch (err: unknown) {
      setState({ status: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      isGenerating.current = false;
    }
  };

  const activeText =
    activeTab === 'google' ? editedGoogle
    : activeTab === 'social' ? editedSocial
    : editedWordpress;

  const setActiveText =
    activeTab === 'google' ? setEditedGoogle
    : activeTab === 'social' ? setEditedSocial
    : setEditedWordpress;

  const copyLabel =
    activeTab === 'google' ? 'Copy Post'
    : activeTab === 'social' ? 'Copy Post'
    : 'Copy Article';

  const wordCount = (text: string) =>
    text.trim() === '' ? 0 : text.trim().split(/\s+/).length;

  const handlePostEverywhere = () => {
    Alert.alert(
      'Connect your channels',
      'To publish directly from Elmer, connect your accounts in Settings.',
      [{ text: 'OK' }]
    );
  };

  const copyToClipboard = () => {
    Clipboard.setString(activeText);
    Alert.alert('Copied!', `${activeTab === 'wordpress' ? 'Article' : 'Post'} copied to clipboard.`);
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
        <Text style={styles.headerTitle}>Preview</Text>
        <View style={styles.backBtn} />
      </View>

      {/* Tab bar */}
      {state.status === 'success' && (
        <View style={styles.tabBar}>
          {(['google', 'social', 'wordpress'] as Tab[]).map(tab => (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => setActiveTab(tab)}
              activeOpacity={0.8}
            >
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab === 'google' ? 'Google Biz' : tab === 'social' ? 'Social' : 'WordPress'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Loading */}
        {state.status === 'loading' && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.orange} />
            <Text style={styles.loadingText}>Generating your content…</Text>
            <Text style={styles.loadingSubtext}>
              Transcribing, extracting job details, and writing{'\n'}Google Business, Social Media, and WordPress posts.
            </Text>
          </View>
        )}

        {/* Error */}
        {state.status === 'error' && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorIcon}>⚠️</Text>
            <Text style={styles.errorTitle}>Something went wrong</Text>
            <Text style={styles.errorMessage}>{state.message}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={generate} activeOpacity={0.8}>
              <Text style={styles.retryBtnText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Success */}
        {state.status === 'success' && (
          <>
            {state.isMock && (
              <View style={styles.mockBanner}>
                <Text style={styles.mockBannerText}>
                  ⚠️  MOCK — Set OPENAI_API_KEY in server/.env for real AI generation.
                </Text>
              </View>
            )}

            {/* Location field */}
            <View style={styles.locationCard}>
              <Text style={styles.locationPin}>📍</Text>
              <TextInput
                style={styles.locationInput}
                value={editedLocation}
                onChangeText={setEditedLocation}
                placeholder="City, State (optional)"
                placeholderTextColor={colors.textLight}
                autoCorrect={false}
                returnKeyType="done"
              />
              {editedLocation === '' && (
                <Text style={styles.locationHint}>Not detected</Text>
              )}
            </View>

            {/* Transcription */}
            {state.transcription !== '' && (
              <View style={styles.transcriptionCard}>
                <Text style={styles.cardLabel}>What you said</Text>
                <Text style={styles.transcriptionText}>{state.transcription}</Text>
              </View>
            )}

            {/* Post content */}
            <View style={styles.postCard}>
              <View style={styles.postCardHeader}>
                <View>
                  <Text style={styles.cardLabel}>
                    {activeTab === 'google'
                      ? 'Google Business Profile'
                      : activeTab === 'social'
                      ? 'Facebook · Instagram · X · LinkedIn'
                      : 'WordPress Blog Post'}
                  </Text>
                  {activeTab === 'wordpress' && (
                    <Text style={styles.cardMeta}>SEO-optimized, {wordCount(editedWordpress)} words</Text>
                  )}
                  {activeTab === 'google' && (
                    <Text style={styles.cardMeta}>Local SEO optimized</Text>
                  )}
                </View>
                <Text style={styles.editHint}>Tap to edit</Text>
              </View>
              <TextInput
                style={[styles.postInput, activeTab === 'wordpress' && styles.postInputLong]}
                value={activeText}
                onChangeText={setActiveText}
                multiline
                textAlignVertical="top"
                autoCorrect
                scrollEnabled={false}
              />
              <Text style={styles.metaCount}>
                {activeTab === 'wordpress'
                  ? `${wordCount(editedWordpress)} words`
                  : `${activeText.length} characters`}
              </Text>
            </View>

            {/* SEO Metadata — WordPress tab only */}
            {activeTab === 'wordpress' && state.seoMetadata && (
              <View style={styles.seoCard}>
                <TouchableOpacity
                  style={styles.seoHeader}
                  onPress={() => setShowSeo(v => !v)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.seoHeaderTitle}>SEO Details</Text>
                  <Text style={styles.seoHeaderChevron}>{showSeo ? '▲' : '▼'}</Text>
                </TouchableOpacity>

                {showSeo && (
                  <View style={styles.seoBody}>
                    <SeoRow label="SEO Title" value={state.seoMetadata.seoTitle} />
                    <SeoRow label="URL Slug" value={`/${state.seoMetadata.urlSlug}`} mono />
                    <SeoRow label="Meta Description" value={state.seoMetadata.metaDescription} />
                    <SeoRow label="Main Keyword" value={state.seoMetadata.mainKeyword} />

                    <Text style={styles.seoFieldLabel}>Secondary Keywords</Text>
                    <View style={styles.tagRow}>
                      {state.seoMetadata.secondaryKeywords.map((kw, i) => (
                        <View key={i} style={styles.tag}>
                          <Text style={styles.tagText}>{kw}</Text>
                        </View>
                      ))}
                    </View>

                    {state.seoMetadata.imageFilenames.length > 0 && (
                      <>
                        <Text style={[styles.seoFieldLabel, { marginTop: 12 }]}>Image Filenames</Text>
                        {state.seoMetadata.imageFilenames.map((fn, i) => (
                          <View key={i} style={styles.imageRow}>
                            <Text style={styles.imageFilename}>{fn}</Text>
                            {state.seoMetadata!.imageAltTexts[i] && (
                              <Text style={styles.imageAlt}>
                                Alt: {state.seoMetadata!.imageAltTexts[i]}
                              </Text>
                            )}
                          </View>
                        ))}
                      </>
                    )}
                  </View>
                )}
              </View>
            )}
          </>
        )}
      </ScrollView>

      {/* Footer */}
      {state.status === 'success' && (
        <View style={styles.footer}>
          <TouchableOpacity
            style={styles.postEverywhereBtn}
            onPress={handlePostEverywhere}
            activeOpacity={0.8}
          >
            <Text style={styles.postEverywhereBtnText}>Post Everywhere</Text>
            <Text style={styles.postEverywhereSubtext}>Connect channels in Settings</Text>
          </TouchableOpacity>
          <View style={styles.secondaryRow}>
            <TouchableOpacity style={styles.copyBtn} onPress={copyToClipboard} activeOpacity={0.8}>
              <Text style={styles.copyBtnText}>{copyLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.regenBtn} onPress={generate} activeOpacity={0.8}>
              <Text style={styles.regenBtnText}>Regenerate</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

function SeoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={seoRowStyles.container}>
      <Text style={seoRowStyles.label}>{label}</Text>
      <Text style={[seoRowStyles.value, mono && seoRowStyles.mono]}>{value}</Text>
    </View>
  );
}

const seoRowStyles = StyleSheet.create({
  container: { marginBottom: 10 },
  label: { fontSize: 11, fontWeight: '700', color: colors.textLight, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 },
  value: { fontSize: 14, color: colors.textDark, lineHeight: 20 },
  mono: { fontFamily: 'Courier', fontSize: 13, color: colors.navy },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.cream },
  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 16,
  },
  backBtn: { width: 80 },
  backBtnText: { color: colors.cream, fontSize: 16, fontWeight: '600' },
  headerTitle: { fontSize: 20, fontWeight: '800', color: colors.cream },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.navy,
    paddingHorizontal: 16,
    paddingBottom: 14,
    gap: 8,
  },
  tab: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 9,
    alignItems: 'center',
    backgroundColor: colors.navyLight,
  },
  tabActive: { backgroundColor: colors.orange },
  tabText: { fontSize: 13, fontWeight: '700', color: colors.cream, opacity: 0.55 },
  tabTextActive: { opacity: 1 },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 32 },

  loadingContainer: { marginTop: 60, alignItems: 'center' },
  loadingText: { marginTop: 20, fontSize: 20, fontWeight: '700', color: colors.textDark },
  loadingSubtext: { marginTop: 8, fontSize: 14, color: colors.textLight, textAlign: 'center', lineHeight: 20 },

  errorContainer: { marginTop: 40, alignItems: 'center', paddingHorizontal: 20 },
  errorIcon: { fontSize: 48, marginBottom: 16 },
  errorTitle: { fontSize: 22, fontWeight: '700', color: colors.textDark, marginBottom: 10 },
  errorMessage: { fontSize: 14, color: colors.textMid, textAlign: 'center', marginBottom: 28, lineHeight: 20 },
  retryBtn: { backgroundColor: colors.orange, borderRadius: 14, paddingVertical: 16, paddingHorizontal: 40 },
  retryBtnText: { color: colors.white, fontSize: 17, fontWeight: '700' },

  mockBanner: {
    backgroundColor: '#FFF3CD',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#FECF67',
  },
  mockBannerText: { fontSize: 13, color: '#7A5C00', lineHeight: 18, fontWeight: '500' },

  locationCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
    gap: 8,
  },
  locationPin: { fontSize: 18 },
  locationInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textDark,
    padding: 0,
  },
  locationHint: { fontSize: 13, color: colors.textLight, fontStyle: 'italic' },

  transcriptionCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textLight,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  cardMeta: { fontSize: 12, color: colors.orange, marginBottom: 8, fontWeight: '500' },
  transcriptionText: { fontSize: 15, color: colors.textMid, lineHeight: 22 },

  postCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  postCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  editHint: { fontSize: 12, color: colors.orange, fontWeight: '500' },
  postInput: {
    fontSize: 15,
    color: colors.textDark,
    lineHeight: 23,
    minHeight: 150,
    padding: 0,
  },
  postInputLong: { minHeight: 300 },
  metaCount: { marginTop: 8, fontSize: 11, color: colors.textLight, textAlign: 'right' },

  seoCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  seoHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 14,
  },
  seoHeaderTitle: { fontSize: 14, fontWeight: '700', color: colors.navy },
  seoHeaderChevron: { fontSize: 12, color: colors.textLight },
  seoBody: {
    paddingHorizontal: 14,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 14,
  },
  seoFieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textLight,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: {
    backgroundColor: colors.creamDark,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  tagText: { fontSize: 12, color: colors.textDark, fontWeight: '500' },
  imageRow: { marginBottom: 8 },
  imageFilename: { fontSize: 13, fontFamily: 'Courier', color: colors.navy },
  imageAlt: { fontSize: 12, color: colors.textMid, marginTop: 2, lineHeight: 17 },

  footer: {
    padding: 16,
    paddingBottom: 20,
    gap: 10,
    backgroundColor: colors.cream,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  postEverywhereBtn: {
    backgroundColor: colors.navy,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
  },
  postEverywhereBtnText: { color: colors.cream, fontSize: 19, fontWeight: '800' },
  postEverywhereSubtext: { color: colors.orange, fontSize: 12, fontWeight: '500', marginTop: 3 },
  secondaryRow: { flexDirection: 'row', gap: 10 },
  copyBtn: {
    flex: 1,
    backgroundColor: colors.orange,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  copyBtnText: { color: colors.white, fontSize: 16, fontWeight: '700' },
  regenBtn: {
    backgroundColor: colors.creamDark,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  regenBtnText: { fontSize: 15, fontWeight: '600', color: colors.textDark },
});
