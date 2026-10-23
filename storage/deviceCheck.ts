import { Platform } from 'react-native';
import { generateDeviceCheckToken as _generateToken } from 'expo-device-check';

/**
 * Returns a fresh Apple DeviceCheck token for this iOS device, or null.
 *
 * Returns null when:
 *  - Running on Android (Play Integrity Device Recall not yet implemented)
 *  - Running on an iOS simulator (DCDevice.isSupported = false)
 *  - DeviceCheck token generation fails for any reason
 *
 * The server enforces the same free-publication limits via the PostgreSQL
 * account-level system regardless of whether a device token is present.
 * A null return value is never an error — the server fails-open for missing tokens.
 */
export async function getDeviceCheckToken(): Promise<string | null> {
  if (Platform.OS !== 'ios') return null;
  try {
    return await _generateToken();
  } catch {
    return null;
  }
}
