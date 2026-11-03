// Feature flags derived from build-time env vars.
// Values are inlined by Metro at bundle time — changing them requires a new build or OTA update.
//
// INSTAGRAM_ENABLED:
//   Staging:    EXPO_PUBLIC_INSTAGRAM_ENABLED=true  (set in eas.json staging profile)
//   Production: not set → false (Instagram publishing pending Meta approval)
export const INSTAGRAM_ENABLED =
  process.env.EXPO_PUBLIC_INSTAGRAM_ENABLED === 'true';
