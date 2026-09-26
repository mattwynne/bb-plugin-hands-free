# iPhone cue-volume investigation: evidence and options

## Answer in brief

- **There are untested session-recovery options.** The earlier claim that a native fix is required was premature.
- A fresh `AudioContext`/player is not a fresh native session. A fully serialized context teardown was not tested either.
- `navigator.audioSession` can request a different policy **without opening the microphone**. The prior persistent `playback` experiment failed to restore a capture-compatible policy; WebKit source shows why that can reject the next microphone request.
- Native code can reconfigure/reactivate a shared session, and native speech can use a separately managed session. Neither is exposed as a general fresh-session constructor in React; WebKit's separate audio process complicates host control.
- Start with an identical, unclipped cue and separate speech-only from capture-only effects. Then test a temporary session policy or serialized teardown, one at a time. Preserve the tone requirement.

## Scope

The options review was research-only: it made no playback, microphone, provider, gain, or deployed plugin changes. Its source snapshot was deployed commit `69b11c6` (worktree equivalent `5a2c4d9`). The later diagnostic addition is described separately below.

The requirement remains an **audible nonverbal ready tone after the reply**, comparable to the tap and finish tones. Removing the tone or substituting spoken “Ready” does not meet that requirement. Opening the microphone merely to repair playback is not an acceptable default. External TTS would require explicit consent.

## What is established—and what is not

| Observation | What it supports | What it does not establish |
|---|---|---|
| Tap-to-talk produces a loud cue; the automatic post-reply cue is quiet. | There is a repeatable difference between these paths. | The user gesture alone causes the difference. The tap also starts microphone capture. |
| Earlier Web Audio diagnostics reported running, scheduled, and ended. | The sound graph ran in those tests. | Speaker route, native session category, output gain, or sound pressure. |
| A manual Web Audio test after speech was also quiet. | Lack of a new tap is not a sufficient explanation for quiet output. | Which lower-level session or route is responsible. |
| Recreating `AudioContext` did not restore volume. | Replacing the JavaScript graph was insufficient in that experiment. | A fully idle native session was recreated: the old context's `close()` was not awaited. |
| A new `Audio` element playing a local WAV after speech was audible but quiet. | Automatic media playback is possible in this configuration. A new element is insufficient. | The native session is specifically ducked; route, remembered volume, or capture processing remain alternatives. |
| `speechSynthesis.cancel()` followed by a one-second delay did not restore volume. | That particular release-and-delay experiment failed. | Every session-lifecycle remedy will fail. |
| Forcing `navigator.audioSession.type = "playback"` was followed by broken microphone access; reverting restored it. | That implementation regressed the workflow. | A carefully scoped Audio Session API transition cannot work. The implementation never restored `auto`/capture-compatible intent. |
| Raising post-reply PCM gain improved loudness. | The audible output responds to source level. | An 8× device attenuation factor was measured or is stable across devices/routes. |

**Correction to previous explanations:** persistent iOS “ducking” is a hypothesis, not a confirmed root cause. Neither “JavaScript cannot play without another gesture” nor “only native code can fix this” follows from the observations. Automatic playback is already audible.

## Source audit

- `app.tsx:startListening` unlocks Web Audio, cancels prior speech, requests `getUserMedia`, starts `MediaRecorder`, **then** plays the ready cue. Gesture, recording, session selection, and audio startup are confounded.
- `app.tsx:stopListening` requests the finish cue and stops recording. Actual cue scheduling is asynchronous, and track shutdown occurs in `onstop`; the cue can straddle that transition.
- `app.tsx:finishPlayback(true)` cancels synthesis, waits one second, creates a **new** `Audio` element for a local WAV, and retains the overall cleanup deadline at 2.5 seconds after speech completion. A delayed decoder/play start could be cut off by this fixed deadline; we have not timed media `playing`, `ended`, and cleanup on the device.
- `voice-cues.ts` generates the first two tones with oscillators and gain envelopes. `media-ready-cue.ts` generates the third with 16 kHz PCM, multiplied by eight and clamped to full scale. These are not identical audio paths or identical PCM.
- The failed Audio Session experiment (`8dd858a` / deployed `72d373d`) set `type = "playback"` after speech and on a manual test, with **no restoration before the next microphone request or on unmount**. It also changed cancellation/timing, so it was not a single-variable test. Its “succeeded” status only meant assignment did not throw; it did not verify route recovery.
- The reset experiment (`e5c6fe5`) began closing the old context and immediately created the next. Old and new context lifetimes could overlap. It did not test a quiescent interval with all Web Audio and media users released.
- Existing jsdom tests use fake audio/microphone APIs. They verify calls, timing, and cleanup—not actual iOS volume or routing. Passing them cannot establish that an iPhone audio fix works.

