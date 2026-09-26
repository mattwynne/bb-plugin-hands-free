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

Open **Voice Drive** in the BB sidebar, select a thread, or use the **Voice** button in a thread header. A rising two-note cue means **ready to dictate** (also played when recording actually starts); tap **Tap to talk**. Tap **Finish dictating** for a descending confirmation cue: speech is transcribed and **sent immediately, without review**. Quiet two-note pulses play every five seconds while the agent works. The talk button stays disabled until the thread is idle; if an approval is needed, it stays disabled and the thinking pulses stop. After the agent finishes, Voice Drive **reads the reply automatically**, without a preview or Read button, while this page stays open. For the current iPhone audio diagnostic, the ready cue is deliberately long (~1.3 seconds). On natural playback completion, it starts that cue before releasing the speech player three seconds later. It attempts to resume Web Audio if iOS interrupts the audio session, and detects device-speech completion if the WebView drops its end event. The temporary **Test ready tone (diagnostic)** button plays the same cue from a direct tap. The on-screen diagnostic reports whether the speech-end event or fallback fired and whether Web Audio scheduled the cue; **scheduled does not prove audible output**. Tap **Stop audio** to interrupt playback. A 60-second recording limit automatically finishes and sends the recording. If sending fails, **Retry sending** appears; nothing is silently discarded.

## Limits and safety

- This is a BB plugin UI, **not CarPlay**, Siri, a wake-word listener, or a background audio service. Keep the BB app open and unlocked. iOS can suspend capture/playback on lock, app switch or an incoming call.
- Tap-to-talk records with `getUserMedia`/`MediaRecorder` and sends the clip to BB's voice transcription endpoint (configure `BB_TRANSCRIPTION` if needed). Recording ends after 60 seconds. If those WebView APIs are missing, it tries `SpeechRecognition`/`webkitSpeechRecognition`. If capture fails, a **keyboard dictation fallback** appears with a Send button because iOS does not let a plugin start the keyboard microphone or detect when its dictation is finished. No transcript or manual send button is shown in the normal microphone flow.
- Recorded audio goes to BB's configured transcription provider; fallback browser speech recognition may use the OS or browser speech service. Read Aloud sends text to Microsoft's neural voice service. Avoid dictating or reading secrets if those services are inappropriate for your data. Without Read Aloud, device speech synthesis is attempted instead.
- The cues are synthesized locally with Web Audio, not sent to a service. iOS may suppress the initial ready cue before a microphone tap unlocks audio. Cue volume is deliberately low; device silent mode and output routing can also affect audibility. iOS may reject automatic playback after the agent replies if it no longer considers the earlier tap a user gesture. The plugin tries device speech as a fallback and shows an error if playback fails; there is deliberately no manual Read button. Auto-read is best effort, not guaranteed. The phone must remain unlocked with BB in the foreground.
- **Speech is sent as soon as dictation ends**; there is no chance to correct transcription before the agent sees it. Do not dictate passwords, destructive instructions or anything you must inspect first. This does **not** approve tool calls or permission prompts, read every stream update, or make coding tasks safe to supervise while driving. Pull over to inspect changes and approve actions. Sending uses only a fresh turn on an idle thread; a busy thread returns an error rather than steering/queuing silently. It uses the thread's server-side defaults, not temporary model/permission choices or attachments from BB's normal composer.
- When a selected thread becomes idle, Voice Drive reads its last assistant output, not every streaming update or a full transcript. Identical consecutive outputs are de-duplicated. Answers over 12,000 characters are not silently truncated: open the normal thread to review them. The voice page only lists threads present in BB's current sidebar roster.

## Audio diagnostics

After an iPhone test, inspect recent events with `bb plugin logs voice-drive -n 100` (or `bb plugin logs voice-drive -f` while testing). Entries include a random per-page session id, thread state transitions, reply start/end source, Web Audio context state and resume result, cue scheduling, oscillator completion, and playback cleanup. They **never contain thread ids, speech transcripts, response text, or audio bytes**. Browser reports such as `cue-scheduled` and `cue-ended` prove that nodes ran, **not** that iOS routed audible sound. Logs are rate-limited to 120 events/minute globally and 100 events/page. The on-screen manual vs automatic cue line remains available for a quick comparison. If the tone is quiet after device speech, use **Test ready tone** and then **Reset audio & test tone**. The second control closes the current Web Audio context and creates a fresh one in the tap gesture; comparing their volume tells us whether the old context was left ducked by iOS. These controls are temporary diagnostics, not part of the final driving UI.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`server.ts` exposes four schema-validated RPC calls (latest output, thread state, send, and bounded diagnostics), and publishes active/idle/failure/interaction notifications without broadcasting message text. `app.tsx` owns speech state in the page and releases the microphone and audio on thread change/unmount. There is no server-side transcript storage. The Read Aloud HTTP integration uses its `/prepare` and `/stream` routes; if those private routes change, device speech is the fallback.
