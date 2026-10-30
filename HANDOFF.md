# HANDOFF

## Goal
Complete staging environment setup by configuring Railway, then push the pending production OTA update.

## Current Problem
Two pending items:
1. Railway staging environment not configured — `https://api-staging.getelmer.com` does not exist yet.
2. Production OTA update (`34fe198`, subscription screen redesign) still not pushed to the `production` channel.

## Proven Facts
- All staging infrastructure is committed to `staging` branch (HEAD `d96bca2`, 2 commits ahead of `main`).
- `main` HEAD is `3fee483` — unchanged, production unaffected.
- EAS `staging` channel and branch exist at expo.dev.
- `app.config.js` sets `scheme: elmer-staging`, `bundleIdentifier: com.clickfuzz.elmer.staging`, `name: Elmer Staging` when `APP_VARIANT=staging`.
- `staging-update.yml` auto-push trigger is disabled (commented out). `workflow_dispatch` is active.
- 505 server tests pass. TypeScript 0 errors.
- Production API `{"ok":true,"aiEnabled":true}` — healthy.

## Ruled Out
- No code changes needed before Railway setup — everything is already in the staging branch.
- No new EAS channel/branch creation needed — already done.

## Current Hypothesis
N/A — waiting on manual Railway configuration.

## Changed
Files committed to `staging` (not yet in `main`):
- `app.config.js` (new)
- `eas.json` (staging profile added)
- `server/.env.example` (Instagram, Threads, Google, SERVER_URL, Stripe vars added)
- `.github/workflows/test.yml` (new CI workflow)
- `.github/workflows/staging-update.yml` (new, auto-trigger disabled)
- `docs/DEPLOYMENT-WORKFLOW.md` (new)

## Exact Next Steps

**Step 1 — Configure Railway staging** (manual, one-time):
See `docs/DEPLOYMENT-WORKFLOW.md` → "Manual Steps Required" for the full env var table.
Critical differences from production:
- `CREDENTIAL_ENCRYPTION_KEY` → generate a new value (never reuse production)
- `STRIPE_TEST_MODE=true`; use `STRIPE_TEST_*` key variants
- All `*_REDIRECT_URI` → `https://api-staging.getelmer.com/*`
- `FACEBOOK_OAUTH_RETURN_SCHEME=elmer-staging`
- `GOOGLE_OAUTH_RETURN_SCHEME=elmer-staging`
- `SERVER_URL=https://api-staging.getelmer.com`
Verify: `curl https://api-staging.getelmer.com/health` → `{"ok":true}`

**Step 2 — Add staging OAuth redirect URIs** (manual, per provider):
- Meta (Facebook + Instagram): add `https://api-staging.getelmer.com/facebook/callback` and `/instagram/callback`
- Threads: add `https://api-staging.getelmer.com/threads/callback`
- Google GCP: add `https://api-staging.getelmer.com/google/callback`
- Stripe test: add webhook at `https://api-staging.getelmer.com/billing/webhook`

**Step 3 — Re-enable staging OTA auto-trigger** (after Railway health check passes):
In `.github/workflows/staging-update.yml`, uncomment the `# on: push:` block.
Commit and push to `staging`.

**Step 4 — Build the staging app** (first staging build):
Register Apple bundle ID `com.clickfuzz.elmer.staging` at developer.apple.com first.
Then: `npx eas-cli@latest build --platform ios --profile staging --non-interactive`

**Step 5 — Push pending production OTA update**:
```bash
npx eas-cli@latest update --branch production --channel production \
  --message "Fix subscription manage screen: no flash, back button, Invalid Date" \
  --non-interactive
```
(Run from project root. No new TestFlight build needed.)

## Do Not Repeat
- Staging code investigation — all files are correct, committed, and verified.
- Server test runs — 505 tests pass.
- EAS channel/branch creation — already done.
- Production safety checks — production is unchanged at `3fee483`.

## Relevant Files
- `docs/DEPLOYMENT-WORKFLOW.md` — complete Railway variable table and all manual steps
- `app.config.js` — `APP_VARIANT=staging` logic
- `.github/workflows/staging-update.yml` — uncomment push trigger in Step 3
- `eas.json` — staging profile

## User Assistance
Steps 1–4 are manual dashboard actions (Railway, Apple Developer, Meta, Google, Stripe).
Step 5 is a single terminal command.

## Git State
- `staging` branch: HEAD `d96bca2`, pushed to origin, 2 commits ahead of `main`
- `main` branch: HEAD `3fee483`, clean, production deployed
- Working tree: clean (PASSDOWN.md modified but not staged — commit separately if desired)
