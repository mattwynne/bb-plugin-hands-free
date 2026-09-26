// Bounded production diagnostics: never transmit an utterance, message, or raw error.
export const SPEECH_PLAYBACK_EVENTS = [
  "request", "start", "end", "silence-complete", "error", "ignored-end", "ignored-error",
] as const;
export type SpeechPlaybackEvent = typeof SPEECH_PLAYBACK_EVENTS[number];

export const SPEECH_ERROR_CODES = [
  "none", "unknown", "canceled", "interrupted", "audio-busy", "audio-hardware",
  "network", "synthesis-unavailable", "synthesis-failed", "language-unavailable",
  "voice-unavailable", "text-too-long", "invalid-argument", "not-allowed",
] as const;
export type SpeechErrorCode = typeof SPEECH_ERROR_CODES[number];

export function speechErrorCode(value: unknown): SpeechErrorCode {
  return typeof value === "string" && SPEECH_ERROR_CODES.includes(value as SpeechErrorCode)
    ? value as SpeechErrorCode : "unknown";
}
