# Elmer — Architecture Reference

> Authoritative record of what is implemented, what is planned, and the decisions behind each layer.
> Update this document when a material technical decision changes (see development rule 11).

---

## System Overview

Elmer is a mobile-first publishing tool for local contractors. The workflow is:

1. Contractor finishes a job and opens the app.
2. Takes up to 5 photos, labels them (General / Before / After / Team), and records a voice description.
3. Taps "Generate Preview" — the app sends photos metadata and audio to the backend.
4. The backend transcribes the audio, extracts location and job context, and generates platform-appropriate posts via OpenAI.
5. Contractor reviews and edits the generated content.
6. Contractor publishes to connected platforms, or copies content manually.

---

## Technology Stack

### Mobile App
| Concern | Implementation |
|---|---|
| Framework | Expo SDK 57, React Native 0.86.3, React 19.2.3 |
| Language | TypeScript 6.0.3 |
| Navigation | Manual `useState` screen switcher in `App.tsx` — **not** Expo Router |
| Local database | `expo-sqlite` (async API, WAL mode) |
| File system | `expo-file-system` (currently imported as `/legacy` — see Known Issues) |
| OAuth browser | `expo-web-browser` (`openAuthSessionAsync` — requires dev or production build for deep-link return) |
| Audio | `expo-audio` (SDK 50+ API, replacing deprecated `expo-av`) |
| Image picker | `expo-image-picker` |
| Fonts | `@expo-google-fonts/dm-sans`, `@expo-google-fonts/inter` |
| Icons | `@expo/vector-icons` (Ionicons) |

### Backend Server (`server/`)
| Concern | Implementation |
|---|---|
| Runtime | Node.js |
| Framework | Express 4 |
| File upload | multer |
| AI transcription | OpenAI `whisper-1` |
| AI content generation | OpenAI `gpt-4o-mini` |
| Geocoding | Nominatim / OpenStreetMap (no API key required) |
| Server database | PostgreSQL via `pg` (connection pool, async) |
| Password hashing | `bcryptjs` (12 rounds) |
| Rate limiting | `express-rate-limit` (in-memory) |
| Configuration | `server/.env` (gitignored) |
| Hosting | Railway (production); local Node.js for development |

Do not add Redis, Supabase, or Firebase without a specific demonstrated requirement.

---

## Mobile App Structure

```
App.tsx                   — root component; font loading, SafeAreaProvider, AppShell
  AppShell                — screen switcher, bottom nav bar, state passed to screens
    HomeScreen            — photo capture, audio recording, generate trigger
    ResultScreen          — content generation, review UI, publish trigger (stub)
    SettingsScreen        — business profile, connected accounts (stub), local stats
    HistoryScreen         — browse past jobs, copy content

constants/colors.ts       — design token colors (dark navy palette)
screens/                  — one file per screen
storage/database.ts       — all SQLite access; schema, migrations, read/write functions

server/index.js           — entry point; loads .env, calls createApp(), starts listener
server/app.js             — Express app factory (createApp); all middleware + routes
server/db.js              — better-sqlite3 singleton; WAL mode, migrations, getDb/closeDb
server/auth.js            — requireAuth / optionalAuth middleware
server/crypto.js          — AES-256-GCM encrypt/decrypt for credential storage
server/routes/auth.js     — /auth/* endpoints
server/routes/platforms.js — /platforms/* endpoints
server/test/              — node:test + supertest test suite
```

### Navigation pattern

`App.tsx` holds `useState<AppScreen>` and passes callbacks (`onGenerate`, `onBack`, `onShowSettings`) to screens. There is no navigation library. Screens do not navigate themselves — they call parent callbacks.

Home state (`photos`, `audioUri`) is preserved in `savedHomeState` on the `AppShell` so that navigating back from the result screen restores the user's work.

---

## Local Database Schema (expo-sqlite, WAL mode)

**Schema version: 5** — applied in `storage/database.ts → migrate()`

