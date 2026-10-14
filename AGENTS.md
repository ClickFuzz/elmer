This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Development rules

1. Preserve existing functionality and avoid unrelated refactors.
2. Diagnose execution order and existing logic before changing implementations.
3. Prefer simple, reliable solutions and minimal dependencies.
4. Make targeted changes rather than rebuilding working components.
5. Do not introduce Supabase, Firebase, PostgreSQL, Redis, or additional infrastructure without a specific demonstrated requirement.
6. Do not repeatedly redesign an acceptable implementation.
7. For changes aligned with the established architecture, proceed without unnecessary approval cycles.
8. Require user approval before changes involving security-sensitive architectural decisions, destructive migrations, or new paid services.
9. Do not use placeholder implementations that appear functional to users — stubs must be clearly non-functional to the user or absent from the UI entirely.
10. Run `npx expo lint` and `npx tsc --noEmit` after modifications and clearly report failures.
11. Update `docs/ARCHITECTURE.md` when a material technical decision changes.
12. Keep Google, Facebook, and future platform integrations independently testable — shared failures in one must not block another.

## What is implemented vs. planned

See `docs/ARCHITECTURE.md` for the authoritative implementation status matrix. Do not treat planned features as existing. Do not claim components are implemented when they are stubs.

## Navigation

Elmer uses a **manual screen switcher** in `App.tsx`, not Expo Router. The active screen is controlled by `useState<AppScreen>`. All screens are imported directly into `App.tsx` and rendered conditionally.

Screen names: `'home' | 'result' | 'settings' | 'history'`

Do not introduce Expo Router, React Navigation, or any navigation library without an explicit requirement and discussion.

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
