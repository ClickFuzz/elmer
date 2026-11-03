// Dynamic app configuration — production is identical to app.json.
// When APP_VARIANT=staging (set in eas.json staging profile and staging OTA workflow):
//   name             → "Elmer Staging"   (distinguishable on home screen)
//   bundleIdentifier → com.clickfuzz.elmer.staging  (coexists with production on device)
//   scheme           → "elmer-staging"   (handles elmer-staging:// deep links)
//
// The separate scheme is required so that OAuth callbacks from the staging server
// (which sets FACEBOOK_OAUTH_RETURN_SCHEME=elmer-staging / GOOGLE_OAUTH_RETURN_SCHEME=elmer-staging)
// route exclusively to the staging app and do not accidentally open the production app.
const IS_STAGING = process.env.APP_VARIANT === 'staging';

module.exports = ({ config }) => ({
  ...config,
  name: IS_STAGING ? 'Elmer Staging' : config.name,
  scheme: IS_STAGING ? 'elmer-staging' : config.scheme,
  ios: {
    ...config.ios,
    bundleIdentifier: IS_STAGING
      ? 'com.clickfuzz.elmer.staging'
      : config.ios.bundleIdentifier,
  },
});
