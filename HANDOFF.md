# HANDOFF

## Goal
Complete staging environment by setting `SERVER_URL` in Railway, then push the pending production OTA update.

## Current Problem
1. Railway staging service exists but `SERVER_URL=https://api-staging.getelmer.com` is not set → Threads/Instagram photo publishing returns 500 on staging (clear failure — correct behavior until the var is set).
2. GBP was sending up to 10 photos; API rejects >1. Fix committed (`292929d`) and pushed to staging — verify Railway has deployed before retesting GBP publish.
3. Production OTA update (`34fe198`, subscription screen redesign) still not pushed to `production` channel.

## Proven Facts
- Staging branch HEAD: `292929d` — pushed to origin/staging.
- `292929d` contains: GBP `.slice(0,1)` fix; Threads/Instagram `SERVER_URL` fallback `''`; guard returning 500 when `SERVER_URL` unset; 2 regression tests.
- `STRIPE_TEST_MODE` check is case-insensitive (`.toLowerCase() === 'true'`); `true` or `TRUE` both work.
- 509 server tests pass. TypeScript 0 errors.
- Production API healthy. `main` at `3fee483` — unchanged.
- EAS `staging` channel and branch exist at expo.dev.
- `app.config.js` sets `scheme: elmer-staging`, bundle `com.clickfuzz.elmer.staging`, name "Elmer Staging" when `APP_VARIANT=staging`.
- `staging-update.yml` auto-push trigger is still disabled (commented out).

## Ruled Out
- No app rebuild needed for GBP or Threads/Instagram fixes — both are server-side only.
- No further code changes needed before Railway `SERVER_URL` is set.
- No new EAS channel/branch creation needed — already done.

## Current Hypothesis
N/A — waiting on Railway `SERVER_URL` env var.

## Changed (this session, staging branch only)
- `server/routes/google.js` — `.slice(0, 1)` GBP 1-photo limit
- `server/routes/instagram.js` — `SERVER_URL` fallback `''` + 500 guard
- `server/routes/threads.js` — `SERVER_URL` fallback `''` + 500 guard with `markFailed`
- `server/test/threads.test.js` — 2 regression tests (509 total)

Previously committed to staging (not yet in `main`):
- `app.config.js`, `eas.json` (staging profile), `server/.env.example`, `.github/workflows/test.yml`, `.github/workflows/staging-update.yml`, `docs/DEPLOYMENT-WORKFLOW.md`

## Exact Next Steps

**Step 1 — Set `SERVER_URL` in Railway staging** (single env var, most critical):
- Railway staging service → Variables → add `SERVER_URL=https://api-staging.getelmer.com`
- Redeploy if Railway doesn't auto-restart on env var change

**Step 2 — Verify fixes on staging**:
- GBP: post with multiple photos → should succeed (only 1 sent to GBP API)
- Threads: carousel post → should succeed (staging URLs now served correctly)

**Step 3 — Complete remaining Railway staging setup** (one-time):
See `docs/DEPLOYMENT-WORKFLOW.md` → "Manual Steps Required" for full env var table.
Key remaining: OAuth redirect URIs for all providers, Stripe test webhook.

**Step 4 — Re-enable staging OTA auto-trigger**:
In `.github/workflows/staging-update.yml`, uncomment the `# on: push:` block. Commit to staging.

**Step 5 — Build the staging app** (first internal build):
Register Apple bundle ID `com.clickfuzz.elmer.staging` at developer.apple.com first.
Then trigger via GitHub Actions → "iOS Build" → branch: staging.

**Step 6 — Push pending production OTA update**:
```bash
bunx eas-cli update --branch production --channel production \
  --message "Fix subscription manage screen: no flash, back button, Invalid Date"
```

## Do Not Repeat
- Staging code investigation — all files committed and verified at `292929d`.
- Server test runs — 509 pass.
- EAS channel/branch creation — already done.
- Production safety checks — unchanged at `3fee483`.
- `SERVER_URL` root cause analysis — confirmed: missing env var; code fix deployed.

## Relevant Files
- `docs/DEPLOYMENT-WORKFLOW.md` — full Railway env var table and manual steps
- `server/routes/threads.js:350` — `SERVER_URL` guard
- `server/routes/google.js:466` — `.slice(0, 1)` GBP fix
- `app.config.js` — `APP_VARIANT=staging` logic
- `.github/workflows/staging-update.yml` — uncomment push trigger in Step 4

## User Assistance
Steps 1, 3 are Railway/dashboard actions.
Steps 4–6 are terminal commands.

## Git State
- `staging` branch: HEAD `292929d`, pushed to origin, 4 commits ahead of `main`
- `main` branch: HEAD `3fee483`, clean, production deployed
- Working tree: clean
