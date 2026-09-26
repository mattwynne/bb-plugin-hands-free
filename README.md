# BB Voice Drive

A large-button, tap-to-talk companion for **BB on iPhone**. This is a separate plugin from [Read Aloud](https://github.com/csells/bb-plugins/tree/HEAD/plugins/read-aloud); it can use Read Aloud's voice service when that plugin is installed, falling back to the device voice.

## Install

```sh
bb plugin install /home/matt/projects/bb-plugin-voice-drive
# Optional, for the neural voice (clone and install its subdirectory):
git clone https://github.com/csells/bb-plugins.git
bb plugin install ./bb-plugins/plugins/read-aloud
```

Voice Drive itself has **no API key**, but recording transcription uses BB's configured voice transcription service (see `bb settings ai-services`).

Open **Voice Drive** in the BB sidebar, select a thread, or use the **Voice** button in a thread header. A rising two-note cue means **ready to dictate** (also played when recording actually starts); tap **Tap to talk**. Tap **Finish dictating** for a confirmation cue: speech is transcribed and **sent immediately, without review**. During volume calibration, tap, finish, and post-reply all use the same rising two-note tone. Quiet two-note pulses play every five seconds while the agent works. The talk button stays disabled until the thread is idle; if an approval is needed, it stays disabled and the thinking pulses stop. After the agent finishes, Voice Drive **reads the reply automatically**, without a preview or Read button, while this page stays open. On streamed playback completion, it starts the Web Audio ready cue before releasing the speech player (to avoid iOS clipping it). On the tested iPhone, the baseline Web Audio cue after `speechSynthesis` was absent even though pre-speech cues worked; recreating `AudioContext` did not restore it, and explicitly forcing the Safari playback session interfered with microphone access. An immediate post-speech locally generated WAV through `HTMLAudioElement` played quietly, and it remained quiet after cancelling device speech and waiting one second, showing that both playback paths can be quiet; the native cause remains unconfirmed. The tap-to-talk and finish-dictating Web Audio cues now share the same `0.14` source gain. The post-speech WAV uses the same frequencies, timing, waveform, and exponential envelope, with targeted 8× compensation for the observed iOS attenuation while leaving the already-loud pre-speech cue unchanged; microphone handling and audio-session settings are untouched. It also detects device-speech completion if the WebView drops its end event. Tap **Stop audio** to interrupt playback. A 60-second recording limit automatically finishes and sends the recording. If sending fails, **Retry sending** appears; nothing is silently discarded.

## Limits and safety

- This is a BB plugin UI, **not CarPlay**, Siri, a wake-word listener, or a background audio service. Keep the BB app open and unlocked. iOS can suspend capture/playback on lock, app switch or an incoming call.
- Tap-to-talk records with `getUserMedia`/`MediaRecorder` and sends the clip to BB's voice transcription endpoint (configure `BB_TRANSCRIPTION` if needed). Recording ends after 60 seconds. If those WebView APIs are missing, it tries `SpeechRecognition`/`webkitSpeechRecognition`. If capture fails, a **keyboard dictation fallback** appears with a Send button because iOS does not let a plugin start the keyboard microphone or detect when its dictation is finished. No transcript or manual send button is shown in the normal microphone flow.
- Recorded audio goes to BB's configured transcription provider; fallback browser speech recognition may use the OS or browser speech service. Read Aloud sends text to Microsoft's neural voice service. Avoid dictating or reading secrets if those services are inappropriate for your data. Without Read Aloud, device speech synthesis is attempted instead.
- Cues are generated locally and never sent to a service. Normal cues use Web Audio; the isolated post-device-speech experiment uses a local PCM WAV through `HTMLAudioElement`. iOS may suppress the initial ready cue before a microphone tap unlocks audio. Cue volume is deliberately low; device silent mode and output routing can also affect audibility. iOS may reject automatic playback after the agent replies if it no longer considers the earlier tap a user gesture. The plugin tries device speech as a fallback and shows an error if playback fails; there is deliberately no manual Read button. Auto-read is best effort, not guaranteed. The phone must remain unlocked with BB in the foreground.
- **Speech is sent as soon as dictation ends**; there is no chance to correct transcription before the agent sees it. Do not dictate passwords, destructive instructions or anything you must inspect first. This does **not** approve tool calls or permission prompts, read every stream update, or make coding tasks safe to supervise while driving. Pull over to inspect changes and approve actions. Sending uses only a fresh turn on an idle thread; a busy thread returns an error rather than steering/queuing silently. It uses the thread's server-side defaults, not temporary model/permission choices or attachments from BB's normal composer.
- When a selected thread becomes idle, Voice Drive reads its last assistant output, not every streaming update or a full transcript. Identical consecutive outputs are de-duplicated. Answers over 12,000 characters are not silently truncated: open the normal thread to review them. The voice page only lists threads present in BB's current sidebar roster.

## Isolated audio comparison

Open **Audio test** in BB's sidebar. For a clean comparison, open that page, fully quit/reopen BB, keep phone volume fixed, and do not start dictation first.

1. **Tone-only control**: tone A, one-second silence, then automatic tone B.
2. **Speech comparison**: tone A, device speech saying only “Test,” then automatic tone B on the speech-end event.
3. **Microphone comparison** (explicit opt-in): open the mic, play tone A while its tracks are live, stop all tracks, wait the same one-second gap as the control, then play tone B. No speech and no `MediaRecorder`: microphone audio is never saved, uploaded, transcribed, or connected to an output. This isolates capture start/stop rather than the full recording workflow. Stopping tracks does not prove the native audio session has finished transitioning.

Report here in chat whether B is quieter than A **in each test**, and whether A itself was clearly audible. Both tones reuse the exact same local WAV and media element at unboosted gain `0.14`. Tests 1 and 2 never open the microphone. None creates an AudioContext, changes audio-session settings, reads thread content, or calls a TTS/transcription service. There is no fallback that could hide which path ran. Errors and a 20-second timeout (including permission waits) are shown as failed tests, not quiet playback. Stop, navigation, and backgrounding release the capture test's tracks; a late permission grant after cancellation is immediately released without playing anything. Leaving the page stops its playback and cancels only its own active speech.

Run-correlated metadata is available via `bb plugin logs voice-drive -n 120`: fixed test/event/session-type enums and elapsed times, no conversation text, recordings, device labels, or freeform errors. Logs are limited to 32 events per run in the UI and 120 events/minute on the server. Session type is observed, not changed, and is not evidence of the native speaker route or output volume. Tests with fake APIs verify sequencing and isolation, not acoustic volume.

See [the sourced investigation](docs/audio-investigation-options.md) for previous findings and remaining options. Normal Voice Drive cue behavior is unchanged by the separate comparison page.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`server.ts` exposes four schema-validated RPC calls (latest output, thread state, send, and bounded audio-test diagnostics), and publishes active/idle/failure/interaction notifications without broadcasting message text. `app.tsx` owns speech state in the page and releases the microphone and audio on thread change/unmount. There is no server-side transcript storage. The Read Aloud HTTP integration uses its `/prepare` and `/stream` routes; if those private routes change, device speech is the fallback.
