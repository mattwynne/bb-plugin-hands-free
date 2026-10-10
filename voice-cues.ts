import { createMediaReadyCue, type MediaReadyCue } from "./media-ready-cue";

export interface VoiceCues {
  ready(): Promise<boolean>;
  started(): void;
  finished(): void;
  stopCue(): void;
  dispose(): void;
}

export function createVoiceCues(report?: (event: "cue-play" | "cue-stop", detail: "none" | "other") => void): VoiceCues {
  let readyCue: MediaReadyCue | null = null;
  let disposed = false;

  const playReady = async (level: "normal" | "tap" | "reply" = "normal"): Promise<boolean> => {
    if (disposed) return false;
    try {
      readyCue ??= createMediaReadyCue();
      if (!readyCue) return false;
      readyCue.selectLevel(level);
      readyCue.audio.currentTime = 0;
      await readyCue.audio.play();
      report?.("cue-play", "none");
      return !disposed;
    } catch { report?.("cue-play", "other"); return false; }
  };

  return {
    ready: () => playReady("reply"),
    started() { void playReady("tap"); },
    finished() { void playReady(); },
    stopCue() {
      if (readyCue && !readyCue.audio.paused && !readyCue.audio.ended) {
        readyCue.audio.pause();
        report?.("cue-stop", "none");
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      readyCue?.dispose();
      readyCue = null;
    },
  };
}
