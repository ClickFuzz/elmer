import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import {
  useAudioRecorder,
  useAudioRecorderState,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  createAudioPlayer,
  RecordingPresets,
} from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import React, { useState, useRef, useEffect } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../constants/colors';
import { savePendingHomeState } from '../storage/database';
import type { GeneratePayload, HomeState, PhotoClassification, PhotoItem } from '../App';

const MAX_PHOTOS = 5;

function extractGpsFromExif(exif: Record<string, unknown> | null | undefined): { lat: number; lng: number } | undefined {
  if (!exif) return undefined;
  // iOS stores GPS under '{GPS}' namespace; Android may use root-level keys
  const ns = (exif['{GPS}'] as Record<string, unknown>) ?? exif;
  const rawLat = (ns['GPSLatitude'] ?? ns['Latitude']) as number | undefined;
  const rawLng = (ns['GPSLongitude'] ?? ns['Longitude']) as number | undefined;
  const latRef = (ns['GPSLatitudeRef'] ?? ns['LatitudeRef']) as string | undefined;
  const lngRef = (ns['GPSLongitudeRef'] ?? ns['LongitudeRef']) as string | undefined;
  if (typeof rawLat !== 'number' || typeof rawLng !== 'number' || isNaN(rawLat) || isNaN(rawLng)) return undefined;
  return {
    lat: latRef === 'S' ? -rawLat : rawLat,
    lng: lngRef === 'W' ? -rawLng : rawLng,
  };
}

const CLASSIFICATIONS: PhotoClassification[] = ['General', 'Before', 'After', 'Team'];

const CLASSIFICATION_COLORS: Record<PhotoClassification, string> = {
  General: 'rgba(21,29,50,0.88)',
  Before: 'rgba(160,80,0,0.88)',
  After: 'rgba(20,100,65,0.88)',
  Team: 'rgba(13,40,100,0.88)',
};

type Props = {
  onGenerate: (data: GeneratePayload) => void;
  initialState: HomeState | null;
};

