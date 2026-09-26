import { createMediaReadyCue, type MediaReadyCue } from "./media-ready-cue";
import { READY_CUE_GAIN } from "./voice-cues";
import type { AudioComparisonEvent, AudioComparisonMode } from "./audio-comparison-events";

export interface AudioComparison { stop(): void }

// Isolated diagnostic. Never acquires capture, creates an AudioContext, changes
// audioSession.type, reads a thread, or calls a speech/transcription service.
export function startAudioComparison(
  mode: AudioComparisonMode,
  report: (event: AudioComparisonEvent) => void,
): AudioComparison {
  let cue: MediaReadyCue | null = null;
  let utterance: SpeechSynthesisUtterance | null = null;
  let phase: "before" | "waiting" | "speech" | "after" = "before";
  let done = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let controlDelay: ReturnType<typeof setTimeout> | undefined;
  const synth = window.speechSynthesis;
  const finish = (event: AudioComparisonEvent) => {
    if (done) return;
    done = true; // ignore any callbacks caused by cleanup itself
    clearTimeout(deadline);
    clearTimeout(controlDelay);
    if (utterance) {
      utterance.onstart = utterance.onend = utterance.onerror = null;
      if (phase === "speech") synth?.cancel();
    }
    if (cue) {
      cue.audio.onplaying = cue.audio.onended = cue.audio.onerror = null;
      cue.dispose();
    }
    report(event);
  };
  const comparison = { stop: () => finish("stopped") };
  report("start");
  if (synth?.speaking || synth?.pending) { finish("busy"); return comparison; }
  if (mode === "speech" && (!synth || typeof SpeechSynthesisUtterance === "undefined")) {
    finish("unavailable"); return comparison;
  }
  try { cue = createMediaReadyCue(READY_CUE_GAIN); }
  catch { finish("unavailable"); return comparison; }
  if (!cue) { finish("unavailable"); return comparison; }
  const player = cue.audio;
  const playTone = (next: "before" | "after") => {
    if (done) return;
    phase = next;
    report(next === "before" ? "before-request" : "after-request");
    try {
      player.currentTime = 0;
      // Call directly, not after awaiting logging/network: preserve the first tap.
      void player.play().catch((error: unknown) => {
        if (done) return;
        const blocked = !!error && typeof error === "object" && "name" in error && error.name === "NotAllowedError";
        finish(blocked ? "play-blocked" : "play-error");
      });
    } catch { finish("play-error"); }
  };
  player.onplaying = () => {
    if (!done && (phase === "before" || phase === "after")) {
      report(phase === "before" ? "before-playing" : "after-playing");
    }
  };
  player.onerror = () => finish("media-error");
  player.onended = () => {
    if (done) return;
    if (phase === "after") { report("after-ended"); finish("complete"); return; }
    if (phase !== "before") return;
    report("before-ended");
    if (mode === "control") {
      phase = "waiting";
      // A deliberate silent gap: the second play is automatic, not a second tap.
      controlDelay = setTimeout(() => playTone("after"), 1000);
      return;
    }
    phase = "speech";
    try {
      utterance = new SpeechSynthesisUtterance("Test.");
      utterance.lang = navigator.language || "en-US";
      utterance.onstart = () => { if (!done) report("speech-start"); };
      utterance.onend = () => {
        if (done || phase !== "speech") return;
        report("speech-ended");
        playTone("after"); // no cancel, session override, gain boost, or guessed release delay
      };
      utterance.onerror = () => finish("speech-error");
      report("speech-request");
      synth.speak(utterance);
    } catch { finish("speech-error"); }
  };
  // Only a failure watchdog. Completion is event-driven, never inferred from a delay.
  deadline = setTimeout(() => finish("timeout"), 20000);
  playTone("before");
  return comparison;
}
