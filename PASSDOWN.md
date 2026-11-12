# PASSDOWN — Elmer

> Durable project record. Updated after each significant milestone.
> For active unfinished tasks, see HANDOFF.md (created/deleted per session).

---

## Project Purpose

Elmer is a mobile publishing tool for contractors and businesses. After finishing a job, the user takes photos, records a voice description, and the app generates platform-ready posts for Facebook, Instagram, Threads, WordPress, and Google Business Profile. Currently in TestFlight.

---

## Milestone Status

| # | Milestone | Status |
|---|---|---|
| 0 | Initial prototype (photos, audio, AI generation, history) | COMPLETE |
| 1 | Backend auth, PostgreSQL, OAuth CSRF, platform management API | COMPLETE |
| 2 | Facebook + Instagram OAuth + publishing | COMPLETE |
| 3 | Threads OAuth + publishing; WordPress Application Password publishing | COMPLETE |
| 4 | Stripe billing ($19/month, 14-day trial, subscription gate) | COMPLETE |
| 5 | Google Business Profile OAuth + posting | COMPLETE |
| 10 | Production security (webhook dedup, content hashing, draft persistence, onboarding leakage fix) | COMPLETE |
| 11 | Multi-device sync, server-authoritative settings, test-mode DeviceCheck bypass | COMPLETE |
| — | GitHub Actions CI/CD pipeline (local EAS build → TestFlight) | COMPLETE |
| — | Manual OTA update checker in Settings (test-mode only) | COMPLETE |
| — | Meta compliance: deletion callbacks, V13 migration, SCHEMA_VERSION fix | COMPLETE |
| — | Staging environment: branch, EAS channel, `app.config.js`, workflows, docs, Railway live | COMPLETE |
| — | GBP 1-photo limit fix; Threads/Instagram SERVER_URL fallback hardening | COMPLETE |
| — | Fix staging Stripe checkout: `BILLING_RETURN_PREFIX` scheme-aware via `EXPO_PUBLIC_APP_SCHEME` | COMPLETE |
| — | Fix staging OTA workflow: remove `--environment preview`; add `EXPO_PUBLIC_APP_SCHEME` | COMPLETE — staging `19975be` |
| — | Staging OTA version badge (`OtaBadge`): shows loaded update ID or EMBEDDED; staging-only | COMPLETE — staging `19975be` |
| — | Production merge: staging → main (all platform integrations, UI polish, security) | COMPLETE — main `b7585d7` |
| — | Instagram feature flag: `INSTAGRAM_ENABLED` server + `EXPO_PUBLIC_INSTAGRAM_ENABLED` mobile; hides IG pending Meta approval | COMPLETE — main `7551889` |
| 14 | RevenueCat iOS/Android in-app subscriptions (StoreKit + Google Play via RC SDK) | COMPLETE — merged main `6c51897` (Nov 11); iOS + Android purchase confirmed working |
| — | Production build preparation: staging→main merge, production RC keys, Android icon fix, Android buildType, EAS production env | COMPLETE — main `6c51897` (Nov 11) |
| — | Fix V14 "poisoned migration" (DDL in try/catch silently failed): V18 repair migration uses `information_schema.columns` pre-check; `provider`, `provider_subscription_id`, `provider_event_at` columns confirmed present on production | COMPLETE — main `fee3116` deployed |
| — | RC sandbox policy decoupling: `isSandboxAllowed(userId)` with three gates (STRIPE_TEST_MODE / RC_ALLOW_SANDBOX / RC_SANDBOX_USER_IDS); replaces `isTestMode()` check in webhook + verify-purchase; 21 new tests in `rc-sandbox.test.js` | COMPLETE — main `fee3116` |
| — | Fix server/tmp parallel-worker ENOENT in CI: `existsSync+mkdirSync` → `mkdirSync({recursive:true})` | COMPLETE — main `82800ed` |
| — | Fix Home screen not clearing after publish: `onPublishSuccess` now fires for all outcomes (success, partial, full failure); extended with `anySuccess: boolean`; clears `savedHomeState` unconditionally after any publish attempt; content already in History at generation time so always safe to clear | COMPLETE — main `1c80abf`; production OTA `1b647aca` |
| — | Fix V18 migration aborting transaction on staging: `ADD CONSTRAINT subscriptions_user_provider_sub_unique` failed (already added by V14 on staging); bare try/catch caught JS error but left PostgreSQL tx aborted (25P02); every subsequent query including schema_migrations INSERT failed; fix: pre-check via `information_schema.table_constraints` before ADD CONSTRAINT; inner try/catch kept as pg-mem fallback | COMPLETE — main `6e4f4be`; staging confirmed healthy |
| — | Fix OAuth return scheme for TestFlight builds hitting staging backend (V16 migration, `oauth_states.return_scheme`, `resolveReturnScheme` allowlist) | COMPLETE — staging `f1b47ef` |
| — | Fix Android registration: SecureStore fallback + handleAuth error separation + 409 idempotency | COMPLETE — staging `5e1bd4d` |
| — | Fix RC init order (initPurchases before switchPurchasesUser); fix $19.99/month price display | COMPLETE — staging OTA `df153e23` |
| — | Android App Links: HTTPS intent filters, `assetlinks.json` endpoint, V17 migration (`oauth_states.return_url`), `returnUrl` in all 5 OAuth routes + mobile `OAUTH_RETURN_URL` constant | COMPLETE — staging `1efff86` / versionCode 6 |
| — | Fix RC Android SDK key missing from OTA bundle (added to EAS `preview` environment) | COMPLETE — staging OTA `df153e23` |
| — | Fix Android audio transcription: `toFile()` with explicit `audio/mp4` MIME type, file size log, stale-path cleanup fix | COMPLETE — staging `d4d2f60`; Railway deployed; device test pending |
| — | MVP input validation and manual text fallback: photo+audio pre-generation guards, silent transcription detection, 500-char manual cap, per-platform verbatim fallback, empty-text blocking | COMPLETE — staging `ea631de`; OTA `28049482` |
| — | UI redesign: tomato-red brand (#DB1200), charcoal text (#252932), warm off-white bg (#F7F6F3), white floating cards with soft shadows, removed all header/footer dividers, floating rounded nav bar with active-item pill | COMPLETE — staging `0d696d0` |
| — | New logo.png (380×100) and icon.png assets from getelmer.com; logo left-aligned at correct aspect ratio | COMPLETE — staging `0d696d0` |
| — | Fix audio re-recording silent failure (4th+ attempt): `keepAudioSessionActive:true` prevents 100ms deactivateSession race; remove `setAudioModeAsync(allowsRecording:false)` from playback; capture URI immediately after prepare; clean ExpoAudio cache on each record | COMPLETE — staging OTA `ff1db83c` |
| — | Fix iOS RevenueCat OTA regression: `EXPO_PUBLIC_RC_API_KEY_IOS` added to EAS Preview environment; `update` script accepts interactive EAS login (no `EXPO_TOKEN` required) | COMPLETE — staging `5f8dfaf`; iOS purchase confirmed Nov 11 |
| — | RC identity guard: `_ensureIdentity()` before purchase/restore; `_abortIfIdentityChanged()` final check before `purchasePackage()`/`restorePurchases()` to close `getOfferings()` async window; email wired into `initPurchases()`/`switchPurchasesUser()` via `fetchAuthMe()`; 26 unit tests | COMPLETE — main `8a7db41`+`6e7facd`; production OTA `d2aa2c3a` (Nov 12) |

---

## Current Build State

- **Production branch:** `main` — HEAD `6e7facd` (RC identity guard + final check)
- **Staging branch:** `staging` — HEAD `9197b7e` (merged from main; V18 fix + home clearing fix; RC guard is JS-only, delivered via OTA)
- **Last production iOS build:** PENDING — awaiting GitHub Actions `ios-build.yml` dispatch from `main` (manual trigger required at https://github.com/ClickFuzz/elmer/actions/workflows/ios-build.yml)
- **Active investigation:** none
- **Last staging TestFlight build:** EAS `58ebf62f` versionCode 28 (staging-testflight; Nov 10)
- **Production Android AAB:** EAS `cfecc61f` versionCode 12 — **FINISHED** (profile `production`, channel `production`, built from main `6c51897`; AAB ready for Google Play upload)
- **Last staging Android build:** EAS `8ca6fecb` versionCode 8 (staging-google-play; Nov 10)
- **Active production OTA update:** `d2aa2c3a` (fix: RC identity guard — prevent orphaned subscriptions); deployed Nov 12
- **Active staging OTA update:** `e46f4266` (same RC identity guard on staging channel)
- **EAS project:** `778df2e5-7a11-47f0-8351-7e3844f59e42` (`@clickfuzz-team/elmer`)
- **ASC App ID:** `6824199734`
- **Production bundle ID:** `com.clickfuzz.elmer` / Android package `com.clickfuzz.elmer`
- **Staging bundle ID:** `com.clickfuzz.elmer` (iOS) / `com.clickfuzz.elmer.staging` (Android, via app.config.js)
- **Production API:** `https://api.getelmer.com` (Railway)
- **Staging API:** `https://api-staging.getelmer.com` (Railway live; `APP_SCHEME`, `APP_URL`, `SERVER_URL`, `STRIPE_TEST_MODE=true`, `REVENUECAT_SECRET_KEY`, `REVENUECAT_WEBHOOK_SECRET`, `ALLOWED_OAUTH_RETURN_SCHEMES=elmer,elmer-staging` confirmed set)
- **EAS channels:** `production` (live), `staging` (live — OTA updates active)
- **EAS production environment** (expo.dev): `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_POSTHOG_API_KEY`, `EXPO_PUBLIC_POSTHOG_HOST`, `EXPO_PUBLIC_RC_API_KEY_IOS`, `EXPO_PUBLIC_RC_API_KEY_ANDROID` — all set Nov 11
- **react-native-purchases**: pinned at `10.16.0` (downgraded from `11.0.1` — `PurchasesHybridCommon 20.4.0` unpublished Nov 2–6 2026 CocoaPods disruption); upgrade back to `11.x` after disruption clears

### Reviewer Account

- Email: `review@clickfuzz.com`
- Password: **`ElmerReview2026!`** (set via SQL below — plaintext documented here, not committed as a hash)
- Subscription: active bypass until 2099 (V10 migration, `sub_review_bypass`)
- **SQL to run in Railway PostgreSQL console to activate this password:**
  ```sql
  UPDATE users
  SET password_hash = '$2a$12$Lky.ITuzamf9E6vfPxHfu.4Dpbs0cMNjvoyg0FLFMAbD/9H0MwAme',
      updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
  WHERE email = 'review@clickfuzz.com';
  ```

## Staging Environment

Staging infrastructure is fully live. Railway staging environment is running.

### What is in place

| Item | State |
|---|---|
| `staging` git branch | Live, pushed to origin |
| `app.config.js` | Wraps `app.json`; `APP_VARIANT=staging` → name "Elmer Staging", bundle `com.clickfuzz.elmer.staging`, scheme `elmer-staging` |
| `eas.json` staging profile | `distribution: internal`, `channel: staging`, `EXPO_PUBLIC_API_URL: https://api-staging.getelmer.com`, `EXPO_PUBLIC_APP_SCHEME: elmer-staging`, `EXPO_PUBLIC_INSTAGRAM_ENABLED: "true"` |
| EAS `staging` channel + branch | Live at expo.dev; OTA updates active |
| `.github/workflows/test.yml` | CI: runs server tests on every push/PR to `main` or `staging` |
| `.github/workflows/staging-update.yml` | OTA workflow (manual dispatch); `--environment` removed; all staging env vars explicit; auto-push trigger still disabled |
| `components/OtaBadge.tsx` | Staging-only OTA version badge; shows `OTA <7-char-id>` or `EMBEDDED`; guards on `EXPO_PUBLIC_APP_SCHEME === 'elmer-staging'`; never visible in production |
| `docs/DEPLOYMENT-WORKFLOW.md` | Full dev/staging/production/rollback/hotfix procedures |
| Railway staging | Live at `https://api-staging.getelmer.com`; `APP_SCHEME=elmer-staging`, `APP_URL`, `SERVER_URL`, `STRIPE_TEST_MODE=true` confirmed set |

### EAS Preview environment — critical rule for OTA variables

The `staging` branch is permanently linked to the EAS **Preview** environment on expo.dev. All OTA updates to the staging channel use this environment's variables, regardless of `--environment` flags, shell exports, or `.env` files — the EAS server-side environment always wins.

**Any `EXPO_PUBLIC_*` variable required in a staging OTA bundle must be present in the EAS Preview environment** (expo.dev → Project → Environment Variables → Preview). `eas.json` build profile `env` blocks apply to native builds only; they are ignored during OTA bundling.

Current EAS Preview environment variables (all confirmed set):
- `EXPO_PUBLIC_API_URL=https://api-staging.getelmer.com`
- `EXPO_PUBLIC_APP_SCHEME=elmer-staging`
- `EXPO_PUBLIC_INSTAGRAM_ENABLED=true`
- `EXPO_PUBLIC_RC_API_KEY_IOS=appl_qiMBWYvElXNhKitKwqFWXExCYsq` ← added Nov 11 2026 (was missing; caused iOS purchase regression)
- `EXPO_PUBLIC_RC_API_KEY_ANDROID=goog_pwUUWIOHItSpOgrtZROpFiIJnjM`

To inspect: `npx eas-cli@latest env:list --environment preview`
To add: `npx eas-cli@latest env:set --environment preview --name KEY --value VALUE`

### Staging OTA workflow — important fix (19975be)

`--environment preview` was causing the EAS server-side "preview" environment (expo.dev) to override and nullify `EXPO_PUBLIC_API_URL`, making the app fall back to `http://localhost:3001`. Removed from the workflow. All staging env vars are now set explicitly in the GitHub Actions `env` block and are correctly inlined by Metro at bundle time.

### What still needs setup

1. **Uncomment `push:` trigger** in `.github/workflows/staging-update.yml` to enable auto-OTA on staging pushes.
2. **Add staging redirect URIs** to Meta (Facebook + Instagram app), Threads app, Google GCP OAuth client — needed before OAuth testing on staging.
3. **Create Stripe test webhook** at `https://api-staging.getelmer.com/billing/webhook`.

### Staging deep-link scheme separation (important)

The staging app uses scheme `elmer-staging://` (set in `app.config.js`). The staging server has `FACEBOOK_OAUTH_RETURN_SCHEME=elmer-staging` and `GOOGLE_OAUTH_RETURN_SCHEME=elmer-staging` as fallback defaults.

**OAuth return scheme fix (f1b47ef):** Mobile now passes `returnScheme: EXPO_PUBLIC_APP_SCHEME ?? 'elmer'` in every connect-url request. The server validates against `ALLOWED_OAUTH_RETURN_SCHEMES` (staging: `elmer,elmer-staging`) and stores the scheme in `oauth_states.return_scheme` (V16 DB migration). The callback reads it back and redirects to the correct app.

**Android App Links (1efff86):** V17 migration adds `oauth_states.return_url TEXT`. All 5 OAuth connect-url routes accept `returnUrl` body param and store it; callbacks read `return_url` and do a plain 302 redirect for HTTPS URLs (Android App Link) or render an intent:// HTML page for custom scheme URLs. Mobile sends `OAUTH_RETURN_URL = Platform.OS === 'android' ? \`${API_URL}/oauth/return\` : \`${RETURN_SCHEME}://oauth/callback\``. Server serves `assetlinks.json` at `/.well-known/assetlinks.json` (Google Play App Signing SHA-256: `87:FB:5B:BE:30:...`). `app.json` has `intentFilters` for `api-staging.getelmer.com` and `api.getelmer.com` with `autoVerify: true`. Helper module: `server/routes/oauth-helpers.js` (`resolveReturnScheme`, `resolveReturnUrl`, `sendOAuthRedirect`).

---

## CI/CD — GitHub Actions Build Pipeline

Builds run on the GitHub Actions macOS runner, not EAS cloud. EAS provides credentials only.

**Trigger:** Actions tab → "iOS Build and Submit to TestFlight" → Run workflow → Branch: main

**Workflow:** `.github/workflows/ios-build.yml`
- Runner: `macos-15`
- `maxim-lobanov/setup-xcode@v1` selects latest Xcode (>= 16.1 required; React Native 0.86.3)
- Validation step fails the job immediately if active Xcode is below 16.1
- `eas build --local` builds on runner; no EAS cloud credits consumed
- IPA uploaded as artifact (`elmer-ios-<run_number>`)
- `eas submit --path ./elmer.ipa` submits to TestFlight
- `EXPO_TOKEN` secret must be set in GitHub repo → Settings → Secrets → Actions

---

## What Is Implemented

### Mobile App (Expo SDK 57 / React Native 0.86.3 / TypeScript)

- Photo capture (camera + library), up to 5 photos, per-photo classification (General / Before / After / Team)
- Featured image star toggle; featured photo promoted to index 0 on publish
- GPS EXIF extraction from photo metadata
- Audio recording and playback (`expo-audio`)
- AI pipeline: Whisper transcription → location extraction → parallel post generation
- Social post, Google Business post, WordPress article, SEO metadata generation
- Writing style selection (7 styles); inquiry URL as CTA fallback
- Business profile settings — persisted to server via authenticated API
- Job history: browse past jobs, expand, copy generated content
- 3-attempt retry with 2-second delay on generation failure
- Home state (photos + audio) preserved when navigating back from result
- Local SQLite schema v8 (`storage/database.ts`): jobs, job_photos, settings
- Manual screen switcher (`App.tsx`) — NOT Expo Router; screens: `home | result | settings | history | subscription`
- **Auth:** sign-in/register in SettingsScreen; session token in SecureStore + SQLite
- **Facebook:** connect (OAuth), multi-page management + selection, publish, token refresh alert
- **Instagram:** connect (OAuth), single photo + carousel publish, Before/After composite — **hidden in production builds** via `INSTAGRAM_ENABLED` feature flag (`constants/features.ts`; `EXPO_PUBLIC_INSTAGRAM_ENABLED=true` required in build/OTA to enable)
- **Threads:** connect (OAuth), text/photo/carousel publish, Before/After composite
- **WordPress:** connect (Application Passwords), multi-site, publish with markdown→HTML
- **Google Business Profile:** connect (OAuth), multi-location management + selection, publish local posts with optional LEARN_MORE CTA, token refresh, reconnect alert
- **Subscription gate:** `SubscriptionScreen` shown until `hasAccess = true`. iOS/Android: native StoreKit / Google Play purchase via RevenueCat SDK (`services/purchases.ts`); no browser for mobile purchases. Web/Stripe: `Linking.openURL` to Stripe Checkout (unchanged). After purchase: `POST /billing/rc-verify-purchase` grants access within seconds; RC webhook confirms asynchronously. Provider-aware management: Apple → Account Settings URL, Google → Play subscriptions URL, Stripe → Customer Portal. Restore Purchases button (Apple requirement). `BILLING_RETURN_PREFIX` is scheme-aware via `EXPO_PUBLIC_APP_SCHEME` (staging: `elmer-staging://`, production: `elmer://`).
- **RC identity guard** (`services/purchases.ts`): `_ensureIdentity()` verifies RC App User ID matches the authenticated Elmer user before any purchase or restore; calls `Purchases.logIn()` once if drifted (anonymous session, stale prior-user identity); uses `_identityGeneration` counter to detect concurrent account switches during the async `logIn()`. `_abortIfIdentityChanged()` performs a second lightweight check (generation + userId + RC App User ID) immediately before `purchasePackage()` and `restorePurchases()` to close the `getOfferings()` async window. Authenticated user email fetched via `GET /auth/me` on startup and login, passed to `initPurchases()` and `switchPurchasesUser()` for RC `setEmail()` calls. `getAppUserID()` properly awaited (returns `Promise<string>` in RN-purchases v10).
- **Staging OTA version badge** (`components/OtaBadge.tsx`): persistent top-right badge visible only when `EXPO_PUBLIC_APP_SCHEME === 'elmer-staging'`; shows `OTA <first-7-chars-of-updateId>` for loaded OTA updates, `EMBEDDED` for the original binary bundle; uses `useUpdates()` so it reflects the actually-running update; `pointerEvents="none"`, safe-area-aware, zero cost in production.
- **Developer update section:** visible in Settings only when server returns `testMode: true` (requires `STRIPE_TEST_MODE=TRUE` in Railway — comparison is case-insensitive). Shows app version, iOS build number, current EAS update ID. Button checks for OTA update, downloads, and prompts restart. Guards against interrupting an active post edit (`returnToPost`). Uses `expo-updates` + `expo-constants`; no new native modules.

### Backend Server (Node.js + Express 4, Railway + PostgreSQL)

- `POST /api/generate` — Whisper + GPT-4o-mini content pipeline
- `GET /health`
- Auth: register, login, logout, /me (`server/routes/auth.js`)
- Platforms: list, disconnect, OAuth CSRF state (`server/routes/platforms.js`)
- Facebook: connect-url, callback, pages list/selection, publish, uninstall/delete callbacks (`server/routes/facebook.js`)
- Instagram: connect-url, callback, account info, media serving, publish, uninstall/delete callbacks (`server/routes/instagram.js`) — connect-url and publish return 503 `instagram_disabled` when `INSTAGRAM_ENABLED=false`; compliance endpoints always active
- Threads: connect-url, callback, account info, media serving, publish, uninstall/delete callbacks (`server/routes/threads.js`)
- WordPress: connect-url, callback, sites list/disconnect, publish (`server/routes/wordpress.js`)
- Google Business Profile: connect-url, callback, locations list/selection, media serving, publish (`server/routes/google.js`)
- Image processing: EXIF correction, AR fitting, carousels, Before/After composites (`server/routes/media-utils.js`)
- **Billing** (`server/routes/billing.js`):
  - `GET /billing/subscription` — status + `hasAccess`
  - `POST /billing/checkout-session` — Stripe Checkout; 409 if already subscribed
  - `POST /billing/portal-session` — Stripe Customer Portal
  - `GET /billing/checkout-return` → redirects to `${APP_SCHEME}://billing/return` (env var; default `elmer`; staging must set `APP_SCHEME=elmer-staging`)
  - `POST /billing/webhook` — `checkout.session.completed` (US-only gate), `customer.subscription.created/updated/deleted`, `invoice.paid/payment_failed`
  - `requireSubscription` middleware on `/api/generate` + all publish endpoints
- **PostgreSQL schema v18**: users, sessions, business_settings, connected_platforms (+ `platform_user_id` column, V12), oauth_states (+ `return_scheme` V16, `return_url` V17), publishing_records (+ `content_hash`), stripe_customers, subscriptions (+ `provider`, `provider_subscription_id`, `provider_event_at` V14/V18 repair; dropped legacy `UNIQUE(user_id)` V15), stripe_webhook_events (V8), deletion_requests (V13), password_reset_tokens (V14-billing)
- **587 automated tests passing** — `cd server && npm test`

---

## Meta Compliance — Callback Details

All three Meta platforms implement signed-request validation (HMAC-SHA256) and atomic deletion with DB-tracked status.

| Platform | Deauthorize URL | Data Deletion URL | Status URL |
|---|---|---|---|
| Facebook | `https://api.getelmer.com/facebook/uninstall` | `https://api.getelmer.com/facebook/delete` | `https://api.getelmer.com/facebook/deletion-status?code=<code>` |
| Instagram | `https://api.getelmer.com/instagram/uninstall` | `https://api.getelmer.com/instagram/delete` | `https://api.getelmer.com/instagram/deletion-status?code=<code>` |
| Threads | `https://api.getelmer.com/threads/uninstall` | `https://api.getelmer.com/threads/delete` | `https://api.getelmer.com/threads/deletion-status?code=<code>` |

**Status semantics** (stored in `deletion_requests` table):
- `completed` — data deleted successfully
- `no_data` — lookup succeeded; no matching records found for this user
- `failed` — identity verification failed (network error, Meta API error, HTTP error from `/debug_token`)
- `pending` — deletion in progress

**Facebook legacy backfill:** `findAndBackfillFbConnections` resolves NULL `platform_user_id` rows via `/debug_token` API. If any debug_token call fails, status is `failed` (unverifiable identity) — never falsely `completed`.

---

## Key Architectural Rules

- **No Expo Router** — manual `useState<AppScreen>` switcher in `App.tsx`.
- **No JWTs** — opaque 64-hex tokens in `sessions` table.
- **Credentials server-side only** — OAuth tokens and app passwords encrypted AES-256-GCM; mobile never holds provider credentials.
- **No PostgreSQL/Redis/Supabase/Firebase addition** without explicit requirement.
- **Platform independence** — Facebook, Instagram, Threads, WordPress failures must not affect each other.
- **iOS billing:** RevenueCat SDK (`react-native-purchases`) + native StoreKit. RC offering `default`, package `$rc_monthly`, entitlement `elmer-post-everywhere`, product `com.clickfuzz.elmer.monthly`. After purchase: `POST /billing/rc-verify-purchase` fast path; RC webhook confirms. Existing Stripe subscribers retain access (multi-provider `subscriptions` table, V15 migration).
- **Android billing:** RevenueCat SDK + Google Play Billing. RC key `EXPO_PUBLIC_RC_API_KEY_ANDROID=goog_pwUUWIOHItSpOgrtZROpFiIJnjM` set in `staging-google-play` EAS profile. AAB (versionCode 4, includes registration fix) built; upload to Google Play Console internal testing track pending.
- **Web/Stripe billing:** `Linking.openURL()` to Stripe Checkout (unchanged for web users on getelmer.com).

---

## Environment Variables (`server/.env`)

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Railway auto-injects) |
| `OPENAI_API_KEY` | Required for real AI; omit for mock mode |
| `PORT` | Default `3001` |
| `SESSION_TTL_DAYS` | Default `30` |
| `CREDENTIAL_ENCRYPTION_KEY` | 64 hex chars (32 bytes) — required for all OAuth |
| `FACEBOOK_APP_ID / _SECRET / _REDIRECT_URI` | Meta App credentials |
| `INSTAGRAM_APP_ID / _SECRET / _REDIRECT_URI` | Same Meta App |
| `THREADS_APP_ID / _SECRET / _REDIRECT_URI` | Separate Threads App |
| `SERVER_URL` | Public base URL for image serving (IG/Threads publish) |
| `WORDPRESS_CALLBACK_URL` | `https://api.getelmer.com/wordpress/callback` |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_…`) |
| `STRIPE_PRICE_ID` | Stripe price ID for the $19/month plan |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client ID from Google Cloud project `elmer-511511` |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret (keep server-side only) |
| `GOOGLE_REDIRECT_URI` | `https://api.getelmer.com/google/callback` (must match GCP console + Railway) |
| `GOOGLE_OAUTH_RETURN_SCHEME` | Default `elmer`; matches `scheme` in `app.json` |
| `STRIPE_TEST_MODE` | `TRUE` in Railway (case-insensitive check); enables test Stripe keys + DeviceCheck bypass + Developer section in Settings |
| `INSTAGRAM_ENABLED` | `false` in production Railway (set); omit or set `true` in staging — blocks connect-url + publish; compliance endpoints always active |
| `REVENUECAT_SECRET_KEY` | RC server-side secret key — required for `rc-verify-purchase` and `rc-webhook` endpoints; Railway only |
| `REVENUECAT_WEBHOOK_SECRET` | Bearer token RC sends in `Authorization` header; must match Railway env var; Railway only |
| `RC_ALLOW_SANDBOX` | Set `true` on staging to allow TestFlight/sandbox RC purchases for all users; never set on production |
| `RC_SANDBOX_USER_IDS` | Comma-separated user IDs permitted to use sandbox RC purchases on production (e.g. `1`); for temporary TestFlight testing only — remove after verification |
| `APP_URL` | `https://api.getelmer.com` (production); `https://api-staging.getelmer.com` (staging) |
| `APP_SCHEME` | `elmer` (production); `elmer-staging` (staging) — used for Stripe + OAuth deep-link returns |
| `ALLOWED_OAUTH_RETURN_SCHEMES` | Comma-separated allowlist for custom-scheme OAuth returns; staging: `elmer,elmer-staging`; production: `elmer` |
| `DISABLE_AUTH` | `false` in production; never `true` in prod |
| `DISABLE_RATE_LIMIT` | `true` in tests only |

---

## Pending Actions Before App Store Release

> Items 1–5 from the Nov 11 2026 production build prep session are **COMPLETE**. The remaining items are console/manual steps.

**COMPLETE (Nov 11):**
- ✅ iOS + Android purchase tests confirmed working
- ✅ staging → main merged (`6c51897`)
- ✅ Production RC keys set in EAS production env + `eas.json` production profile
- ✅ Android `buildType: app-bundle` added to production profile
- ✅ Android icon Gradle fix committed (replaced missing adaptive icon assets)
- ✅ Android EAS production build submitted (EAS `cfecc61f`, versionCode 12, IN PROGRESS)

**REMAINING:**

0. **[PENDING] TestFlight sandbox purchase verification** — `RC_SANDBOX_USER_IDS=1,16` is live on Railway production. User (user_id=1, `clgsplace@gmail.com`) should retry TestFlight sandbox purchase now that RC identity guard (`d2aa2c3a`) is live on production OTA. After successful purchase: verify RC subscriber state, confirm `subscriptions` row with `provider='apple'` inserted in production DB, confirm `hasAccess=true`. Then remove `RC_SANDBOX_USER_IDS`: `railway variable delete RC_SANDBOX_USER_IDS --environment production --service elmer`.

1. **[REQUIRED BEFORE iOS REVIEW SUBMISSION] Trigger production iOS build** — GitHub Actions → `https://github.com/ClickFuzz/elmer/actions/workflows/ios-build.yml` → "Run workflow" → Branch: `main`. Builds locally, signs, submits to TestFlight automatically. Then submit for App Review from App Store Connect.

2. **[REQUIRED BEFORE BOTH] Reviewer password SQL** — Run in Railway PostgreSQL console:
   ```sql
   UPDATE users
   SET password_hash = '$2a$12$Lky.ITuzamf9E6vfPxHfu.4Dpbs0cMNjvoyg0FLFMAbD/9H0MwAme',
       updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
   WHERE email = 'review@clickfuzz.com';
   ```
   Reviewer credentials: `review@clickfuzz.com` / `ElmerReview2026!`

3. **[REQUIRED] Android AAB upload** — Once EAS `cfecc61f` completes, download AAB from expo.dev and upload to Google Play Console → Internal testing track.

4. **[REQUIRED] App Store Connect listing** — Complete: app description, screenshots, support URL (`https://getelmer.com`), privacy policy URL (`https://getelmer.com/privacy`), age rating, US-only territory restriction, subscription product linked to build.

5. **[REQUIRED] Google Play listing** — Complete: description, screenshots, content rating questionnaire, data safety form.

6. **[PRE-RELEASE] Upgrade react-native-purchases to 11.x** — CocoaPods disruption cleared; run `npx expo install react-native-purchases@latest`, typecheck, staging build to confirm, then new production builds.

7. **[PRE-RELEASE] Stripe production keys** — Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` in Railway production. **Do not set `STRIPE_TEST_MODE=true` when live key is present** — billing.js startup guard will crash the server.

8. **[PRE-RELEASE] Stripe webhook** — Register `https://api.getelmer.com/billing/webhook` in Stripe Dashboard.

9. **[PRE-RELEASE] Set `REVENUECAT_SECRET_KEY` + `REVENUECAT_WEBHOOK_SECRET` on Railway production** — Configure RC production webhook at `https://api.getelmer.com/billing/rc-webhook`.

10. **[PRE-RELEASE] Meta App Review** — Currently in progress. Do not modify the pending review submission. After approval, configure callback URLs per Meta Compliance section above.

11. **[DEFERRED] Google OAuth hang** — New personal Gmail accounts hang after password entry in `ASWebAuthenticationSession`; existing connected account works (has session cookies). Google OAuth app confirmed In production, branding verified, `business.manage` registered as non-sensitive. Root cause unconfirmed — no active investigation.

12. **[PRE-RELEASE / partially done] Google Cloud Console** — GBP OAuth app is live (In production, branding verified, `business.manage` non-sensitive). Confirm `https://api.getelmer.com/google/callback` is in authorized redirect URIs and GBP APIs (My Business Account Management, Business Information) are enabled in project `elmer-511511`.

13. **[PRE-RELEASE / partially done] Railway GBP env vars** — At least one account connects successfully, so `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` are likely set on production. Confirm after OAuth hang is resolved.

## Instagram Activation (when Meta approves publishing permissions)

1. Set `INSTAGRAM_ENABLED=true` in Railway production (server enables connect-url + publish)
2. Add `EXPO_PUBLIC_INSTAGRAM_ENABLED=true` to the production `eas.json` build profile
3. Build and submit a new production binary (GitHub Actions → ios-build.yml → Branch: main)
4. Publish a production OTA update to reveal the Instagram row in installed builds while the new binary propagates

---

## Known Bugs (pre-existing, not yet fixed)

| Bug | Location |
|---|---|
| Orphaned `elmer_recording_*.m4a` accumulate | `HomeScreen.tsx` |
| Job status never changes from `draft` | `storage/database.ts` |
| `expo-file-system/legacy` import | `HomeScreen.tsx`, `ResultScreen.tsx` |
| `Clipboard` imported from `react-native` (deprecated) | `ResultScreen.tsx`, `HistoryScreen.tsx` |
| `deleteOldPublishedMedia` never called | `storage/database.ts` |
| Server `tmp/` not cleaned on crash | `server/` |
| Instagram/Threads temp media not cleaned on crash | `server/routes/instagram.js`, `threads.js` |

---

## Testing

```bash
cd server && npm test
# 587 tests: db, auth, platforms, facebook, instagram, threads,
#             media-utils, generation, account-isolation, wordpress,
#             billing, google, free-publication, analytics, device,
#             security, settings, testmode, meta-callbacks, revenuecat,
#             rc-sandbox, cors, web-billing, password-reset
```

Mobile:
```bash
npx jest            # 26 tests: RC identity guard unit tests (__tests__/purchases.test.ts)
npx tsc --noEmit    # 0 errors
npx expo lint       # warnings only in pre-existing files; 0 errors in billing/subscription code
```

---

## Key File Locations

| File | Purpose |
|---|---|
| `docs/ARCHITECTURE.md` | Authoritative schemas, routes, implementation status |
| `AGENTS.md` | Dev rules, Expo guidance, commands |
| `server/.env.example` | Template for required env vars |
| `storage/database.ts` | All device SQLite access |
| `server/db.js` | PostgreSQL pool + migrations (schema v18) |
| `server/app.js` | Express app factory — middleware + route mounting order |
| `server/auth.js` | `requireAuth` / `optionalAuth` |
| `server/crypto.js` | AES-256-GCM encrypt/decrypt |
| `server/routes/billing.js` | Stripe billing: checkout, portal, webhook, `requireSubscription`; `isSandboxAllowed()` for RC sandbox policy |
| `server/routes/google.js` | GBP: OAuth connect-url/callback, locations, publish, token refresh |
| `server/routes/facebook.js` | Facebook: OAuth, pages, publish, Meta callbacks, backfill |
| `server/routes/instagram.js` | Instagram: OAuth, publish, Meta callbacks |
| `server/routes/threads.js` | Threads: OAuth, publish, Meta callbacks |
| `services/purchases.ts` | RevenueCat SDK wrapper — configure, purchase, restore, logIn/logOut; identity guard (`_ensureIdentity`, `_abortIfIdentityChanged`) |
| `screens/SubscriptionScreen.tsx` | Trial offer, native StoreKit purchase flow, manage subscription (provider-aware) |
| `server/test/meta-callbacks.test.js` | 19 Meta callback integration tests |
| `eas.json` | EAS build/submit config; `ascAppId: 6824199734`; remote versioning |
| `constants/features.ts` | Mobile feature flags: `INSTAGRAM_ENABLED` (derived from `EXPO_PUBLIC_INSTAGRAM_ENABLED`) |
| `components/OtaBadge.tsx` | Staging-only OTA version badge; guards on `EXPO_PUBLIC_APP_SCHEME` |
| `.github/workflows/staging-update.yml` | Staging OTA publish workflow; no `--environment`; all env vars explicit |
| `update` | Local bash script for manual staging OTA publishes; sets all staging env vars |
