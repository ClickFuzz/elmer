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
server/routes/threads.js  — /threads/* endpoints (OAuth, publish, Meta callbacks)
server/routes/wordpress.js — /wordpress/* endpoints (connect, callback, sites, publish)
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
**Schema version: 13** — applied in `server/db.js → migrate()` on startup; tracked in `schema_migrations` table

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
  platform_user_id  TEXT,                            -- V12: Meta app-scoped user ID (Facebook/IG); NULL for existing rows and non-Meta platforms
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

CREATE TABLE deletion_requests (
  id                  BIGSERIAL PRIMARY KEY,
  platform            TEXT    NOT NULL,
  confirmation_code   TEXT    NOT NULL UNIQUE,
  status              TEXT    NOT NULL DEFAULT 'pending',  -- pending | completed | failed | no_data
  connections_deleted INTEGER NOT NULL DEFAULT 0,
  records_deleted     INTEGER NOT NULL DEFAULT 0,
  created_at          BIGINT  NOT NULL,
  completed_at        BIGINT
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
| `THREADS_APP_ID` | _(required for Threads OAuth)_ | Threads App ID from Meta Developer Dashboard (separate from Facebook/Instagram) |
| `THREADS_APP_SECRET` | _(required for Threads OAuth)_ | Threads App Secret — keep server-side only, never in mobile code; also used to validate uninstall/delete callbacks |
| `THREADS_REDIRECT_URI` | _(required for Threads OAuth)_ | Must match "Valid OAuth Redirect URIs" in Meta App Dashboard; production: `https://api.getelmer.com/threads/callback` |
| `SERVER_URL` | _(required for Instagram/Threads publish)_ | Base URL the IG/Threads API uses to fetch prepared images; must be publicly reachable; production: `https://api.getelmer.com` |
| `WORDPRESS_CALLBACK_URL` | `https://api.getelmer.com/wordpress/callback` | WordPress Application Password authorization callback URL; must match `success_url` registered with each WordPress site |

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
Step 2 — Extract content context (gpt-4o-mini, JSON mode):
           location, contentIntent, primarySubject, mainService,
           specificWork, people, organizations, meaningfulFacts,
           explicitUrls, ctaHint, keyTerms
Step 3 — GPS reverse geocode fallback (Nominatim, if no transcription location)
Step 4 — Build content brief + CTA block from extracted context
Step 5 — Generate content in parallel (gpt-4o-mini):
           googlePost    (if 'google' in platforms)
           socialPost    (if 'social' in platforms — always included)
           webContent    (if 'wordpress' in platforms)
           seoMetadata   (if 'wordpress' in platforms, JSON mode)

Response:
  mock, transcription, location, mainService,
  googlePost, socialPost, webContent, seoMetadata
```

### Content generation philosophy

Elmer serves all types of publishing businesses — contractors, agencies, ecommerce brands, creators, wellness providers, real estate, and more. Prompts are universal; no contractor assumptions.

**Core principle**: preserve what the user wants to say, improve how they say it, optimize for the destination.

**Full transcript guarantee**: The complete Whisper transcript always reaches every generation prompt as the primary source. Structured extraction supplements but never replaces it.

**Content brief**: Each generation prompt receives a rich content brief alongside the transcript, including named people and their contributions, organizations/clients distinct from the publisher, human details (observations, humor, anecdotes, seasonal notes), and explicit URLs from the transcript.

### CTA selection (`buildCtaBlock`)

The CTA block is injected into every generation prompt. It keeps the publisher's URL separate from any client/subject URLs extracted from the transcript, preventing publisher website being presented as a client's URL.

Priority: `businessInquiryUrl` > `businessWebsite` > natural non-link CTA > none.

When `primarySubject` differs from the publishing business name, the prompt explicitly names both and directs the primary CTA to the publisher's contact URL.

**Mock mode**: When `OPENAI_API_KEY` is absent, the server returns a hardcoded electrical-panel mock response, clearly labeled `mock: true`. The mobile app shows a banner when displaying mock content.

**Audio handling on the server**: multer writes uploads to `server/tmp/`. The file is renamed to `.m4a`, passed to OpenAI, then deleted. Cleanup happens within the request handler; a crash could leave orphan files in `server/tmp/`.

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
| `GET /facebook/callback` | Public (validates via state) | Facebook redirects here; exchanges code, fetches `/me` for `platform_user_id`, stores page tokens (selected=true on first insert), redirects to app |
| `GET /facebook/pages` | Bearer | Lists connected pages with `selected` flag; no tokens in response |
| `POST /facebook/pages/selection` | Bearer | Replace the user's selected-page set; body: `{page_ids: number[]}` |
| `POST /facebook/publish` | Bearer, multipart | Publish to all selected pages; per-page idempotency; returns `results[]` |
| `POST /facebook/uninstall` | Public (signed_request) | Meta deauthorize callback; validates HMAC-SHA256 signed_request, resolves user via `platform_user_id` (with debug_token backfill for legacy NULL rows), removes Facebook connections |
| `POST /facebook/delete` | Public (signed_request) | Meta data deletion callback; validates signed_request; resolves identity via phase-1 direct lookup + phase-2 debug_token backfill; atomically deletes connections + publishing records; persists status in `deletion_requests`; returns `{ url, confirmation_code }` |
| `GET /facebook/deletion-status` | Public | Queries `deletion_requests` by `?code=` param and returns accurate status (completed / pending / no_data / failed / not found); no personal data exposed |

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
| `GET /instagram/callback` | Public (validates via state) | Instagram redirects here; exchanges code, stores token (account_id = Instagram user ID), redirects to app |
| `GET /instagram/profile` | Bearer | Returns connected IG account info |
| `GET /instagram/media/:filename` | Public (short-lived) | Serves temp-prepared images for IG API upload; deleted post-publish |
| `POST /instagram/publish` | Bearer, multipart | Publishes single photo or carousel; returns `{ ok, postId?, postUrl? }` |
| `POST /instagram/uninstall` | Public (signed_request) | Meta deauthorize callback; validates HMAC-SHA256 signed_request, removes Instagram connection for the verified user |
| `POST /instagram/delete` | Public (signed_request) | Meta data deletion callback; validates signed_request; atomically deletes connection + publishing records; persists status in `deletion_requests`; returns `{ url, confirmation_code }` |
| `GET /instagram/deletion-status` | Public | Queries `deletion_requests` by `?code=` param and returns accurate status; no personal data exposed |

---

## Threads Integration

### OAuth flow

```
Mobile                          Elmer Server                  Threads (Meta)
  │                                  │                              │
  ├─POST /threads/connect-url ───────►│ creates oauth_state, returns authUrl
  │◄─── { authUrl } ─────────────────┤                              │
  ├─openAuthSessionAsync(authUrl) ───►│                              │
  │                            browser opens Threads OAuth dialog ──►
  │                                  │◄── GET /threads/callback?code&state ──┤
  │                                  │  validates state                      │
  │                                  │  exchanges code → short-lived token   │
  │                                  │  exchanges → long-lived token (60d)   │
  │                                  │  GET /me → username/id                │
  │                                  │  stores encrypted token in DB         │
  │◄── redirect to elmer://oauth/callback?platform=threads&success=true ─────┤
```

### Publishing flow

```
1. Mobile → POST /threads/publish (multipart: text, job_id, photo_0…photo_N [optional],
                                    featured_index, classifications)
2. Server applies orderWithFeaturedFirst(photoFiles, featured_index)
3. If Before + After classifications present → generateBeforeAfterComposite → prepend composite
4. If photos present: run prepareForInstagram / prepareCarouselForInstagram (same AR requirements)
5. Stage images via GET /threads/media/:filename (same temporary HTTPS serving pattern)
6. Text-only: POST /{userId}/threads (media_type=TEXT) → POST /{userId}/threads_publish
7. Single image: POST /{userId}/threads (media_type=IMAGE) → threads_publish
8. Carousel: POST /{userId}/threads per child (is_carousel_item=true) →
             POST /{userId}/threads (media_type=CAROUSEL, children=...) → threads_publish
9. Delete temp files; return { ok, postId?, postUrl? }
```

**Graph API base**: `https://graph.threads.net/v1.0/`  
**Authorization URL**: `https://threads.net/oauth/authorize`  
**Token exchange**: `POST https://graph.threads.net/oauth/access_token`  
**Long-lived token**: `GET https://graph.threads.net/access_token?grant_type=th_exchange_token`  
**Token refresh**: `GET https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token`  
**Required permissions**: `threads_basic`, `threads_content_publish`  
**Token lifecycle**: Short-lived user token → long-lived user token (60 days); renewed on reconnect

### Threads Routes

| Endpoint | Auth | Description |
|---|---|---|
| `POST /threads/connect-url` | Bearer | Returns Threads OAuth authorization URL + creates CSRF state |
| `GET /threads/callback` | Public (validates via state) | Threads redirects here; exchanges code, stores token, redirects to app |
| `GET /threads/account` | Bearer | Returns connected Threads account info |
| `GET /threads/media/:filename` | Public (short-lived) | Serves temp-prepared images for Threads API upload; deleted post-publish |
| `POST /threads/publish` | Bearer, multipart | Publishes text, single image, or carousel; returns `{ ok, postId?, postUrl? }` |
| `POST /threads/uninstall` | Public (signed_request) | Meta deauthorize callback; validates HMAC-SHA256 signed_request, removes connection |
| `POST /threads/delete` | Public (signed_request) | Meta data deletion callback; validates signed_request; atomically deletes connection + publishing records; persists status in `deletion_requests`; returns `{ url, confirmation_code }` |
| `GET /threads/deletion-status` | Public | Queries `deletion_requests` by `?code=` param and returns accurate status; no personal data exposed |

**Callback validation**: Both `/threads/uninstall` and `/threads/delete` authenticate via `signed_request` — a dot-separated `base64url(HMAC-SHA256-sig).base64url(JSON-payload)` string computed with `THREADS_APP_SECRET`. Validated using `crypto.timingSafeEqual` to prevent timing attacks.  
**Token revocation**: API error code 190 → `reconnect_required: true` in publish response; mobile shows "Reconnect Threads" alert.

---

## WordPress Integration

### Connection flow (Application Passwords)

WordPress uses the built-in Application Passwords authorization flow (available since WP 5.6). There is no OAuth server — instead, the user grants the app a named application password via a browser-based WordPress admin dialog.

```
Mobile                          Elmer Server                  WordPress Site
  │                                  │                              │
  ├─POST /wordpress/connect-url ─────►│ validates URL (HTTPS, SSRF check)
  │                                  │ checks /wp-json/ for app-password support
  │                                  │ creates oauth_state, builds authorize URL
  │◄─── { authUrl } ─────────────────┤                              │
  ├─openAuthSessionAsync(authUrl) ───►│                              │
  │                    browser opens /wp-admin/authorize-application.php ──►
  │                                  │◄── GET /wordpress/callback?user_login=&password=&site_url= ──┤
  │                                  │  consumes state (FOR UPDATE, single-use)
  │                                  │  re-checks SSRF on returned site_url
  │                                  │  verifies credentials via GET /wp-json/wp/v2/users/me
  │                                  │  checks publish_posts capability
  │                                  │  encrypts {userLogin, password} JSON (AES-256-GCM)
  │                                  │  upserts connected_platforms row
  │◄── redirect to elmer://oauth/callback?platform=wordpress&success=true ─┤
```

**URL validation**: `normalizeWordPressUrl` strips paths (connection is per-site, not per-page), enforces HTTPS, and blocks private IP ranges via `isPrivateHost` (localhost, 127.x, 10.x, 192.168.x, 172.16–31.x, 169.254.x, ::1, fd00:/8 ULA, fe80: link-local).

**Site verification**: `checkWordPressInstallation` fetches `GET /wp-json/` and confirms `authentication['application-passwords']` is present in the response. Times out at 8 seconds.

**Credential verification**: `verifyWordPressCredentials` calls `GET /wp-json/wp/v2/users/me` with Basic auth. Confirms `capabilities.publish_posts` or `capabilities.edit_posts` is truthy.

**Multiple sites**: Each WordPress site is stored as an independent `connected_platforms` row. Users can connect multiple sites; each is an independent publishing destination.

### Publishing flow

```
1. Mobile → POST /wordpress/publish (multipart: title, content, job_id, wp_site_id,
                                      featured_index, classifications, seo_slug,
                                      seo_excerpt, photo_0…photo_N)
2. Server loads site credentials (decrypt {userLogin, password} from connected_platforms)
3. Idempotency check: job_ref = wp_{userId}_{jobId}_{siteId}; skip if already published
4. Upload each photo to /wp-json/wp/v2/media (raw JPEG, Basic auth)
5. Set featured photo as featured_media on the post
6. Convert markdown content → HTML (markdownToHtml)
7. Embed non-featured photos as <figure class="wp-block-image"> blocks after every 2nd section
8. POST /wp-json/wp/v2/posts: {title, content, status:'publish', featured_media, slug, excerpt}
9. Record result in publishing_records; return { ok, postId?, postUrl? }
```

**Markdown → HTML**: Block-based converter (split on `\n{2,}`). Supports `# `, `## `, `### ` headings, paragraphs, `**bold**`, `*italic*`, HTML entity escaping. Keeps content as markdown in the mobile app (for display and editing); converts only at publish time.

**Image embedding**: Featured photo → `featured_media` field. Additional photos distributed as `<figure>` blocks inserted after every 2nd h2/h3 section heading to break up long articles naturally.

**Title**: Mobile sends an editable title field (pre-populated by `extractMarkdownTitle` from the first heading in the article, falling back to `seoMetadata.seoTitle`).

### Disconnect

`DELETE /wordpress/sites/:id` makes a best-effort attempt to revoke the Application Password via the WP REST API (fetch list → find by name 'Elmer' → DELETE by UUID), then deletes the `connected_platforms` row regardless of revocation success.

### WordPress Routes

| Endpoint | Auth | Description |
|---|---|---|
| `POST /wordpress/connect-url` | Bearer | Validates WP site URL, checks REST API + Application Passwords support, creates CSRF state, returns `authorize-application.php` URL |
| `GET /wordpress/callback` | Public (validates via state) | WordPress redirects here with credentials; verifies, encrypts, stores; redirects to app |
| `GET /wordpress/sites` | Bearer | Lists the user's connected WordPress sites (credentials excluded) |
| `DELETE /wordpress/sites/:id` | Bearer | Best-effort revoke Application Password, then delete site from DB |
| `POST /wordpress/publish` | Bearer, multipart | Upload media, convert markdown→HTML, create post; idempotency via `publishing_records` |

**No new DB migration required**: `connected_platforms.platform` already includes `'wordpress'` in the CHECK constraint (added in V3 migration alongside `'google'` and `'facebook'`).  
**Credential storage**: `{userLogin, password}` JSON serialized, then AES-256-GCM encrypted; stored in `access_token_enc`. No separate refresh token.  
**SSRF protection**: Applied on both the initial connect-url request and again on the callback's returned `site_url` to prevent redirect-based SSRF.

---

## Google Business Profile Integration

### OAuth flow

```
Mobile                          Elmer Server                  Google OAuth
  │                                  │                              │
  ├─POST /google/connect-url ────────►│ creates oauth_state, returns authUrl
  │◄─── { authUrl } ─────────────────┤                              │
  ├─openAuthSessionAsync(authUrl) ───►│                              │
  │                          browser opens Google consent screen ───►
  │                                  │◄── GET /google/callback?code&state ──┤
  │                                  │  validates + consumes state           │
  │                                  │  exchanges code → access + refresh tokens
  │                                  │  GET /v1/accounts → list accounts     │
  │                                  │  GET /v1/{account}/locations → locs   │
  │                                  │  stores each location as connected_platforms row
  │◄── redirect to elmer://oauth/callback?platform=google&success=true&location_count=N ─┤
  ├─GET /google/locations ───────────►│ returns connected locations
  │◄─── { locations } ───────────────┤
```

### Publishing flow

```
1. Mobile → POST /google/publish (multipart: message, job_id, featured_index,
                                   classifications, business_url [optional],
                                   photo_0…photo_N [optional])
2. Server loads all selected=true Google locations for the user
3. If none selected → 422 no_locations_selected
4. For each selected location:
   a. getValidToken(userId, pool) — proactive refresh if < 5 min until expiry
   b. Check idempotency: job_ref = gbp_{userId}_{jobId}_{sanitized_locationPath}
   c. Insert publishing_record status='pending'
   d. Upload each photo: copy to tmp, serve via GET /google/media/:filename
   e. POST /{locationPath}/localPosts — summary (≤1500 chars), optional LEARN_MORE CTA, optional media array
   f. On 401: _doRefresh → retry once
   g. Update publishing_record to status='published' or 'failed'
   h. Delete temp photo files
5. Returns { ok: anyOk, results: [{locationName, ok, postId?, postUrl?,
                                    reconnect_required?, duplicate?, error?}] }
```

**APIs used:**
- Account Management: `https://mybusinessaccountmanagement.googleapis.com/v1/accounts`
- Business Information: `https://mybusinessbusinessinformation.googleapis.com/v1/{account}/locations`
- Local Posts (v4): `https://mybusiness.googleapis.com/v4/{locationPath}/localPosts`

**Token lifecycle**: `access_type=offline&prompt=consent` forces refresh token on first authorization. Access tokens expire in 1 hour; proactively refreshed when < 5 minutes until expiry. Reactive 401 retry with single re-refresh. All rows for the same Google account are updated together (tokens are per-account, not per-location).

**Location storage**: each location stored as a separate `connected_platforms` row. `account_id` = full location path `accounts/{accountId}/locations/{locationId}`. All locations from the same OAuth consent share the same access/refresh tokens, updated atomically.

**Image delivery**: GBP local posts accept `sourceUrl` in the `media` array. Server copies prepared images to `server/tmp/`, serves them at `GET /google/media/:filename` (public, short-lived), then deletes them after publish.

**Summary limit**: GBP local post `summary` field is capped at 1500 characters. Truncation applied server-side with `…` suffix if needed.

**Optional CTA**: When `business_url` is provided, a `LEARN_MORE` call-to-action is appended to the local post.

**No new DB migration**: `connected_platforms.platform` CHECK constraint already includes `'google'` (V3 migration). `refresh_token_enc` column already exists.

### Google Business Profile Routes

| Endpoint | Auth | Description |
|---|---|---|
| `POST /google/connect-url` | Bearer | Creates CSRF state, returns Google OAuth authorization URL |
| `GET /google/callback` | Public (validates via state) | Google redirects here; exchanges code, fetches accounts + locations, stores encrypted tokens, redirects to app |
| `GET /google/locations` | Bearer | Lists connected GBP locations with `selected` flag |
| `POST /google/locations/selection` | Bearer | Replace the user's selected-location set; body: `{location_ids: number[]}` |
| `GET /google/media/:filename` | Public (short-lived) | Serves temp photos for GBP API `sourceUrl`; deleted post-publish |
| `POST /google/publish` | Bearer, multipart | Publishes local post to all selected locations; idempotency via `publishing_records`; token auto-refresh |

**Required scopes**: `https://www.googleapis.com/auth/business.manage`  
**Google Cloud Project**: `elmer-511511`  
**Required APIs (enable in GCP console)**: My Business API, My Business Account Management API, My Business Business Information API  
**OAuth redirect URI**: `https://api.getelmer.com/google/callback` (add to authorized redirect URIs in GCP OAuth 2.0 client)  
**Token invalidation**: HTTP 401 from GBP API → `reconnect_required: true` in per-location result → mobile shows "Reconnect Google" alert

---

## Content Types

| Type | Field | Platform target | Generation condition |
|---|---|---|---|
| Social post | `social_content` | Facebook, Instagram, X, LinkedIn | Always generated |
| Google Business post | `post_content` | Google Business Profile | When 'google' in platforms |
| WordPress article | `web_content` | WordPress | When 'wordpress' in platforms |
| SEO metadata | `seo_metadata` (JSON) | WordPress | When 'wordpress' in platforms |

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
- Google Business post generation (surfaced in ResultScreen platform variations tab)
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
- **Post Everywhere — mobile**: Connected channels loaded from server; publishes to Facebook pages, Instagram, and Threads independently; per-page results shown in result footer (`ResultScreen.tsx`).
- **Threads OAuth — server + mobile**: Full OAuth flow using `threads_basic` + `threads_content_publish` scopes; encrypted token stored in DB; same deep-link return pattern as Facebook/Instagram (`server/routes/threads.js`, `SettingsScreen.tsx`).
- **Threads publishing**: Text-only posts, single-image posts, and carousels (up to 20); automatic image preparation using same EXIF/AR pipeline as Instagram; Before/After composite generation; featured-image ordering; images served temporarily from server for Threads API upload (`server/routes/threads.js`).
- **Threads deauthorize callback**: `POST /threads/uninstall` — validates Meta's HMAC-SHA256 `signed_request`, removes the Threads platform connection (`server/routes/threads.js`).
- **Threads data deletion callback**: `POST /threads/delete` — validates signed_request, deletes Threads-associated data atomically, persists status in `deletion_requests`, returns `{ url, confirmation_code }` as required by Meta; status page at `GET /threads/deletion-status` queries by confirmation code (`server/routes/threads.js`).
- **Meta deletion request persistence** (V13 migration): New `deletion_requests` table stores confirmation codes, status (`pending`/`completed`/`failed`/`no_data`), deletion counts, and timestamps for all three Meta platforms. Status URLs query this table by `?code=` so callers get accurate deletion outcomes rather than a static page.
- **Facebook legacy identity backfill**: `findAndBackfillFbConnections` — resolves NULL `platform_user_id` rows using the Facebook `/debug_token` API. Phase 1 does a direct lookup; Phase 2 calls debug_token for each legacy NULL row to discover and backfill the owning user ID, then matches the requester. `no_data` status is returned when any debug_token call fails (network error), ensuring honest non-completion reporting. `account_id` (Page ID) is never overwritten.
- **205 automated tests** (DB, auth, platforms, Facebook, Instagram, Threads, media-utils, generation) — all passing (`server/test/`).

### Implemented (Phase 3 — WordPress integration)

- **WordPress connection — server**: `POST /wordpress/connect-url` validates site URL (HTTPS + SSRF guard), checks `/wp-json/` for Application Password support, creates CSRF state token, returns `authorize-application.php` URL; `GET /wordpress/callback` consumes state (FOR UPDATE), re-validates SSRF on returned site_url, verifies credentials via `/wp-json/wp/v2/users/me`, checks `publish_posts` capability, encrypts `{userLogin, password}` JSON (AES-256-GCM), upserts `connected_platforms` (`server/routes/wordpress.js`).
- **WordPress connection — mobile**: URL input form in SettingsScreen; `openAuthSessionAsync` opens browser; deep-link return to `elmer://oauth/callback`; handles success/error codes; lists connected sites with Disconnect and "Add Another Site" (`SettingsScreen.tsx`).
- **WordPress multi-site management**: `GET /wordpress/sites` lists sites; `DELETE /wordpress/sites/:id` revokes Application Password (best-effort) then removes from DB; each site is an independent publishing destination (`server/routes/wordpress.js`, `SettingsScreen.tsx`).
- **WordPress publishing**: `POST /wordpress/publish` — uploads photos to WP Media Library, sets featured photo as `featured_media`, converts markdown → HTML (`markdownToHtml`), embeds non-featured photos as `<figure>` blocks distributed after every 2nd section heading, creates published post; per-site idempotency key `wp_{userId}_{jobId}_{siteId}` (`server/routes/wordpress.js`).
- **WordPress publish — mobile**: Editable article title input in ResultScreen (pre-populated from first heading or seoMetadata.seoTitle); `runWordpressPublish` iterates over connected WP sites independently; per-site result shown in result footer (`ResultScreen.tsx`).
- **276 automated tests** (DB, auth, platforms, Facebook, Instagram, Threads, media-utils, generation, WordPress) — all passing (`server/test/`).

### Implemented (Phase 4 — Stripe billing)

- **V5 DB migration**: `stripe_customers` (user ↔ Stripe customer mapping) and `subscriptions` (status, trial dates, `trial_used` sticky flag) tables (`server/db.js`).
- **Billing routes** (`server/routes/billing.js`):
  - `GET /billing/subscription` — returns current subscription status and `hasAccess` flag
  - `POST /billing/checkout-session` — creates Stripe Checkout session; 409 if already subscribed; 503 if `STRIPE_SECRET_KEY` not set
  - `POST /billing/portal-session` — creates Stripe Customer Portal session for managing/canceling
  - `GET /billing/checkout-return` — Stripe success/cancel redirect; bridges to `elmer://billing/return` deep link
  - `POST /billing/webhook` — receives Stripe events; verifies HMAC-SHA256 signature in production; handles `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid/payment_failed`
- **US-only restriction**: `checkout.session.completed` webhook cancels the subscription if `customer_details.address.country !== 'US'`.
- **`trial_used` sticky**: upsert uses `CASE WHEN … THEN true ELSE trial_used END` so `trial_used` can only go `false → true`, never reversed; prevents re-granting a free trial after cancellation.
- **Entitlement check** (`requireSubscription` middleware): `trialing`/`active` = full access; `past_due` within a 3-day grace period = full access; all other statuses = 402. Guards `/api/generate` and all platform publish endpoints.
- **`hasAccess` exported** for server-side use and unit testing.
- **Checkout flow — iOS**: disclosure Alert before leaving the app (`Linking.openURL`); no StoreKit or external-purchase-link entitlement required — Elmer is US-only and Apple's App Review Guideline 3.1.1(a) (updated October 16, 2026) does not require an entitlement for US storefront apps linking to external purchase pages.
- **Checkout flow — Android**: uses `Linking.openURL()` directly. Google Play Billing is not used; Elmer sells only access to an external backend service, not in-app digital goods, so the Google Play Billing policy exemption for SaaS applies.
- **SubscriptionScreen** (`screens/SubscriptionScreen.tsx`): trial offer card (14 days free / $19/month); starts checkout via `Linking.openURL`; polls `GET /billing/subscription` every 2 s (up to 15 attempts) on return from browser; shows manage/portal card for existing subscribers; deep-link listener for `elmer://billing/return`.
- **App.tsx subscription gate**: fetches subscription status after auth token found; shows loading spinner; blocks app access (shows SubscriptionScreen) until `hasAccess = true`; `onManageSubscription` callback from SettingsScreen.
- **SettingsScreen**: "Subscription" row in Elmer Account card navigates to SubscriptionScreen.
- **308 automated tests** (all prior + 32 billing tests) — all passing (`server/test/`).

### Implemented (Phase 5 — Google Business Profile integration)

- **GBP OAuth — server**: `POST /google/connect-url` creates CSRF state, returns Google authorization URL; `GET /google/callback` exchanges code, fetches all accounts + locations via My Business Account Management + Business Information APIs, stores encrypted access + refresh tokens, one row per location; redirect to `elmer://oauth/callback?platform=google&success=true` (`server/routes/google.js`).
- **GBP OAuth — mobile**: "Coming Soon" stub replaced with full Connect / Manage UI; `openAuthSessionAsync` opens browser; deep-link return; lists connected locations with checkbox selection; Disconnect option; Reconnect alert on token invalidation (`SettingsScreen.tsx`).
- **GBP location selection**: `GET /google/locations` lists locations with `selected` flag; `POST /google/locations/selection` replaces selection set; mobile renders per-location checkboxes in Manage Locations sheet.
- **GBP token refresh**: proactive refresh when < 5 minutes until expiry; reactive 401 retry with single re-refresh; `UPDATE ... WHERE user_id = $1 AND platform = 'google'` keeps all location rows for the same account in sync.
- **GBP publishing**: `POST /google/publish` publishes to all selected locations; `summary` capped at 1500 chars; optional `LEARN_MORE` CTA when `business_url` provided; optional photo array via temporary `sourceUrl` serving; idempotency key `gbp_{userId}_{jobId}_{sanitized_locationPath}` (`server/routes/google.js`).
- **GBP publish — mobile**: `runGooglePublish` in ResultScreen sends edited Google post + optional photos; appends `business_url` from inquiry URL / website; per-location results in result footer; Reconnect alert on `reconnect_required` (`ResultScreen.tsx`).
- **GBP content editor**: Google post preview/editing in ResultScreen platform variations tab (1500-char limit indicator); uses `editedGoogle || editedSocial` fallback.
- **Post Everywhere**: `if (hasGoogle)` branch added to `handlePostEverywhere`; GBP publishes independently alongside Facebook, Instagram, Threads, WordPress.
- **33 automated tests** (connect-url, callback state validation, callback success, locations list, selection, media serving, publish — including idempotency, cross-user isolation, reconnect on 401) — all passing (`server/test/google.test.js`).
- **341 total automated tests** — all passing.

### Implemented (Phase 11 — Multi-device sync, server-authoritative settings, test-mode controls)

- **V11 DB migration** (`server/db.js`): Added `settings_version INTEGER NOT NULL DEFAULT 0` column to `business_settings` for optimistic concurrency control on settings updates.
- **Settings API** (`server/routes/auth.js`):
  - `GET /auth/settings` — returns the user's business profile JSON and current `version`.
  - `PATCH /auth/settings` — partial merge update with optimistic locking; body: `{ settings: {...}, version: N }`; 409 with `{ error: 'version_conflict', current: {settings, version} }` on stale version.
- **Server-authoritative onboarding** (`server/routes/billing.js`, `App.tsx`): Onboarding completion is now derived from whether the user has a non-empty `business_name` in their server settings, replacing the brittle device-local `onboarding_completed` flag. `/billing/subscription` response includes `businessName` for cross-device consistency.
- **New-device login sync** (`App.tsx`): On startup, `syncServerSettings()` calls `GET /auth/settings`, merges the server profile into the local SQLite cache, and stores the server-assigned version. A new device recovers the business name (and therefore skips onboarding) automatically after login.
- **Business profile server sync** (`screens/OnboardingWizard.tsx`, `screens/SettingsScreen.tsx`): Step 1 of the onboarding wizard and both "Save" buttons in SettingsScreen now PATCH the business profile to the server (fire-and-forget; local save always wins). Version conflicts auto-retry once with the server's current version.
- **Test mode DeviceCheck bypass** (`server/routes/billing.js`): When `STRIPE_TEST_MODE=true`, `_enforceDeviceCheck` returns `next()` immediately without querying Apple's API. `redeemFreePublication` skips the `updateDeviceBit0` call so production DeviceCheck bits are never modified during testing. Each new test account gets its own free publication independent of physical-device history.
- **21 new automated tests** (`server/test/settings.test.js` — 15 tests, `server/test/testmode.test.js` — 6 tests): settings GET/PATCH/versioning/cross-user isolation; test mode bypass with injected Apple API mock; production enforcement of DeviceCheck.
- **457 total automated tests** — all passing.

### Implemented (Phase 10 — Production readiness, security fixes)

- **Stripe webhook deduplication** (`server/routes/billing.js`, V8 migration in `server/db.js`): New `stripe_webhook_events` table (`event_id TEXT PRIMARY KEY`). `handleWebhookEvent` inserts the event ID via `INSERT ... ON CONFLICT DO NOTHING` at the top of every handled event; if `rowCount === 0` the event was already processed — returns early without re-applying side-effects. Fail-open: table-access errors are logged and processing continues.
- **Free-publication content hash** (`server/routes/{facebook,instagram,threads,wordpress,google}.js`, V9 migration): Added `content_hash TEXT` column to `publishing_records`. Each publish route computes SHA-256 of its primary content field and stores it at INSERT time. On a free retry (`req.publishIsFreeRetry`), if the stored hash exists and differs from the incoming request, the retry is rejected with 409.
- **Destination locking improvement** (all 5 publish routes): Free-retry validation query changed from `status = 'failed'` to `status IN ('failed', 'pending')` so stuck-pending records caused by server crashes mid-publish also satisfy the prior-attempt requirement. This prevents new destinations from being silently added to a retry.
- **Draft persistence across app termination** (`storage/database.ts`, `App.tsx`): Added `savePendingGenerationFlag` / `getPendingGenerationFlag` / `deleteSetting` to the SQLite layer. When the user taps Generate while unsubscribed, the intent is written to SQLite as `pending_generation_after_subscription = '1'`. On startup, if both the flag and `pending_home_state` are present, `payload` is reconstructed from the saved state and `pendingGenerationAfterSubscription` is set — so ResultScreen auto-generates immediately after returning from a Stripe checkout that terminated the app process.
- **Onboarding cross-account leakage fix** (`App.tsx`): `deleteSetting('onboarding_completed')` is now called in both sign-out paths (`handleAuthChange(false)` and `handleSubscriptionSignOut`). Previously, the onboarding-completed flag was never cleared on sign-out, so a second user on the same device would inherit the first user's completed onboarding state.
- **10 targeted security tests** (`server/test/security.test.js`): Stripe webhook deduplication (3 tests), content hash storage and validation (2 tests), destination locking (3 tests), HTTP webhook endpoint deduplication (2 tests). All passing.
- **436 total automated tests** — all passing.

### Implemented (Meta compliance — deletion integrity)

- **V13 DB migration** (`server/db.js`): New `deletion_requests` table persists confirmation codes and statuses (`pending`/`completed`/`failed`/`no_data`) for all three Meta platforms' data-deletion callbacks. Also fixed a SCHEMA_VERSION bug (was stuck at 11) that prevented the V12 `platform_user_id` column migration from running on existing production databases.
- **Facebook `/delete` — atomic + tracked** (`server/routes/facebook.js`): Deletion is now transactional (connections + publishing records + status update committed together). Status persisted in `deletion_requests`; honest `no_data` returned when identity cannot be fully verified.
- **Facebook legacy identity backfill** (`server/routes/facebook.js`): `findAndBackfillFbConnections` resolves NULL `platform_user_id` rows via the Facebook `/debug_token` API. Phase 1 does direct lookup; Phase 2 calls debug_token for each NULL row to discover + backfill the owning user ID, then matches against the requester. Prevents false-positive deletion reporting for pre-V12 connections.
- **Instagram `/delete` — atomic + tracked** (`server/routes/instagram.js`): Same transactional + deletion_requests pattern as Facebook. `account_id` = Instagram user ID (no debug_token backfill needed).
- **Threads `/delete` — atomic + tracked** (`server/routes/threads.js`): Same transactional + deletion_requests pattern.
- **Status pages updated** (all three platforms): `GET /{platform}/deletion-status?code=X` now queries `deletion_requests` by confirmation code and returns an accurate outcome message (completed / pending / no_data / failed / not found). No personal data exposed.
- **13 new regression tests** (`server/test/meta-callbacks.test.js`): debug_token backfill with match/mismatch/error cases; status-page code lookup (completed, no_data, not-found, generic); Instagram and Threads deletion_request tracking; status page verification via returned code.
- **505 total automated tests** — all passing.

### Requires live credentials before functional testing

- Facebook OAuth callback requires `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_REDIRECT_URI` in `server/.env`.
- Publishing requires a verified Meta App with `pages_manage_posts` permission and a real Page access token.
- GBP OAuth requires `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` in `server/.env`; redirect URI must be added to the GCP OAuth 2.0 client's authorized redirect URIs.
- GBP publishing requires the My Business API, My Business Account Management API, and My Business Business Information API to be enabled in GCP project `elmer-511511`, and may require Google's GBP API access verification process.

### Planned — no implementation exists

- Cross-device settings synchronization
- Push notifications

---

## Testing

```bash
cd server
npm test
# node --test test/db.test.js test/auth.test.js test/platforms.test.js test/facebook.test.js test/instagram.test.js test/threads.test.js test/media-utils.test.js test/generation.test.js test/account-isolation.test.js test/wordpress.test.js test/billing.test.js test/google.test.js test/free-publication.test.js test/analytics.test.js test/device.test.js test/security.test.js test/settings.test.js test/testmode.test.js
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

## Publishing Architecture

Each platform is independently implemented, tested, and deployable. A failure in Google publishing must not affect Facebook publishing.

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
