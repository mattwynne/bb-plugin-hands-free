# Changelog

## [Unreleased]

## [0.2.2] - 2026-10-11

- Keep the selected thread and Stop audio control visible when the thread archives, so its final reply can finish playing. Show that the thread has archived and prevent new dictation into it.

## [0.2.1] - 2026-10-10

- Keep the car stereo's audio playback active while the agent works, and hand off the thinking tones to spoken replies without an unnecessary pause.
- Make the periodic thinking tones easier to hear in a car while preserving the recording and reply confirmation sounds.
- Add privacy-bounded audio diagnostics to help troubleshoot interrupted or silent playback without logging conversations or recordings.

## [0.2.0] - 2026-10-09

- Add Hands-Free voice settings to choose an Edge neural voice and speaking speed, with a shortcut from the Hands-Free page. Existing device/OpenAI voice choices migrate to the default Sonia voice while retaining speed.
- Speak replies with built-in Edge neural voices; the separate Read Aloud plugin is no longer needed for speech output. Speech text is sent to Microsoft.
- Read Markdown replies as plain speech without speaking formatting marks or link destinations.
- Add an action to open the selected thread from the Hands-Free activity view.
- Show an up arrow instead of a stop square while recording, to make the finish-and-send action clearer.

## [0.1.0] - 2026-09-27

- Initial Hands-Free release.
