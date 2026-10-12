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

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';

type Props = {
  payload: GeneratePayload;
  onBack: () => void;
};

type State =
  | { status: 'loading' }
  | { status: 'success'; post: string; transcription: string; isMock: boolean }
  | { status: 'error'; message: string };

export default function ResultScreen({ payload, onBack }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [editedPost, setEditedPost] = useState('');
  const hasFetched = useRef(false);

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    generatePost();
  }, []);

  const generatePost = async () => {
    setState({ status: 'loading' });
    try {
      const formData = new FormData();
      formData.append('photoCount', String(payload.photos.length));

      if (payload.audioUri) {
        const filename = payload.audioUri.split('/').pop() ?? 'recording.m4a';
        formData.append('audio', {
          uri: payload.audioUri,
          type: 'audio/m4a',
          name: filename,
        } as unknown as Blob);
      }

      const response = await fetch(`${API_URL}/api/generate`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Server error ${response.status}: ${text}`);
      }

      const data = await response.json();
      setState({
        status: 'success',
        post: data.post,
        transcription: data.transcription ?? '',
        isMock: data.mock === true,
      });
      setEditedPost(data.post);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setState({ status: 'error', message });
    }
  };

  const copyToClipboard = () => {
    Clipboard.setString(editedPost);
    Alert.alert('Copied!', 'Post copied to clipboard.');
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Your Post</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {state.status === 'loading' && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.orange} />
            <Text style={styles.loadingText}>Generating your post…</Text>
            <Text style={styles.loadingSubtext}>Transcribing audio and writing copy.</Text>
          </View>
        )}

        {state.status === 'error' && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorIcon}>⚠️</Text>
            <Text style={styles.errorTitle}>Something went wrong</Text>
            <Text style={styles.errorMessage}>{state.message}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={generatePost} activeOpacity={0.8}>
              <Text style={styles.retryBtnText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        )}

        {state.status === 'success' && (
          <>
            {state.isMock && (
              <View style={styles.mockBanner}>
                <Text style={styles.mockBannerText}>
                  ⚠️  MOCK RESPONSE — AI server not connected. Set OPENAI_API_KEY in server/.env to enable real generation.
                </Text>
              </View>
            )}

            {state.transcription !== '' && (
              <View style={styles.transcriptionCard}>
                <Text style={styles.transcriptionLabel}>What you said</Text>
                <Text style={styles.transcriptionText}>{state.transcription}</Text>
              </View>
            )}

            <View style={styles.postCard}>
              <View style={styles.postCardHeader}>
                <Text style={styles.postCardLabel}>Generated Post</Text>
                <Text style={styles.postCardHint}>Tap to edit</Text>
              </View>
              <TextInput
                style={styles.postInput}
                value={editedPost}
                onChangeText={setEditedPost}
                multiline
                textAlignVertical="top"
                autoCorrect
                scrollEnabled={false}
              />
              <Text style={styles.charCount}>{editedPost.length} characters</Text>
            </View>
          </>
        )}
      </ScrollView>

      {/* Footer actions */}
      {state.status === 'success' && (
        <View style={styles.footer}>
          <TouchableOpacity style={styles.copyBtn} onPress={copyToClipboard} activeOpacity={0.8}>
            <Text style={styles.copyBtnText}>Copy Post</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.retrySmallBtn} onPress={() => { hasFetched.current = false; generatePost(); }} activeOpacity={0.8}>
            <Text style={styles.retrySmallText}>Regenerate</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.cream,
  },
  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 20,
  },
  backBtn: {
    width: 80,
  },
  backBtnText: {
    color: colors.cream,
    fontSize: 16,
    fontWeight: '600',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.cream,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 32,
  },
  loadingContainer: {
    marginTop: 60,
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 20,
    fontSize: 20,
    fontWeight: '700',
    color: colors.textDark,
  },
  loadingSubtext: {
    marginTop: 8,
    fontSize: 14,
    color: colors.textLight,
  },
  errorContainer: {
    marginTop: 40,
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  errorIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  errorTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.textDark,
    marginBottom: 10,
  },
  errorMessage: {
    fontSize: 14,
    color: colors.textMid,
    textAlign: 'center',
    marginBottom: 28,
    lineHeight: 20,
  },
  retryBtn: {
    backgroundColor: colors.orange,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 40,
  },
  retryBtnText: {
    color: colors.white,
    fontSize: 17,
    fontWeight: '700',
  },
  mockBanner: {
    backgroundColor: '#FFF3CD',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#FECF67',
  },
  mockBannerText: {
    fontSize: 13,
    color: '#7A5C00',
    lineHeight: 18,
    fontWeight: '500',
  },
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
  transcriptionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textLight,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  transcriptionText: {
    fontSize: 15,
    color: colors.textMid,
    lineHeight: 22,
  },
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
    alignItems: 'center',
    marginBottom: 12,
  },
  postCardLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textLight,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  postCardHint: {
    fontSize: 12,
    color: colors.orange,
    fontWeight: '500',
  },
  postInput: {
    fontSize: 16,
    color: colors.textDark,
    lineHeight: 24,
    minHeight: 160,
    padding: 0,
  },
  charCount: {
    marginTop: 10,
    fontSize: 12,
    color: colors.textLight,
    textAlign: 'right',
  },
  footer: {
    flexDirection: 'row',
    padding: 20,
    paddingBottom: 24,
    gap: 12,
    backgroundColor: colors.cream,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  copyBtn: {
    flex: 1,
    backgroundColor: colors.orange,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    shadowColor: colors.orange,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 3,
  },
  copyBtnText: {
    color: colors.white,
    fontSize: 17,
    fontWeight: '700',
  },
  retrySmallBtn: {
    backgroundColor: colors.creamDark,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  retrySmallText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textDark,
  },
});
