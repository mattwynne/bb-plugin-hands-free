# BB Hands-Free

A large-button, tap-to-talk and spoken-reply companion for **BB on iPhone**. Choose device speech, built-in Microsoft Edge neural voices, or OpenAI voices. No Read Aloud installation is needed. Neural speech support was inspired by [Chris Sells’ Read Aloud](https://github.com/csells/bb-plugins/tree/HEAD/plugins/read-aloud); adapted Edge protocol code retains its full MIT license in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Install

```sh
bb plugin install git:https://github.com/mattwynne/bb-plugin-hands-free.git@^0.1.0
```

Edge voices need no API key. OpenAI voices require the optional **OpenAI speech API key** secret in **Settings → Installed plugins → Hands-Free** and incur OpenAI API charges. All OpenAI voices remain visible but disabled, with a missing-credentials reason, until that key is set. Recording transcription remains separate and uses BB's configured transcription service (see `bb settings ai-services`).

**The voices you hear are AI-generated, not human.** Choose voice and speaking speed in the Hands-Free settings. Device speech is an explicit choice, not a silent downgrade from a failed network voice.

### Why a separate OpenAI key?

The installed, host-aligned public SDK **0.4.87** exposes `system.transcribeVoice` and AI-service registration for `inference` and `voice` (transcription), but no TTS consumer service or configured-provider credential getter. Provider resources explicitly exclude credentials. Hands-Free therefore uses the supported `bb.settings.define({ secret: true })` mechanism for `openaiApiKey`; it does not inspect BB's private database, configuration or secrets files, and never returns or logs credential values. The key stays on the server and is sent only to the fixed OpenAI HTTPS speech endpoint. Availability means a key is configured, not that its billing or permissions have been verified.

Open **Hands-Free** in the BB sidebar, select a thread, or use the **Hands-Free** button in a thread header. Opening or selecting an idle thread is silent. Tap the microphone button; a rising two-note cue confirms recording has started. Tap the stop-square button to finish dictating for a confirmation cue: speech is transcribed and **sent immediately, without review**. Tap and finish use a rising two-note tone, with a slightly quieter tap cue. A distinct falling two-note chime signals that the spoken reply has ended. Quiet two-note pulses play every five seconds while the agent works. The talk button stays disabled until the thread is idle; if an approval is needed, it stays disabled and the thinking pulses stop. After the agent finishes, Hands-Free **reads the reply automatically**, without a preview or Read button, while this page stays open. All confirmation cues reuse **one retained media player**. The tap cue uses 85% of the normal PCM amplitude (source gain `0.119`); finish and post-reply remain at `0.14`, without the experimental 8× boost. All three local WAV variants are cached. The post-reply chime reverses the note order (659 → 523 Hz) without creating another media player. Microphone handling, thinking pulses, audio-session policy, and the existing one-second post-device-speech cue delay are unchanged. It also detects device-speech completion if the WebView drops its end event. Tap the stop-square button to interrupt playback. Expand **Thread activity** to inspect the host's live conversation and tool timeline; it starts collapsed. While recording, the talk button shows a scrolling microphone-level waveform; browser SpeechRecognition (which exposes no audio samples) shows a decorative scrolling indicator instead. Reduced-motion settings keep the display still. A 60-second recording limit automatically finishes and sends the recording. If sending fails, **Retry sending** appears; nothing is silently discarded.

## Limits and safety

- Hands-Free runs only while the BB app is open and unlocked. It is not a wake-word listener or background audio service. iOS can suspend capture/playback on lock, app switch or an incoming call.
- Tap-to-talk records with `getUserMedia`/`MediaRecorder` and sends the clip to BB's voice transcription endpoint (configure `BB_TRANSCRIPTION` if needed). Recording ends after 60 seconds. If those WebView APIs are missing, it tries `SpeechRecognition`/`webkitSpeechRecognition`. If capture fails, a **keyboard dictation fallback** appears with a Send button because iOS does not let a plugin start the keyboard microphone or detect when its dictation is finished. No transcript or manual send button is shown in the normal microphone flow.
- Recorded audio goes to BB's configured transcription provider; fallback browser speech recognition may use the OS or browser speech service. Edge speech sends reply/preview text to Microsoft; OpenAI speech sends it to OpenAI. Device speech uses the OS/browser service. Avoid dictating or reading secrets if those services are inappropriate for your data.
- Cues are generated locally and never sent to a service. Tap/finish/post-reply cues reuse one `HTMLAudioElement` with cached rising tap/finish and falling reply PCM WAVs; only the quiet thinking pulse uses Web Audio. Stop pauses the cue without discarding its player or source; leaving the page releases both. Device silent mode and output routing can also affect audibility. iOS may reject automatic playback after the agent replies if it no longer considers the earlier tap a user gesture. The plugin shows an error if the selected voice fails; choose another voice explicitly to retry; there is deliberately no manual Read button. Auto-read is best effort, not guaranteed. The phone must remain unlocked with BB in the foreground.
- **Speech is sent as soon as dictation ends**; there is no chance to correct transcription before the agent sees it. Do not dictate passwords, destructive instructions or anything you must inspect first. Hands-Free does **not** approve tool calls or permission prompts, read every stream update, or replace reviewing code changes in the normal thread view. Sending uses only a fresh turn on an idle thread; a busy thread returns an error rather than steering/queuing silently. It uses the thread's server-side defaults, not temporary model/permission choices or attachments from BB's normal composer.
- When a selected thread becomes idle, Hands-Free reads its last assistant output, not every streaming update or a full transcript. Identical consecutive outputs are de-duplicated. Network speech accepts at most 4,096 characters per request and does not silently truncate: open the normal thread to review longer answers. The voice page only lists threads present in BB's current sidebar roster.

## Identity

The package is `bb-plugin-hands-free` and its BB plugin ID is `hands-free`. The sidebar route is `hands-free`, and the bundled skill is `skills/hands-free`.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`server.ts` exposes three schema-validated RPC calls (latest output, thread state, and send), and publishes active/idle/failure/interaction notifications without broadcasting message text. `app.tsx` owns speech state in the page and releases the microphone and audio on thread change/unmount. No transcripts or speech audio are persisted. The plugin owns its speech HTTP routes and does not call another plugin's private APIs. Request text and MP3 data exist temporarily in server memory during synthesis; prepared audio expires after two minutes, and client cleanup, settings changes or plugin disposal release it.

### Speech HTTP contract

Base: `/api/v1/plugins/hands-free/http`. Every route explicitly uses public SDK `auth: "local"` (BB trusted-origin checks; mutations require `application/json`) and responses use `Cache-Control: no-store`. Use BB's authenticated remote access, not an unprotected public server. This SDK mode does not expose a per-user principal: jobs are random UUIDs scoped to the plugin, not per-user ACLs.

- `GET /voices` → `{voices:[{id,name,engine,language,available,unavailableReason?}]}`. Engines are `edge` or `openai`; device voices remain client-side. The fixed curated Edge catalog contains `edge:en-US-AriaNeural`, `edge:en-US-GuyNeural`, `edge:en-GB-SoniaNeural`, `edge:en-GB-RyanNeural`. OpenAI IDs are `openai:` followed by alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin or cedar. OpenAI language is `multilingual`; Edge uses the voice's locale. Catalog loading makes no provider network requests.
- `POST /speech/prepare` with `{text,voiceId,speed?}` → `{audioId,url,expiresAt}`. Text is trimmed, nonempty and limited to 4,096 UTF-16 code units; JSON body limit is 32 KiB. Speed defaults to 1, range 0.5–2. `expiresAt` is epoch milliseconds. **Prepare waits for complete synthesis**; aborting it cancels upstream work. There is no partial-audio streaming or automatic paid retry.
- `GET /speech/audio?id=<audioId>` (the returned `url`) → reusable `audio/mpeg` until expiry, suitable for a retained HTML audio player.
- `DELETE /speech/audio?id=<audioId>` → `{deleted:true}` (idempotent). Send the JSON content-type header even without a body.
- Errors are `{error:string,code:string}` with sanitized messages: 400 invalid input/cancelled, 409 unavailable voice, 429 capacity, 502 upstream/audio failure, 504 synthesis timeout, 404 unknown/expired audio. Upstream bodies are never forwarded.

Limits: two concurrent preparations, eight retained/in-flight jobs, 8 MiB MP3 per job, 60-second synthesis deadline, 10-second input-read/Edge handshake deadline, and 120-second audio TTL. Settings changes and plugin disposal abort active work and clear cached audio. Long Edge requests may exceed the deadline; shorten the text. Edge uses an unofficial Read Aloud endpoint with a pinned client protocol/version, so service changes may require an update. Availability does not guarantee network reachability. Neither network voice requires local executables.

OpenAI uses `gpt-4o-mini-tts` at `POST https://api.openai.com/v1/audio/speech`, MP3 output, and the documented voice/speed parameters (the plugin intentionally narrows speed to 0.5–2). References: [OpenAI speech guide](https://developers.openai.com/api/docs/guides/text-to-speech), [create speech API](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create).

The temporary Audio test panel and diagnostic RPCs have been removed. Automated regression tests remain; the [archived audio investigation](docs/audio-investigation-options.md) preserves the findings and rationale.
