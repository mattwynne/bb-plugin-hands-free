import { createMediaReadyCue, type MediaReadyCue } from "./media-ready-cue";

// Reuse one local media player for all confirmation cues. Web Audio is only
// for the quiet thinking pulse. No network or audio-session policy changes.

export interface VoiceCues {
  unlock(): void;
  ready(): Promise<boolean>;
  finished(): void;
  stopCue(): void;
  startThinking(): void;
  stopThinking(): void;
  dispose(): void;
}

export function createVoiceCues(): VoiceCues {
  let readyCue: MediaReadyCue | null = null;
  let context: AudioContext | null = null;
  let loop: ReturnType<typeof setInterval> | null = null;
  let firstPulse: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let thinking = false;

  const playReady = async (): Promise<boolean> => {
    if (disposed) return false;
    try {
      readyCue ??= createMediaReadyCue();
      if (!readyCue) return false;
      readyCue.audio.currentTime = 0;
      // Reuse the player actually heard before speech, not just an earlier
      // allocation. A blocked attempt retains it for the next user tap.
      await readyCue.audio.play();
      return !disposed;
    } catch { return false; }
  };

  const ensure = (): AudioContext | null => {
    if (disposed) return null;
    const BrowserAudioContext = (typeof AudioContext !== "undefined" ? AudioContext : undefined)
      ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!BrowserAudioContext) return null;
    try {
      if (context?.state === "closed") context = null;
      return context ?? (context = new BrowserAudioContext());
    } catch { return null; }
  };
  const activate = async (): Promise<AudioContext | null> => {
    const ctx = ensure();
    if (!ctx) return null;
    // WebKit also reports a non-standard "interrupted" state when system
    // speech relinquishes its audio session. It needs resume() as well.
    if (ctx.state !== "running") {
      try { await ctx.resume(); } catch { return null; }
    }
    return ctx.state === "running" ? ctx : null;
  };
  const tone = (ctx: AudioContext, hz: number, at: number, length: number, volume: number) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(hz, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(at);
    oscillator.stop(at + length + 0.01);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  };
  const cue = (notes: readonly [number, number][], volume: number, onlyThinking = false, length = 0.16) => {
    void activate().then((ctx) => {
      if (!ctx || disposed || (onlyThinking && !thinking)) return;
      const now = ctx.currentTime + 0.01;
      for (const [hz, delay] of notes) tone(ctx, hz, now + delay, length, volume);
    });
  };
  return {
    unlock() { void activate(); },
    ready: playReady,
    finished() { void playReady(); },
    stopCue() { readyCue?.audio.pause(); }, // retain source/player for the next cue
    startThinking() {
      if (disposed || thinking) return;
      thinking = true;
      // Two very quiet notes every five seconds, not a continuous drone.
      const pulse = () => cue([[392, 0], [440, 0.22]], 0.012, true);
      // Leave room for the finish-dictating confirmation cue to complete.
      firstPulse = setTimeout(() => {
        firstPulse = null;
        if (!thinking || disposed) return;
        pulse();
        loop = setInterval(pulse, 5000);
      }, 1200);
    },
    stopThinking() {
      thinking = false;
      if (firstPulse !== null) clearTimeout(firstPulse);
      firstPulse = null;
      if (loop !== null) clearInterval(loop);
      loop = null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      readyCue?.dispose();
      readyCue = null;
      thinking = false;
      if (firstPulse !== null) clearTimeout(firstPulse);
      firstPulse = null;
      if (loop !== null) clearInterval(loop);
      loop = null;
      if (context) void context.close().catch(() => {});
      context = null;
    },
  };
}
