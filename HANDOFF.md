# HANDOFF

## Goal

Upload Android AAB (versionCode 4) to Google Play Console for internal testing, then
run two device tests: (1) Android registration, (2) RevenueCat billing trial purchase.

## Current Problem

Nothing blocking — all code and build are ready. AAB not yet uploaded to Google Play Console.

## Proven Facts

- Android registration bug root cause: `SecureStore.setItemAsync` throws on Android 15
  emulators when Keystore is unavailable; old single catch block reported it as a network
  error after a successful server-side account creation.
- Fix committed `5e1bd4d`: `setSession` falls back to SQLite; `handleAuth` has separate
  network vs. storage catch blocks; 409 on register auto-retries as login.
- versionCode 4 AAB built from staging HEAD `56ecdf8`, keystore `8E6K3E1KGm`.
- RC Android key `goog_pwUUWIOHItSpOgrtZROpFiIJnjM` is in the build.
- Staging API (`https://api-staging.getelmer.com`) handles PLAY_STORE → `google` provider
  in `rc-verify-purchase` and `rc-webhook`.

## Ruled Out

- Network connectivity (second registration attempt reached server and got 409)
- Server not creating the account (confirmed by 409 on retry)
- TLS/certificate issue on Android (second fetch succeeds normally)

## Changed (staging — 16 commits ahead of main)

- `screens/SignInScreen.tsx` — split try/catch; network vs. storage errors; 409 auto-login
- `storage/database.ts` — `setSession`, `getSessionToken`, `clearSession` resilient to
  SecureStore failures (SQLite fallback)

## Production / Deployment State

- AAB versionCode 4:
  https://expo.dev/artifacts/eas/9ZaJkNs_arNqi9Bd_YFV_HISVXoOVqIn48HF7pJrKXc.aab
- Build dashboard:
  https://expo.dev/accounts/clickfuzz-team/projects/elmer/builds/247c402d-ee9b-4dee-b71b-dbb7c53194bf
- Not yet uploaded to Google Play Console. Not yet installed or tested on Android.
- TestFlight build 24 still in TestFlight; iOS sandbox purchase test also pending.

## Exact Next Step

1. Google Play Console → `com.clickfuzz.elmer` → Internal testing → Create new release
   → upload AAB → publish to internal track.
2. Install via internal testing link on Android 15 emulator/device.
3. Test registration: create new account → should succeed on first attempt.
4. Test billing: sign in → Subscribe → verify 14-day trial offer appears (product
   `com.clickfuzz.elmer.monthly:monthly`, offer `free-trial-14-day`) → complete purchase
   → verify `hasAccess = true`.

## Do Not Repeat

- RC SDK version audit — confirmed `10.16.0` compatible with base plans
- Package name verification — `com.clickfuzz.elmer` for `staging-google-play`
- Server PLAY_STORE handler check — already implemented
- Network connectivity investigation — confirmed client-side storage issue, not network

## Relevant Files

- `screens/SignInScreen.tsx` — `handleAuth` (lines 27–88)
- `storage/database.ts` — `setSession`, `getSessionToken`, `clearSession` (~213–280)
- `eas.json` — `staging-google-play` profile
- `services/purchases.ts` — `initPurchases`, `purchaseSubscription`, `restorePurchases`
- `screens/SubscriptionScreen.tsx` — `handleStartTrial`, `verifyPurchaseWithServer`
- `server/routes/billing.js` — `/billing/rc-verify-purchase`, `/billing/rc-webhook`

## Git State

- Branch: `staging`, 16 commits ahead of `main`
- HEAD: `56ecdf8` — Update HANDOFF with versionCode 4 AAB link
- Working tree: clean
- **Do not merge to main until registration test + both iOS/Android purchase tests pass**

## MERGE STATUS: INCOMPLETE — staging contains unmerged RC integration + registration fix; merge after all tests pass.
