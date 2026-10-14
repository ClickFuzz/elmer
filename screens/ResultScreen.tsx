import * as FileSystem from 'expo-file-system/legacy';
import React, { useState, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../constants/colors';
import { GeneratePayload, PhotoClassification } from '../App';
import {
  saveJob,
  getBusinessProfile,
  getConnectedChannels,
  fetchServerConnectedChannels,
  ConnectedChannel,
  SeoMetadata,
  getSessionToken,
  getActiveFacebookPage,
} from '../storage/database';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

function raceTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out. Check your connection and try again.')), TIMEOUT_MS)
    ),
  ]);
}

type Props = {
  payload: GeneratePayload;
  onBack: () => void;
  onShowSettings: () => void;
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

const BADGE_COLORS: Record<PhotoClassification, string> = {
  General: '#28344B',
  Before: '#5C3200',
  After: '#0D5C3A',
  Team: '#0D2E6B',
};

type PublishState =
  | { status: 'idle' }
  | { status: 'publishing' }
  | { status: 'success'; postUrl: string }
  | { status: 'error'; message: string };

export default function ResultScreen({ payload, onBack, onShowSettings }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [editedSocial, setEditedSocial] = useState('');
  const [editedWordpress, setEditedWordpress] = useState('');
  const [editedLocation, setEditedLocation] = useState('');
  const [showWebArticle, setShowWebArticle] = useState(false);
  const [showSeo, setShowSeo] = useState(false);
  const [connectedChannels, setConnectedChannels] = useState<ConnectedChannel[]>([]);
  const [copiedItem, setCopiedItem] = useState<'social' | 'web' | null>(null);
  const [publishState, setPublishState] = useState<PublishState>({ status: 'idle' });
  const [savedJobId, setSavedJobId] = useState<number | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isGenerating = useRef(false);
  // Google post is generated server-side and saved to DB but not surfaced in this UI
  const googlePostRef = useRef('');

  const generate = async () => {
    if (isGenerating.current) return;
    isGenerating.current = true;
    setState({ status: 'loading' });

    // Load channels — prefer server-side (real OAuth connections) when signed in
    let channels: ConnectedChannel[] = [];
    try {
      const token = await getSessionToken();
      if (token) {
        channels = await fetchServerConnectedChannels(token, API_URL);
      }
      if (channels.length === 0) channels = await getConnectedChannels();
      setConnectedChannels(channels);
    } catch { /* ignore */ }

    // Only generate content for connected platforms; social post is always included
    const platforms = [
      'social',
      ...(channels.some(ch => ch.platform === 'google')    ? ['google']    : []),
      ...(channels.some(ch => ch.platform === 'wordpress') ? ['wordpress'] : []),
    ];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const classifications = payload.photos.map(p => p.classification);
        const gpsCoords = payload.photos
          .map(p => p.gps)
          .filter((g): g is { lat: number; lng: number } => g != null);

        const profile = await getBusinessProfile();
        const effectiveCategory = profile.category === 'Other' ? profile.categoryCustom : profile.category;

        let data: any;

        if (payload.audioUri) {
          const result = await raceTimeout(FileSystem.uploadAsync(
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
                gpsCoords: JSON.stringify(gpsCoords),
                businessName: profile.name,
                businessWebsite: profile.website,
                businessCategory: effectiveCategory,
                businessDescription: profile.description,
                writingStyle: profile.writingStyle,
                businessServices: JSON.stringify(profile.services),
                serviceAreas: JSON.stringify(profile.serviceAreas),
                platforms: JSON.stringify(platforms),
              },
            }
          ));
          if (result.status < 200 || result.status >= 300) {
            throw new Error(`Server error ${result.status}: ${result.body}`);
          }
          data = JSON.parse(result.body);
        } else {
          const response = await raceTimeout(fetch(`${API_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              photoCount: payload.photos.length,
              classifications,
              gpsCoords,
              businessName: profile.name,
              businessWebsite: profile.website,
              businessCategory: effectiveCategory,
              businessDescription: profile.description,
              writingStyle: profile.writingStyle,
              businessServices: profile.services,
              serviceAreas: profile.serviceAreas,
              platforms,
            }),
          }));
          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Server error ${response.status}: ${text}`);
          }
          data = await response.json();
        }

        // Location resolution: transcription → GPS reverse geocode → business location
        let loc = data.location ? `${data.location.city}, ${data.location.state}` : '';
        if (!loc && profile.location) loc = profile.location;

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
        googlePostRef.current = data.googlePost ?? '';
        setEditedSocial(data.socialPost ?? '');
        setEditedWordpress(data.webContent ?? '');
        setEditedLocation(loc);

        saveJob({
          audioSourceUri: payload.audioUri,
          transcription: data.transcription ?? '',
          googlePost: googlePostRef.current,
          socialPost: data.socialPost ?? '',
          webContent: data.webContent ?? '',
          location: loc,
          seoMetadata: data.seoMetadata ?? null,
          isMock: data.mock === true,
          photos: payload.photos.map(p => ({ uri: p.uri, classification: p.classification })),
        }).then(jobId => setSavedJobId(jobId)).catch(err => console.warn('DB save failed:', err));

        break; // success — exit retry loop

      } catch (err: unknown) {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 2000));
          // continue to next attempt
        } else {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          setState({ status: 'error', message: msg });
        }
      }
    }

    isGenerating.current = false;
  };

  useEffect(() => {
    generate();
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const copyItem = (item: 'social' | 'web') => {
    Clipboard.setString(item === 'social' ? editedSocial : editedWordpress);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    setCopiedItem(item);
    copiedTimerRef.current = setTimeout(() => setCopiedItem(null), 2000);
  };

  const publishToFacebook = async (sessionToken: string) => {
    const activePage = await getActiveFacebookPage();
    if (!activePage) {
      Alert.alert(
        'No Facebook page selected',
        'Go to Settings → Connected Accounts and select a Facebook page.',
        [{ text: 'Open Settings', onPress: onShowSettings }, { text: 'Cancel', style: 'cancel' }]
      );
      return;
    }

    const jobId = savedJobId != null ? String(savedJobId) : `tmp_${Date.now()}`;

    const formData = new FormData();
    formData.append('message', editedSocial);
    formData.append('platform_id', String(activePage.id));
    formData.append('job_id', jobId);

    payload.photos.forEach((photo, i) => {
      formData.append(`photo_${i}`, {
        uri: photo.uri,
        type: 'image/jpeg',
        name: `photo_${i}.jpg`,
      } as unknown as Blob);
    });

    setPublishState({ status: 'publishing' });

    try {
      const res = await raceTimeout(fetch(`${API_URL}/facebook/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
        body: formData,
      }));

      const data = await res.json();

      if (!res.ok) {
        const errMsg = data.error ?? `Server error ${res.status}`;
        setPublishState({ status: 'error', message: errMsg });
        return;
      }

      setPublishState({ status: 'success', postUrl: data.postUrl ?? '' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Publishing failed';
      setPublishState({ status: 'error', message: msg });
    }
  };

  const handlePostEverywhere = async () => {
    if (connectedChannels.length === 0) {
      Alert.alert(
        'No channels connected',
        'Connect your publishing accounts in Settings to post directly from Elmer.',
        [
          { text: 'Open Settings', onPress: onShowSettings },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return;
    }

    const token = await getSessionToken();
    if (!token) {
      Alert.alert(
        'Sign in required',
        'Sign in to your Elmer account in Settings to publish.',
        [
          { text: 'Open Settings', onPress: onShowSettings },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return;
    }

    const hasFacebook = connectedChannels.some(ch => ch.platform === 'facebook');
    const channelList = connectedChannels.map(ch => ch.accountName).join(', ');

    Alert.alert(
      'Publish?',
      `Post to: ${channelList}`,
      [
        { text: 'Post', onPress: () => {
          if (hasFacebook) publishToFacebook(token);
        }},
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  const wordCount = (text: string) =>
    text.trim() === '' ? 0 : text.trim().split(/\s+/).length;

  const hasConnections = connectedChannels.length > 0;
  const hasWordpress = connectedChannels.some(ch => ch.platform === 'wordpress');

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
        <Text style={styles.headerTitle}>Ready to post!</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Loading */}
        {state.status === 'loading' && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.cyan} />
            <Text style={styles.loadingText}>Generating your content…</Text>
            <Text style={styles.loadingSubtext}>
              Transcribing your recording and writing your post.{'\n'}This usually takes about 15 seconds.
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
                  MOCK — Set OPENAI_API_KEY in server/.env for real AI generation.
                </Text>
              </View>
            )}

            {/* Job summary: photos + location */}
            <View style={styles.summaryCard}>
              {payload.photos.length > 0 && (
                <View style={styles.photoStrip}>
                  {payload.photos.map((photo, i) => (
                    <View key={i} style={styles.photoThumb}>
                      <Image source={{ uri: photo.uri }} style={styles.photoImg} />
                      <View style={[styles.photoBadge, { backgroundColor: BADGE_COLORS[photo.classification] }]}>
                        <Text style={styles.photoBadgeText}>{photo.classification}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
              <View style={[styles.locationRow, payload.photos.length > 0 && styles.locationRowBorder]}>
                <Text style={styles.locationLabel}>Location</Text>
                <TextInput
                  style={styles.locationInput}
                  value={editedLocation}
                  onChangeText={setEditedLocation}
                  placeholder="City, State"
                  placeholderTextColor={colors.textMuted}
                  autoCorrect={false}
                  returnKeyType="done"
                />
                {!editedLocation && (
                  <Text style={styles.locationNotDetected}>Not detected</Text>
                )}
              </View>
            </View>

            {/* Primary post */}
            <View style={styles.postCard}>
              <View style={styles.postCardHeader}>
                <Text style={styles.cardLabel}>Your post</Text>
                <Text style={styles.editHint}>Tap to edit</Text>
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
              <View style={styles.postCardFooter}>
                <Text style={styles.metaCount}>{editedSocial.length} characters</Text>
                <TouchableOpacity
                  onPress={() => copyItem('social')}
                  hitSlop={{ top: 8, bottom: 8, left: 12, right: 4 }}
                >
                  <Text style={styles.copyInline}>
                    {copiedItem === 'social' ? '✓ Copied!' : 'Copy'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Where Elmer will post */}
            <View style={styles.destinationsCard}>
              <Text style={styles.destinationsTitle}>Where Elmer will post</Text>

              {hasConnections ? (
                connectedChannels.map((ch, i) => (
                  <View key={ch.id}>
                    {i > 0 && <View style={styles.divider} />}
                    <View style={styles.destinationRow}>
                      <View>
                        <Text style={styles.destinationName}>{ch.accountName}</Text>
                        <Text style={styles.destinationSub}>{platformLabel(ch.platform)}</Text>
                      </View>
                      <View style={styles.connectedChip}>
                        <Text style={styles.connectedChipText}>Connected</Text>
                      </View>
                    </View>
                  </View>
                ))
              ) : (
                <View style={styles.noChannels}>
                  <Text style={styles.noChannelsText}>No channels connected yet.</Text>
                  <TouchableOpacity
                    style={styles.connectBtn}
                    onPress={onShowSettings}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.connectBtnText}>Connect Channels</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            {/* Website article — only shown when WordPress is connected */}
            {hasWordpress && <View style={styles.articleCard}>
              <View style={styles.articleHeader}>
                <View>
                  <Text style={styles.cardLabel}>Website article</Text>
                  <Text style={styles.articleMeta}>{wordCount(editedWordpress)} words · WordPress</Text>
                </View>
                <TouchableOpacity
                  onPress={() => setShowWebArticle(v => !v)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.previewToggle}>
                    {showWebArticle ? 'Hide ▲' : 'Preview ▼'}
                  </Text>
                </TouchableOpacity>
              </View>

              {showWebArticle && (
                <View style={styles.articleBody}>
                  <TextInput
                    style={styles.webInput}
                    value={editedWordpress}
                    onChangeText={setEditedWordpress}
                    multiline
                    textAlignVertical="top"
                    autoCorrect
                    scrollEnabled={false}
                  />
                  <View style={styles.postCardFooter}>
                    <Text style={styles.metaCount}>{wordCount(editedWordpress)} words</Text>
                    <TouchableOpacity
                      onPress={() => copyItem('web')}
                      hitSlop={{ top: 8, bottom: 8, left: 12, right: 4 }}
                    >
                      <Text style={styles.copyInline}>
                        {copiedItem === 'web' ? '✓ Copied!' : 'Copy Article'}
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {state.seoMetadata && (
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
                </View>
              )}
            </View>}
          </>
        )}
      </ScrollView>

      {/* Footer */}
      {state.status === 'success' && (
        <View style={styles.footer}>
          {/* Publish status feedback */}
          {publishState.status === 'publishing' && (
            <View style={styles.publishingBanner}>
              <ActivityIndicator color={colors.cyan} size="small" />
              <Text style={styles.publishingText}>Publishing to Facebook…</Text>
            </View>
          )}
          {publishState.status === 'success' && (
            <View style={styles.publishSuccessBanner}>
              <Text style={styles.publishSuccessText}>Posted to Facebook!</Text>
              {publishState.postUrl ? (
                <Text style={styles.publishSuccessUrl} numberOfLines={1}>{publishState.postUrl}</Text>
              ) : null}
            </View>
          )}
          {publishState.status === 'error' && (
            <View style={styles.publishErrorBanner}>
              <Text style={styles.publishErrorText}>{publishState.message}</Text>
              <TouchableOpacity onPress={() => setPublishState({ status: 'idle' })} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.publishErrorDismiss}>Dismiss</Text>
              </TouchableOpacity>
            </View>
          )}

          <TouchableOpacity
            style={[
              styles.postEverywhereBtn,
              (!hasConnections || publishState.status === 'publishing') && styles.postEverywhereBtnDim,
            ]}
            onPress={handlePostEverywhere}
            disabled={publishState.status === 'publishing'}
            activeOpacity={0.8}
          >
            <Text style={styles.postEverywhereBtnText}>Post Everywhere</Text>
            {!hasConnections && (
              <Text style={styles.postEverywhereSubtext}>Connect channels in Settings</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.regenBtn} onPress={generate} activeOpacity={0.8}>
            <Text style={styles.regenBtnText}>Regenerate</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function platformLabel(platform: ConnectedChannel['platform']): string {
  const labels: Record<ConnectedChannel['platform'], string> = {
    google: 'Google Business Profile',
    facebook: 'Facebook Pages',
    instagram: 'Instagram',
    twitter: 'X (Twitter)',
    wordpress: 'WordPress',
  };
  return labels[platform];
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
  label: { fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 },
  value: { fontSize: 14, color: colors.textPrimary, lineHeight: 20 },
  mono: { fontFamily: 'Courier', fontSize: 13, color: colors.cyan },
});

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

  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 32 },

  loadingContainer: { marginTop: 60, alignItems: 'center' },
  loadingText: { marginTop: 20, fontSize: 20, fontFamily: 'DMSans_600SemiBold', color: colors.textPrimary },
  loadingSubtext: { marginTop: 8, fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },

  errorContainer: { marginTop: 40, alignItems: 'center', paddingHorizontal: 20 },
  errorIcon: { fontSize: 48, marginBottom: 16 },
  errorTitle: { fontSize: 22, fontFamily: 'DMSans_600SemiBold', color: colors.error, marginBottom: 10 },
  errorMessage: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: 28, lineHeight: 20 },
  retryBtn: { backgroundColor: colors.cyan, borderRadius: 14, paddingVertical: 16, paddingHorizontal: 40 },
  retryBtnText: { color: colors.bg, fontSize: 17, fontFamily: 'Inter_600SemiBold' },

  mockBanner: {
    backgroundColor: 'rgba(200,160,40,0.12)',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(200,160,40,0.25)',
  },
  mockBannerText: { fontSize: 13, color: '#C8A040', lineHeight: 18, fontWeight: '500' },

  // Job summary card
  summaryCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    marginBottom: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  photoStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    padding: 12,
    paddingBottom: 10,
  },
  photoThumb: { position: 'relative' },
  photoImg: { width: 68, height: 68, borderRadius: 8 },
  photoBadge: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
    paddingVertical: 2,
    alignItems: 'center',
  },
  photoBadgeText: { fontSize: 9, fontWeight: '700', color: '#fff', letterSpacing: 0.3 },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  locationRowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  locationLabel: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  locationInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    padding: 0,
  },
  locationNotDetected: { fontSize: 13, color: colors.textMuted, fontStyle: 'italic' },

  // Primary post card
  postCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  postCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  editHint: { fontSize: 12, color: colors.textMuted, fontWeight: '500' },
  postInput: {
    fontSize: 15,
    color: colors.textPrimary,
    lineHeight: 23,
    minHeight: 150,
    padding: 0,
  },
  postCardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  metaCount: { fontSize: 11, color: colors.textMuted },
  copyInline: { fontSize: 13, fontWeight: '700', color: colors.cyan },

  // Destinations card
  destinationsCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    marginBottom: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    paddingBottom: 4,
  },
  destinationsTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  destinationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  destinationName: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, marginBottom: 2 },
  destinationSub: { fontSize: 12, color: colors.textMuted },
  connectedChip: {
    backgroundColor: 'rgba(82,214,164,0.15)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  connectedChipText: { fontSize: 11, fontWeight: '700', color: colors.success },
  noChannels: {
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 12,
  },
  noChannelsText: { fontSize: 14, color: colors.textSecondary },
  connectBtn: {
    backgroundColor: colors.cyan,
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 28,
  },
  connectBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: colors.bg },
  divider: { height: 1, backgroundColor: colors.border, marginHorizontal: 16 },

  // Website article card
  articleCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    marginBottom: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  articleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  articleMeta: { fontSize: 12, color: colors.textMuted, marginTop: 3 },
  previewToggle: { fontSize: 13, fontWeight: '700', color: colors.cyan },
  articleBody: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: 16,
  },
  webInput: {
    fontSize: 14,
    color: colors.textPrimary,
    lineHeight: 22,
    minHeight: 200,
    padding: 0,
  },

  // SEO card
  seoCard: {
    backgroundColor: colors.bg,
    borderRadius: 10,
    overflow: 'hidden',
    marginTop: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  seoHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
  },
  seoHeaderTitle: { fontSize: 13, fontFamily: 'DMSans_600SemiBold', color: colors.textPrimary },
  seoHeaderChevron: { fontSize: 11, color: colors.textMuted },
  seoBody: {
    paddingHorizontal: 12,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 12,
  },
  seoFieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: {
    backgroundColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  tagText: { fontSize: 12, color: colors.textSecondary, fontWeight: '500' },
  imageRow: { marginBottom: 8 },
  imageFilename: { fontSize: 13, fontFamily: 'Courier', color: colors.cyan },
  imageAlt: { fontSize: 12, color: colors.textSecondary, marginTop: 2, lineHeight: 17 },

  // Footer
  footer: {
    padding: 16,
    paddingBottom: 20,
    gap: 10,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },

  publishingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(82,214,164,0.08)',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: 'rgba(82,214,164,0.2)',
  },
  publishingText: { fontSize: 14, color: colors.success, fontWeight: '500' },

  publishSuccessBanner: {
    backgroundColor: 'rgba(82,214,164,0.08)',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: 'rgba(82,214,164,0.2)',
  },
  publishSuccessText: { fontSize: 14, color: colors.success, fontWeight: '600' },
  publishSuccessUrl: { fontSize: 11, color: colors.textMuted, marginTop: 3 },

  publishErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(255,80,80,0.08)',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,80,80,0.25)',
  },
  publishErrorText: { flex: 1, fontSize: 13, color: colors.error, lineHeight: 18 },
  publishErrorDismiss: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  postEverywhereBtn: {
    backgroundColor: colors.cyan,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
  },
  postEverywhereBtnDim: { opacity: 0.4 },
  postEverywhereBtnText: { color: colors.bg, fontSize: 19, fontFamily: 'Inter_600SemiBold' },
  postEverywhereSubtext: { color: colors.bg, fontSize: 12, fontWeight: '500', marginTop: 3, opacity: 0.7 },
  regenBtn: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    alignItems: 'center',
  },
  regenBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: colors.textSecondary },
});
