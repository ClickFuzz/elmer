'use strict';

// Returns a validated OAuth return scheme.
// Accepts the client-requested scheme only if it appears in ALLOWED_OAUTH_RETURN_SCHEMES.
// Falls back to the platform-specific env var default when the requested scheme is absent or
// not in the allowlist — preserving backward compatibility with existing deployments.
function resolveReturnScheme(requested, envFallback = 'elmer') {
  const allowed = new Set(
    (process.env.ALLOWED_OAUTH_RETURN_SCHEMES ?? 'elmer')
      .split(',').map(s => s.trim()).filter(Boolean)
  );
  if (requested && typeof requested === 'string' && allowed.has(requested)) {
    return requested;
  }
  return envFallback;
}

// Sends an OAuth redirect response as an HTML page with a JavaScript navigation.
// On Android, Chrome Custom Tabs do not fire Android Intents for server-side HTTP 302
// redirects to custom URL schemes (e.g. elmer://). A JavaScript-initiated navigation
// (window.location.replace) is reliably dispatched as an Intent by Chrome on both
// Android and iOS, completing the openAuthSessionAsync flow correctly.
function sendOAuthRedirect(res, url) {
  const safeUrl = url.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const jsUrl = JSON.stringify(url);
  res.set('Content-Type', 'text/html; charset=utf-8').send(
    `<!DOCTYPE html><html><head><title>Connecting...</title>` +
    `<meta http-equiv="refresh" content="0;url=${safeUrl}">` +
    `</head><body>` +
    `<script>window.location.replace(${jsUrl});</script>` +
    `</body></html>`
  );
}

module.exports = { resolveReturnScheme, sendOAuthRedirect };
