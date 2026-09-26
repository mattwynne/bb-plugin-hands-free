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

Open a thread's **… → Enter hands-free mode** action (in BB's sidebar thread actions menu), or open **Voice Drive** in the sidebar and select a thread. The **Voice** button in the thread header remains as a shortcut. Tap the large **Tap to talk** button; tap **Finish dictating**, check or edit the transcript, optionally tap **Read my words**, then tap **Send this reply**. Tap **Read reply** to hear the agent's latest answer. **Read new replies automatically** is opt-in, lasts only while this page is open, and does not auto-send anything.

## Limits and safety

- This is a BB plugin UI, **not CarPlay**, Siri, a wake-word listener, or a background audio service. Keep the BB app open and unlocked. iOS can suspend capture/playback on lock, app switch or an incoming call.
- Tap-to-talk records with `getUserMedia`/`MediaRecorder` and sends the clip to BB's voice transcription endpoint (configure `BB_TRANSCRIPTION` if needed). Recording ends after 60 seconds. If those WebView APIs are missing, it tries `SpeechRecognition`/`webkitSpeechRecognition`. **Microphone access and the transcription endpoint must be tested on a physical iPhone.** If either fails, tap the text box and use the iPhone keyboard microphone (Apple Dictation). A plugin cannot force keyboard dictation to start programmatically.
- Recorded audio goes to BB's configured transcription provider; fallback browser speech recognition may use the OS or browser speech service. Read Aloud sends text to Microsoft's neural voice service. Avoid dictating or reading secrets if those services are inappropriate for your data. Without Read Aloud, device speech synthesis is attempted instead.
- iOS may reject automatic playback after the agent replies if it no longer considers the earlier tap a user gesture. Tap **Read reply** again in that case. Auto-read is best effort, not guaranteed.
- This does **not** approve tool calls or permission prompts, read every stream update, or make coding tasks safe to supervise while driving. Pull over to inspect changes and approve actions. Sending is an explicit separate button and uses only a fresh turn on an idle thread; a busy thread returns an error rather than steering/queuing silently. Sending via the plugin uses the thread's server-side defaults; it does not carry a draft, attachment or temporary model/permission choice from BB's normal composer. Use the normal composer when those choices matter.
- BB 0.43 has no public thread-actions-menu extension slot. The **…** entry uses a narrowly scoped content script that attaches beside **Copy thread link** when the menu opens. This depends on BB's menu markup and may need adjustment after BB updates; if it disappears, use the header button or Voice Drive sidebar entry. The action deliberately does not guess a thread if it cannot identify exactly one.
- Latest answer is the thread's last assistant output, not an all-message transcript. Answers over 12,000 characters are not silently truncated: open the normal thread to review them. The voice page only lists threads present in BB's current sidebar roster.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`server.ts` exposes two schema-validated RPC calls (latest output and send), and publishes thread-idle notifications without broadcasting message text. `app.tsx` owns speech state in the page and releases the microphone and audio on thread change/unmount. `menu-link.ts` owns the optional DOM menu enhancement and cleans it up when disabled. There is no server-side transcript storage. The Read Aloud HTTP integration uses its `/prepare` and `/stream` routes; if those private routes change, device speech is the fallback.
