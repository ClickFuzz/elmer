# HANDOFF

## Goal
Complete staging environment Railway setup and test end-to-end Stripe checkout on staging.

## Current Problem
1. **Railway staging `APP_SCHEME` and `APP_URL` not set** — the Stripe `checkout-return` endpoint defaults to `elmer://` scheme and production server URL. Without these, the staging app never receives the post-checkout deep link.
2. **Railway staging `SERVER_URL` not confirmed set** — Threads/Instagram photo publish returns 500 until this is in place.
3. **Production OTA update (`34fe198`)** still not pushed to `production` EAS channel.

## Proven Facts
- Staging branch HEAD: `ccf563f` — pushed to origin/staging.
- Root cause of Stripe checkout failure confirmed: `BILLING_RETURN_PREFIX` was hardcoded `elmer://` in `SubscriptionScreen.tsx`; staging app registers `elmer-staging://` scheme.
- Fix committed `ccf563f`: `BILLING_RETURN_PREFIX` now reads `EXPO_PUBLIC_APP_SCHEME` env var (fallback `elmer`); `eas.json` staging profile sets `EXPO_PUBLIC_APP_SCHEME=elmer-staging`; 2 regression tests added.
- 511 server tests pass. TypeScript 0 errors.
- Stripe checkout does successfully create a subscription in sandbox (payment UI shows checkmark); the failure was purely the deep-link return, not payment processing.
- Production API healthy. `main` at `3fee483` — unchanged.

## Ruled Out
- Stripe sandbox payment processing failure — Stripe IS processing payments; the subscription IS created.
- Mobile polling logic bugs — polling triggers correctly once the deep link is received.

## Current Hypothesis
N/A — code is correct. Blocked on Railway env vars.

## Changed (this session, staging branch only)
- `screens/SubscriptionScreen.tsx` — `BILLING_RETURN_PREFIX` uses `EXPO_PUBLIC_APP_SCHEME ?? 'elmer'`
- `eas.json` — `EXPO_PUBLIC_APP_SCHEME: "elmer-staging"` added to staging env
- `server/.env.example` — `APP_SCHEME` and `APP_URL` documented with staging/production examples
- `server/test/billing.test.js` — 2 regression tests for `APP_SCHEME` redirect (511 total)

Previously committed to staging (not yet in `main`):
- `app.config.js`, `eas.json` (staging profile), `server/.env.example`, workflows, `docs/DEPLOYMENT-WORKFLOW.md`
- GBP 1-photo limit fix, Threads/Instagram `SERVER_URL` hardening

## Exact Next Steps

**Step 1 — Set Railway staging env vars** (most critical):
```
APP_SCHEME=elmer-staging
APP_URL=https://api-staging.getelmer.com
SERVER_URL=https://api-staging.getelmer.com   (if not already set)
```
Redeploy staging Railway service after setting vars.

**Step 2 — Build the staging app** (so `EXPO_PUBLIC_APP_SCHEME=elmer-staging` is baked in):
- Register Apple bundle ID `com.clickfuzz.elmer.staging` at developer.apple.com first
- Then trigger via GitHub Actions → "iOS Build" → branch: staging

**Step 3 — Test end-to-end Stripe checkout on staging**:
- Sign in to staging app → hit subscription gate → tap "Start My Free Trial"
- Complete Stripe sandbox checkout (test card `4242 4242 4242 4242`)
- Confirm app returns and activates subscription

**Step 4 — Complete remaining Railway staging setup** (one-time):
See `docs/DEPLOYMENT-WORKFLOW.md` → "Manual Steps Required" for full env var table.
Key remaining: OAuth redirect URIs for all providers, Stripe test webhook.

**Step 5 — Re-enable staging OTA auto-trigger**:
In `.github/workflows/staging-update.yml`, uncomment the `# on: push:` block. Commit to staging.

**Step 6 — Push pending production OTA update**:
```bash
bunx eas-cli update --branch production --channel production \
  --message "Fix subscription manage screen: no flash, back button, Invalid Date"
```

## Do Not Repeat
- Stripe deep-link root cause analysis — confirmed and fixed in `ccf563f`.
- Server test runs — 511 pass.
- EAS channel/branch creation — already done.
- Production safety checks — unchanged at `3fee483`.

## Relevant Files
- `docs/DEPLOYMENT-WORKFLOW.md` — full Railway env var table and manual steps
- `screens/SubscriptionScreen.tsx:22` — `BILLING_RETURN_PREFIX` (now dynamic)
- `app.config.js` — `APP_VARIANT=staging` scheme logic
- `server/routes/billing.js:54` — `APP_SCHEME` and `APP_URL` accessors
- `.github/workflows/staging-update.yml` — uncomment push trigger in Step 5

## User Assistance
Steps 1, 4 are Railway/dashboard actions.
Steps 2, 5, 6 are terminal/GitHub Actions.

## Git State
- `staging` branch: HEAD `ccf563f`, pushed to origin, 5 commits ahead of `main`
- `main` branch: HEAD `3fee483`, clean, production deployed
- Working tree: clean
