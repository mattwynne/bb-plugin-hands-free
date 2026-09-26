// Small local Web Audio cues; no downloaded files, persistent audio stream,
// or network requests. Playback is best effort under iOS user-gesture rules.
export interface CueDiagnostic {
  scheduled: boolean;
  audioState: string;
}
export interface VoiceCues {
  unlock(): void;
  ready(): Promise<CueDiagnostic>;
  finished(): void;
  startThinking(): void;
  stopThinking(): void;
  dispose(): void;
}

export function createVoiceCues(): VoiceCues {
  let context: AudioContext | null = null;
  let loop: ReturnType<typeof setInterval> | null = null;
  let firstPulse: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let thinking = false;

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
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        // A WebKit interruption can leave resume() pending indefinitely.
        await Promise.race([ctx.resume(), new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 900);
        })]);
      } catch { return null; }
      finally { if (timeout !== null) clearTimeout(timeout); }
    }
    return ctx.state === "running" ? ctx : null;
  };
  const tone = (ctx: AudioContext, hz: number, at: number, length: number, volume: number, waveform: OscillatorType = "sine") => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = waveform;
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
  const cue = async (notes: readonly [number, number][], volume: number, onlyThinking = false, length = 0.16, waveform: OscillatorType = "sine"): Promise<CueDiagnostic> => {
    const ctx = await activate();
    if (!ctx || disposed || (onlyThinking && !thinking)) {
      return { scheduled: false, audioState: context?.state ?? "unavailable" };
    }
    try {
      const now = ctx.currentTime + 0.01;
      for (const [hz, delay] of notes) tone(ctx, hz, now + delay, length, volume, waveform);
      // Scheduled does not mean audible: iOS may still mute the output route.
      return { scheduled: true, audioState: ctx.state };
    } catch { return { scheduled: false, audioState: ctx.state }; }
  };
  return {
    unlock() { void activate(); },
    // Deliberately conspicuous diagnostic cue: ~1.3 seconds with a richer
    // triangle waveform. Keep the thinking pulse soft and unchanged.
    ready() { return cue([[523, 0], [659, 0.62]], 0.16, false, 0.7, "triangle"); },
    finished() { void cue([[659, 0], [440, 0.16]], 0.045); },
    startThinking() {
      if (disposed || thinking) return;
      thinking = true;
      // Two very quiet notes every five seconds, not a continuous drone.
      const pulse = () => { void cue([[392, 0], [440, 0.22]], 0.012, true); };
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
      disposed = true;
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
