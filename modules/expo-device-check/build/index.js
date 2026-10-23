"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateDeviceCheckToken = generateDeviceCheckToken;
const expo_modules_core_1 = require("expo-modules-core");
let _module = null;
try {
    _module = (0, expo_modules_core_1.requireNativeModule)('ExpoDeviceCheck');
}
catch (_a) {
    // Module not available (Android, simulator, or development host).
    _module = null;
}
/**
 * Generate a single-use Apple DeviceCheck token (iOS only).
 * Returns null on Android, iOS simulators, or when DeviceCheck is unavailable.
 * The token is valid for approximately 5 minutes and must be sent to the
 * Elmer backend within that window.
 */
async function generateDeviceCheckToken() {
    if (!_module)
        return null;
    try {
        return await _module.generateTokenAsync();
    }
    catch (_a) {
        // Fail silently — DeviceCheck unavailability must never block the user.
        return null;
    }
}
