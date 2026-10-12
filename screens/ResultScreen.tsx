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
import { saveJob } from '../storage/database';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';

type Tab = 'social' | 'web';

type Props = {
  payload: GeneratePayload;
  onBack: () => void;
};

type State =
  | { status: 'loading' }
  | {
      status: 'success';
      socialPost: string;
      webContent: string;
      transcription: string;
      isMock: boolean;
    }
  | { status: 'error'; message: string };

export default function ResultScreen({ payload, onBack }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [activeTab, setActiveTab] = useState<Tab>('social');
  const [editedSocial, setEditedSocial] = useState('');
  const [editedWeb, setEditedWeb] = useState('');
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

      setState({
        status: 'success',
        socialPost: data.socialPost ?? '',
        webContent: data.webContent ?? '',
        transcription: data.transcription ?? '',
        isMock: data.mock === true,
      });
      setEditedSocial(data.socialPost ?? '');
      setEditedWeb(data.webContent ?? '');

      saveJob({
        audioSourceUri: payload.audioUri,
        transcription: data.transcription ?? '',
        postContent: data.socialPost ?? '',
        webContent: data.webContent ?? '',
        isMock: data.mock === true,
        photos: payload.photos.map(p => ({ uri: p.uri, classification: p.classification })),
      }).catch(err => console.warn('Failed to save job:', err));
    } catch (err: unknown) {
      setState({ status: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      isGenerating.current = false;
    }
  };

  const activeText = activeTab === 'social' ? editedSocial : editedWeb;
  const setActiveText = activeTab === 'social' ? setEditedSocial : setEditedWeb;

  const copyToClipboard = () => {
    Clipboard.setString(activeText);
    Alert.alert('Copied!', `${activeTab === 'social' ? 'Social media post' : 'Web content'} copied to clipboard.`);
  };

  const handlePostEverywhere = () => {
    Alert.alert(
      'Connect your channels',
      'To publish directly from Elmer, connect your Google Business Profile, Facebook Pages, or WordPress account in Settings.',
      [{ text: 'OK' }]
    );
  };

  const wordCount = (text: string) =>
    text.trim() === '' ? 0 : text.trim().split(/\s+/).length;

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

      {/* Tab bar — only shown when content is ready */}
      {state.status === 'success' && (
        <View style={styles.tabBar}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'social' && styles.tabActive]}
            onPress={() => setActiveTab('social')}
            activeOpacity={0.8}
          >
            <Text style={[styles.tabText, activeTab === 'social' && styles.tabTextActive]}>
              Social Media
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'web' && styles.tabActive]}
            onPress={() => setActiveTab('web')}
            activeOpacity={0.8}
          >
            <Text style={[styles.tabText, activeTab === 'web' && styles.tabTextActive]}>
              Web Content
            </Text>
          </TouchableOpacity>
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
            <Text style={styles.loadingText}>Generating your posts…</Text>
            <Text style={styles.loadingSubtext}>
              Transcribing audio and writing social + web content.
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
                  ⚠️  MOCK RESPONSE — Set OPENAI_API_KEY in server/.env to enable real generation.
                </Text>
              </View>
            )}

            {state.transcription !== '' && (
              <View style={styles.transcriptionCard}>
                <Text style={styles.cardLabel}>What you said</Text>
                <Text style={styles.transcriptionText}>{state.transcription}</Text>
              </View>
            )}

            {activeTab === 'social' && (
              <View style={styles.postCard}>
                <View style={styles.postCardHeader}>
                  <View>
                    <Text style={styles.cardLabel}>Social Media Post</Text>
                    <Text style={styles.cardMeta}>Google · Facebook · Instagram · X · LinkedIn</Text>
                  </View>
                  <Text style={styles.postCardHint}>Tap to edit</Text>
                </View>
                <TextInput
                  style={styles.postInput}
                  value={editedSocial}
                  onChangeText={setEditedSocial}
                  multiline
                  textAlignVertical="top"
                  autoCorrect
                  scrollEnabled={false}
                />
                <Text style={styles.metaCount}>{editedSocial.length} characters</Text>
              </View>
            )}

            {activeTab === 'web' && (
              <View style={styles.postCard}>
                <View style={styles.postCardHeader}>
                  <View>
                    <Text style={styles.cardLabel}>Web Content</Text>
                    <Text style={styles.cardMeta}>WordPress · 500+ words</Text>
                  </View>
                  <Text style={styles.postCardHint}>Tap to edit</Text>
                </View>
                <TextInput
                  style={[styles.postInput, styles.postInputLong]}
                  value={editedWeb}
                  onChangeText={setEditedWeb}
                  multiline
                  textAlignVertical="top"
                  autoCorrect
                  scrollEnabled={false}
                />
                <Text style={styles.metaCount}>{wordCount(editedWeb)} words</Text>
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
              <Text style={styles.copyBtnText}>Copy {activeTab === 'social' ? 'Post' : 'Article'}</Text>
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
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.navy,
    paddingHorizontal: 20,
    paddingBottom: 16,
    gap: 10,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: colors.navyLight,
  },
  tabActive: {
    backgroundColor: colors.orange,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.cream,
    opacity: 0.6,
  },
  tabTextActive: {
    opacity: 1,
  },
  scroll: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 32 },
  loadingContainer: { marginTop: 60, alignItems: 'center' },
  loadingText: { marginTop: 20, fontSize: 20, fontWeight: '700', color: colors.textDark },
  loadingSubtext: { marginTop: 8, fontSize: 14, color: colors.textLight, textAlign: 'center' },
  errorContainer: { marginTop: 40, alignItems: 'center', paddingHorizontal: 20 },
  errorIcon: { fontSize: 48, marginBottom: 16 },
  errorTitle: { fontSize: 22, fontWeight: '700', color: colors.textDark, marginBottom: 10 },
  errorMessage: { fontSize: 14, color: colors.textMid, textAlign: 'center', marginBottom: 28, lineHeight: 20 },
  retryBtn: {
    backgroundColor: colors.orange,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 40,
  },
  retryBtnText: { color: colors.white, fontSize: 17, fontWeight: '700' },
  mockBanner: {
    backgroundColor: '#FFF3CD',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#FECF67',
  },
  mockBannerText: { fontSize: 13, color: '#7A5C00', lineHeight: 18, fontWeight: '500' },
  transcriptionCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
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
  cardMeta: {
    fontSize: 12,
    color: colors.textLight,
    marginBottom: 8,
  },
  transcriptionText: { fontSize: 15, color: colors.textMid, lineHeight: 22 },
  postCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    padding: 16,
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
  postCardHint: { fontSize: 12, color: colors.orange, fontWeight: '500' },
  postInput: {
    fontSize: 16,
    color: colors.textDark,
    lineHeight: 24,
    minHeight: 160,
    padding: 0,
  },
  postInputLong: {
    minHeight: 320,
  },
  metaCount: { marginTop: 10, fontSize: 12, color: colors.textLight, textAlign: 'right' },
  footer: {
    padding: 20,
    paddingBottom: 24,
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
