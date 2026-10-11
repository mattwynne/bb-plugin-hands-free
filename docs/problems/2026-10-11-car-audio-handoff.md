# 2026-10-11 — Car audio handoff between Hands-Free and other apps

Hands-Free cannot reliably hand the car stereo back to music or an audiobook while BB thinks and reclaim it for a spoken reply. In an on-car test, recording paused the music; removing the thinking tones did not resume it. When the reply started, BB's browser reported that the audio was playing, but it was not audible through the stereo. Pressing Play on the head unit resumed the music rather than BB. The quiet-thinking experiment was reverted.

Hands-Free runs in the upstream BB iPhone app's WKWebView. Browser audio APIs do not expose the native iOS audio-session options that navigation apps use to mix or duck music, interrupt spoken audio, and notify other apps when a prompt finishes. Browser `playing` events also cannot establish which source the stereo is rendering. A reliable handoff probably needs an upstream BB mobile change: a native audio component or bridge that owns prompt playback and coordinates its audio session with WebView recording. This is feasible to explore without rewriting the whole app, but it is not guaranteed to make every music app resume automatically and would require on-device car/Bluetooth testing.

Deferred: there is no capacity to implement or validate that native integration now. Do not treat another plugin-side `play()` call or silent thinking period as a demonstrated fix.

References: [Hands-Free audio investigation](../audio-investigation-options.md), [W3C Audio Session API](https://w3c.github.io/audio-session/), [Apple AVAudioSession](https://developer.apple.com/documentation/avfaudio/avaudiosession), [Apple duckOthers option](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions/1616618-duckothers).
