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
    ResultScreen          — content generation, review UI, publish trigger
    SettingsScreen        — business profile, connected accounts, local stats
    HistoryScreen         — browse past jobs, copy content

constants/colors.ts       — design token colors (dark navy palette)
screens/                  — one file per screen
storage/database.ts       — all SQLite access; schema, migrations, read/write functions

server/index.js           — entry point; loads .env, calls createApp(), starts listener
server/app.js             — Express app factory (createApp); all middleware + routes
server/db.js              — PostgreSQL pool, migrations, getPool/closeDb
server/auth.js            — requireAuth / optionalAuth middleware
server/crypto.js          — AES-256-GCM encrypt/decrypt for credential storage
server/routes/auth.js     — /auth/* endpoints
server/routes/platforms.js — /platforms/* endpoints
server/routes/facebook.js — /facebook/* endpoints (OAuth, pages, publish)
server/routes/instagram.js — /instagram/* endpoints (OAuth, publish)
server/routes/media-utils.js — shared image processing (sharp): EXIF, IG prep, composites
server/test/              — node:test + supertest test suite
```

### Navigation pattern

`App.tsx` holds `useState<AppScreen>` and passes callbacks (`onGenerate`, `onBack`, `onShowSettings`) to screens. There is no navigation library. Screens do not navigate themselves — they call parent callbacks.

Home state (`photos`, `audioUri`) is preserved in `savedHomeState` on the `AppShell` so that navigating back from the result screen restores the user's work.

---

## Local Database Schema (expo-sqlite, WAL mode)

**Schema version: 8** — applied in `storage/database.ts → migrate()`

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
  is_featured    INTEGER NOT NULL DEFAULT 0,       -- 1 if this is the featured/cover photo
  sort_order     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Settings keys in use:**
- `business_profile` — JSON-encoded `BusinessProfile` object (fields: `name`, `website`, `inquiryUrl`, `category`, `description`, `writingStyle`, `services`, `serviceAreas`)
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
**Schema version: 2** — applied in `server/db.js → migrate()` on startup; tracked in `schema_migrations` table

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
  selected          BOOLEAN NOT NULL DEFAULT false,  -- user has enabled this page for publishing
  tasks_json        TEXT,                            -- JSON array of page tasks from /me/accounts
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
| `INSTAGRAM_APP_ID` | _(required for OAuth)_ | Same Meta App ID (Instagram uses the same Meta Developer App) |
| `INSTAGRAM_APP_SECRET` | _(required for OAuth)_ | Same Meta App Secret |
| `INSTAGRAM_REDIRECT_URI` | _(required for OAuth)_ | Must match "Valid OAuth Redirect URIs" in Meta App Dashboard; production: `https://api.getelmer.com/instagram/callback` |
| `SERVER_URL` | _(required for Instagram publish)_ | Base URL the IG API uses to fetch prepared images; must be publicly reachable; production: `https://api.getelmer.com` |

---

## Backend: Content Generation Pipeline

**Endpoint:** `POST /api/generate`  
**Health check:** `GET /health`

```
Request (multipart/form-data or JSON):
  audio              — m4a file (optional)
  photoCount         — integer
  classifications    — JSON array of classification strings
  gpsCoords          — JSON array of {lat, lng}
  businessName, businessWebsite, businessInquiryUrl,
  businessCategory, businessDescription, writingStyle,
  businessServices, serviceAreas — business profile fields
  platforms          — JSON array: ['social', 'google', 'wordpress']

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

**Contact URL fallback**: `contactUrl = businessInquiryUrl || businessWebsite`. Used as the call-to-action link in Google Business posts and social posts. If neither is set, no link is appended.

**Server URL**: `EXPO_PUBLIC_API_URL` environment variable; defaults to `http://localhost:3001`. Must be set to the local machine's LAN IP for physical device testing.

---

## Image Processing (server-side)

All image manipulation uses `sharp` (^0.35.5). Processing is non-fatal: if sharp fails (e.g., corrupt file), the server falls back to the original file rather than returning 500.

### Instagram aspect ratio requirements

Instagram Feed requires images with aspect ratio in **[0.8, 1.91]** (4:5 portrait to 1.91:1 landscape).

`prepareForInstagram(inputPath)` in `server/routes/media-utils.js`:
1. Reads EXIF orientation to get effective width/height (EXIF-rotated dimensions)
2. If AR is valid: rotate + cap at 1440×1440 + JPEG 92%
3. If too tall (AR < 0.8, e.g. 9:16): pad left/right to 4:5 on dark background
4. If too wide (AR > 1.91, e.g. panoramic): pad top/bottom to 1.91:1 on dark background

`prepareCarouselForInstagram(inputPaths)`: normalises all carousel images to the same AR (derived from the first image, clamped to [0.8, 1.91]) so Instagram accepts the carousel.

### Before/After composite

When a job has both a **Before** and an **After** photo, `generateBeforeAfterComposite` produces a single 1080×1080 square image:
- Two 537px-wide halves with a 6px dark gap
- Each photo scaled to `contain` within its half (dark background fills gaps)
- SVG "BEFORE" / "AFTER" label overlays at bottom of each half
- Composite leads the media array; remaining General/Team photos follow

### Featured image ordering

`orderWithFeaturedFirst(files, featuredIndex)` moves the starred photo to index 0 of any array before publishing. Mobile sends `featured_index` as a multipart field; server applies ordering before image preparation and API calls.

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

### Publishing flow (multi-page, multi-photo)

```
1. Mobile → POST /facebook/publish (multipart: message, job_id, photo_0…photo_N,
                                     featured_index, classifications)
2. Server applies orderWithFeaturedFirst(photoFiles, featured_index)
3. Server fetches all selected=true pages for the user
4. If none selected → 422 no_pages_selected
5. For each selected page:
   a. Validate CREATE_CONTENT or MANAGE task from tasks_json
   b. Check idempotency (job_ref = fb_{userId}_{jobId}_{accountId} AND status='published')
   c. Decrypt page access token
   d. Insert publishing_record status='pending'
   e. For each photo: POST /{pageId}/photos?published=false → collect media_fbid values
   f. POST /{pageId}/feed?message=...&attached_media=[{"media_fbid":"..."},...]
   g. Update publishing_record to status='published' or 'failed'
6. Returns { ok: anyOk, results: [{pageId, pageName, ok, postId?, postUrl?, duplicate?,
                                    reconnect_required?, error?}] }
```

**Token invalidation**: Facebook error code 190 (revoked/expired token) sets `reconnect_required: true` in the per-page result. The mobile app shows an actionable "Reconnect Facebook" alert.

**Graph API version**: `v21.0`  
**Required permissions**: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`  
**`business_management` rationale**: Required for pages managed via Meta Business Portfolio. Without it, `/me/accounts` returns an empty list for Business Portfolio pages (FB error code 10/200).  
**Token lifecycle**: Short-lived user token → long-lived user token (60 days) → page access token (non-expiring for managed pages)

### Facebook Routes

| Endpoint | Auth | Description |
|---|---|---|
| `POST /facebook/connect-url` | Bearer | Returns Facebook OAuth authorization URL + creates CSRF state |
| `GET /facebook/callback` | Public (validates via state) | Facebook redirects here; exchanges code, stores page tokens (selected=true on first insert), redirects to app |
| `GET /facebook/pages` | Bearer | Lists connected pages with `selected` flag; no tokens in response |
| `POST /facebook/pages/selection` | Bearer | Replace the user's selected-page set; body: `{page_ids: number[]}` |
| `POST /facebook/publish` | Bearer, multipart | Publish to all selected pages; per-page idempotency; returns `results[]` |

**Page selection behavior**: New pages are auto-selected (`selected=true`) on first connect. Reconnecting (`ON CONFLICT`) updates the token but does **not** change `selected` — the user's previous choice is preserved.  
**Error redirect codes**: `no_manageable_pages`, `insufficient_permissions` (FB error codes 10/200), `auth_failed`, `invalid_state`, `state_already_used`, `state_expired`, `missing_params`.

### Meta App Review requirements

| Item | Detail |
|---|---|
| Required permissions | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management` |
| OAuth redirect URI | `https://api.getelmer.com/facebook/callback` (must be HTTPS in production) |
| App type | Business |
| Products | Facebook Login, Pages API |
| Review screencast | Sign in → Settings → Connect Facebook → authorize pages → Manage Pages → select pages → create job → Post Everywhere → confirm post appears on each selected page |

---

## Instagram Integration

### OAuth flow

```
Mobile                          Elmer Server                  Instagram (Meta)
  │                                  │                              │
  ├─POST /instagram/connect-url ─────►│ creates oauth_state, returns authUrl
  │◄─── { authUrl } ─────────────────┤                              │
  ├─openAuthSessionAsync(authUrl) ───►│                              │
  │                            browser opens IG OAuth dialog ───────►
  │                                  │◄── GET /instagram/callback?code&state ─┤
  │                                  │  validates state                       │
  │                                  │  exchanges code → short-lived token    │
  │                                  │  exchanges → long-lived token (60d)    │
  │                                  │  GET /me → account name/id             │
  │                                  │  stores encrypted token in DB          │
  │◄── redirect to elmer://oauth/callback?success=true ──────────────────────┤
```

### Publishing flow

```
1. Mobile → POST /instagram/publish (multipart: caption, job_id, photo_0…photo_N,
                                      featured_index, classifications)
2. Server applies orderWithFeaturedFirst(photoFiles, featured_index)
3. If Before + After classifications present → generateBeforeAfterComposite → prepend composite
4. Run prepareCarouselForInstagram on all photos (EXIF-correct, AR normalise, JPEG)
5. Upload each image to tmpdir; serve via GET /instagram/media/:filename
6. Single photo: POST /media (IMAGE type) → wait for FINISHED status → POST /media_publish
7. Multiple photos: POST /media for each (IMAGE) → POST /media (CAROUSEL_ALBUM) → /media_publish
8. Delete temp files; return { ok, postId?, postUrl? }
```

**Graph API version**: `v21.0`  
**Required permissions**: `instagram_basic`, `instagram_content_publish`  
**Token lifecycle**: Short-lived user token → long-lived user token (60 days); renewed on reconnect  
**Image URL delivery**: Server temporarily serves prepared images via `GET /instagram/media/:filename`; deleted after publish attempt

### Instagram Routes

| Endpoint | Auth | Description |
|---|---|---|
| `POST /instagram/connect-url` | Bearer | Returns Instagram OAuth authorization URL + creates CSRF state |
| `GET /instagram/callback` | Public (validates via state) | Instagram redirects here; exchanges code, stores token, redirects to app |
| `GET /instagram/profile` | Bearer | Returns connected IG account info |
| `GET /instagram/media/:filename` | Public (short-lived) | Serves temp-prepared images for IG API upload; deleted post-publish |
| `POST /instagram/publish` | Bearer, multipart | Publishes single photo or carousel; returns `{ ok, postId?, postUrl? }` |

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

### Implemented (Phase 2 — Facebook + Instagram integration)

- **Mobile sign-in/register**: Full sign-in form in SettingsScreen (`SettingsScreen.tsx`); session token stored in SecureStore/SQLite.
- **Facebook OAuth — server**: `POST /facebook/connect-url` returns authorization URL with `business_management` scope; `GET /facebook/callback` exchanges code, fetches pages via `/me/accounts`, stores encrypted page tokens with `selected=true`; CSRF state validation; redirect to `elmer://oauth/callback` deep link (`server/routes/facebook.js`).
- **Facebook OAuth — mobile**: `openAuthSessionAsync` opens browser; deep link return on dev/production builds; falls back gracefully on Expo Go; handles `insufficient_permissions` and `no_manageable_pages` error codes with specific alerts and Reconnect option (`SettingsScreen.tsx`).
- **Facebook multi-page management**: `GET /facebook/pages` lists connected pages with `selected` flag; `POST /facebook/pages/selection` replaces the selection set; Manage Pages UI with per-page checkboxes; reconnect/disconnect UI; one-time multi-page warning alert (`SettingsScreen.tsx`, `server/routes/facebook.js`).
- **Facebook multi-page publishing**: `POST /facebook/publish` publishes to all selected pages independently; per-page idempotency key includes Facebook account ID; partial success preserved; `tasks_json` used to validate `CREATE_CONTENT`/`MANAGE` permission; featured-image ordering applied; photos re-read per page (`server/routes/facebook.js`).
- **Facebook token invalidation**: Error code 190 → `reconnect_required: true` in per-page result → mobile shows "Reconnect Facebook" alert (`server/routes/facebook.js`, `ResultScreen.tsx`).
- **Instagram OAuth — server + mobile**: Full OAuth flow using `instagram_basic` + `instagram_content_publish` scopes; encrypted token stored in DB; same deep-link return pattern as Facebook (`server/routes/instagram.js`, `SettingsScreen.tsx`).
- **Instagram publishing**: Single photo and carousel (up to 10); automatic EXIF correction and AR fitting to [0.8, 1.91]; Before/After composite generation when both labels present; featured-image ordering; images served temporarily from server for IG API upload (`server/routes/instagram.js`).
- **Featured image**: Star toggle in photo modal replaces Destination field; star indicator on thumbnail; first photo auto-featured; promoted to next on deletion; `is_featured` persisted in `job_photos` (schema v8); `featured_index` sent with publish requests (`HomeScreen.tsx`, `storage/database.ts`).
- **Inquiry URL**: `BusinessProfile.inquiryUrl` field; `contactUrl = inquiryUrl || website` fallback used as CTA link in Google Business and social posts; SettingsScreen field (`SettingsScreen.tsx`, `server/app.js`).
- **Post Everywhere — mobile**: Connected channels loaded from server; publishes to Facebook pages and Instagram independently; per-page results shown in result footer (`ResultScreen.tsx`).
- **148 automated tests** (DB, auth, platforms, Facebook, Instagram, media-utils) — all passing (`server/test/`).

### Stub — UI exists but action is a no-op or alert

- **Connect channels — Google** (`SettingsScreen.tsx`): Shows "Coming Soon — awaiting API approval" alert.
- **Connect channels — WordPress** (`SettingsScreen.tsx`): Shows "Coming Soon" alert. Server-side OAuth state infrastructure exists; WordPress-specific flow not implemented.

### Requires live Meta credentials before functional testing

- Facebook OAuth callback requires `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_REDIRECT_URI` in `server/.env`.
- Publishing requires a verified Meta App with `pages_manage_posts` permission and a real Page access token.

### Planned — no implementation exists

- Google Business Profile OAuth callback and posting API
- WordPress REST API publishing
- Cross-device settings synchronization
- Stripe billing and subscription management
- Push notifications

---

## Testing

```bash
cd server
npm test
# node --test test/db.test.js test/auth.test.js test/platforms.test.js test/facebook.test.js test/instagram.test.js test/media-utils.test.js
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
| Google post generated but not shown in UI | `ResultScreen.tsx` | Users cannot review Google content before publishing |
| `connected_channels` never written | `SettingsScreen.tsx` | Platform-specific content never generated for real users |
| Orphaned `elmer_recording_*.m4a` files | `HomeScreen.tsx` | Audio files accumulate; never deleted |
| Job status never changes from `draft` | `storage/database.ts` | `deleteOldPublishedMedia` is dead code; history always shows "Draft" |
| `expo-file-system/legacy` import | `HomeScreen.tsx:1`, `ResultScreen.tsx:1` | Deprecation warning; will break in a future SDK |
| `Clipboard` imported from `react-native` (deprecated) | `ResultScreen.tsx`, `HistoryScreen.tsx` | Replace with `expo-clipboard` |
| `deleteOldPublishedMedia` never called | `storage/database.ts` | Published media is never cleaned up |
| Server `tmp/` not cleaned on crash | `server/index.js` | Orphan audio files possible on server |
| Instagram temp media files not cleaned on crash | `server/routes/instagram.js` | Temp `_ig.jpg` / `_carousel.jpg` files may persist if process exits mid-publish |

---

## Out of Scope

These will not be introduced without a specific demonstrated requirement and explicit approval:

- Supabase, Firebase, or any BaaS platform
- PostgreSQL or any external relational database
- Redis or any cache layer
- Permanent cloud media storage (photos, audio, recordings)
- Cross-device job synchronization or job backup
- Expo Router or any navigation library migration
