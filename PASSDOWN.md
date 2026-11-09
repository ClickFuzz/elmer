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
| 14 | RevenueCat iOS/Android in-app subscriptions (StoreKit + Google Play via RC SDK) | IN PROGRESS — staging `5d68bff`; iOS sandbox test pending; Android AAB versionCode 6 built + App Links + OTA active |
| — | Fix OAuth return scheme for TestFlight builds hitting staging backend (V16 migration, `oauth_states.return_scheme`, `resolveReturnScheme` allowlist) | COMPLETE — staging `f1b47ef` |
| — | Fix Android registration: SecureStore fallback + handleAuth error separation + 409 idempotency | COMPLETE — staging `5e1bd4d` |
| — | Fix RC init order (initPurchases before switchPurchasesUser); fix $19.99/month price display | COMPLETE — staging OTA `df153e23` |
| — | Android App Links: HTTPS intent filters, `assetlinks.json` endpoint, V17 migration (`oauth_states.return_url`), `returnUrl` in all 5 OAuth routes + mobile `OAUTH_RETURN_URL` constant | COMPLETE — staging `1efff86` / versionCode 6 |
| — | Fix RC Android SDK key missing from OTA bundle (added to EAS `preview` environment) | COMPLETE — staging OTA `df153e23` |
| — | Fix Android audio transcription: `toFile()` with explicit `audio/mp4` MIME type, file size log, stale-path cleanup fix | COMPLETE — staging `d4d2f60`; Railway deployed; device test pending |
| — | MVP input validation and manual text fallback: photo+audio pre-generation guards, silent transcription detection, 500-char manual cap, per-platform verbatim fallback, empty-text blocking | COMPLETE — staging `ea631de`; OTA `28049482` |

---

## Current Build State

- **Production branch:** `main` — HEAD `7551889`
- **Staging branch:** `staging` — HEAD `ea631de` (21+ commits ahead of main — RC integration + OAuth fix + Android App Links + audio fix + MVP validation)
- **Last known TestFlight build:** #24 (staging-testflight profile; `com.clickfuzz.elmer`; connects to staging API; submitted Nov 6 2026 — includes OAuth return scheme fix)
- **Last Android AAB build:** versionCode 6 (staging-google-play profile; `com.clickfuzz.elmer`; connects to staging API; built Nov 9 2026 — includes Android App Links, RC init fix, App Links intent filters) — artifact: https://expo.dev/artifacts/eas/6Udn72XWEIzZQItqn77D5DZ0CYpHSur9l2Gi8GXVQ-o.aab — build: https://expo.dev/accounts/clickfuzz-team/projects/elmer/builds/3a2f6cae-12c7-4600-b5b9-a772d41df665
- **Active staging OTA update:** group `28049482` (MVP validation + manual text fallback; RC Android key confirmed in bundle) — targets staging channel, runtime 1.0.0
- **EAS project:** `778df2e5-7a11-47f0-8351-7e3844f59e42` (`@clickfuzz-team/elmer`)
- **ASC App ID:** `6824199734`
- **Production bundle ID:** `com.clickfuzz.elmer`
- **Staging bundle ID:** `com.clickfuzz.elmer.staging` (internal distribution only; no ASC app)
- **Production API:** `https://api.getelmer.com` (Railway)
- **Staging API:** `https://api-staging.getelmer.com` (Railway live; `APP_SCHEME`, `APP_URL`, `SERVER_URL`, `STRIPE_TEST_MODE=true`, `REVENUECAT_SECRET_KEY`, `REVENUECAT_WEBHOOK_SECRET`, `ALLOWED_OAUTH_RETURN_SCHEMES=elmer,elmer-staging` confirmed set)
- **EAS channels:** `production` (live), `staging` (live — OTA updates active)
- **EAS cloud build credits:** exhausted for the free tier — all builds must go through GitHub Actions (exception: `npx eas-cli@latest build` still works for staging-testflight ad-hoc builds)
- **Pending OTA update:** `34fe198` (subscription screen redesign) — **not yet pushed to `production` channel**
- **react-native-purchases**: pinned at `10.16.0` on staging (downgraded from `11.0.1` — `PurchasesHybridCommon 20.4.0` unpublished Nov 2–6 2026 CocoaPods disruption); upgrade back to `11.x` after disruption clears

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
- **PostgreSQL schema v13**: users, sessions, business_settings, connected_platforms (+ `platform_user_id` column, V12), oauth_states, publishing_records (+ `content_hash` column), stripe_customers, subscriptions, stripe_webhook_events, deletion_requests (V13)
- **566 automated tests passing** — `cd server && npm test`

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
| `APP_URL` | `https://api.getelmer.com` (production); `https://api-staging.getelmer.com` (staging) |
| `APP_SCHEME` | `elmer` (production); `elmer-staging` (staging) — used for Stripe + OAuth deep-link returns |
| `ALLOWED_OAUTH_RETURN_SCHEMES` | Comma-separated allowlist for custom-scheme OAuth returns; staging: `elmer,elmer-staging`; production: `elmer` |
| `DISABLE_AUTH` | `false` in production; never `true` in prod |
| `DISABLE_RATE_LIMIT` | `true` in tests only |

---

## Pending Actions Before App Store Release