### Measured source clipping

I bundled and executed the current WAV generator locally with a stub `Audio` element, captured its generated `Blob`, and inspected the PCM. No audio was played and no network request was made.

| Multiplier | Peak before clamping | Clipped samples of 8,640 |
|---|---:|---:|
| 1× | 0.13840 | 0 |
| 3× | 0.41519 | 0 |
| 6× | 0.83038 | 0 |
| 8× | 1.10717 | 27 |

The current WAV lasts 0.54 seconds at 16 kHz; 27 samples (0.3125%) saturate. Clipping is a demonstrated additional distortion source, not proof that it explains all perceived loss of clarity. Increasing amplitude further will increase clipping; a longer or compressed envelope can increase average loudness but changes the tone rather than fixing session behavior.

There was also a substantial **source-level** change during the experiment. At equal peak gain `0.14`, the original WAV's sustained linear envelope has RMS `0.09465`; the later matching exponential envelope has RMS `0.02648`—an **11.06 dB reduction** over the same 0.54-second interval. These values come from evaluating the old and new formulas, not recording the phone. Thus the loss of loudness reported after matching envelopes need not represent a further iOS session change. Earlier claims about equal source level and identical tones were too strong. Envelope, average power, playback path, and native route must be separated.

## What “a fresh audio session” can mean

### Fresh JavaScript audio objects

`new AudioContext()` replaces an audio graph, and `new Audio()` replaces a media player. Neither API promises a new native iOS audio session. Our current third cue already creates a new media element every time. The earlier fresh-context test does not exclude **awaited complete teardown**, because old and new context lifetimes could overlap; even complete teardown would not guarantee a native reset.

### Browser Audio Session API: session intent without opening the microphone

