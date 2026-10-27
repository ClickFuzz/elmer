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

---

## Current Build State

- **Branch:** `main`
- **HEAD:** `daaeab0`
- **Last known TestFlight build:** #13 (commit `90bf9e9`) — did NOT include GBP HEIC/topicType fixes
- **Build in progress:** GitHub Actions run triggered from `daaeab0`; expected to be next EAS build number (auto-incremented)
- **EAS project:** `778df2e5-7a11-47f0-8351-7e3844f59e42` (`@clickfuzz-team/elmer`)
- **ASC App ID:** `6824199734`
- **Bundle ID:** `com.clickfuzz.elmer`
- **Production API:** `https://api.getelmer.com` (Railway)
- **EAS cloud build credits:** exhausted for the free tier this month — all builds must go through GitHub Actions

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
- **Instagram:** connect (OAuth), single photo + carousel publish, Before/After composite
- **Threads:** connect (OAuth), text/photo/carousel publish, Before/After composite
- **WordPress:** connect (Application Passwords), multi-site, publish with markdown→HTML
- **Google Business Profile:** connect (OAuth), multi-location management + selection, publish local posts with optional LEARN_MORE CTA, token refresh, reconnect alert
- **Subscription gate:** `SubscriptionScreen` shown until `hasAccess = true`; 14-day trial offer → Stripe Checkout via `Linking.openURL`; polls for activation on return; Manage Subscription → Customer Portal

### Backend Server (Node.js + Express 4, Railway + PostgreSQL)

- `POST /api/generate` — Whisper + GPT-4o-mini content pipeline
- `GET /health`
- Auth: register, login, logout, /me (`server/routes/auth.js`)
- Platforms: list, disconnect, OAuth CSRF state (`server/routes/platforms.js`)
- Facebook: connect-url, callback, pages list/selection, publish (`server/routes/facebook.js`)
- Instagram: connect-url, callback, account info, media serving, publish (`server/routes/instagram.js`)
- Threads: connect-url, callback, account info, media serving, publish, uninstall/delete callbacks (`server/routes/threads.js`)
- WordPress: connect-url, callback, sites list/disconnect, publish (`server/routes/wordpress.js`)
- Google Business Profile: connect-url, callback, locations list/selection, media serving, publish (`server/routes/google.js`)
- Image processing: EXIF correction, AR fitting, carousels, Before/After composites (`server/routes/media-utils.js`)
- **Billing** (`server/routes/billing.js`):
  - `GET /billing/subscription` — status + `hasAccess`
  - `POST /billing/checkout-session` — Stripe Checkout; 409 if already subscribed
  - `POST /billing/portal-session` — Stripe Customer Portal
  - `GET /billing/checkout-return` → redirects to `elmer://billing/return`
  - `POST /billing/webhook` — `checkout.session.completed` (US-only gate), `customer.subscription.created/updated/deleted`, `invoice.paid/payment_failed`
  - `requireSubscription` middleware on `/api/generate` + all publish endpoints
- PostgreSQL schema v5: users, sessions, business_settings, connected_platforms, oauth_states, publishing_records, stripe_customers, subscriptions (no new migration for GBP — `connected_platforms` already supports `google` platform)
- **457 automated tests passing** — `cd server && npm test`

---

## Key Architectural Rules

- **No Expo Router** — manual `useState<AppScreen>` switcher in `App.tsx`.
- **No JWTs** — opaque 64-hex tokens in `sessions` table.
- **Credentials server-side only** — OAuth tokens and app passwords encrypted AES-256-GCM; mobile never holds provider credentials.
- **No PostgreSQL/Redis/Supabase/Firebase addition** without explicit requirement.
- **Platform independence** — Facebook, Instagram, Threads, WordPress failures must not affect each other.
- **iOS billing:** `Linking.openURL()` to Stripe Checkout. No StoreKit or `com.apple.developer.storekit.external-purchase-link` entitlement needed — Elmer is US-only and App Review Guideline 3.1.1(a) (updated Oct 16, 2026) does not require the entitlement for US storefront apps.
- **Android billing:** `Linking.openURL()`. SaaS exemption applies — Elmer sells backend service access, not in-app digital goods.

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
| `DISABLE_AUTH` | `false` in production; never `true` in prod |
| `DISABLE_RATE_LIMIT` | `true` in tests only |

---

## Pending Actions Before App Store Release

1. **App Store Connect — Territory Availability:** restrict to United States only (Pricing and Availability → Territory Availability → deselect all, check only United States).
2. **Stripe production keys:** set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` in Railway.
3. **Stripe webhook endpoint:** register `https://api.getelmer.com/billing/webhook` in Stripe Dashboard.
4. **Meta App Review:** submit Facebook/Instagram permissions for review (screencast: connect → select pages → create job → Post Everywhere → confirm posts).
5. **Google Cloud Console:** add `https://api.getelmer.com/google/callback` to authorized redirect URIs for the OAuth 2.0 client in project `elmer-511511`. Add `https://api.getelmer.com` to authorized JavaScript origins.
6. **Railway GBP env vars:** set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI=https://api.getelmer.com/google/callback` in the Elmer Server service and redeploy.
7. **GBP API library approval:** `My Business API`, `My Business Account Management API`, `My Business Business Information API` must be enabled in GCP console and, if required, the app must go through Google's GBP API access verification process.
8. **Confirm current TestFlight build includes GBP fixes** — build in progress from `daaeab0` includes the HEIC→JPEG conversion fix and `topicType: 'STANDARD'` fix. Verify it reaches TestFlight successfully.

---

## Known Bugs (pre-existing, not yet fixed)

| Bug | Location |
|---|---|
| Google Business post generated but UI shows legacy stub (GBP edit/preview now in ResultScreen) | fixed in Phase 5 |
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
# 341 tests: db, auth, platforms, facebook, instagram, threads,
#             media-utils, generation, account-isolation, wordpress, billing, google
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
| `server/db.js` | PostgreSQL pool + migrations (schema v5) |
| `server/app.js` | Express app factory — middleware + route mounting order |
| `server/auth.js` | `requireAuth` / `optionalAuth` |
| `server/crypto.js` | AES-256-GCM encrypt/decrypt |
| `server/routes/billing.js` | Stripe billing: checkout, portal, webhook, `requireSubscription` |
| `server/routes/google.js` | GBP: OAuth connect-url/callback, locations, publish, token refresh |
| `screens/SubscriptionScreen.tsx` | Trial offer, checkout flow, manage subscription |
| `server/test/google.test.js` | 33 GBP integration tests |
| `eas.json` | EAS build/submit config; `ascAppId: 6824199734`; remote versioning |
