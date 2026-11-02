import { useUpdates } from 'expo-updates';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const IS_STAGING = process.env.EXPO_PUBLIC_APP_SCHEME === 'elmer-staging';

function OtaBadgeInner() {
  const { currentlyRunning } = useUpdates();
  const insets = useSafeAreaInsets();

  const label = currentlyRunning.isEmbeddedLaunch
    ? 'EMBEDDED'
    : `OTA ${(currentlyRunning.updateId ?? '???????').slice(0, 7)}`;

  return (
    <View
      pointerEvents="none"
      style={[styles.badge, { top: insets.top + 6, right: insets.right + 8 }]}
    >
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

export default function OtaBadge() {
  if (!IS_STAGING) return null;
  return <OtaBadgeInner />;
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    zIndex: 9999,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  text: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
});
