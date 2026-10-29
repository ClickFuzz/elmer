// Dynamic app configuration — production is identical to app.json.
// When APP_VARIANT=staging (set in eas.json staging profile):
//   - App name changes to "Elmer Staging"
//   - Bundle ID changes to com.clickfuzz.elmer.staging
//   - Coexists with the production app on the same device
const IS_STAGING = process.env.APP_VARIANT === 'staging';

module.exports = ({ config }) => ({
  ...config,
  name: IS_STAGING ? 'Elmer Staging' : config.name,
  ios: {
    ...config.ios,
    bundleIdentifier: IS_STAGING
      ? 'com.clickfuzz.elmer.staging'
      : config.ios.bundleIdentifier,
  },
});
