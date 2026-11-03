# Elmer — Deployment Workflow

> Reference for daily development, staging testing, production releases, rollback,
> environment variable management, database migrations, and emergency hotfixes.

---

## Environment Overview

| Layer | Production | Staging |
|---|---|---|
| Git branch | `main` | `staging` |
| API URL | `https://api.getelmer.com` | `https://api-staging.getelmer.com` |
| Railway environment | `production` | `staging` (see setup) |
| EAS update channel | `production` | `staging` |
| iOS bundle ID | `com.clickfuzz.elmer` | `com.clickfuzz.elmer.staging` |
| App display name | Elmer | Elmer Staging |
| Stripe | Live keys | Test keys (`STRIPE_TEST_MODE=true`) |
| Database | Production PostgreSQL | Staging PostgreSQL (separate) |

**Golden rule:** `staging` branch → staging everything. `main` branch → production everything.
Never commit directly to `main`. Merge from `staging` via a reviewed pull request.

---

## Daily Development Commands

```bash
# 1. Confirm you are on staging (always work here)
git branch                           # should show * staging

# 2. Pull latest changes
git fetch origin
git merge origin/staging             # keep staging up to date

# 3. Run the server tests before making changes
cd server && npm test && cd ..

# 4. Start the local server
cd server && npm run dev             # listens on port 3001

# 5. Start the Expo dev server (separate terminal)
npx expo start

# 6. Lint and typecheck before committing
npx expo lint
npx tsc --noEmit
```

---

## Staging Backend — Deploy a Change

```bash
# 1. Make changes on the staging branch
git checkout staging

# 2. Run tests
cd server && npm test && cd ..

# 3. Commit
git add server/<changed-files>
git commit -m "feat: describe the change"

# 4. Push to origin/staging
git push origin staging
# Railway auto-deploys the staging environment from origin/staging (once configured).

# 5. Verify health
curl https://api-staging.getelmer.com/health
# Expected: {"ok":true}
```

---

## Staging OTA Update — Push JS/asset changes to staging app

```bash
# Publish a staging OTA update manually (no new build needed):
npx eas-cli@latest update \
  --branch staging \
  --channel staging \
  --message "describe the change" \
  --non-interactive

# Or push to origin/staging — the GitHub Action does this automatically
git push origin staging
```

**Note:** OTA updates only work if the runtime version matches the installed staging build.
A new native build is required after adding/removing native modules or changing `app.json`
fields that affect the native layer.

---

## Build a Staging iOS App (internal distribution)

The staging app installs alongside the production app on the same device.

```bash
# Build a staging IPA for internal distribution (no App Store)
npx eas-cli@latest build \
  --platform ios \
  --profile staging \
  --non-interactive

# After the build finishes, install it via the Expo dashboard or a shared link.
# EAS sends you a QR code / install link automatically.
```

