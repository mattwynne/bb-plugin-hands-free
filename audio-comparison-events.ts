// Fixed diagnostic vocabulary only: never accept speech, device labels, or errors as text.
export const AUDIO_COMPARISON_EVENTS = [
  "start", "before-request", "before-playing", "before-ended",
  "speech-request", "speech-start", "speech-ended", "player-recreated",
  "mic-request", "mic-open", "mic-stopped", "mic-denied", "mic-invalid-state", "mic-error",
  "after-request", "after-playing", "after-ended",
  "complete", "stopped", "busy", "unavailable", "play-blocked",
  "play-error", "media-error", "speech-error", "timeout",
] as const;
export type AudioComparisonEvent = typeof AUDIO_COMPARISON_EVENTS[number];
export type AudioComparisonMode = "control" | "speech" | "speech-fresh" | "capture";
export const COMPARISON_TERMINAL_EVENTS: ReadonlySet<AudioComparisonEvent> = new Set([
  "complete", "stopped", "busy", "unavailable", "play-blocked",
  "play-error", "media-error", "speech-error", "timeout",
  "mic-denied", "mic-invalid-state", "mic-error",
]);
export const AUDIO_SESSION_TYPES = [
  "auto", "playback", "play-and-record", "ambient", "transient",
  "transient-solo", "unavailable", "unknown",
] as const;
export type AudioSessionType = typeof AUDIO_SESSION_TYPES[number];