The [Audio Session draft specification](https://w3c.github.io/audio-session/) exposes `navigator.audioSession` for a Window; it is not a general constructor/reset API. Audio contexts, elements, and capture tracks contribute to session behavior. Creating another player does not allocate another document AudioSession. The draft also arbitrates sessions across the top-level browsing context and child frames.

Current WebKit [`DOMAudioSession.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/audiosession/DOMAudioSession.cpp) stores the type on the **Page** and changes an underlying category override. Its `setType` does **not** call `getUserMedia`. Consequently, **requesting `play-and-record` intent without opening or recording from the microphone is a real browser-level option**. The requested category can still change speaker/Bluetooth routing or mixing. It is not guaranteed to reproduce actual-capture behavior; [WebKit 218012, comment 49](https://bugs.webkit.org/show_bug.cgi?id=218012#c49) reports differences before and after capture despite that intent.

Most importantly, current [`MediaDevices.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediastream/MediaDevices.cpp) explicitly rejects audio capture if the audio-session override is neither None nor PlayAndRecord:

> `InvalidStateError`: `AudioSession category is not compatible with audio capture.`

That is a concrete, source-supported explanation for how our previous persistent `playback` setting **could** have broken subsequent microphone requests. We did not record the device's error, and upstream source is not the installed iOS build, so this is not a retrospective proof of that error. It does demonstrate that leaving the override in place was an invalid experiment for the full capture workflow.

| Scoped intent | What it tests | Constraint |
|---|---|---|
| `auto` | Remove explicit override; allow WebKit to infer policy from active audio users. | Not a command to reset or deactivate the native session. It does not reveal the inferred category. |
| `playback` | Playback-only behavior after capture tracks have ended. | Restore capture-compatible intent **before** the next mic request; can affect other audio. |
| `play-and-record` | Whether a session-policy change alone, with **no mic activation**, restores cue loudness. | May change output route, remembered volume, Bluetooth mode, or mixing; capture itself can still behave differently. |
| `transient` | Policy intended for a short notification sound. | Not an “unduck” command. Current WebKit maps it to ambient behavior; may follow silent-mode policy. |
| `ambient` / `transient-solo` | Mixing and silent-mode comparisons, if the preceding tests justify them. | Lower priority; exclusive/solo policy can interfere with other audio, not isolate a new session. |

For a valid test, save/restore prior intent, serialize cue/capture transitions, relinquish any temporary override on completion/error/cancel/unmount, and verify the readback. Do not overwrite another audio owner's state without coordination. Restore the normal `auto` or deliberately managed capture-compatible state before `getUserMedia`. API support must be feature-detected on this exact client.

Readback is limited: `type` is declared intent; `state`, where supported, is active/inactive/interrupted—not native category, speaker route, or output gain. WebKit's [`IDL`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/audiosession/DOMAudioSession.idl) gates state/events separately from the type API. Its setter also checks the document's **microphone Permissions Policy**, which is not the same as requesting user microphone permission; a disallowed embedded document can return without applying a type. “Assignment did not throw” is insufficient evidence of success.

### Native iOS session control

Apple exposes the app's shared [`AVAudioSession`](https://developer.apple.com/documentation/avfaudio/avaudiosession) via [`sharedInstance()`](https://developer.apple.com/documentation/avfaudio/avaudiosession/sharedinstance()). Native code normally **deactivates, configures, and reactivates that session**, rather than constructing disposable session instances. [`setActive(_:options:)`](https://developer.apple.com/documentation/avfaudio/avaudiosession/setactive(_:options:)) documents conflicts with higher-priority sessions and the effects of deactivating running audio objects. Such a reset must coordinate recording and playback.

There is a speech-specific exception worth distinguishing: [`AVSpeechSynthesizer.usesApplicationAudioSession = false`](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer/usesapplicationaudiosession) lets the system create a **separate, automatically managed speech session**. This is a native speech ownership choice, not a JavaScript factory for isolated tone sessions. Web Speech does not expose this property.

**Important WebView boundary:** current WebKit [`RemoteAudioSession.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/WebProcess/GPU/media/RemoteAudioSession.cpp) sends category/activation requests to the GPU process and explicitly calls it the source of truth for activity. [`RemoteAudioSessionProxy.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/GPUProcess/media/RemoteAudioSessionProxy.cpp) delegates session management; [`AudioSessionIOS.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/ios/AudioSessionIOS.mm) selects native category/mode/options. Thus changing the embedding app's session is **not guaranteed to reset WebKit's remotely managed session**. Upstream source is architectural evidence, not proof of the installed iPhone's exact code path.

Creating a new `WKWebView` is not a documented guarantee of a fresh, independent native audio session or new GPU process. It is a disruptive diagnostic at most, not a demonstrated fix.

### Native alternatives preserving the tone

1. **Native tone bridge:** play the ready cue through a host-controlled native player after speech, with explicit session/route handling. Smaller integration, but it still has to coexist with WebKit's speech/capture ownership; success is not guaranteed.
2. **Native speech and cue in one output pipeline:** use [`AVSpeechSynthesizer.write(_:toBufferCallback:)`](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer/write(_:tobuffercallback:)) to render speech buffers with an available on-device voice, convert formats as needed, and schedule speech plus the actual cue through one [`AVAudioPlayerNode`](https://developer.apple.com/documentation/avfaudio/avaudioplayernode). This avoids the system-speech-playback → browser-cue handoff. It is a feasible architectural candidate, not a tested fix; verify voice availability/offline behavior, interruptions, and capture transitions.
3. **Upstream host/WebKit fix:** use a minimal reproduction and native category/route observations to identify the responsible layer, then correct its session lifecycle rather than adding compensation.

The [Web Speech API](https://webaudio.github.io/web-speech-api/) exposes no speech PCM buffer, `AudioNode`, or output `MediaStream`, so routing browser `speechSynthesis` into our own common audio graph is not directly available. Native integration or a different speech-audio source is needed for that design. No publicly usable BB iOS audio bridge was established during this review; availability remains unverified. Confirm whether the client is a native shell, Safari, or an installed web app before planning native work.

## Remaining options and their limits

| Option | Assessment |
|---|---|
| **Await `AudioContext.suspend()` then `resume()`** | Plausible low-complexity diagnostic for releasing/restarting the audio client. Our current code only resumes non-running contexts; it has not tested deliberate suspension of a running-but-quiet one. Not a native reset guarantee. |
| **Complete teardown, then recreate** | Still distinguishable from the failed overlapping reset: stop sound sources and capture, release media players, await old context `close()`, then create/resume a new context. Could expose autoplay restrictions or still retain shared session state. Does not require opening a microphone. |
| **One reusable, initially gesture-started media element** | Tests player lifecycle and avoids fresh-decoder setup for each cue. Use identical cue bytes at all three points. Automatic playback already working means mere autoplay priming is not a complete explanation. |
| **One canonical buffer and the same playback path for all cues** | Removes waveform, sample rate, gain, and rendering-path confounds. A necessary comparison, not proof it will repair native routing. |
| **Web Audio → `MediaStreamDestination` → media element** | A distinct output path that needs no physical microphone. Lower priority; [WebKit 236219 comment 8](https://bugs.webkit.org/show_bug.cgi?id=236219#c8) reports it did not fix a microphone-related volume case on iOS 16.2/16.4. That is not a universal verdict either. |
| **Keep a silent media stream running** | Sometimes used to retain playback policy, but can itself retain the wrong session, consume resources, interfere with background music, and complicate capture. Not a default fix. |
| **Speech cancellation or another delay** | Cancellation plus one second already failed here. [WebKit 278598](https://bugs.webkit.org/show_bug.cgi?id=278598) reports TTS ducking during speech and roughly one second afterward on iOS 17. It supports a timed reproduction, not proof of indefinite ducking or a universal delay fix. The report's prose also uses the invalid string `record-and-play`; do not copy it as API code. |
| **Iframe, reload, new tab, or new WebView** | Useful to locate page vs browser/host state. None promises a clean, independent native session; iframe isolation is especially weak because WebKit stores the override on Page. Disrupts current work and can lose autoplay eligibility. |
| **Browser/client/iOS comparison** | Run the identical small reproduction in Safari and BB, on a documented OS version and route. An OS update or different host may change behavior; neither should be presented as a fix without a comparison. |
| **Output-route and physical-volume check** | Compare phone speaker, headphones, and Bluetooth separately; rule out receiver/speaker changes or per-category volume differences. Browser media-session metadata does not expose a native route reset, and JS cannot freely set system volume. Sink selection is feature-/platform-dependent, not a universal iPhone remedy. |
| **More amplitude or compression** | Current amplitude already clips. Changing envelope, applying a limiter/compressor, or lengthening the cue can improve audibility at bounded peaks, but changes the signal and must be matched across all three tones. Cannot establish or correct the underlying session mechanism; restored routing could make compensated output too loud. |
| **Different speech-audio source with one shared player** | Avoids a browser-synthesis → media-output handoff. Options include native on-device PCM rendering, an explicitly chosen local/offline synthesizer, or approved external TTS. Plain Web Speech exposes no PCM. No provider installation, reply-text transfer, or new speech engine is authorized by this research. |
| **Native session management / upstream fix** | Most control, but requires a native host and correct ownership across WebKit processes. Not required merely to play automatic audio, and not proven necessary for this issue. See native options above. |

[`AudioContext.close()`](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/close) releases that context's system audio resources; [`suspend()`](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/suspend) suspends processing. Neither API promises a reset of the native audio session shared/managed below the page.

## Controlled baseline needed before another fix

Use one exact, unboosted PCM asset and one chosen playback path for comparisons. Keep device output route and physical volume fixed. Test only while stationary.

1. Play the cue automatically after an initial tap, **without microphone or speech**.
2. Play it before and after a short fixed device-speech utterance, **without any microphone use**.
3. Play it before and after capture start/stop, **without speech**. Microphone activation must be an explicit user action; discard the test recording locally.
4. Reproduce the combined capture → stop → speech → cue sequence.
5. After quiet output, compare a **tone-only tap** with automatic playback of those same bytes. Do not open the microphone in the tone-only control.

This distinguishes gesture policy, capture transitions, speech transitions, and source differences before trying to reset anything. Repeat in BB and Safari on the same iPhone; record the exact iOS and BB versions and whether the route is speaker, wired headphones, Bluetooth, or AirPlay.

Collect only bounded metadata: relative timestamps, test variant, `AudioContext.state` and sample rate, Audio Session API availability/type/state, media `play` resolution/`playing`/`ended`/error codes/currentTime, capture track lifecycle, and speech start/end/error/cancel timing. Browser session state is not a native route/volume measurement. Do not log reply text, transcripts, recordings, device labels, or arbitrary error strings. If native instrumentation is available, category/mode/options/route/output-volume snapshots can resolve the remaining ambiguity.

## Recommended decision sequence

1. **Do not declare the browser incapable or raise gain again.** Current automatic playback works; the mechanism behind the level difference is unconfirmed and source clipping exists.
2. Establish the capture-free, speech-only control above with a fixed local test utterance and identical cue bytes. If speech alone does not cause the difference, investigate capture teardown before trying to repair synthesis.
3. Once reproduced, compare **temporary session intent without mic acquisition**: `auto` versus `play-and-record`, and separately playback-only `playback` with proper restoration. This most directly examines whether policy alone can reproduce the loud path without reopening the mic. API readback and error handling are required; do not combine it with gain, envelope, or delay changes.
4. If that is unavailable or ineffective, try explicit suspend/resume, then independently a fully awaited teardown/recreate. A reused media player is another separately controlled branch, not a simultaneous fallback that hides which path worked.
5. If browser options fail with a stable reproduction, compare Safari/BB and pursue a native tone bridge or native PCM-speech-plus-tone ownership. Do not install a TTS provider or send reply text elsewhere without consent.

No runtime fix or device-volume success is claimed by this report. The research verified API/source semantics and local waveform math; on-device recovery still requires testing. The research-only phase needed no build/reload.

## Follow-up: capture-free comparison

The user confirmed **native BB app, phone speaker**, on a recent but unspecified iOS version. A separate **Audio test** navigation panel now provides the tone-only control and speech comparison. It deliberately does not run Voice Drive's capture/thread/reply logic. The same unboosted WAV is replayed through the same media element before/after fixed “Test.” speech, with no gain, cancellation, session-type, or release-delay changes between the two tones. A second control replays the same tone automatically after one second of silence and no speech, to check automatic playback independently.

Completion is event-driven; missing callbacks fail with a watchdog rather than silently guessing speech completion. User stop/navigation cleans up only the test's audio and its own active speech. Fixed-vocabulary, rate-limited events identify the run and timing via `bb plugin logs voice-drive`. The existing 8× production cue is unchanged; the new factory parameter is used only to select unboosted `0.14` for this diagnostic.

On-device result is pending. First obtain the control and speech-only comparisons before implementing a session-reset hypothesis. If either fails to play, logs must distinguish permission/error/missing-event failure from quiet output. Relaunching the app is a preparation step, not a claimed guarantee of native session reset.
