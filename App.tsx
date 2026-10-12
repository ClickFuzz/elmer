import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';
import { colors } from './constants/colors';
import HomeScreen from './screens/HomeScreen';
import ResultScreen from './screens/ResultScreen';

export type PhotoItem = {
  uri: string;
};

export type GeneratePayload = {
  photos: PhotoItem[];
  audioUri: string | null;
};

export type AppScreen = 'home' | 'result';

export default function App() {
  const [screen, setScreen] = useState<AppScreen>('home');
  const [payload, setPayload] = useState<GeneratePayload | null>(null);

  const handleGenerate = (data: GeneratePayload) => {
    setPayload(data);
    setScreen('result');
  };

  const handleBack = () => {
    setScreen('home');
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      {screen === 'home' && (
        <HomeScreen onGenerate={handleGenerate} />
      )}
      {screen === 'result' && payload && (
        <ResultScreen payload={payload} onBack={handleBack} />
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
