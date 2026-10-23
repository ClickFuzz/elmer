/**
 * Generate a single-use Apple DeviceCheck token (iOS only).
 * Returns null on Android, iOS simulators, or when DeviceCheck is unavailable.
 * The token is valid for approximately 5 minutes and must be sent to the
 * Elmer backend within that window.
 */
export declare function generateDeviceCheckToken(): Promise<string | null>;