```sql
CREATE TABLE jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft',   -- 'draft' | 'published'
  audio_local_uri TEXT,                            -- device path, nullable after cleanup
  transcription  TEXT,
  post_content   TEXT,    -- Google Business post
  social_content TEXT,    -- social media post (Facebook, Instagram, X, LinkedIn)
  web_content    TEXT,    -- WordPress blog article (markdown)
  job_location   TEXT,
  seo_metadata   TEXT,    -- JSON blob (SeoMetadata type)
  is_mock        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE job_photos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER NOT NULL,
  local_uri      TEXT NOT NULL,     -- device path from camera or photo library
  classification TEXT NOT NULL DEFAULT 'General',  -- General | Before | After | Team
  sort_order     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Settings keys in use:**
- `business_profile` — JSON-encoded `BusinessProfile` object
- `connected_channels` — JSON-encoded `ConnectedChannel[]` (currently always `[]`; no write path exists yet)
- `business_location` — legacy key, migrated into `business_profile` on read

### Data lifecycle

- **Photos**: `local_uri` values in `job_photos` point to original device paths. Photos are not copied into app storage. These URIs may become stale if the OS clears the camera temp directory.
- **Audio**: Copied from recorder temp to `documentDirectory/elmer_recording_${Date.now()}.m4a` at generate time, then copied again to `elmer_jobs/${timestamp}/audio.m4a` at save time. The first copy is not cleaned up (see Known Issues).
- **Published jobs**: `deleteOldPublishedMedia()` removes audio for published jobs older than 30 days. This function exists in `database.ts` but is not currently called from any screen.
- **Drafts**: Never deleted automatically.

---

## Server-Side Database Schema (PostgreSQL)

**Connection:** `DATABASE_URL` environment variable (Railway provides this automatically)  
**Schema version: 1** — applied in `server/db.js → migrate()` on startup; tracked in `schema_migrations` table

```sql
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  created_at    BIGINT  NOT NULL,
  updated_at    BIGINT  NOT NULL
);

CREATE TABLE sessions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT    NOT NULL UNIQUE,      -- 64 hex chars, random
  created_at BIGINT  NOT NULL,
  expires_at BIGINT  NOT NULL
);

CREATE TABLE business_settings (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT  NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  settings_json TEXT    NOT NULL DEFAULT '{}',
  updated_at    BIGINT  NOT NULL
);

CREATE TABLE connected_platforms (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform          TEXT    NOT NULL CHECK(platform IN ('google','facebook','wordpress')),
  account_name      TEXT    NOT NULL,
  account_id        TEXT    NOT NULL,
  access_token_enc  TEXT,   -- AES-256-GCM encrypted hex; NULL until connected
  refresh_token_enc TEXT,   -- AES-256-GCM encrypted hex; NULL if not applicable
  token_expires_at  BIGINT,
  connected_at      BIGINT  NOT NULL,
  updated_at        BIGINT  NOT NULL,
  UNIQUE(user_id, platform, account_id)
);

CREATE TABLE oauth_states (
  id         BIGSERIAL PRIMARY KEY,
  state      TEXT    NOT NULL UNIQUE,   -- 48 hex chars, random; CSRF token
  user_id    BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   TEXT    NOT NULL,
  created_at BIGINT  NOT NULL,
  expires_at BIGINT  NOT NULL,          -- 10 minutes from creation
  used_at    BIGINT                     -- set on first use; NULL = not yet consumed
);

