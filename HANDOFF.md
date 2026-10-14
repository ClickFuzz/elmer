# HANDOFF

## Goal
Deploy Elmer backend to Railway with PostgreSQL.

## Current State
PostgreSQL migration is complete and committed. All 76 server tests pass using pg-mem. Railway config is ready. The server has never been deployed — waiting on the user to create a Railway account and follow the deployment steps.

## Proven Facts
- `better-sqlite3` fully replaced with `pg` (async pool) across all server files
- `server/db.js` runs migrations via `schema_migrations` table; migrations are idempotent
- All 76 tests pass using `pg-mem` (no real PostgreSQL required to run tests)
- Production safety guards enforced: `DISABLE_AUTH=true` + `NODE_ENV=production` → server refuses to start
- `CREDENTIAL_ENCRYPTION_KEY` is required in production
- Facebook OAuth callback URL updated in docs to `https://api.getelmer.com/facebook/callback`
- `railway.json` exists at repo root with build + health check config
- `server/.env` has `DATABASE_URL=` placeholder (needs a real connection string)

## Ruled Out
- No SQLite code remains in server-side production paths
- No data to migrate (server SQLite DB was empty)
- No secrets are committed to git

## Exact Next Steps

### 1 — Create Railway account and deploy

Follow the exact steps in `docs/ARCHITECTURE.md → Railway Deployment → Railway setup steps`.

Summary:
1. railway.app → New Project → connect GitHub repo, Root Directory = `server/`
2. Add PostgreSQL service → DATABASE_URL auto-populates
3. Add env vars: `OPENAI_API_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `DISABLE_AUTH=false`, `NODE_ENV=production`
4. Deploy → verify `GET /health` returns `{"ok":true}`
5. Add custom domain `api.getelmer.com` → add CNAME at DNS provider

### 2 — Facebook OAuth redirect URI

In Meta App Dashboard → Facebook Login → Settings:
- Add Valid OAuth Redirect URI: `https://api.getelmer.com/facebook/callback`

In Railway env vars:
- `FACEBOOK_REDIRECT_URI=https://api.getelmer.com/facebook/callback`

### 3 — Mobile app production URL

In the mobile project root or `.env`:
```
EXPO_PUBLIC_API_URL=https://api.getelmer.com
```
Rebuild with EAS.

### 4 — End-to-end test (from previous HANDOFF, still required)

1. Build iOS dev client: `npx eas-cli@latest build --profile development --platform ios`
2. Test: Sign in → Connect Facebook → Generate → Post Everywhere → verify on Facebook Page

## Do Not Repeat
- SQLite → PostgreSQL translation (complete)
- pg-mem test infrastructure (complete)
- Production safety guards (complete)

## Relevant Files
| File | Purpose |
|---|---|
| `server/db.js` | PostgreSQL pool, migrations, `initDb()`, `getPool()` |
| `server/index.js` | Startup: `await initDb()` before `createApp()` |
| `server/.env.example` | All required env vars documented |
| `railway.json` | Railway build + deploy config |
| `docs/ARCHITECTURE.md` | Railway setup steps, schema, env vars |

## Git State
Branch: `main`  
Last commit before this work: `492f5ca`  
Changed files: 15 modified + 3 new (helpers.js, railway.json, HANDOFF.md)  
Status: all changes staged and ready to commit
