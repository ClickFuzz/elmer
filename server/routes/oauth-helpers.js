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

module.exports = { resolveReturnScheme };
