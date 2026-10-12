import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';
import { colors } from './constants/colors';
import HomeScreen from './screens/HomeScreen';
import ResultScreen from './screens/ResultScreen';
import SettingsScreen from './screens/SettingsScreen';

export type PhotoClassification = 'General' | 'Before' | 'After' | 'Team';

export type PhotoItem = {
  uri: string;
  classification: PhotoClassification;
};

export type GeneratePayload = {
  photos: PhotoItem[];
  audioUri: string | null;
};

export type HomeState = {
  photos: PhotoItem[];
  audioUri: string | null;
};

export type AppScreen = 'home' | 'result' | 'settings';

export default function App() {
  const [screen, setScreen] = useState<AppScreen>('home');
  const [payload, setPayload] = useState<GeneratePayload | null>(null);
  // Preserved so HomeScreen restores its state after back navigation
  const [savedHomeState, setSavedHomeState] = useState<HomeState | null>(null);

  const handleGenerate = (data: GeneratePayload) => {
    setSavedHomeState({ photos: data.photos, audioUri: data.audioUri });
    setPayload(data);
    setScreen('result');
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      {screen === 'home' && (
        <HomeScreen
          onGenerate={handleGenerate}
          onShowSettings={() => setScreen('settings')}
          initialState={savedHomeState}
        />
      )}
      {screen === 'result' && payload && (
        <ResultScreen payload={payload} onBack={() => setScreen('home')} />
      )}
      {screen === 'settings' && (
        <SettingsScreen onBack={() => setScreen('home')} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.navy,
  },
});
