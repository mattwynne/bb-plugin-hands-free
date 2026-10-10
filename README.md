# BB Hands-Free

A large-button, tap-to-talk and spoken-reply companion for **BB in a mobile browser or the iPhone app**. Spoken replies use Microsoft Edge neural voices only. No Read Aloud installation is needed. Neural speech support was inspired by [Chris Sells’ Read Aloud](https://github.com/csells/bb-plugins/tree/HEAD/plugins/read-aloud); adapted Edge protocol code retains its full MIT license in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Install

```sh
bb plugin install git:https://github.com/mattwynne/bb-plugin-hands-free.git@^0.2.1
```

Edge voices need no API key. Recording transcription remains separate and uses BB's configured transcription service (see `bb settings ai-services`). **The voices you hear are AI-generated, not human.** Choose an Edge voice and speaking speed in Hands-Free settings. The default is Sonia; saved device/OpenAI selections migrate to Sonia while retaining speed. Browser speech recognition remains available as a microphone transcription fallback, not a speech-output engine.

Open **Hands-Free** in the BB sidebar, select a thread, or use the **Hands-Free** button in a thread header. Opening or selecting an idle thread is silent. Tap the microphone button; a rising two-note cue confirms recording has started. Tap the up-arrow button to finish dictating for a confirmation cue: speech is transcribed and **sent immediately, without review**. Tap and finish use a rising two-note tone, with a slightly quieter tap cue. A distinct falling two-note chime signals that the spoken reply has ended. Quiet two-note pulses play every five seconds while the agent works. The talk button stays disabled until the thread is idle; if an approval is needed, it stays disabled and the thinking pulses stop. After the agent finishes, Hands-Free **reads the reply automatically**, without a preview or Read button, while this page stays open. All confirmation cues reuse **one retained media player**. The tap cue uses 85% of the normal PCM amplitude (source gain `0.119`); finish and post-reply remain at `0.14`, without the experimental 8× boost. All three local WAV variants are cached. The post-reply chime reverses the note order (659 → 523 Hz) without creating another media player. Thinking notes now use a five-second looping WAV on the same media element that reads the reply, keeping media playback active until speech is ready; microphone handling and audio-session policy are unchanged. Tap the stop-square button to interrupt playback. Expand **Thread activity** to inspect the host's live conversation and tool timeline; it starts collapsed. While recording, the talk button shows a scrolling microphone-level waveform; browser SpeechRecognition (which exposes no audio samples) shows a decorative scrolling indicator instead. Reduced-motion settings keep the display still. A 60-second recording limit automatically finishes and sends the recording. If sending fails, **Retry sending** appears; nothing is silently discarded.

## Limits and safety

- Hands-Free runs only while BB is open in the foreground, whether in a browser or the iPhone app. It is not a wake-word listener or background audio service. iOS can suspend capture/playback on lock, app switch or an incoming call. Browsers require a secure context (HTTPS or localhost) and microphone permission for recording.
- Tap-to-talk records with `getUserMedia`/`MediaRecorder` and sends the clip to BB's voice transcription endpoint (configure `BB_TRANSCRIPTION` if needed). Recording ends after 60 seconds. If those WebView APIs are missing, it tries `SpeechRecognition`/`webkitSpeechRecognition`. If capture fails, a **keyboard dictation fallback** appears with a Send button because iOS does not let a plugin start the keyboard microphone or detect when its dictation is finished. No transcript or manual send button is shown in the normal microphone flow.
- Recorded audio goes to BB's configured transcription provider; fallback browser speech recognition may use the OS or browser speech service. Edge speech sends reply/preview text to Microsoft. Avoid dictating or reading secrets if those services are inappropriate for your data.
- Cues are generated locally and never sent to a service. Tap/finish/post-reply cues reuse one `HTMLAudioElement` with cached rising tap/finish and falling reply PCM WAVs. Thinking notes loop on a second retained media element at peak PCM gain `0.14` (the same peak as the completion cue), which switches to the prepared MP3 without a `pause()` call before the spoken reply. Stop interrupts active playback; leaving the page releases both players and the local WAV. Device silent mode and output routing can also affect audibility. iOS may reject automatic playback after the agent replies if it no longer considers the earlier tap a user gesture. The plugin shows an error if the selected voice fails; choose another voice explicitly to retry; there is deliberately no manual Read button. Auto-read is best effort, not guaranteed. The phone must remain unlocked with BB in the foreground.
- **Speech is sent as soon as dictation ends**; there is no chance to correct transcription before the agent sees it. Do not dictate passwords, destructive instructions or anything you must inspect first. Hands-Free does **not** approve tool calls or permission prompts, read every stream update, or replace reviewing code changes in the normal thread view. Sending uses only a fresh turn on an idle thread; a busy thread returns an error rather than steering/queuing silently. It uses the thread's server-side defaults, not temporary model/permission choices or attachments from BB's normal composer.
- When a selected thread becomes idle, Hands-Free reads its last assistant output, not every streaming update or a full transcript. Markdown is converted to plain text before either device or network speech, so formatting markers and link destinations are not spoken. Identical consecutive outputs are de-duplicated. Network speech accepts at most 4,096 characters per request and does not silently truncate: open the normal thread to review longer answers. The voice page only lists threads present in BB's current sidebar roster.

## Identity

The package is `bb-plugin-hands-free` and its BB plugin ID is `hands-free`. The sidebar route is `hands-free`, and the bundled skill is `skills/hands-free`.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`server.ts` exposes schema-validated RPC calls for latest output, thread state, send, and bounded audio diagnostics, and publishes active/idle/failure/interaction notifications without broadcasting message text. `app.tsx` owns speech state in the page and releases the microphone and audio on thread change/unmount. No transcripts or speech audio are persisted. The plugin owns its speech HTTP routes and does not call another plugin's private APIs. Request text and MP3 data exist temporarily in server memory during synthesis; prepared audio expires after two minutes, and client cleanup or plugin disposal release it.

### Speech HTTP contract

Base: `/api/v1/plugins/hands-free/http`. Every route explicitly uses public SDK `auth: "local"` (BB trusted-origin checks; mutations require `application/json`) and responses use `Cache-Control: no-store`. Use BB's authenticated remote access, not an unprotected public server. This SDK mode does not expose a per-user principal: jobs are random UUIDs scoped to the plugin, not per-user ACLs.

- `GET /voices` → `{voices:[{id,name,engine,language,available}]}`. The only engine is `edge`; the fixed catalog contains `edge:en-US-AriaNeural`, `edge:en-US-GuyNeural`, `edge:en-GB-SoniaNeural`, and `edge:en-GB-RyanNeural`. Catalog loading makes no provider network requests.
- `POST /speech/prepare` with `{text,voiceId,speed?}` → `{audioId,url,expiresAt}`. Text is trimmed, nonempty and limited to 4,096 UTF-16 code units; JSON body limit is 32 KiB. Speed defaults to 1, range 0.5–2. `expiresAt` is epoch milliseconds. **Prepare waits for complete synthesis**; aborting it cancels upstream work. There is no partial-audio streaming or automatic retry.
- `GET /speech/audio?id=<audioId>` (the returned `url`) → reusable `audio/mpeg` until expiry, suitable for a retained HTML audio player.
- `DELETE /speech/audio?id=<audioId>` → `{deleted:true}` (idempotent). Send the JSON content-type header even without a body.
- Errors are `{error:string,code:string}` with sanitized messages: 400 invalid input/unknown voice/cancelled, 429 capacity, 502 upstream/audio failure, 504 synthesis timeout, 404 unknown/expired audio. Upstream bodies are never forwarded.

Limits: two concurrent preparations, eight retained/in-flight jobs, 8 MiB MP3 per job, 60-second synthesis deadline, 10-second input-read/Edge handshake deadline, and 120-second audio TTL. Plugin disposal aborts active work and clears cached audio. Long Edge requests may exceed the deadline; shorten the text. Edge uses an unofficial Read Aloud endpoint with a pinned client protocol/version, so service changes may require an update. Availability does not guarantee network reachability. No local speech executable is required.

The temporary Audio test panel and its retired diagnostic RPCs have been removed. Current playback diagnostics are available via `bb plugin logs hands-free`: bounded event names, elapsed times, browser media states, synthesis outcome and audio byte counts are logged without reply text, transcripts, recordings or upstream error bodies. A browser media `playing` event does not prove the car stereo produced sound. Automated regression tests remain; the [archived audio investigation](docs/audio-investigation-options.md) preserves the findings and rationale.
