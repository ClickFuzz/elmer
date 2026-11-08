# HANDOFF

## Goal

Two parallel work items on staging:
1. Android registration fix (committed, needs EAS build + test)
2. Android RevenueCat billing test (AAB built, needs Google Play upload + purchase test)

## Current Problem (Registration Fix)

Diagnosed and fixed. Root cause: `SecureStore.setItemAsync` on Android 15 emulators throws
when the Keystore is unavailable (no hardware backing or no device lock screen). The old
single `catch` block treated every post-registration exception as a network error, showing
"Could not reach the server" after a successful server-side account creation.

Fix committed `5e1bd4d` — not yet EAS-built or tested on device.

## Proven Facts

- Server creates the account on the first attempt (second attempt returns 409 "email exists")
- The error was thrown by `setSession → SecureStore.setItemAsync` AFTER a successful 201 response
- `setSession` now falls back to SQLite when SecureStore throws — `setSession` no longer throws
- `handleAuth` now has separate catch blocks: network errors vs. local storage errors
- If registration returns 409, `handleAuth` auto-retries as login (recovers lost-response scenario)
- RC Android RC key: `EXPO_PUBLIC_RC_API_KEY_ANDROID=goog_pwUUWIOHItSpOgrtZROpFiIJnjM`
- Server handles PLAY_STORE → `google` provider in rc-verify-purchase and rc-webhook

## Ruled Out

- Network connectivity issue (second attempt reaches server and gets 409)
- Server not creating the account (confirmed by 409 on retry)
- TLS/certificate issue (second fetch succeeds)

## Changed (staging — 15 commits ahead of main)

- `screens/SignInScreen.tsx` — split try/catch; network error vs. storage error; 409 auto-login
- `storage/database.ts` — `setSession`, `getSessionToken`, `clearSession` all handle SecureStore failures

## Production / Deployment State

- Registration fix: committed `5e1bd4d`, not yet built or deployed
- RC Android AAB (versionCode 3): https://expo.dev/artifacts/eas/V1UkbYeUrAP8UuUt4sqctvg7fTlOem_Hm1whRphGiIU.aab
  - Not yet uploaded to Google Play Console
- TestFlight build 23 still in TestFlight; iOS sandbox purchase test still pending

## Exact Next Step

1. **For registration fix**: Run `bunx eas-cli build --profile staging-google-play --platform android`
   then test registration on Android 15 emulator.

2. **For RC Android**: Upload existing AAB (versionCode 3) to Google Play Console →
   Internal testing → install → sign in → subscribe → verify server grants hasAccess.

## Do Not Repeat

- RC SDK version audit — confirmed v10.16.0 compatible with base plans
- Package name verification — confirmed `com.clickfuzz.elmer` for staging-google-play
- Server PLAY_STORE handler check — already implemented
- Network connectivity investigation — confirmed issue is client-side storage, not network

## Relevant Files

- `screens/SignInScreen.tsx` — `handleAuth` (lines 27–88)
- `storage/database.ts` — `setSession`, `getSessionToken`, `clearSession` (lines ~213–280)
- `eas.json` — `staging-google-play` profile
- `services/purchases.ts` — `initPurchases`, `purchaseSubscription`, `restorePurchases`
- `screens/SubscriptionScreen.tsx` — `handleStartTrial`, `verifyPurchaseWithServer`

## Git State

- Branch: `staging`, 15 commits ahead of `main`
- HEAD: `5e1bd4d` — Fix Android registration showing false network error
- Working tree: clean
- **Do not merge to main until registration test + both iOS/Android purchase tests pass**

## MERGE STATUS: INCOMPLETE — staging contains unmerged RC integration + registration fix; merge after all tests pass.
