# PASSDOWN — Elmer

> Durable project record. Updated after each significant milestone.
> For active unfinished tasks, see HANDOFF.md (created/deleted per session).

---

## Project Purpose

Elmer is a mobile publishing tool for local contractors. After finishing a job, a contractor takes photos, records a voice description, and the app generates platform-ready posts for Google Business Profile, Facebook/social, and WordPress. Pre-launch prototype stage.

---

## Milestone Status

| # | Milestone | Status |
|---|---|---|
| 0 | Initial prototype (photos, audio, AI generation, history) | COMPLETE |
| 1 | Backend persistence, auth, OAuth readiness | COMPLETE |
| 2 | Mobile app auth (send Bearer token) | PARTIAL — sign-in/register implemented in SettingsScreen; token stored in local SQLite; used for Facebook integration |
| 3 | Google Business Profile OAuth + posting | NOT STARTED (awaiting API approval) |
| 4 | Facebook OAuth + posting | COMPLETE (awaiting live Meta credentials for functional test) |
| 5 | WordPress REST API publishing | NOT STARTED |
| 6 | Stripe billing | NOT STARTED |

---

## What Is Implemented and Working

### Mobile App (Expo SDK 57 / React Native 0.86.3 / TypeScript 6.0.3)

- Photo capture (camera + library), up to 5 photos, per-photo classification (General / Before / After / Team)
- GPS EXIF extraction from photo metadata
- Audio recording and playback (`expo-audio`, SDK 50+ API)
- AI pipeline: transcription → location extraction → parallel post generation
- Social post, Google Business post, WordPress article, SEO metadata generation
- Writing style selection (7 styles)
- Business profile settings (name, website, category, services, service areas, description) — persisted to SQLite
- Job history: browse past jobs, expand, copy generated content
- Mock mode when `OPENAI_API_KEY` is absent (labeled in UI)
- 3-attempt retry with 2-second delay on generation failure
- Home state (photos + audio) preserved when navigating back from result screen
- Local SQLite persistence, schema v5, WAL mode, versioned migrations (`storage/database.ts`)

### Backend Server (Node.js + Express 4)

- `POST /api/generate` — transcription + content generation pipeline (unchanged from prototype)
- `GET /health` — server health check
- **Auth endpoints** (`server/routes/auth.js`):
  - `POST /auth/register` — validates email + password ≥ 8 chars; bcrypt 12 rounds; returns `{token, expiresAt}`
  - `POST /auth/login` — constant-time comparison; returns `{token, expiresAt}`
  - `POST /auth/logout` — deletes session row
  - `GET /auth/me` — returns `{userId, email}`
- **Platform endpoints** (`server/routes/platforms.js`):
  - `GET /platforms` — list connected platforms for authenticated user (no credentials in response)
  - `DELETE /platforms/:id` — disconnect; ownership-checked; 404 for missing or wrong user
  - `POST /platforms/oauth/state` — create CSRF state token (48 hex chars, 10-min TTL)
  - `POST /platforms/oauth/state/validate` — validate + consume state (single-use)
- Server-side SQLite: WAL mode, foreign keys, busy timeout, schema v1 (`server/db.js`)
- AES-256-GCM credential encryption at rest (`server/crypto.js`)
- Auth middleware: `requireAuth` / `optionalAuth` (`server/auth.js`)
- Rate limiting: `express-rate-limit` — 10 req/15min on generate, 20 req/15min on auth
- `DISABLE_AUTH=true` escape hatch for local mobile dev (mobile app not yet sending tokens)
- 52 automated tests passing: db (12), auth (18), platforms (22) — `npm test` in `server/`

---

## Server-Side Database Schema (schema v1, `server/elmer.db`)

Six tables: `users`, `sessions`, `business_settings`, `connected_platforms`, `oauth_states`, `publishing_records`.

See `docs/ARCHITECTURE.md → Server-Side Database Schema` for full DDL.

Key constraints:
- `connected_platforms.platform` CHECK(`google`, `facebook`, `wordpress`)
- `publishing_records.status` CHECK(`pending`, `published`, `failed`)
- All tables use `ON DELETE CASCADE` from `users`
- `users.email` is `UNIQUE COLLATE NOCASE`

---

## Environment Variables (`server/.env`)

