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

// Converts a custom-scheme URL (e.g. elmer://oauth/callback?foo=bar) to an Android
// intent:// URI (e.g. intent://oauth/callback?foo=bar#Intent;scheme=elmer;end).
// Chrome on Android always dispatches intent:// URIs as Intents, even without a user
// gesture — unlike custom scheme navigations which Chrome may silently block.
function toIntentUri(url) {
  const sep = url.indexOf('://');
  if (sep === -1) return url;
  const scheme = url.substring(0, sep);
  const rest   = url.substring(sep + 3);
  return `intent://${rest}#Intent;scheme=${encodeURIComponent(scheme)};end`;
}

// Sends an OAuth redirect response as an HTML page.
//
// Android: Chrome Custom Tabs may silently block window.location.replace(customScheme://)
// without a user gesture. We use intent:// URIs for the automatic redirect on Android
// (Chrome always dispatches these) and show a visible "Open Elmer" button as a
// user-gesture fallback for both platforms.
//
// iOS: ASWebAuthenticationSession intercepts all custom scheme navigations natively, so
// window.location.replace works directly there.
function sendOAuthRedirect(res, url) {
  const intentUrl = toIntentUri(url);
  const safeUrl   = url.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const jsUrl     = JSON.stringify(url);
  const jsIntent  = JSON.stringify(intentUrl);
  res.set('Content-Type', 'text/html; charset=utf-8').send(
    `<!DOCTYPE html><html><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Connecting...</title>` +
    `<style>*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;` +
    `display:flex;flex-direction:column;align-items:center;justify-content:center;` +
    `min-height:100vh;margin:0;background:#0f172a;color:#fff;text-align:center;padding:24px}` +
    `h1{font-size:20px;font-weight:600;margin:0 0 8px}` +
    `p{font-size:14px;color:#94a3b8;margin:0 0 32px}` +
    `a{display:inline-block;padding:14px 32px;font-size:16px;font-weight:600;` +
    `color:#0f172a;background:#fff;border-radius:12px;text-decoration:none}</style>` +
    `</head><body>` +
    `<h1>Connected!</h1><p>Return to Elmer to continue.</p>` +
    `<a href="${safeUrl}" id="btn">Open Elmer</a>` +
    `<script>` +
    `var url=${jsUrl};var intent=${jsIntent};` +
    `var android=/Android/.test(navigator.userAgent);` +
    `try{window.location.replace(android?intent:url);}catch(e){}` +
    `document.getElementById('btn').href=android?intent:url;` +
    `</script>` +
    `</body></html>`
  );
}

module.exports = { resolveReturnScheme, sendOAuthRedirect };
