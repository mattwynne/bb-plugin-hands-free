import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { startAudioComparison, type AudioComparison } from "./audio-comparison";
import {
  AUDIO_SESSION_TYPES, COMPARISON_TERMINAL_EVENTS,
  type AudioComparisonEvent, type AudioComparisonMode, type AudioSessionType,
} from "./audio-comparison-events";

function readSessionType(): AudioSessionType {
  try {
    const session = (navigator as Navigator & { audioSession?: { type?: string } }).audioSession;
    if (!session) return "unavailable";
    const type = session.type;
    return AUDIO_SESSION_TYPES.includes(type as AudioSessionType) ? type as AudioSessionType : "unknown";
  } catch { return "unknown"; }
}
const messages: Partial<Record<AudioComparisonEvent, string>> = {
  "before-playing": "Tone A (before)",
  "speech-start": "Speaking the fixed word “Test.”",
  "after-playing": "Tone B (after)",
  complete: "Done. Compare A and B: same, B quieter, or B louder?",
  stopped: "Stopped.",
  busy: "Other speech is active. Wait for it to finish, then retry.",
  unavailable: "This client cannot run the selected audio test.",
  "play-blocked": "Playback was blocked—not a volume result.",
  "play-error": "Playback failed—not a volume result.",
  "media-error": "The media element reported an error.",
  "speech-error": "Device speech failed—not a volume result.",
  timeout: "A completion event was missing. Test stopped; report this message.",
};

export function AudioTestPage() {
  const rpc = useRpc<typeof rpcContract>();
  const comparison = useRef<AudioComparison | null>(null);
  const mounted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready for an isolated comparison.");
  const [session, setSession] = useState("");
  const [trace, setTrace] = useState<string[]>([]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; comparison.current?.stop(); };
  }, []);
  const start = (variant: AudioComparisonMode) => {
    comparison.current?.stop();
    const id = globalThis.crypto?.randomUUID?.() ?? `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const started = performance.now();
    let count = 0;
    setSession(id);
    setTrace([]);
    setStatus("Starting…");
    setBusy(true);
    comparison.current = startAudioComparison(variant, (event) => {
      const elapsedMs = Math.min(60000, Math.max(0, Math.round(performance.now() - started)));
      const sessionType = readSessionType(); // observation only; never change session policy
      if (count++ < 32) {
        if (mounted.current) setTrace((lines) => [...lines, `${elapsedMs} ms · ${event} · session ${sessionType}`]);
        void rpc.call("audioTestDiagnostic", { session: id, variant, event, elapsedMs, sessionType }).catch(() => {});
      }
      if (!mounted.current) return;
      if (messages[event]) setStatus(messages[event]!);
      if (COMPARISON_TERMINAL_EVENTS.has(event)) setBusy(false);
    });
  };
  return <main className="h-full overflow-y-auto px-4 py-5" aria-label="Audio test">
    <div className="mx-auto max-w-xl space-y-5 pb-12">
      <h1 className="text-2xl font-bold">Audio test</h1>
      <p>No microphone or thread access. Both tones use the same unboosted WAV and the same player. Audio-session settings are only observed.</p>
      <p>Keep phone volume fixed. Run the control first, then the speech comparison. Do not dictate between them. If tone A is already barely audible, report that too.</p>
      <button type="button" disabled={busy} onClick={() => start("control")} className="min-h-16 w-full rounded-xl border px-3 text-lg font-semibold disabled:opacity-40">1. Tone-only control</button>
      <p className="text-sm text-muted-foreground">Tone A → one-second silence → tone B. Checks automatic playback without speech.</p>
      <button type="button" disabled={busy} onClick={() => start("speech")} className="min-h-16 w-full rounded-xl border px-3 text-lg font-semibold disabled:opacity-40">2. Speech comparison</button>
      <p className="text-sm text-muted-foreground">Tone A → device says “Test” → tone B.</p>
      {busy && <button type="button" onClick={() => comparison.current?.stop()} className="min-h-16 w-full rounded-xl border px-3 text-lg font-semibold">Stop test</button>}
      <p aria-live="off" className="rounded-xl border p-3">{status}</p>
      {session && <details>
        <summary>Diagnostic events</summary>
        <p className="break-all text-xs">Run: {session}</p>
        <ol className="text-xs">{trace.map((line, index) => <li key={index}>{line}</li>)}</ol>
      </details>}
      <p className="text-xs text-muted-foreground">Logs contain only a random run ID, test variant, event names, timing, and declared session type—never conversation text or recordings. Normal Voice Drive audio is unchanged.</p>
    </div>
  </main>;
}
