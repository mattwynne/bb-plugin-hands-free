import { createMediaReadyCue, READY_CUE_GAIN, type MediaReadyCue } from "./media-ready-cue";
import type { AudioComparisonEvent, AudioComparisonMode } from "./audio-comparison-events";

export interface AudioComparison { stop(): void }

// Isolated diagnostic. Only the explicit capture variant opens the microphone.
// Never records, creates an AudioContext, changes audioSession.type, reads a
// thread, or calls a speech/transcription service.
export function startAudioComparison(
  mode: AudioComparisonMode,
  report: (event: AudioComparisonEvent) => void,
): AudioComparison {
  let cue: MediaReadyCue | null = null;
  let replacementPlayer: HTMLAudioElement | null = null;
  let utterance: SpeechSynthesisUtterance | null = null;
  let capture: MediaStream | null = null;
  const stopCapture = () => {
    const stream = capture;
    capture = null;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    report("mic-stopped");
  };
  let phase: "before" | "waiting" | "speech" | "after" = "before";
  let done = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let controlDelay: ReturnType<typeof setTimeout> | undefined;
  const synth = window.speechSynthesis;
  function onPageHide() { finish("stopped"); }
  function onVisibilityChange() { if (document.hidden) finish("stopped"); }
  const finish = (event: AudioComparisonEvent) => {
    if (done) return;
    done = true; // ignore any callbacks caused by cleanup itself
    clearTimeout(deadline);
    clearTimeout(controlDelay);
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    stopCapture();
    if (utterance) {
      utterance.onstart = utterance.onend = utterance.onerror = null;
      if (phase === "speech") synth?.cancel();
    }
    if (replacementPlayer) {
      replacementPlayer.onplaying = replacementPlayer.onended = replacementPlayer.onerror = null;
      replacementPlayer.pause();
      replacementPlayer.removeAttribute("src");
      replacementPlayer.load();
    }
    if (cue) {
      cue.audio.onplaying = cue.audio.onended = cue.audio.onerror = null;
      cue.dispose(); // revoke the shared Blob URL only after both players release it
    }
    report(event);
  };
  const comparison = { stop: () => finish("stopped") };
  report("start");
  if (synth?.speaking || synth?.pending) { finish("busy"); return comparison; }
  if ((mode === "speech" || mode === "speech-fresh") && (!synth || typeof SpeechSynthesisUtterance === "undefined")) {
    finish("unavailable"); return comparison;
  }
  try { cue = createMediaReadyCue(READY_CUE_GAIN); }
  catch { finish("unavailable"); return comparison; }
  if (!cue) { finish("unavailable"); return comparison; }
  let player = cue.audio;
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
    if (mode === "control" || mode === "capture") {
      phase = "waiting";
      if (mode === "capture") stopCapture();
      // Match the control's silent gap; not a claimed native-session reset delay.
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
        if (mode === "speech-fresh") {
          try {
            // Keep identical bytes and retain A until completion so this changes
            // only player reuse, not source generation or early resource release.
            replacementPlayer = new Audio(player.src);
            replacementPlayer.onplaying = player.onplaying;
            replacementPlayer.onended = player.onended;
            replacementPlayer.onerror = player.onerror;
            player.onplaying = player.onended = player.onerror = null;
            player = replacementPlayer;
            report("player-recreated");
          } catch { finish("unavailable"); return; }
        }
        playTone("after"); // no cancel, session override, gain boost, or guessed release delay
      };
      utterance.onerror = () => finish("speech-error");
      report("speech-request");
      synth.speak(utterance);
    } catch { finish("speech-error"); }
  };
  // Only a failure watchdog. Completion is event-driven, never inferred from a delay.
  deadline = setTimeout(() => finish("timeout"), 20000);
  if (mode === "capture") {
    if (!navigator.mediaDevices?.getUserMedia) { finish("unavailable"); return comparison; }
    const captureFailed = (error: unknown) => {
      if (done) return;
      const name = error && typeof error === "object" && "name" in error ? error.name : undefined;
      finish(name === "NotAllowedError" ? "mic-denied" : name === "InvalidStateError" ? "mic-invalid-state" : "mic-error");
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    report("mic-request");
    try {
      // Request only in this explicit button's tap handler. No MediaRecorder,
      // source connection, stream upload, transcription, or retained audio data.
      void navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        if (done) {
          // Permission may resolve after stop/navigation/timeout. Release it
          // immediately; never let a late grant resurrect the test or capture.
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        capture = stream;
        if (!stream.getAudioTracks().some((track) => track.readyState === "live")) {
          finish("mic-error"); return;
        }
        stream.getTracks().forEach((track) => { track.onended = () => finish("mic-error"); });
        report("mic-open");
        playTone("before");
      }, captureFailed);
    } catch (error) { captureFailed(error); }
  } else {
    playTone("before");
  }
  return comparison;
}
