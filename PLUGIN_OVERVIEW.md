Use your iPhone to dictate a message to an existing BB thread and hear its reply when the agent finishes.

## What you get

Hands-Free adds a tap-to-talk page in the BB sidebar and a shortcut in each thread header. The recording button shows a waveform while listening and a reduced-motion-aware working indicator while the agent runs. Expand Thread activity whenever you want to inspect the live conversation and tool use. Spoken replies play automatically while the page remains open; you can stop playback.

## How it works

Choose a thread, tap the microphone, speak, then tap again to finish. Recording is limited to 60 seconds. Hands-Free transcribes and sends immediately: **there is no transcript review before sending**. If microphone capture is unavailable, it offers a keyboard-dictation text fallback. Recording and reply cues are generated locally.

## Requirements and limits

Requires BB 0.43 or newer with a configured voice-transcription service, an iPhone with BB open and unlocked, and microphone access. Browser speech recognition may be used as a fallback. Device speech synthesis reads replies by default; the separately installed [Read Aloud plugin](https://github.com/csells/bb-plugins/tree/HEAD/plugins/read-aloud) can provide a neural voice through Microsoft's service. Audio may fail when iOS locks or suspends the app. Do not dictate secrets or destructive instructions: text is sent without review, and audio or speech may pass through the configured transcription, browser, or voice provider. Hands-Free does not approve agent permissions or replace the normal thread view for reviewing code changes.
