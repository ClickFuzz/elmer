import * as ImagePicker from 'expo-image-picker';
import { Audio } from 'expo-av';
import React, { useState, useRef, useEffect } from 'react';
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../constants/colors';
import { GeneratePayload, PhotoItem } from '../App';

const MAX_PHOTOS = 5;

type Props = {
  onGenerate: (data: GeneratePayload) => void;
};

export default function HomeScreen({ onGenerate }: Props) {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isPlayingBack, setIsPlayingBack] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      soundRef.current?.unloadAsync();
    };
  }, []);

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
            setPhotos(prev => [...prev, { uri: result.assets[0].uri }].slice(0, MAX_PHOTOS));
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
          });
          if (!result.canceled) {
            const newPhotos = result.assets.map(a => ({ uri: a.uri }));
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

  const startRecording = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission required', 'Microphone access is needed to record audio.');
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }

      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recordingRef.current = rec;
      setIsRecording(true);
      setAudioUri(null);
      setRecordingSeconds(0);

      timerRef.current = setInterval(() => {
        setRecordingSeconds(s => s + 1);
      }, 1000);
    } catch (err) {
      console.error('Failed to start recording', err);
      Alert.alert('Error', 'Could not start recording. Please try again.');
    }
  };

  const stopRecording = async () => {
    if (!recordingRef.current) return;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      setIsRecording(false);
      setAudioUri(uri ?? null);
    } catch (err) {
      console.error('Failed to stop recording', err);
      setIsRecording(false);
    }
  };

  const playback = async () => {
    if (!audioUri) return;
    try {
      if (isPlayingBack && soundRef.current) {
        await soundRef.current.stopAsync();
        setIsPlayingBack(false);
        return;
      }
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri: audioUri },
        { shouldPlay: true },
        (status) => {
          if (status.isLoaded && status.didJustFinish) {
            setIsPlayingBack(false);
          }
        }
      );
      soundRef.current = sound;
      setIsPlayingBack(true);
    } catch (err) {
      console.error('Playback failed', err);
      Alert.alert('Error', 'Could not play recording.');
    }
  };

  const formatSeconds = (s: number) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  const canGenerate = audioUri !== null || photos.length > 0;

  const handleGenerate = () => {
    if (!canGenerate) {
      Alert.alert('Nothing to generate', 'Add at least one photo or record a description.');
      return;
    }
    onGenerate({ photos, audioUri });
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.logo}>Elmer</Text>
        <Text style={styles.tagline}>You do the work. Elmer spreads the word.</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Prompt */}
        <Text style={styles.sectionPrompt}>Finished a job?</Text>

        {/* Photos Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>Job Photos</Text>
            <Text style={styles.sectionCount}>{photos.length}/{MAX_PHOTOS}</Text>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoRow}>
            {photos.map((photo, index) => (
              <View key={index} style={styles.photoThumb}>
                <Image source={{ uri: photo.uri }} style={styles.photoImage} />
                <TouchableOpacity
                  style={styles.photoRemove}
                  onPress={() => removePhoto(index)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.photoRemoveText}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}

            {photos.length < MAX_PHOTOS && (
              <TouchableOpacity style={styles.addPhotoBtn} onPress={addPhotos} activeOpacity={0.7}>
                <Text style={styles.addPhotoBtnIcon}>+</Text>
                <Text style={styles.addPhotoBtnLabel}>
                  {photos.length === 0 ? 'Add Photo' : 'Add More'}
                </Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </View>

        {/* Audio Section */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Voice Description</Text>
          <Text style={styles.sectionHint}>
            Describe the job in ~15 seconds — what you did, where, any details.
          </Text>

          <View style={styles.recordRow}>
            {/* Record / Stop button */}
            <Pressable
              style={[styles.recordBtn, isRecording && styles.recordBtnActive]}
              onPress={isRecording ? stopRecording : startRecording}
            >
              <View style={[styles.recordDot, isRecording && styles.recordDotActive]} />
              <Text style={styles.recordBtnText}>
                {isRecording
                  ? `Stop  ${formatSeconds(recordingSeconds)}`
                  : audioUri
                  ? 'Re-record'
                  : 'Record'}
              </Text>
            </Pressable>

            {/* Playback button */}
            {audioUri && !isRecording && (
              <TouchableOpacity
                style={styles.playBtn}
                onPress={playback}
                activeOpacity={0.7}
              >
                <Text style={styles.playBtnText}>
                  {isPlayingBack ? '⏹ Stop' : '▶ Play'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {audioUri && !isRecording && (
            <Text style={styles.recordedNote}>
              Recording saved · {formatSeconds(recordingSeconds)}
            </Text>
          )}
        </View>
      </ScrollView>

      {/* Generate Button */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.generateBtn, !canGenerate && styles.generateBtnDisabled]}
          onPress={handleGenerate}
          activeOpacity={0.8}
        >
          <Text style={styles.generateBtnText}>Generate Post</Text>
        </TouchableOpacity>
      </View>
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
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 24,
    alignItems: 'center',
  },
  logo: {
    fontSize: 38,
    fontWeight: '800',
    color: colors.cream,
    letterSpacing: 1,
  },
  tagline: {
    fontSize: 13,
    color: colors.orange,
    marginTop: 4,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 20,
  },
  sectionPrompt: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.textDark,
    marginBottom: 24,
  },
  section: {
    backgroundColor: colors.white,
    borderRadius: 16,
    padding: 18,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  sectionLabel: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.textDark,
  },
  sectionCount: {
    fontSize: 14,
    color: colors.textLight,
    fontWeight: '600',
  },
  sectionHint: {
    fontSize: 14,
    color: colors.textMid,
    marginBottom: 16,
    lineHeight: 20,
  },
  photoRow: {
    flexDirection: 'row',
  },
  photoThumb: {
    width: 90,
    height: 90,
    borderRadius: 10,
    marginRight: 10,
    overflow: 'hidden',
    position: 'relative',
  },
  photoImage: {
    width: '100%',
    height: '100%',
  },
  photoRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 10,
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoRemoveText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '700',
  },
  addPhotoBtn: {
    width: 90,
    height: 90,
    borderRadius: 10,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cream,
  },
  addPhotoBtnIcon: {
    fontSize: 28,
    color: colors.textLight,
    lineHeight: 32,
  },
  addPhotoBtnLabel: {
    fontSize: 11,
    color: colors.textLight,
    marginTop: 2,
    fontWeight: '600',
  },
  recordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  recordBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.navy,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 24,
    flex: 1,
    gap: 10,
  },
  recordBtnActive: {
    backgroundColor: colors.danger,
  },
  recordDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.danger,
  },
  recordDotActive: {
    backgroundColor: colors.white,
  },
  recordBtnText: {
    color: colors.white,
    fontSize: 17,
    fontWeight: '700',
  },
  playBtn: {
    backgroundColor: colors.creamDark,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 18,
  },
  playBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textDark,
  },
  recordedNote: {
    marginTop: 10,
    fontSize: 13,
    color: colors.success,
    fontWeight: '600',
  },
  footer: {
    padding: 20,
    paddingBottom: 24,
    backgroundColor: colors.cream,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  generateBtn: {
    backgroundColor: colors.orange,
    borderRadius: 16,
    paddingVertical: 20,
    alignItems: 'center',
    shadowColor: colors.orange,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  generateBtnDisabled: {
    backgroundColor: colors.border,
    shadowOpacity: 0,
  },
  generateBtnText: {
    color: colors.white,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
});
