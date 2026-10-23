import { requireNativeModule, NativeModule } from 'expo-modules-core';

// The native module is only available on iOS real devices.
// Simulators and Android will not have this module — callers must handle null.
interface ExpoDeviceCheckInterface extends NativeModule {
  generateTokenAsync(): Promise<string>;
}

let _module: ExpoDeviceCheckInterface | null = null;
try {
  _module = requireNativeModule<ExpoDeviceCheckInterface>('ExpoDeviceCheck');
} catch {
  // Module not available (Android, simulator, or development host).
  _module = null;
}

/**
 * Generate a single-use Apple DeviceCheck token (iOS only).
 * Returns null on Android, iOS simulators, or when DeviceCheck is unavailable.
 * The token is valid for approximately 5 minutes and must be sent to the
 * Elmer backend within that window.
 */
export async function generateDeviceCheckToken(): Promise<string | null> {
  if (!_module) return null;
  try {
    return await _module.generateTokenAsync();
  } catch {
    // Fail silently — DeviceCheck unavailability must never block the user.
    return null;
  }
}
