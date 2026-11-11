# HANDOFF

## Goal
Verify two staging fixes on physical devices before merging to main.

---

## Task A — iOS audio re-recording fix (just deployed)

### Current Problem
On repeated re-records (3rd+ attempt), the new recording plays back as ~2 seconds of silence.

### Root Cause (confirmed)
Race condition in expo-audio's native iOS layer:
- When `AudioPlayer` finishes playback, it schedules `deactivateSession()` with a 100ms delay
- If the user taps Re-record and `prepareToRecordAsync()` calls `setActive(true)`, the deactivation task fires shortly after and silently kills the `AVAudioRecorder`
- `setAudioModeAsync({ allowsRecording: false })` in `togglePlayback` was also unnecessary — `playAndRecord + defaultToSpeaker` already routes audio to the speaker

### Fix Deployed (staging OTA `ff1db83c`, commit `c912012`)
- `keepAudioSessionActive: true` on `createAudioPlayer` — prevents `deactivateSession()` from firing
- Removed `setAudioModeAsync({ allowsRecording: false })` from `togglePlayback`
- `pendingUriRef` captures `recorder.uri` immediately after `prepareToRecordAsync()`
- Cleans old `elmer_pending_audio_*.m4a` and `ExpoAudio/recording-*.m4a` before each record

### Next Step
1. User: open Elmer Staging on iOS → record → play back → re-record → repeat 5+ times
2. If all recordings play back correctly: task complete; merge `staging → main`
3. If still silent: check whether it's reproducible consistently or on specific attempt number

### Changed
- `screens/HomeScreen.tsx` — `startRecording`, `stopRecording`, `togglePlayback`, `handleGenerate`

---

## Task B — Android audio transcription fix (pending device test from prior session)

### Current Problem
Android: record voice → Generate → "Transcription failed" (OpenAI Whisper 400 "audio file could not be decoded").

### Root Cause (confirmed)
Without an explicit MIME type, OpenAI SDK sends `Content-Type: ""` to Whisper. Android MPEG-4 files use `mp42`/`isom` ftyp brand (not Apple's `M4A`), so Whisper can't identify the format.

### Fix Deployed (Railway staging `d4d2f60`)
`server/app.js` — `toFile(stream, 'audio.m4a', { type: 'audio/mp4' })` to send explicit MIME type.
Also added `[Generate] Audio received: X bytes` log to Railway.

### Next Step
1. User: open Elmer on Android versionCode 6 → record voice → tap Generate
2. If works: task complete
3. If still fails: check Railway logs for `[Generate] Audio received: X bytes`
   - If bytes > 50 KB: try extension `.mp4` in `toFile()` instead of `.m4a`
   - If bytes < 1 KB: upload broken — investigate `FileSystem.uploadAsync` on Android

---

## Do Not Repeat
- iOS: Traced full `AudioModule.swift` + `AudioRecorder.swift` native state machine; `AVAudioRecorder.record()` returns `false` silently when session is deactivated by the 100ms deactivation task
- Android: Traced `RecordingPresets` → `AudioRecords.kt` → `MediaRecorder` MPEG_4/AAC; traced OkHttp upload path; confirmed OpenAI SDK `toFile()` behavior without MIME type

## Relevant Files
- `screens/HomeScreen.tsx` — full re-recording fix (Task A)
- `server/app.js:375–410` — transcription block with Android MIME fix (Task B)

## Git State
Branch: `staging`. HEAD: `c912012`. Working tree clean.
Staging OTA active: group `ff1db83c`.
Android transcription fix: Railway staging auto-deployed `d4d2f60`.
566 server tests pass.
