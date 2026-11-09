# HANDOFF

## Goal
Confirm Android audio transcription fix works on-device with versionCode 6.

## Current Problem
Android recording → Generate → "Transcription failed" (OpenAI Whisper 400 "audio file could not be decoded").
Fix was deployed to Railway staging (`d4d2f60`) but not yet confirmed by device test.

## Proven Facts
- Android MediaRecorder with `mpeg4` output + `aac` encoder creates valid MPEG-4/AAC `.m4a` files.
- `RecordingPresets.HIGH_QUALITY` on Android → `MediaRecorder.OutputFormat.MPEG_4` + `AudioEncoder.AAC` (confirmed in `AudioRecords.kt`).
- File plays back successfully on device (confirmed by user), so file is not empty.
- Root cause: without an explicit MIME type, the OpenAI SDK sends `Content-Type: ""` to Whisper. Android MPEG-4 files use `mp42`/`isom` ftyp brand (not Apple's `M4A `), so Whisper can't identify the format.
- Fix deployed: `server/app.js` now uses `toFile(stream, 'audio.m4a', { type: 'audio/mp4' })` to send explicit MIME type.
- Also added `[Generate] Audio received: X bytes` log to Railway.
- Fix also repairs stale-path cleanup bug in catch block (was unlinking `audioFile.path` after rename).

## Ruled Out
- Format mismatch — Android HIGH_QUALITY preset confirmed MPEG-4/AAC.
- Empty file — playback works.
- Upload corruption — OkHttp reads raw bytes without encoding.
- Multer misconfiguration — same config serves iOS fine.

## Current Hypothesis
Fix is correct. Whisper needed explicit `audio/mp4` content-type to identify Android's MPEG-4 file.

## Changed
- `server/app.js` — `toFile()` with explicit MIME type, file size log, stale-path cleanup fix
- `server/test/generation.test.js` — added `MockOpenAI.toFile = async (stream) => stream`
- Committed `d4d2f60`, pushed `staging`, Railway auto-deployed. 564 tests pass.

## Production / Deployment State
Railway staging deployed `d4d2f60`. versionCode 6 (staging-google-play AAB) with OTA `df153e23` active on the staging channel.

## Exact Next Step
1. User: open Elmer on Android versionCode 6 → record voice → tap Generate.
2. If it works: transcription succeeds → task complete; delete HANDOFF.md.
3. If still fails: check Railway logs for `[Generate] Audio received: X bytes`.
   - If bytes > 50 KB: file format still wrong → try sending with extension `.mp4` instead of `.m4a` in `toFile()`.
   - If bytes < 1 KB: upload broken → investigate `FileSystem.uploadAsync` on Android with `file://` URI.

## Do Not Repeat
- Traced full Android recording stack: `RecordingPresets` → `AudioRecords.kt` → `MediaRecorder` → MPEG_4/AAC.
- Traced OkHttp upload path (`FileSystemUploadTask.kt`) — raw bytes, no encoding.
- Confirmed OpenAI SDK `toFile()` behavior — creates `File` with no type from `ReadStream`, which is why iOS happened to work (Apple `M4A ` brand is unambiguous) but Android didn't.

## Relevant Files / Functions
- `server/app.js:375–410` — transcription block with the fix
- `screens/HomeScreen.tsx:74,88–103,241–266` — recording + file copy path
- `screens/ResultScreen.tsx:187–213` — `FileSystem.uploadAsync` with `mimeType: 'audio/m4a'`
- `node_modules/expo-audio/src/RecordingConstants.ts:69` — HIGH_QUALITY preset (android: mpeg4/aac)
- `node_modules/expo-audio/android/.../AudioRecords.kt:61–88` — `toMediaOutputFormat()` / `toMediaEncoding()`

## Git State
Branch: `staging`. Last commit: `d4d2f60`. All 564 server tests pass. Working tree clean.