1. **Complete iOS sandbox purchase test** — Install TestFlight build 24, sign in, tap Subscribe, complete with sandbox Apple ID, verify unlock.
2. **Complete Android purchase + registration test** — Upload AAB (versionCode 6) to Google Play Console → `com.clickfuzz.elmer` → Internal testing track. Install via internal testing link. Test: (a) register new account; (b) Subscribe → verify 14-day trial offer (product `com.clickfuzz.elmer.monthly:monthly`, offer `free-trial-14-day`) → verify unlock. Test Restore Purchases. Install OTA update group `28049482` or confirm it auto-applies.
2a. **Confirm Android audio transcription fix** — On versionCode 6 with Railway staging deployed, record voice + tap Generate. Confirm no "Transcription failed" error. Check Railway logs for `[Generate] Audio received: X bytes` (expect 50 KB+).
3. **Merge staging → main** — After both iOS and Android purchase tests pass; 20+ commits of RC integration + App Links + audio fix.
4. **Upgrade react-native-purchases to 11.x** — After Nov 6 CocoaPods disruption clears; run `npx expo install react-native-purchases@latest`, typecheck, build new staging-testflight to confirm, then production.
4. **New production iOS build** — Required after merging RC integration (new native module; OTA alone is not sufficient). Trigger via GitHub Actions → "iOS Build and Submit to TestFlight" → Branch: main.
5. **Set `EXPO_PUBLIC_RC_API_KEY_IOS` in production `eas.json` env** — Only after RC sandbox test passes on staging; use the same key `appl_qiMBWYvElXNhKitKwqFWXExCYsq`.
6. **Set `REVENUECAT_SECRET_KEY` + `REVENUECAT_WEBHOOK_SECRET` on Railway production** — After staging test passes; configure RC production webhook at `https://api.getelmer.com/billing/rc-webhook`.
3. **OTA update (interim):** if shipping before a new binary, push `34fe198` to `production` channel — `bunx eas-cli update --branch production --message "Fix subscription manage screen: no flash, back button, Invalid Date"` — but note this does NOT include the Instagram flag (that requires a build with the new `EXPO_PUBLIC_INSTAGRAM_ENABLED` env var absent).
4. **App Store Connect — Territory Availability:** restrict to United States only (Pricing and Availability → Territory Availability → deselect all, check only United States).
5. **Stripe production keys:** set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` in Railway. **Do not set `STRIPE_TEST_MODE=true` when live key is present** — the billing.js startup guard will crash the server.
6. **Stripe webhook endpoint:** register `https://api.getelmer.com/billing/webhook` in Stripe Dashboard and verify checkout → subscription activation end-to-end.
7. **Meta App Review:** Elmer v2 is currently under Meta review. After TestFlight verification passes, configure the Meta dashboard callback URLs (see Meta Compliance section above). Do not modify the pending review submission.
8. **Google Cloud Console:** add `https://api.getelmer.com/google/callback` to authorized redirect URIs for the OAuth 2.0 client in project `elmer-511511`. Add `https://api.getelmer.com` to authorized JavaScript origins.
9. **Railway GBP env vars:** set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI=https://api.getelmer.com/google/callback` in the Elmer Server service and redeploy.
10. **GBP API library approval:** `My Business API`, `My Business Account Management API`, `My Business Business Information API` must be enabled in GCP console; may require Google's GBP API access verification process.

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
# 566 tests: db, auth, platforms, facebook, instagram, threads,
#             media-utils, generation, account-isolation, wordpress,
#             billing, google, free-publication, analytics, device,
#             security, settings, testmode, meta-callbacks
```

Mobile:
```bash
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
| `server/db.js` | PostgreSQL pool + migrations (schema v13) |
| `server/app.js` | Express app factory — middleware + route mounting order |
| `server/auth.js` | `requireAuth` / `optionalAuth` |
| `server/crypto.js` | AES-256-GCM encrypt/decrypt |
| `server/routes/billing.js` | Stripe billing: checkout, portal, webhook, `requireSubscription` |
| `server/routes/google.js` | GBP: OAuth connect-url/callback, locations, publish, token refresh |
| `server/routes/facebook.js` | Facebook: OAuth, pages, publish, Meta callbacks, backfill |
| `server/routes/instagram.js` | Instagram: OAuth, publish, Meta callbacks |
| `server/routes/threads.js` | Threads: OAuth, publish, Meta callbacks |
| `services/purchases.ts` | RevenueCat SDK wrapper — configure, purchase, restore, logIn/logOut |
| `screens/SubscriptionScreen.tsx` | Trial offer, native StoreKit purchase flow, manage subscription (provider-aware) |
| `server/test/meta-callbacks.test.js` | 19 Meta callback integration tests |
| `eas.json` | EAS build/submit config; `ascAppId: 6824199734`; remote versioning |
| `constants/features.ts` | Mobile feature flags: `INSTAGRAM_ENABLED` (derived from `EXPO_PUBLIC_INSTAGRAM_ENABLED`) |
| `components/OtaBadge.tsx` | Staging-only OTA version badge; guards on `EXPO_PUBLIC_APP_SCHEME` |
| `.github/workflows/staging-update.yml` | Staging OTA publish workflow; no `--environment`; all env vars explicit |
| `update` | Local bash script for manual staging OTA publishes; sets all staging env vars |
