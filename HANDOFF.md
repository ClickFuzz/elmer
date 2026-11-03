# HANDOFF

## Goal
Open PR from `staging` → `main` for the Instagram feature flag, then merge when approved.

## Current Problem
`gh` CLI is not authenticated in this environment — the PR could not be created automatically.

## Proven Facts
- All implementation is complete and pushed to `staging` (HEAD `2aa2d43`)
- 524 server tests pass, 0 failures
- TypeScript: 0 errors
- Staging API healthy: `{"ok":true,"aiEnabled":true}`
- Production API healthy: `{"ok":true,"aiEnabled":true}`
- Production Railway has `INSTAGRAM_ENABLED=false` (confirmed set by operator this session)

## Ruled Out
- No merge conflicts — staging is a clean 3-commit fast-forward over `b7585d7`
- No test failures introduced by the feature flag

## Changed
Three commits on `staging` not yet in `main`:

| Commit | Description |
|---|---|
| `9ee34f0` | Add Instagram feature flag for production launch |
| `4acd0b8` | Add EXPO_PUBLIC_INSTAGRAM_ENABLED=true to staging OTA workflow |
| `2aa2d43` | Track staging OTA helper script (`update`) |

Files: `constants/features.ts` (new), `eas.json`, `screens/ResultScreen.tsx`, `screens/SettingsScreen.tsx`, `server/routes/instagram.js`, `server/test/instagram.test.js`, `.github/workflows/staging-update.yml`, `update`

## Exact Next Step
Open the PR manually:
**https://github.com/ClickFuzz/elmer/compare/main...staging**

Title: `Instagram feature flag for production launch`

Then merge with `--no-ff` when approved:
```bash
git checkout main
git merge staging --no-ff -m "Merge staging: Instagram feature flag for production launch"
git push origin main
```

## Do Not Repeat
- Tests already run and pass — no need to re-run before merging
- Feature flag implementation already reviewed and verified correct
- Railway `INSTAGRAM_ENABLED=false` already confirmed set by operator

## Relevant Files / Functions
- `constants/features.ts` — `INSTAGRAM_ENABLED` flag (mobile)
- `server/routes/instagram.js:24` — `isInstagramEnabled()` + guards at connect-url (line 83) and publish (line 281)
- `screens/SettingsScreen.tsx:1439` — Instagram row conditional render
- `screens/ResultScreen.tsx:148` — channel filter at load time
- `eas.json` — `EXPO_PUBLIC_INSTAGRAM_ENABLED: "true"` in staging profile only

## Git State
- Branch: `staging`
- Working tree: clean
- `staging` is 3 commits ahead of `main` (`b7585d7`)
- All 3 commits pushed to `origin/staging`
