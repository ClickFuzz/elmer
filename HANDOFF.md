# HANDOFF

## Goal
Complete real Apple sandbox subscription purchase against Railway staging, then merge staging → main.

## Current Problem
Build 23 (staging-testflight profile) is in TestFlight pending install and testing. No code changes needed — purely a testing step. Install, sign in, subscribe, verify unlock.

## Proven Facts
- **TestFlight build 23**: bundle `com.clickfuzz.elmer`, v1.0.0, submitted 6:09 PM Nov 6
- **API**: build connects to `https://api-staging.getelmer.com` (not production)
- **RC SDK key**: `appl_qiMBWYvElXNhKitKwqFWXExCYsq` baked into the build env
- **Railway staging RC vars**: `REVENUECAT_SECRET_KEY` and `REVENUECAT_WEBHOOK_SECRET` live (verified: webhook returns 401 without token; verify-purchase returns 401 not 503)
- **EAS submission**: `e701288d-1e8b-411a-a4dc-547affeab019`, status: finished
- **react-native-purchases**: pinned at `10.16.0` — `PurchasesHybridCommon 20.4.0` (required by 11.0.1) was not published to CocoaPods CDN or git specs during the Nov 2–6 RevenueCat disruption; `19.17.0` used by 10.16.0 is unaffected; API is fully compatible

## Ruled Out
- `withGitPodSource` plugin: cloned the git specs repo successfully, pod still not found — 20.4.0 genuinely unpublished
- `podInstallCommand: "pod install --repo-update"`: no effect on EAS (agents have no local git specs repo)
- `com.clickfuzz.elmer.staging` internal distribution build: cannot be submitted to TestFlight (no ASC app for that bundle ID)

## Changed (staging — 12 commits ahead of main)
- `services/purchases.ts` (NEW) — RC SDK wrapper: configure, purchase, restore, logIn/logOut
- `screens/SubscriptionScreen.tsx` — native StoreKit purchase flow, `verifyPurchaseWithServer()` fast path, provider-aware manage (Apple→Account Settings, Google→Play, Stripe→Portal), Restore Purchases button, IAP disclosure text; Stripe AppState listener removed
- `App.tsx` — `initPurchases()` on startup, `switchPurchasesUser()` after sign-in, `logOutPurchases()` on sign-out
- `eas.json` — `staging-testflight` build + submit profiles added; `EXPO_PUBLIC_RC_API_KEY_IOS` in staging env; `react-native-purchases` pinned to `10.16.0`
- `server/routes/billing.js` — `provider` field in `/billing/subscription` response
- `docs/ARCHITECTURE.md` — Phase 14 (RevenueCat) fully documented
- `server/.env.example` — `REVENUECAT_SECRET_KEY`, `REVENUECAT_WEBHOOK_SECRET` added
- `app.json` — `expo-build-properties` plugin added (kept; harmless)

## Exact Next Step
1. Install build 23 from TestFlight on device
2. Sign in to Elmer account (connects to `api-staging.getelmer.com`)
3. Tap Subscribe → Apple sandbox purchase sheet → complete with sandbox Apple ID
4. Verify app unlocks within seconds (`rc-verify-purchase` polls RC immediately after purchase)
5. RC webhook fires asynchronously — check Railway staging logs if needed
6. If purchase test passes → merge `staging` → `main`

## Do Not Repeat
- Do not re-investigate the CocoaPods disruption or add pod workarounds
- Do not use the `staging` profile (internal distribution, `com.clickfuzz.elmer.staging`) for purchase testing — wrong bundle ID
- `com.clickfuzz.elmer.staging` has no App Store Connect entry — cannot go to TestFlight

## Relevant Files
- `services/purchases.ts` — `purchaseSubscription()`, `restorePurchases()`, `initPurchases()`
- `screens/SubscriptionScreen.tsx` — `handleStartTrial()`, `verifyPurchaseWithServer()`, `pollForActivation()`
- `App.tsx` — RC lifecycle (search `initPurchases`)
- `server/routes/billing.js:986` — `POST /billing/rc-webhook`
- `server/routes/billing.js:1009` — `POST /billing/rc-verify-purchase`
- `eas.json` — `staging-testflight` profile

## Post-Test Upgrade
After Nov 6 CocoaPods disruption clears, upgrade react-native-purchases back to latest 11.x:
```bash
npx expo install react-native-purchases@latest
npx tsc --noEmit
# build new staging-testflight build to confirm, then production
```

## Git State
- Branch: `staging`, 12 commits ahead of `main`
- Working tree: clean
- Last commit: `fd73554` — Add staging-testflight EAS profile
- **Do not merge to main until sandbox purchase test passes**

## MERGE STATUS: INCOMPLETE — staging contains unmerged RC integration; merge after sandbox test passes.