CREATE TABLE publishing_records (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform         TEXT    NOT NULL,
  platform_post_id TEXT,
  job_ref          TEXT,
  status           TEXT    NOT NULL CHECK(status IN ('pending','published','failed')),
  error_message    TEXT,
  published_at     BIGINT,
  created_at       BIGINT  NOT NULL,
  updated_at       BIGINT  NOT NULL
);

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at BIGINT  NOT NULL
);
```

Credential encryption uses AES-256-GCM (12-byte IV + 16-byte auth tag + ciphertext, hex-encoded). The key is loaded from `CREDENTIAL_ENCRYPTION_KEY` (64 hex chars = 32 bytes). Generate with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Authentication API

All session tokens are opaque 64-hex-char random strings stored in the `sessions` table. There are no JWTs.

| Endpoint | Auth required | Description |
|---|---|---|
| `POST /auth/register` | No | Create account; returns `{token, expiresAt}` |
| `POST /auth/login` | No | Verify credentials; returns `{token, expiresAt}` |
| `POST /auth/logout` | Yes | Delete session row |
| `GET /auth/me` | Yes | Returns `{userId, email}` |

**Registration**: validates email format and password ≥ 8 chars; rejects duplicate email with 409.  
**Login**: uses constant-time bcrypt even for unknown users to prevent user enumeration via timing.  
**Session TTL**: `SESSION_TTL_DAYS` env (default 30 days).

---

## Platform Management API

All platform endpoints require a valid Bearer token.

| Endpoint | Description |
|---|---|
| `GET /platforms` | List the caller's connected platforms (credentials excluded) |
| `DELETE /platforms/:id` | Disconnect a platform; 404 if not found or owned by another user |
| `POST /platforms/oauth/state` | Create a CSRF state token for an OAuth flow; body: `{platform}` |
| `POST /platforms/oauth/state/validate` | Validate and consume a state token; body: `{state}` |

**OAuth state**: 48-hex-char random token, 10-minute TTL, single-use. Protects against CSRF in the OAuth callback. Platform must be `google`, `facebook`, or `wordpress`.

---

## Environment Variables

`server/.env` (gitignored — copy from `server/.env.example`):

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | _(required)_ | PostgreSQL connection string; Railway sets this automatically when a DB is linked |
| `OPENAI_API_KEY` | _(none)_ | Required for real transcription/generation; server returns mock without it |
| `PORT` | `3001` | HTTP listen port |
| `SESSION_TTL_DAYS` | `30` | Session lifetime in days |
| `CREDENTIAL_ENCRYPTION_KEY` | _(required for OAuth)_ | 64-char hex string (32 bytes) for AES-256-GCM credential encryption |
| `DISABLE_AUTH` | `false` | Set `true` during local mobile dev before the app sends tokens; **never in production** |
| `GENERATE_RATE_LIMIT` | `10` | Max `/api/generate` requests per IP per 15 min |
| `AUTH_RATE_LIMIT` | `20` | Max `/auth/*` requests per IP per 15 min |
| `DISABLE_RATE_LIMIT` | `false` | Disable all rate limiting (tests only) |
| `FACEBOOK_APP_ID` | _(required for OAuth)_ | Meta App ID — create at https://developers.facebook.com/ |
| `FACEBOOK_APP_SECRET` | _(required for OAuth)_ | Meta App Secret — keep server-side only, never in mobile code |
| `FACEBOOK_REDIRECT_URI` | _(required for OAuth)_ | Must match "Valid OAuth Redirect URIs" in Meta App Dashboard; production: `https://api.getelmer.com/facebook/callback` |
| `FACEBOOK_OAUTH_RETURN_SCHEME` | `elmer` | Custom URI scheme Elmer uses to return from the OAuth browser; must match `scheme` in `app.json` |

---

## Backend: Content Generation Pipeline

**Endpoint:** `POST /api/generate`  
**Health check:** `GET /health`

```
Request (multipart/form-data or JSON):
  audio          — m4a file (optional)
  photoCount     — integer
  classifications — JSON array of classification strings
  gpsCoords      — JSON array of {lat, lng}
  businessName, businessWebsite, businessCategory,
  businessDescription, writingStyle,
  businessServices, serviceAreas — business profile fields
  platforms      — JSON array: ['social', 'google', 'wordpress']

Step 1 — Transcribe audio (Whisper, if audio present)
Step 2 — Extract job info (gpt-4o-mini, JSON mode):
           location, mainService, specificWork, keyTerms
Step 3 — GPS reverse geocode fallback (Nominatim, if no transcription location)
Step 4 — Generate content in parallel (gpt-4o-mini):
           googlePost    (if 'google' in platforms)
           socialPost    (if 'social' in platforms — always included)
           webContent    (if 'wordpress' in platforms)
           seoMetadata   (if 'wordpress' in platforms, JSON mode)

Response:
  mock, transcription, location, mainService,
  googlePost, socialPost, webContent, seoMetadata
```

**Mock mode**: When `OPENAI_API_KEY` is absent, the server returns a hardcoded electrical-panel mock response, clearly labeled `mock: true`. The mobile app shows a banner when displaying mock content.

**Audio handling on the server**: multer writes uploads to `server/tmp/`. The file is renamed to `.m4a`, passed to OpenAI, then deleted. Cleanup happens within the request handler; a crash could leave orphan files in `server/tmp/`.

**Server URL**: `EXPO_PUBLIC_API_URL` environment variable; defaults to `http://localhost:3001`. Must be set to the local machine's LAN IP for physical device testing.

---

## Facebook Integration

### OAuth flow

```
Mobile                          Elmer Server                  Facebook
  │                                  │                              │
  ├─POST /facebook/connect-url ──────►│ creates oauth_state, returns authUrl
  │◄─── { authUrl } ─────────────────┤                              │
  │                                  │                              │
  ├─openAuthSessionAsync(authUrl) ───►│                              │
  │                            browser opens FB OAuth dialog ───────►
  │                                  │◄── GET /facebook/callback?code&state ─┤
  │                                  │  validates state                      │
  │                                  │  exchanges code → user token          │
  │                                  │  exchanges → long-lived token (60d)   │
  │                                  │  GET /me/accounts → page tokens       │
  │                                  │  stores encrypted page tokens in DB   │
  │◄── redirect to elmer://oauth/callback?success=true&page_count=N ─────────┤
  ├─GET /facebook/pages ─────────────►│ returns connected pages
  │◄─── { pages } ───────────────────┤
```

### Publishing flow (multi-photo)

```
1. Mobile → POST /facebook/publish (multipart: message, platform_id, job_id, photo_0…photo_N)
2. Server checks idempotency (publishing_records WHERE job_ref = fb_{userId}_{jobId} AND status='published')
3. Server decrypts page access token from connected_platforms
4. Server inserts publishing_record status='pending'
5. For each photo: POST /{pageId}/photos?published=false → collect media_fbid values
6. POST /{pageId}/feed?message=...&attached_media=[{"media_fbid":"..."},...]
7. Server updates publishing_record to status='published' with platform_post_id
8. Returns { ok: true, postId, postUrl }
```

**Graph API version**: `v21.0`  
**Required permissions**: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`  
**Token lifecycle**: Short-lived user token → long-lived user token (60 days) → page access token (non-expiring for managed pages)

### Facebook Routes

| Endpoint | Auth | Description |
|---|---|---|
| `POST /facebook/connect-url` | Bearer | Returns Facebook OAuth authorization URL + creates CSRF state |
| `GET /facebook/callback` | Public (validates via state) | Facebook redirects here; exchanges code, stores page tokens, redirects to app |
| `GET /facebook/pages` | Bearer | Lists connected pages for user (no tokens in response) |
| `POST /facebook/publish` | Bearer, multipart | Publishes post + photos to selected page; idempotent |

### Meta App Review requirements

| Item | Detail |
|---|---|
| Required permissions | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` |
| OAuth redirect URI | `https://your-domain.com/facebook/callback` (must be HTTPS in production) |
| App type | Business |
| Products | Facebook Login, Pages API |
| Review screencast | Sign in → Settings → Connect Facebook → authorize → select page → create job → Post Everywhere → confirm post appears on page |

---

## Content Types

| Type | Field | Platform target | Generation condition |
|---|---|---|---|
| Social post | `social_content` | Facebook, Instagram, X, LinkedIn | Always generated |
| Google Business post | `post_content` | Google Business Profile | When 'google' in platforms |
| WordPress article | `web_content` | WordPress | When 'wordpress' in platforms |
| SEO metadata | `seo_metadata` (JSON) | WordPress | When 'wordpress' in platforms |

**Current gap**: The Google Business post is generated and saved to `post_content` but is not shown in the ResultScreen UI. Users cannot review it before publishing.

---

## Feature Implementation Status

### Implemented and functional

- Photo selection: camera and photo library, up to 5 photos (`HomeScreen.tsx`)
- Photo classification: General / Before / After / Team, per-photo (`HomeScreen.tsx`)
- GPS EXIF extraction from photo metadata (`HomeScreen.tsx:31`)
- Audio recording and playback (`HomeScreen.tsx`)
- AI transcription via Whisper (`server/index.js`)
- Location extraction from transcription (`server/index.js`)
- Reverse geocode fallback via Nominatim (`server/index.js`)
- Social post generation (`server/index.js`)
- Google Business post generation (server-side; not surfaced in UI)
- WordPress article generation (conditional on WordPress channel)
- SEO metadata generation (conditional on WordPress channel)
- Writing style customization (7 styles)
- Business profile settings with persistence (`SettingsScreen.tsx`)
- Job history: browse, expand, copy content (`HistoryScreen.tsx`)
- Local SQLite persistence with versioned migrations (`storage/database.ts`)
- Request retry: up to 3 attempts with 2-second delay (`ResultScreen.tsx`)
- Home state preservation across back navigation (`App.tsx`)

### Implemented (Phase 1 — backend only, no mobile UI yet)

- User registration, login, logout, session validation (`server/routes/auth.js`)
- Server-side SQLite with WAL mode, foreign keys, versioned migrations (`server/db.js`)
- AES-256-GCM credential encryption at rest (`server/crypto.js`)
- OAuth CSRF state token creation, validation, and single-use consumption (`server/routes/platforms.js`)
- List connected platforms per user (`GET /platforms`)
- Disconnect a platform (`DELETE /platforms/:id`)
- Auth + rate limiting on all externally accessible endpoints (`server/app.js`)
- 52 automated tests: db init (12), auth endpoints (18), platform endpoints (22) (`server/test/`)

### Implemented (Phase 2 partial — Facebook integration)

- **Mobile sign-in/register**: Full sign-in form in SettingsScreen (`SettingsScreen.tsx`); session token stored in local SQLite.
- **Facebook OAuth — server**: `POST /facebook/connect-url` returns authorization URL; `GET /facebook/callback` exchanges code, fetches pages, stores encrypted page tokens; CSRF state validation; redirect to `elmer://oauth/callback` deep link (`server/routes/facebook.js`).
- **Facebook OAuth — mobile**: `openAuthSessionAsync` opens browser; deep link return on dev/production builds; falls back gracefully on Expo Go. (`SettingsScreen.tsx`)
- **Facebook page management**: `GET /facebook/pages` lists connected pages; page selection stored in local settings; reconnect/disconnect UI (`SettingsScreen.tsx`, `server/routes/facebook.js`).
- **Facebook publishing**: `POST /facebook/publish` uploads photos as multipart, stages multi-photo posts as unpublished then creates feed post, handles single-photo and text-only flows, idempotency check via `job_ref`, publishing records saved (`server/routes/facebook.js`).
- **Post Everywhere — mobile**: Connected channels loaded from server when signed in; "Post" button calls `POST /facebook/publish`; publish status (loading/success/error) shown in result footer (`ResultScreen.tsx`).
- **77 new automated tests** covering OAuth state/callback, page ownership, token storage/encryption, text/single-photo/multi-photo publishing, duplicate prevention, failure handling, retry (`server/test/facebook.test.js`; total: 78 tests passing).

### Stub — UI exists but action is a no-op or alert

- **Connect channels — Google** (`SettingsScreen.tsx`): Shows "Coming Soon — awaiting API approval" alert.
- **Connect channels — WordPress** (`SettingsScreen.tsx`): Shows "Coming Soon" alert. Server-side OAuth state infrastructure exists; WordPress-specific flow not implemented.

### Requires live Meta credentials before functional testing

- Facebook OAuth callback requires `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_REDIRECT_URI` in `server/.env`.
- Publishing requires a verified Meta App with `pages_manage_posts` permission and a real Page access token.

### Planned — no implementation exists

- Mobile app authentication (send Bearer token on all API requests; Phase 2)
- Google Business Profile OAuth callback and posting API
- Facebook OAuth callback and Pages posting API
- WordPress REST API publishing
- Cross-device settings synchronization
- Stripe billing and subscription management
- Duplicate publish prevention
- Per-platform publish status tracking
- Push notifications

---

## Testing

```bash
cd server
npm test
# node --test test/db.test.js test/auth.test.js test/platforms.test.js test/facebook.test.js
```

Tests use `pg-mem` (in-memory PostgreSQL emulation) via `server/test/helpers.js → setupFreshTestDb()`. Each test gets a completely fresh, isolated in-memory database with migrations pre-applied. No real PostgreSQL server or `.env` file is required to run tests.

---

## Railway Deployment

### Architecture on Railway

```
GitHub repository
  └── Railway project
        ├── Elmer Server (Node.js service)
        │     Root directory: server/
        │     Start command:  node index.js
        │     Health check:   GET /health
        └── PostgreSQL (Railway-managed database)
              DATABASE_URL → injected into server service automatically
```

### Railway setup steps (one-time)

1. Go to [railway.app](https://railway.app) and create a new project
2. Add a **GitHub** source → connect the `elmer` repository → set **Root Directory** to `server/`
3. Add a **PostgreSQL** database service to the same project
4. In the server service → **Variables** — `DATABASE_URL` auto-populates from the linked database; if not, copy it manually from the PostgreSQL service's **Connect** tab
5. Add remaining required variables: `OPENAI_API_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_REDIRECT_URI`, `DISABLE_AUTH=false`, `NODE_ENV=production`
6. Click **Deploy** — Railway runs `node index.js`; database migrations execute automatically on startup
7. Confirm `GET /health` returns `{"ok":true}` on the provisioned `.up.railway.app` domain
8. In Railway → **Settings** → **Networking** → add custom domain `api.getelmer.com`
9. Add the CNAME DNS record Railway provides at your DNS registrar
10. Wait for HTTPS certificate provisioning (typically < 5 minutes)
11. In Meta App Dashboard → Facebook Login → Settings → add `https://api.getelmer.com/facebook/callback` as a Valid OAuth Redirect URI
12. Set `FACEBOOK_REDIRECT_URI=https://api.getelmer.com/facebook/callback` in Railway variables and redeploy
13. Set `EXPO_PUBLIC_API_URL=https://api.getelmer.com` in the mobile app and rebuild

### Local development with PostgreSQL

```bash
# macOS (Homebrew)
brew install postgresql@16 && brew services start postgresql@16
createdb elmer_dev
# Add to server/.env:
# DATABASE_URL=postgresql://localhost/elmer_dev
cd server && npm start   # migrations run automatically
```

### PostgreSQL backup and restore

```bash
# Backup
pg_dump "$DATABASE_URL" --no-owner --no-acl -Fc -f elmer_backup_$(date +%Y%m%d).dump

# Restore
pg_restore --no-owner --no-acl -d "$TARGET_DATABASE_URL" elmer_backup_YYYYMMDD.dump
```

Railway offers automatic daily backups via the database service → **Backups** tab (paid plans).

---

## Publishing Architecture (Planned)

Each platform must be independently implemented, tested, and deployable. A failure in Google publishing must not affect Facebook publishing.

**Per-platform requirements:**
- Independent OAuth token storage (server-side, encrypted)
- Independent publish endpoint on the server
- Independent status tracking per job per platform (`published`, `failed`, `pending`)
- Independent retry logic
- Idempotency key or check to prevent duplicate posts

**Platform content mapping:**
- Google Business Profile → `post_content` (plain text, no markdown)
- Facebook Pages → `social_content` (plain text)
- WordPress → `web_content` (markdown) + `seo_metadata`

The mobile app must never hold OAuth access tokens or refresh tokens. Credentials live server-side only. The app authenticates to the Elmer backend; the backend authenticates to platform APIs.

---

## Security Constraints

- Provider credentials (Google, Facebook, WordPress) must never be stored on the device or transmitted to the mobile app.
- The server must validate that a request is from an authenticated Elmer user before performing any OAuth exchange or platform publish.
- Passwords are hashed with bcryptjs at 12 rounds. Never store or log plaintext passwords.
- OAuth access tokens and refresh tokens are encrypted at rest with AES-256-GCM. Never store them in plaintext.
- `server/.env` is gitignored. Never commit API keys, secrets, or `CREDENTIAL_ENCRYPTION_KEY`.
- `server/elmer.db` is gitignored. Never commit the database file.
- The `EXPO_PUBLIC_*` namespace is visible to the client bundle. Only non-secret configuration (server URL, feature flags) belongs there.
- `DISABLE_AUTH=true` is for local development only. It must never be set in a production environment.

---

## Known Issues

These are bugs confirmed by audit. They should be fixed before user testing or publishing integration begins.

| Issue | Location | Impact |
|---|---|---|
| "Post Everywhere" is a no-op | `ResultScreen.tsx:234` | Core user action does nothing |
| Google post generated but not shown in UI | `ResultScreen.tsx:71` | Users cannot review Google content |
| `connected_channels` never written | `SettingsScreen.tsx:93` | Platform-specific content never generated for real users |
| Orphaned `elmer_recording_*.m4a` files | `HomeScreen.tsx:273` | Audio files accumulate; never deleted |
| Job status never changes from `draft` | `storage/database.ts` | `deleteOldPublishedMedia` is dead code; history always shows "Draft" |
| `expo-file-system/legacy` import | `HomeScreen.tsx:1`, `ResultScreen.tsx:1` | Deprecation warning; will break in a future SDK |
| `Clipboard` imported from `react-native` (deprecated) | `ResultScreen.tsx:13`, `HistoryScreen.tsx:7` | Replace with `expo-clipboard` |
| `deleteOldPublishedMedia` never called | `storage/database.ts:257` | Published media is never cleaned up |
| Server `tmp/` not cleaned on crash | `server/index.js:17` | Orphan audio files possible on server |

---

## Out of Scope

These will not be introduced without a specific demonstrated requirement and explicit approval:

- Supabase, Firebase, or any BaaS platform
- PostgreSQL or any external relational database
- Redis or any cache layer
- Permanent cloud media storage (photos, audio, recordings)
- Cross-device job synchronization or job backup
- Expo Router or any navigation library migration
