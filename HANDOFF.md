# HANDOFF

## Goal
Fix Android Google OAuth callback — browser stays on loading screen instead of returning to Elmer.

## Current Problem
Stage 2 fix deployed (`bdf94e6`). Waiting for Railway staging deploy + Android retest.

The first fix (JS `window.location.replace`) was insufficient: Chrome Custom Tabs on Android may silently block custom scheme JS navigation without a user gesture. Stage 2 adds:
1. `intent://` URI for auto-redirect on Android (Chrome always dispatches these as Intents)
2. Visible "Open Elmer" button (user-gesture fallback)

## Proven Facts
- Chrome Custom Tabs on Android does NOT fire Android Intents for server-side HTTP 302 redirects to custom URL schemes (`elmer://`).
- `window.location.replace("elmer://...")` also silently blocked by Chrome on Android without user gesture.
- iOS works fine: `ASWebAuthenticationSession` intercepts all custom scheme navigations natively.
- Server confirms Google auth/token exchange/DB persistence works (user shows as Connected after manually closing Chrome).
- `staging-google-play` build (versionCode 4) uses `elmer` scheme natively and `EXPO_PUBLIC_APP_SCHEME` defaults to `'elmer'` — scheme is NOT `elmer-staging`.
- 564 tests pass locally.

## Ruled Out
- Android intent filters / app.json scheme config — correct (`elmer` scheme)
- Mobile app OAuth code — correct
- Server token exchange / callback logic — works
- New Android build requirement — not needed; fix is server-only
- Scheme mismatch — staging-google-play sends `returnScheme: 'elmer'` and server uses it correctly

## Changed Files
- `server/routes/oauth-helpers.js` — stage 1: `sendOAuthRedirect(res, url)` helper; stage 2: `toIntentUri()`, intent:// for Android, button

## Production / Deployment State
- `staging` branch: `bdf94e6` — pushed to origin, Railway deploying
- Existing Android install (versionCode 4 from Google Play internal testing) ready to test — no rebuild needed

## Exact Next Step
1. Wait for Railway staging deploy of `bdf94e6` (~2 min)
2. Confirm: `curl https://api-staging.getelmer.com/google/callback?error=test_check` returns HTML with `intent://` and button
3. Test Google OAuth on Android versionCode 4
4. If passes: also test Facebook, Instagram, Threads, WordPress OAuth on Android
5. After all passing: merge `staging` → `main`

## Do Not Repeat
- Do not investigate Android intent filters or app.json — already confirmed correct
- Do not look for more `res.redirect` calls — all 6 OAuth routes use `sendOAuthRedirect`
- Do not rebuild Android AAB — no mobile code changed

## Relevant Files / Functions
- `server/routes/oauth-helpers.js` — `sendOAuthRedirect(res, url)` + `toIntentUri(url)` (the core fix)
- `server/routes/google.js` — `GET /google/callback`

## Git State
- Branch: `staging`
- Latest commit: `bdf94e6` (pushed to origin)
- Working tree: clean
- Not yet merged to `main` — waiting for Android test
