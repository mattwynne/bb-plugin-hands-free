> Historical implementation notes below describe the retired device/OpenAI output design. Current speech output is Edge-only; Sonia is the default, and saved device/OpenAI selections migrate to Sonia while retaining speed. Microphone/browser SpeechRecognition transcription is unchanged. Preview and speed remain in the unified settings picker. No API key is needed.

# Hands-Free voice settings

## Requirements
- One voice picker on the Hands-Free settings page across Device, Edge neural, and OpenAI; no engine selector. Keep the main talk screen uncluttered.
- Show unavailable voices disabled with an actionable reason (including missing credentials).
- Voice preview and speaking speed; persist preferences.
- Reuse BB OpenAI configuration only through supported public APIs; never expose credentials to the frontend.
- Explicit device fallback notice; preserve recording/playback lifecycle safety.
- Credit [Read Aloud](https://github.com/csells/bb-plugins/tree/HEAD/plugins/read-aloud) as inspiration; retain MIT notices for reused code.

## TODO
- [x] Backend: investigate supported credential reuse and implement voice catalog, availability, and bounded/cancellable Edge/OpenAI synthesis.
- [x] Frontend: unified voice picker, preview, speed, persistence, and selected-voice playback.
- [x] Integration: connect frontend/backend contracts and check unavailable/fallback behavior.
- [x] Attribution and documentation: inspiration, license notices, privacy, costs, configuration.
- [x] Verification: focused tests, full tests, typecheck, production build.
- [x] Reload running plugin and check deployed bundle.
- [ ] User/device check: preview voice on iPhone and verify configured OpenAI key with a real request.
- [x] Review/integrate child commits; archive completed children after retaining their work.

## Verification results
64 combined tests passed; typecheck, production build, diff check and production dependency audit passed. Reload confirmed running with frontend bundle `045faa10bba3408d`. Backend child verified real Edge synthesis using non-sensitive sample text; OpenAI tested with mocks only. Both child commits retained on main and child runtimes archived/stopped.

## Implementation notes
Public SDK cannot reuse BB's OpenAI key for TTS; Hands-Free has its own server-only secret setting. Voice/speed preferences are browser-local. No silent fallback: select a Device voice explicitly when cloud speech fails. Edge catalog is curated; synthesis is buffered with bounded lifetime and size.

## Ownership
Backend and frontend implementation are delegated to separate BB child worktrees. Parent owns integration, final verification, and runtime reload. Do not push until requested.