| Variable | Notes |
|---|---|
| `OPENAI_API_KEY` | Required for real AI; omit for mock mode |
| `PORT` | Default `3001` |
| `DB_PATH` | Default `./elmer.db`; use `:memory:` for ephemeral tests only |
| `SESSION_TTL_DAYS` | Default `30` |
| `CREDENTIAL_ENCRYPTION_KEY` | **Required for OAuth** — 64 hex chars (32 bytes). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DISABLE_AUTH` | `true` during local dev before Phase 2; **never in production** |
| `GENERATE_RATE_LIMIT` | Default `10` per 15 min |
| `AUTH_RATE_LIMIT` | Default `20` per 15 min |
| `DISABLE_RATE_LIMIT` | `true` in tests only |

---

## Architecture Decisions and Rules

### Navigation
Manual `useState<AppScreen>` switcher in `App.tsx` — NOT Expo Router. Do not introduce a navigation library without demonstrated requirement. Screens call parent callbacks; they do not navigate themselves. Screen names: `'home' | 'result' | 'settings' | 'history'`.

### Databases
- **Device**: `expo-sqlite` WAL, schema v5 — jobs, job_photos, settings
- **Server**: `better-sqlite3` WAL, schema v1 — users, sessions, business_settings, connected_platforms, oauth_states, publishing_records

### Auth pattern
Opaque 64-hex-char tokens in `sessions` table. No JWTs. Sessions expire per `SESSION_TTL_DAYS`. `DISABLE_AUTH=true` bypasses requireAuth on `/api/generate` for backward compat while the mobile app doesn't yet send tokens.

### Platform independence
Google, Facebook, and WordPress integrations must be independently implemented, tested, and deployable. A failure in one must not affect the others. Each gets its own OAuth token storage, publish endpoint, status tracking, retry logic.

### Credentials
OAuth access/refresh tokens live server-side only, encrypted with AES-256-GCM. The mobile app never holds provider credentials. The app authenticates to the Elmer backend; the backend authenticates to platform APIs.

### What must not be introduced without explicit approval
PostgreSQL, Redis, Supabase, Firebase, permanent cloud media storage, cross-device job sync, Expo Router migration.

---

## Known Bugs (not yet fixed)

| Bug | Location | Impact |
|---|---|---|
| "Post Everywhere" is a no-op | `ResultScreen.tsx:234` | Core publish action does nothing |
| Google post generated but not shown in UI | `ResultScreen.tsx:71` | Users can't review Google content |
| `connected_channels` never written | `SettingsScreen.tsx:93` | Platform-specific content not generated for real users |
| Orphaned `elmer_recording_*.m4a` accumulate | `HomeScreen.tsx:273` | Device audio files never deleted |
| Job status never changes from `draft` | `storage/database.ts` | `deleteOldPublishedMedia()` is dead code |
| `expo-file-system/legacy` import | `HomeScreen.tsx:1`, `ResultScreen.tsx:1` | Deprecation warning; will break in future SDK |
| `Clipboard` from `react-native` (deprecated) | `ResultScreen.tsx:13`, `HistoryScreen.tsx:7` | Replace with `expo-clipboard` |
| Server `tmp/` not cleaned on crash | `server/app.js` | Orphan audio files possible |

---

## Phase 2 Requirements (next milestone)

Mobile app must send a Bearer token on all API requests. Steps:
1. Add auth state to `App.tsx` / `AppShell` — store token in `expo-secure-store`
2. Inject `Authorization: Bearer <token>` header in `ResultScreen`'s generate call
3. Add login/register screens or modal
4. Update `SettingsScreen` Sign In stub to call `/auth/register` + `/auth/login`
5. Set `DISABLE_AUTH=false` (or remove it) in `server/.env` once the app sends tokens
6. Tokens should persist across app restarts via `expo-secure-store`

Do NOT use `AsyncStorage` for tokens — use `expo-secure-store`.

---

## Testing

```bash
cd server && npm test
# 52 tests: db.test.js (12) + auth.test.js (18) + platforms.test.js (22)
```

Mobile:
```bash
npx expo lint
npx tsc --noEmit
```

---

## Key File Locations

| File | Purpose |
|---|---|
| `docs/ARCHITECTURE.md` | Authoritative implementation status + schemas |
| `AGENTS.md` | Dev rules, commands, Expo guidance |
| `server/.env.example` | Template for required env vars |
| `storage/database.ts` | All device SQLite access |
| `server/db.js` | Server SQLite singleton + migrations |
| `server/app.js` | Express app factory (createApp) |
| `server/auth.js` | requireAuth / optionalAuth middleware |
| `server/crypto.js` | AES-256-GCM encrypt/decrypt |
| `server/routes/auth.js` | /auth/* endpoints |
| `server/routes/platforms.js` | /platforms/* endpoints |

---

## Development Notes

- Local IP for physical device testing: set `EXPO_PUBLIC_API_URL=http://<LAN-IP>:3001` in `server/.env`
- `server/elmer.db`, `server/elmer.db-wal`, `server/elmer.db-shm` are gitignored
- `server/.env` is gitignored — copy from `server/.env.example` and fill in values
- `CREDENTIAL_ENCRYPTION_KEY` must be set before any OAuth connect flow will work
- Tests use `:memory:` SQLite and set their own env vars — no `.env` file needed to run tests
- Node 22 runs each test file in an isolated worker thread — test state does not bleed between files
