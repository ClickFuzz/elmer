# HANDOFF

## Goal
Fix GBP "Couldn't publish to Google Business" error and ship TestFlight build 14.

## Current Problem
All GBP fixes are committed and on main. A new TestFlight build has NOT been started yet — the user needs to run it.

## Proven Facts
- GBP INVALID_ARGUMENT was `topic_type` required (confirmed via fieldViolations in Railway logs). Fixed in 853bfd1 by restoring `topicType: 'STANDARD'`.
- GBP 500 INTERNAL was caused by HEIC photos — Railway's sharp build lacks libde265. Confirmed in logs: "heif: Support for this compression format has not been built in: HEVC".
- Fix: `expo-image-manipulator` added; `toJpeg()` helper in HomeScreen converts library-picked photos to JPEG on-device before upload (4edbf7e).
- Server-side `prepareForGbp` added to media-utils as a fallback (c705dc0).
- Railway is already running all server-side fixes.
- Current TestFlight build is build 13, commit 90bf9e9 — three commits behind main. Has neither the topicType nor the HEIC fix.

## Ruled Out
- languageCode (removed in 898abfe)
- callToAction URL format (trimmed, normalized — not the cause)
- Empty summary

## Changed (all committed, pushed to main)
- `server/routes/google.js` — topicType: 'STANDARD' restored; prepareForGbp image processing; callToAction URL trimming
- `server/routes/media-utils.js` — prepareForGbp function added
- `screens/HomeScreen.tsx` — expo-image-manipulator import + toJpeg helper; library photos converted to JPEG after pick
- `App.tsx` — onClear callback wired to HomeScreen
- `package.json` — expo-image-manipulator ~57.0.21 added

## Exact Next Step
EAS cloud builds are exhausted until November 1. Use GitHub Actions instead:
1. Push current commits to GitHub (if not already pushed).
2. Go to Actions tab → "iOS Build and Submit to TestFlight" → Run workflow.
3. Requires `EXPO_TOKEN` secret set in GitHub repo settings (Settings → Secrets → Actions).

## Do Not Repeat
- Re-investigating GBP errors — both INVALID_ARGUMENT and 500 INTERNAL are fixed.
- EAS cloud builds are exhausted; do not try `eas build --profile production` until November 1.

## Relevant Files / Functions
- `server/routes/google.js` — postBody construction (~line 582), prepareForGbp call (~line 475)
- `server/routes/media-utils.js` — prepareForGbp (~line 189)
- `screens/HomeScreen.tsx` — toJpeg helper, library picker handler

## Git State
Branch: main. Last commit: 4edbf7e. Only `package-lock.json` is dirty (irrelevant to build).

MERGE STATUS: COMPLETE — all completed work is in main.