**Prerequisite (one-time — manual):** The staging bundle ID `com.clickfuzz.elmer.staging`
must be registered in Apple Developer Portal before the first build succeeds. See
[Manual Steps Required](#manual-steps-required) section.

---

## Promote Staging to Production — Full Release

```bash
# 1. Verify all tests pass on staging
cd server && npm test && cd ..
npx expo lint
npx tsc --noEmit

# 2. Verify staging API is healthy
curl https://api-staging.getelmer.com/health

# 3. Create a pull request: staging → main
#    (use GitHub UI or gh CLI if authenticated)
#    Title: describe the release
#    Include: what was tested, test results, any manual verification performed

# 4. Review the PR diff carefully.
#    Ensure no staging-only credentials or URLs are included.

# 5. Merge the PR (squash or merge commit — not rebase, to preserve history).

# 6. Railway auto-deploys production from origin/main (once configured).
#    Verify production health after deploy:
curl https://api.getelmer.com/health

# 7. Update main locally
git checkout main && git pull origin main
git checkout staging
git merge origin/main         # keep staging in sync
```

---

## Publish a Production OTA Update

OTA updates push JS/asset changes to the existing App Store build without a new submission.
They are safe as long as the runtime version (currently `1.0.0`) has not changed.

```bash
# Push an OTA update to production (only after verifying on staging first):
npx eas-cli@latest update \
  --branch production \
  --channel production \
  --message "describe the change" \
  --non-interactive

# Confirm the update is visible:
npx eas-cli@latest update:list --branch production --limit 3
```

**Safety check:** Never publish a production OTA update with `EXPO_PUBLIC_API_URL`
pointing at staging. Verify your local `.env` or the EAS build env before publishing.

---

## Build and Submit a Production App Store Build

A new native build is required when:
- Adding or removing Expo native modules
- Changing `app.json` fields that affect the native bundle (scheme, permissions, plugins)
- Incrementing the app version

```bash
# Trigger a new production build (runs on EAS cloud, not locally)
npx eas-cli@latest build \
  --platform ios \
  --profile production \
  --non-interactive

# After build succeeds, submit to TestFlight:
npx eas-cli@latest submit \
  --platform ios \
  --profile production \
  --latest \
  --non-interactive
```

The GitHub Actions workflow (`.github/workflows/ios-build.yml`) can also be triggered
manually from the GitHub Actions tab. It builds locally on a macOS runner and submits
to TestFlight using the `github` profile (which extends `production`).

---

## Rollback

### Rollback a production OTA update

```bash
# List recent production update groups
npx eas-cli@latest update:list --branch production --limit 5

# Roll back to the previous good group (replace <group-id> with the target group):
npx eas-cli@latest channel:rollout \
  --channel production \
  --runtime-version 1.0.0 \
  --percent 0
# Then republish the known-good update if needed.
```

### Rollback a Railway production deploy

1. Open Railway dashboard → Elmer Server (production environment)
2. Click **Deployments** tab
3. Find the last known-good deployment and click **Redeploy**

This reverts the server code; the database schema is not rolled back automatically.
If a migration must be reversed, apply the inverse SQL manually via the Railway
PostgreSQL console.

---

## Database Migrations

Migrations run automatically on server startup via `server/db.js → migrate()`.

```bash
# Run migrations locally:
cd server && node -e "require('./db').initDb().then(() => process.exit())"

# Check current schema version in PostgreSQL:
psql "$DATABASE_URL" -c "SELECT version, applied_at FROM schema_migrations ORDER BY version"
```

**Staging:** migrations run when the staging service starts. Keep staging's schema
version at or ahead of production to catch migration issues before they reach production.

**Emergency:** if a migration breaks production, redeploy the previous server version
(which will not re-run already-applied migrations) and fix the migration in a hotfix branch.

---

## Environment Variable Management

### Production (Railway — production environment)

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Railway auto-injects from linked PostgreSQL |
| `OPENAI_API_KEY` | platform.openai.com → API Keys |
| `CREDENTIAL_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `FACEBOOK_APP_ID` / `_SECRET` | developers.facebook.com → your app |
| `INSTAGRAM_APP_ID` / `_SECRET` | same Meta app as Facebook |
| `THREADS_APP_ID` / `_SECRET` | developers.facebook.com → Threads app |
| `GOOGLE_CLIENT_ID` / `_SECRET` | console.cloud.google.com → OAuth credentials |
| `STRIPE_SECRET_KEY` | dashboard.stripe.com → API keys (live) |
| `STRIPE_WEBHOOK_SECRET` | dashboard.stripe.com → Webhooks |
| `STRIPE_PRICE_ID` | dashboard.stripe.com → Products |
| `SERVER_URL` | `https://api.getelmer.com` |
| `NODE_ENV` | `production` |

### Staging (Railway — staging environment)

Use the same structure but with:
- `STRIPE_TEST_MODE=true` → uses `STRIPE_TEST_*` key variants
- `STRIPE_TEST_SECRET_KEY` / `STRIPE_TEST_WEBHOOK_SECRET` / `STRIPE_TEST_PRICE_ID`
  from dashboard.stripe.com/test
- `SERVER_URL=https://api-staging.getelmer.com`
- `NODE_ENV=production` (staging runs in production mode for auth guards)
- `DISABLE_AUTH=false`
- A freshly generated `CREDENTIAL_ENCRYPTION_KEY` (different from production)
- Separate PostgreSQL database (Railway auto-injects `DATABASE_URL` per environment)

**Never copy production `CREDENTIAL_ENCRYPTION_KEY` or `STRIPE_SECRET_KEY` into staging.**

---

## Emergency Hotfix

A hotfix bypasses the normal staging → main promotion cycle when production is broken.

```bash
# 1. Branch from main (not staging)
git checkout main
git pull origin main
git checkout -b hotfix/describe-the-fix

# 2. Make the minimal fix
# 3. Run tests
cd server && npm test && cd ..
npx expo lint && npx tsc --noEmit

# 4. Open a PR directly against main and get a quick review
# 5. Merge to main
# 6. Verify production health
curl https://api.getelmer.com/health

# 7. Merge the fix back into staging to stay in sync
git checkout staging
git merge origin/main
git push origin staging
```

---

## Checking Deployments

```bash
# Server health
curl https://api.getelmer.com/health          # production
curl https://api-staging.getelmer.com/health  # staging

# EAS update channels
npx eas-cli@latest channel:list

# Recent production updates
npx eas-cli@latest update:list --branch production --limit 5

# Recent staging updates
npx eas-cli@latest update:list --branch staging --limit 5

# Recent builds
npx eas-cli@latest build:list --platform ios --limit 5
```

---

## Manual Steps Required

The following steps cannot be automated and must be performed once before staging is fully functional.

### 1. Register the staging bundle ID with Apple
**URL:** https://developer.apple.com/account/resources/identifiers/list  
**Action:** Click "+" → App IDs → App  
**Bundle ID:** `com.clickfuzz.elmer.staging`  
**Capabilities:** enable Camera, Microphone (same as production)  
EAS will create provisioning profiles automatically on the first `staging` build.

### 2. Set up Railway staging environment
**URL:** https://railway.app  
**Actions:**
1. Open the Elmer project
2. Click **New Environment** → name it `staging`
3. In the staging environment, add a **PostgreSQL** database service
4. Add a **Node.js** service with:
   - Root directory: `server/`
   - Start command: `node index.js`
   - Health check path: `/health`
   - GitHub repo connected with branch: `staging`
5. Copy all production environment variables into the staging service, then:
   - Change `STRIPE_TEST_MODE` to `true`
   - Add `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_WEBHOOK_SECRET`, `STRIPE_TEST_PRICE_ID`
   - Generate a NEW `CREDENTIAL_ENCRYPTION_KEY` (never reuse production key)
   - Set `SERVER_URL=https://api-staging.getelmer.com` (or the Railway-assigned URL)
   - Set `NODE_ENV=production` and `DISABLE_AUTH=false`
6. Add the custom domain `api-staging.getelmer.com` (or use the Railway `.up.railway.app` URL)
7. Deploy and verify: `curl https://api-staging.getelmer.com/health`

### 3. Update staging OAuth redirect URIs
Once the staging API URL is known, add it to each provider:
- **Facebook/Instagram:** Meta App Dashboard → Facebook Login → Valid OAuth Redirect URIs → add `https://api-staging.getelmer.com/facebook/callback` and `../instagram/callback`
- **Threads:** Meta App Dashboard (Threads app) → add `https://api-staging.getelmer.com/threads/callback`
- **Google:** GCP Console → OAuth 2.0 Client → Authorized redirect URIs → add `https://api-staging.getelmer.com/google/callback`

Use separate Meta App IDs for staging if Meta App Review is sensitive. During development, the same app with test users is sufficient.

### 4. Add GitHub Actions secrets
**URL:** https://github.com/clickfuzz-team/elmer/settings/secrets/actions  
Confirm `EXPO_TOKEN` exists (used by both the iOS build and staging update workflows).

### 5. Set up Stripe staging webhook
**URL:** https://dashboard.stripe.com/test/webhooks  
**Action:** Add endpoint `https://api-staging.getelmer.com/billing/webhook`  
**Events:** `checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.paid`, `invoice.payment_failed`  
Copy the signing secret into Railway staging as `STRIPE_TEST_WEBHOOK_SECRET`.

---

## Notes on Production Safety

- The `staging-update.yml` GitHub Action targets `--branch staging --channel staging` exclusively. It cannot write to the `production` channel.
- The `test.yml` CI workflow runs server tests on every push to `main` or `staging`, with no deploy step.
- The `ios-build.yml` workflow is `workflow_dispatch` only — it never triggers automatically.
- Railway staging and production are separate environments with separate databases. A crash or bad migration in staging cannot affect production data.
- `STRIPE_TEST_MODE=true` in staging means even if a staging webhook fires against live Stripe by mistake, the test key lookup fails cleanly (`billing_not_configured`).