export default function HomeScreen({ onGenerate, initialState }: Props) {
  // useState initializer runs on each mount — restores state after back navigation
  const [photos, setPhotos] = useState<PhotoItem[]>(initialState?.photos ?? []);
  const [audioUri, setAudioUri] = useState<string | null>(initialState?.audioUri ?? null);
  const [isPlayingBack, setIsPlayingBack] = useState(false);
  const playerRef = useRef<AudioPlayer | null>(null);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  // Prevents expo-audio's persisted recorder.uri from falsely showing "Recording saved"
  // on fresh app open. Set to true only when the user actually starts a recording.
  const hasRecordedThisSession = useRef(false);
  // Tracks the last recorder.uri we already copied/processed to avoid duplicate work.
  const lastProcessedRecorderUri = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      playerRef.current?.remove();
    };
  }, []);

  useEffect(() => {
    if (!hasRecordedThisSession.current) return;
    if (!recorderState.isRecording && recorder.uri && recorder.uri !== lastProcessedRecorderUri.current) {
      lastProcessedRecorderUri.current = recorder.uri;
      // Copy to document dir so the URI survives app restarts
      (async () => {
        let uri = recorder.uri!;
        try {
          const dest = `${FileSystem.documentDirectory}elmer_pending_audio_${Date.now()}.m4a`;
          await FileSystem.copyAsync({ from: uri, to: dest });
          uri = dest;
        } catch { /* use original path */ }
        setAudioUri(uri);
      })();
    }
  }, [recorderState.isRecording, recorder.uri]);

  // Persist photos + audio so state survives app restarts
  useEffect(() => {
    savePendingHomeState({ photos, audioUri }).catch(() => {});
  }, [photos, audioUri]);

  const clearAll = () => {
    setPhotos([]);
    setAudioUri(null);
    if (playerRef.current) {
      playerRef.current.pause();
      playerRef.current.remove();
      playerRef.current = null;
      setIsPlayingBack(false);
    }
  };

  // ─── Photos ──────────────────────────────────────────────────────────────

  const addPhotos = async () => {
    const remaining = MAX_PHOTOS - photos.length;
    if (remaining <= 0) {
      Alert.alert('Photo limit', `You can add up to ${MAX_PHOTOS} photos.`);
      return;
    }

    Alert.alert('Add Photos', 'Choose a source', [
      {
        text: 'Camera',
        onPress: async () => {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) {
            Alert.alert('Permission required', 'Camera access is needed to take photos.');
            return;
          }
          const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
          if (!result.canceled && result.assets.length > 0) {
            setPhotos(prev =>
              [...prev, {
                uri: result.assets[0].uri,
                classification: 'General' as const,
              }].slice(0, MAX_PHOTOS)
            );
          }
        },
      },
      {
        text: 'Photo Library',
        onPress: async () => {
          const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!perm.granted) {
            Alert.alert('Permission required', 'Photo library access is needed.');
            return;
          }
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsMultipleSelection: true,
            selectionLimit: remaining,
            quality: 0.8,
            exif: true,
          });
          if (!result.canceled) {
            const newPhotos: PhotoItem[] = result.assets.map(a => ({
              uri: a.uri,
              classification: 'General' as const,
              gps: extractGpsFromExif(a.exif as Record<string, unknown> | null),
            }));
            setPhotos(prev => [...prev, ...newPhotos].slice(0, MAX_PHOTOS));
          }
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const removePhoto = (index: number) => {
    setPhotos(prev => prev.filter((_, i) => i !== index));
  };

  const changeClassification = (index: number) => {
    const current = photos[index].classification;
    const apply = (c: PhotoClassification) => {
      setPhotos(prev => prev.map((p, i) => (i === index ? { ...p, classification: c } : p)));
    };

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: 'Photo Type',
          options: [...CLASSIFICATIONS, 'Cancel'],
          cancelButtonIndex: CLASSIFICATIONS.length,
          destructiveButtonIndex: undefined,
          message: 'How should this photo be labelled in your post?',
        },
        (buttonIndex) => {
          if (buttonIndex < CLASSIFICATIONS.length) {
            apply(CLASSIFICATIONS[buttonIndex]);
          }
        }
      );
    } else {
      Alert.alert(
        'Photo Type',
        'How should this photo be labelled?',
        CLASSIFICATIONS.map(c => ({
          text: c === current ? `${c} ✓` : c,
          onPress: () => apply(c),
        })).concat([{ text: 'Cancel', onPress: () => {} }])
      );
    }
  };

  // ─── Audio ───────────────────────────────────────────────────────────────

  const startRecording = async () => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission required', 'Microphone access is needed to record audio.');
        return;
      }

      if (playerRef.current) {
        playerRef.current.pause();
        playerRef.current.remove();
        playerRef.current = null;
        setIsPlayingBack(false);
      }

      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      hasRecordedThisSession.current = true;
      setAudioUri(null);
    } catch (err) {
      console.error('Failed to start recording', err);
      Alert.alert('Error', 'Could not start recording. Please try again.');
    }
  };

  const stopRecording = async () => {
    try {
      await recorder.stop();
    } catch (err) {
      console.error('Failed to stop recording', err);
    }
  };

  const togglePlayback = async () => {
    if (!audioUri) return;
    try {
      if (isPlayingBack && playerRef.current) {
        playerRef.current.pause();
        setIsPlayingBack(false);
        return;
      }

      if (playerRef.current) {
        playerRef.current.remove();
        playerRef.current = null;
      }

      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const player = createAudioPlayer({ uri: audioUri });
      playerRef.current = player;

      player.addListener('playbackStatusUpdate', (status: { didJustFinish?: boolean }) => {
        if (status.didJustFinish) {
          setIsPlayingBack(false);
        }
      });

      player.play();
      setIsPlayingBack(true);
    } catch (err) {
      console.error('Playback failed', err);
      Alert.alert('Error', 'Could not play recording.');
    }
  };

  const formatSeconds = (s: number) => {
    const secs = Math.floor(s);
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const sec = (secs % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  const isRecording = recorderState.isRecording;
  const recordingDuration = recorderState.durationMillis ? recorderState.durationMillis / 1000 : 0;
  const canGenerate = audioUri !== null || photos.length > 0 || isRecording;

  const handleGenerate = async () => {
    let finalAudioUri = audioUri;

    if (isRecording) {
      try {
        await recorder.stop();
        finalAudioUri = recorder.uri;
      } catch (err) {
        console.error('Failed to stop recording before generate', err);
      }
    }

    if (!finalAudioUri && photos.length === 0) {
      Alert.alert('Nothing to generate', 'Add at least one photo or record a description.');
      return;
    }

    // Copy audio from temp cache to document directory so it survives until upload
    if (finalAudioUri) {
      try {
        const dest = `${FileSystem.documentDirectory}elmer_recording_${Date.now()}.m4a`;
        await FileSystem.copyAsync({ from: finalAudioUri, to: dest });
        finalAudioUri = dest;
      } catch (err) {
        console.error('Failed to copy audio to permanent storage', err);
      }
    }

    const hasBefore = photos.some(p => p.classification === 'Before');
    const hasAfter  = photos.some(p => p.classification === 'After');
    if ((hasBefore && !hasAfter) || (!hasBefore && hasAfter)) {
      const present = hasBefore ? 'Before' : 'After';
      const missing = hasBefore ? 'After' : 'Before';
      const capturedUri = finalAudioUri;
      Alert.alert(
        `No "${missing}" photo`,
        `You tagged a photo as "${present}" but didn't add a matching "${missing}" photo. Go back to fix the tags, or continue — the photos will be used as general photos.`,
        [
          { text: 'Go Back', style: 'cancel' },
          { text: 'Continue', onPress: () => onGenerate({ photos, audioUri: capturedUri }) },
        ]
      );
      return;
    }

    onGenerate({ photos, audioUri: finalAudioUri });
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.logoRow}>
          <Text style={styles.logoText}>elmer</Text>
          <Text style={styles.logoPeriod}>.</Text>
        </View>
        <Text style={styles.headline}>Turn great work into growth.</Text>
        <Text style={styles.subheadline}>Take a minute to spread the word</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Photos */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionIconWrap}>
              <Ionicons name="camera" size={18} color={colors.cyan} />
            </View>
            <View style={styles.sectionLabelGroup}>
              <Text style={styles.sectionLabel}>Job Photos</Text>
              <Text style={styles.sectionSubLabel}>Add up to {MAX_PHOTOS}</Text>
            </View>
            <View style={styles.sectionCountWrap}>
              {(photos.length > 0 || !!audioUri) && (
                <TouchableOpacity onPress={clearAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={styles.clearAllBtn}>Clear All</Text>
                </TouchableOpacity>
              )}
              <Text style={styles.sectionCount}>{photos.length}/{MAX_PHOTOS}</Text>
            </View>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoRow}>
            {photos.map((photo, index) => (
              <View key={index} style={styles.photoItem}>
                <TouchableOpacity
                  style={styles.photoThumb}
                  onPress={() => changeClassification(index)}
                  activeOpacity={0.85}
                >
                  <Image source={{ uri: photo.uri }} style={styles.photoImage} />
                  {/* Classification badge */}
                  <View style={[styles.classBadge, { backgroundColor: CLASSIFICATION_COLORS[photo.classification] }]}>
                    <Text style={styles.classBadgeText}>{photo.classification}</Text>
                  </View>
                  {/* Remove button */}
                  <TouchableOpacity
                    style={styles.photoRemove}
                    onPress={() => removePhoto(index)}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    <Text style={styles.photoRemoveText}>✕</Text>
                  </TouchableOpacity>
                </TouchableOpacity>
              </View>
            ))}

            {photos.length < MAX_PHOTOS && (
              <TouchableOpacity style={styles.addPhotoBtn} onPress={addPhotos} activeOpacity={0.7}>
                <Ionicons name="add" size={28} color={colors.textMuted} />
                <Text style={styles.addPhotoBtnLabel}>
                  {photos.length === 0 ? 'Add Photo' : 'Add More'}
                </Text>
              </TouchableOpacity>
            )}
          </ScrollView>

          {photos.length > 0 && (
            <Text style={styles.classHint}>Tap a photo to change its label</Text>
          )}
        </View>

        {/* Audio */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionIconWrap}>
              <Ionicons name="mic" size={18} color={colors.cyan} />
            </View>
            <View style={styles.sectionLabelGroup}>
              <Text style={styles.sectionLabel}>Voice Description</Text>
              <Text style={styles.sectionSubLabel}>Explain the details about this job</Text>
            </View>
          </View>

          <View style={styles.recordRow}>
            <Pressable
              style={[styles.recordBtn, isRecording && styles.recordBtnActive]}
              onPress={isRecording ? stopRecording : startRecording}
            >
              <View style={[styles.recordDot, isRecording && styles.recordDotActive]} />
              <Text style={[styles.recordBtnText, isRecording && styles.recordBtnTextActive]}>
                {isRecording
                  ? `Stop  ${formatSeconds(recordingDuration)}`
                  : audioUri
                  ? 'Re-record'
                  : 'Record'}
              </Text>
            </Pressable>

            {audioUri && !isRecording && (
              <TouchableOpacity style={styles.playBtn} onPress={togglePlayback} activeOpacity={0.7}>
                <Text style={styles.playBtnText}>{isPlayingBack ? '⏹ Stop' : '▶ Play'}</Text>
              </TouchableOpacity>
            )}
          </View>

          {audioUri && !isRecording && (
            <Text style={styles.recordedNote}>✓ Recording saved</Text>
          )}
        </View>
      </ScrollView>

      {/* Generate Preview */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.generateBtn, !canGenerate && styles.generateBtnDisabled]}
          onPress={handleGenerate}
          activeOpacity={0.8}
        >
          <Text style={[styles.generateBtnText, !canGenerate && styles.generateBtnTextDisabled]}>
            Generate Preview
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    backgroundColor: colors.bg,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  logoRow: { flexDirection: 'row', alignItems: 'baseline' },
  logoText: { fontSize: 42, fontFamily: 'DMSans_700Bold', color: colors.textPrimary, letterSpacing: -1 },
  logoPeriod: { fontSize: 42, fontFamily: 'DMSans_700Bold', color: colors.cyan, letterSpacing: -1 },
  headline: { fontSize: 24, fontFamily: 'DMSans_600SemiBold', color: colors.textPrimary, marginTop: 10, lineHeight: 30 },
  subheadline: { fontSize: 15, fontFamily: 'Inter_400Regular', color: colors.textSecondary, marginTop: 4 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 20 },
  section: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  sectionIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 9,
    backgroundColor: 'rgba(83,219,243,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  sectionLabelGroup: { flex: 1 },
  sectionLabel: { fontSize: 17, fontFamily: 'DMSans_600SemiBold', color: colors.textPrimary },
  sectionSubLabel: { fontSize: 12, fontFamily: 'Inter_400Regular', color: colors.textMuted, marginTop: 1 },
  sectionCount: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  photoRow: { flexDirection: 'row' },
  photoItem: { marginRight: 10 },
  photoThumb: {
    width: 90,
    height: 90,
    borderRadius: 10,
    overflow: 'hidden',
    position: 'relative',
  },
  photoImage: { width: '100%', height: '100%' },
  classBadge: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingVertical: 4,
    alignItems: 'center',
  },
  classBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  photoRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 10,
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoRemoveText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  addPhotoBtn: {
    width: 90,
    height: 90,
    borderRadius: 10,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    gap: 2,
  },
  addPhotoBtnLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  classHint: { marginTop: 10, fontSize: 12, color: colors.textMuted },
  recordRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  recordBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 16,
    paddingHorizontal: 24,
    flex: 1,
    gap: 10,
  },
  recordBtnActive: {
    backgroundColor: colors.error,
    borderColor: colors.error,
  },
  recordDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.error },
  recordDotActive: { backgroundColor: '#fff' },
  recordBtnText: { color: colors.textSecondary, fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  recordBtnTextActive: { color: '#fff' },
  playBtn: {
    backgroundColor: colors.bg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 16,
    paddingHorizontal: 18,
  },
  playBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: colors.textSecondary },
  recordedNote: { marginTop: 10, fontSize: 13, color: colors.success, fontWeight: '600' },
  footer: {
    padding: 20,
    paddingBottom: 24,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  generateBtn: {
    backgroundColor: colors.cyan,
    borderRadius: 16,
    paddingVertical: 20,
    alignItems: 'center',
  },
  generateBtnDisabled: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  generateBtnText: {
    color: colors.bg,
    fontSize: 18,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.2,
  },
  generateBtnTextDisabled: { color: colors.textMuted },
  sectionCountWrap: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  clearAllBtn: { fontSize: 12, fontFamily: 'Inter_500Medium', color: colors.textMuted },
});
