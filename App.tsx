import { DMSans_600SemiBold, DMSans_700Bold } from '@expo-google-fonts/dm-sans';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';
import { Ionicons } from '@expo/vector-icons';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from './constants/colors';
import HistoryScreen from './screens/HistoryScreen';
import HomeScreen from './screens/HomeScreen';
import ResultScreen from './screens/ResultScreen';
import SettingsScreen from './screens/SettingsScreen';

export type PhotoClassification = 'General' | 'Before' | 'After' | 'Team';

export type PhotoItem = {
  uri: string;
  classification: PhotoClassification;
  gps?: { lat: number; lng: number };
};

export type GeneratePayload = {
  photos: PhotoItem[];
  audioUri: string | null;
};

export type HomeState = {
  photos: PhotoItem[];
  audioUri: string | null;
};

export type AppScreen = 'home' | 'result' | 'settings' | 'history';

type NavItemProps = {
  iconActive: React.ComponentProps<typeof Ionicons>['name'];
  iconInactive: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  active: boolean;
  onPress: () => void;
};

function NavItem({ iconActive, iconInactive, label, active, onPress }: NavItemProps) {
  return (
    <TouchableOpacity style={navStyles.item} onPress={onPress} activeOpacity={0.7}>
      <Ionicons name={active ? iconActive : iconInactive} size={24} color={active ? colors.cyan : colors.textMuted} />
      <Text style={[navStyles.label, active && navStyles.labelActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function AppShell() {
  const { bottom: bottomInset } = useSafeAreaInsets();
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
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />
      <View style={styles.content}>
        {screen === 'home' && (
          <HomeScreen
            onGenerate={handleGenerate}
            initialState={savedHomeState}
          />
        )}
        {screen === 'result' && payload && (
          <ResultScreen
            payload={payload}
            onBack={() => setScreen('home')}
            onShowSettings={() => setScreen('settings')}
          />
        )}
        {screen === 'settings' && (
          <SettingsScreen onBack={() => setScreen('home')} />
        )}
        {screen === 'history' && (
          <HistoryScreen onBack={() => setScreen('home')} />
        )}
      </View>
      <View style={[navStyles.bar, { paddingBottom: Math.max(bottomInset, 10) }]}>
        <NavItem
          iconActive="home"
          iconInactive="home-outline"
          label="Home"
          active={screen === 'home' || screen === 'result'}
          onPress={() => setScreen('home')}
        />
        <NavItem
          iconActive="time"
          iconInactive="time-outline"
          label="History"
          active={screen === 'history'}
          onPress={() => setScreen('history')}
        />
        <NavItem
          iconActive="settings-sharp"
          iconInactive="settings-outline"
          label="Settings"
          active={screen === 'settings'}
          onPress={() => setScreen('settings')}
        />
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({
    DMSans_700Bold,
    DMSans_600SemiBold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
  });

  if (!fontsLoaded) {
    return <SafeAreaProvider><View style={styles.root} /></SafeAreaProvider>;
  }

  return (
    <SafeAreaProvider>
      <AppShell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1 },
});

const navStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 10,
    paddingHorizontal: 8,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 2,
  },
  label: { fontSize: 11, fontFamily: 'Inter_500Medium', color: colors.textMuted },
  labelActive: { color: colors.cyan },
});
