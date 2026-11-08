# HANDOFF

## Goal

Complete Google Play internal testing of Android RevenueCat billing. Upload the signed AAB to Google Play Console and run an end-to-end purchase/restore test on a real Android device.

## Current Problem

Build is complete and committed. No code blockers remain. The AAB has not yet been uploaded to Google Play Console or tested on device.

## Proven Facts

- `react-native-purchases@10.16.0` supports Google Play base plans/offers (uses GPBL v5+). No SDK upgrade needed.
- `staging-google-play` EAS profile builds with package `com.clickfuzz.elmer` (no `APP_VARIANT` set → `app.config.js` uses production values).
- `EXPO_PUBLIC_RC_API_KEY_ANDROID=goog_pwUUWIOHItSpOgrtZROpFiIJnjM` added to `staging-google-play` env in `eas.json` and committed (`5d68bff`).
- Signed AAB built successfully: versionCode 3, keystore `8E6K3E1KGm`.
- Server already handles `PLAY_STORE` → `google` provider mapping in `/billing/rc-verify-purchase` and `/billing/rc-webhook`.
- `SubscriptionScreen.tsx` already shows Google Play trial disclosure text on Android and opens the Google Play subscriptions URL for `provider === 'google'` in Manage Subscription.
- Staging API (`https://api-staging.getelmer.com`) is live with `REVENUECAT_SECRET_KEY` and `REVENUECAT_WEBHOOK_SECRET` set.
- **Previous iOS work**: TestFlight build 23 (`com.clickfuzz.elmer`) submitted Nov 6; sandbox Apple purchase test still pending.

## Ruled Out

- Package name mismatch (`com.clickfuzz.elmer.staging`) — not an issue; `staging-google-play` omits `APP_VARIANT`.
- Preview API mode on Android — resolved by adding the RC Android key.
- SDK incompatibility with base plans — SDK v10.16.0 supports them natively.

## Changed (staging — 14 commits ahead of main)

- `eas.json` — `EXPO_PUBLIC_RC_API_KEY_ANDROID` added to `staging-google-play` env. Committed `5d68bff`.
- All prior RC integration changes from `fd73554` through `5d68bff` (services/purchases.ts, SubscriptionScreen.tsx, App.tsx, etc.) — see PASSDOWN for full list.

## Production / Deployment State

- AAB artifact: https://expo.dev/artifacts/eas/V1UkbYeUrAP8UuUt4sqctvg7fTlOem_Hm1whRphGiIU.aab
- Build dashboard: https://expo.dev/accounts/clickfuzz-team/projects/elmer/builds/d0531a6d-9071-4614-98dd-9f6462480f7c
- Not yet uploaded to Google Play Console. Not yet installed or tested on Android.
- TestFlight build 23 still in TestFlight; iOS sandbox test also still pending.

## Exact Next Step

Upload the AAB to Google Play Console → `com.clickfuzz.elmer` → Internal testing track → Create new release → upload AAB → add test accounts → publish internal track.

Then: install via internal testing link on Android device, sign in, tap Subscribe, verify 14-day trial offer appears (product `com.clickfuzz.elmer.monthly:monthly`, offer `free-trial-14-day`), complete purchase, verify server grants `hasAccess = true`.

## Do Not Repeat

- RC SDK version audit — confirmed v10.16.0 is compatible with base plans.
- Package name verification — confirmed `com.clickfuzz.elmer` for `staging-google-play`.
- Server PLAY_STORE handler check — already implemented.

## Relevant Files

- `eas.json` — `staging-google-play` profile (key now set)
- `services/purchases.ts` — `initPurchases`, `purchaseSubscription`, `restorePurchases`
- `screens/SubscriptionScreen.tsx` — `handleStartTrial`, `verifyPurchaseWithServer`, `handleManageSubscription`
- `server/routes/billing.js` — `/billing/rc-verify-purchase` (line 1009), `/billing/rc-webhook` (line 986)

## Git State

- Branch: `staging`, 14 commits ahead of `main`
- HEAD: `5d68bff` — Add EXPO_PUBLIC_RC_API_KEY_ANDROID to staging-google-play EAS profile
- Working tree: clean
- **Do not merge to main until both Android purchase test AND iOS sandbox test pass**

## MERGE STATUS: INCOMPLETE — staging contains unmerged RC integration (iOS + Android); merge after both purchase tests pass.
