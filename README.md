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

Open **Voice Drive** in the BB sidebar, select a thread, or use the **Voice** button in a thread header. Opening or selecting an idle thread is silent. Tap **Tap to talk**; a rising two-note cue confirms recording has started. Tap **Finish dictating** for a confirmation cue: speech is transcribed and **sent immediately, without review**. Tap and finish use a rising two-note tone, with a slightly quieter tap cue. A distinct falling two-note chime signals that the spoken reply has ended. Quiet two-note pulses play every five seconds while the agent works. The talk button stays disabled until the thread is idle; if an approval is needed, it stays disabled and the thinking pulses stop. After the agent finishes, Voice Drive **reads the reply automatically**, without a preview or Read button, while this page stays open. All confirmation cues reuse **one retained media player**. The tap cue uses 85% of the normal PCM amplitude (source gain `0.119`); finish and post-reply remain at `0.14`, without the experimental 8× boost. All three local WAV variants are cached. The post-reply chime reverses the note order (659 → 523 Hz) without creating another media player. Microphone handling, thinking pulses, audio-session policy, and the existing one-second post-device-speech cue delay are unchanged. It also detects device-speech completion if the WebView drops its end event. Tap **Stop audio** to interrupt playback. A 60-second recording limit automatically finishes and sends the recording. If sending fails, **Retry sending** appears; nothing is silently discarded.

## Limits and safety

- This is a BB plugin UI, **not CarPlay**, Siri, a wake-word listener, or a background audio service. Keep the BB app open and unlocked. iOS can suspend capture/playback on lock, app switch or an incoming call.
- Tap-to-talk records with `getUserMedia`/`MediaRecorder` and sends the clip to BB's voice transcription endpoint (configure `BB_TRANSCRIPTION` if needed). Recording ends after 60 seconds. If those WebView APIs are missing, it tries `SpeechRecognition`/`webkitSpeechRecognition`. If capture fails, a **keyboard dictation fallback** appears with a Send button because iOS does not let a plugin start the keyboard microphone or detect when its dictation is finished. No transcript or manual send button is shown in the normal microphone flow.
- Recorded audio goes to BB's configured transcription provider; fallback browser speech recognition may use the OS or browser speech service. Read Aloud sends text to Microsoft's neural voice service. Avoid dictating or reading secrets if those services are inappropriate for your data. Without Read Aloud, device speech synthesis is attempted instead.
- Cues are generated locally and never sent to a service. Tap/finish/post-reply cues reuse one `HTMLAudioElement` with cached rising tap/finish and falling reply PCM WAVs; only the quiet thinking pulse uses Web Audio. Stop pauses the cue without discarding its player or source; leaving the page releases both. Device silent mode and output routing can also affect audibility. iOS may reject automatic playback after the agent replies if it no longer considers the earlier tap a user gesture. The plugin tries device speech as a fallback and shows an error if playback fails; there is deliberately no manual Read button. Auto-read is best effort, not guaranteed. The phone must remain unlocked with BB in the foreground.
- **Speech is sent as soon as dictation ends**; there is no chance to correct transcription before the agent sees it. Do not dictate passwords, destructive instructions or anything you must inspect first. This does **not** approve tool calls or permission prompts, read every stream update, or make coding tasks safe to supervise while driving. Pull over to inspect changes and approve actions. Sending uses only a fresh turn on an idle thread; a busy thread returns an error rather than steering/queuing silently. It uses the thread's server-side defaults, not temporary model/permission choices or attachments from BB's normal composer.
- When a selected thread becomes idle, Voice Drive reads its last assistant output, not every streaming update or a full transcript. Identical consecutive outputs are de-duplicated. Answers over 12,000 characters are not silently truncated: open the normal thread to review them. The voice page only lists threads present in BB's current sidebar roster.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`server.ts` exposes three schema-validated RPC calls (latest output, thread state, and send), and publishes active/idle/failure/interaction notifications without broadcasting message text. `app.tsx` owns speech state in the page and releases the microphone and audio on thread change/unmount. There is no server-side transcript storage. The Read Aloud HTTP integration uses its `/prepare` and `/stream` routes; if those private routes change, device speech is the fallback.

The temporary Audio test panel and diagnostic RPCs have been removed. Automated regression tests remain; the [archived audio investigation](docs/audio-investigation-options.md) preserves the findings and rationale.
