import { useEffect, useRef } from "react";

const PITCH = 5;
const BAR_WIDTH = 3;
const IDLE = 0.06;

/** A local visualizer: it never records, plays, or sends microphone audio. */
export function RecordingWaveform({ stream }: { stream: MediaStream | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const bars: number[] = [];
    let width = 0;
    let height = 0;
    let count = 1;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = getComputedStyle(canvas).color;
      ctx.lineWidth = BAR_WIDTH;
      ctx.lineCap = "round";
      count = Math.max(1, Math.floor(width / PITCH));
      if (bars.length > count) bars.splice(0, bars.length - count);
    };
    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < bars.length; i++) {
        const x = width - BAR_WIDTH / 2 - i * PITCH;
        const half = bars[bars.length - 1 - i] * Math.max(0, (height - BAR_WIDTH) / 2);
        ctx.globalAlpha = x < width * 0.15 ? Math.max(0.15, x / (width * 0.15)) : 1;
        ctx.beginPath();
        ctx.moveTo(x, height / 2 - half);
        ctx.lineTo(x, height / 2 + half);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    measure();
    bars.push(...Array.from({ length: count }, () => IDLE));
    draw();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { measure(); draw(); });
    observer?.observe(canvas);

    // SpeechRecognition does not expose samples. Show a quiet, decorative
    // scrolling indicator rather than claiming to measure its input level.
    const track = stream?.getAudioTracks?.()[0];
    let audio: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    if (!reducedMotion && track && typeof AudioContext !== "undefined") {
      try {
        audio = new AudioContext();
        source = audio.createMediaStreamSource(stream!);
        analyser = audio.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        void audio.resume().catch(() => {});
      } catch {
        source?.disconnect();
        analyser?.disconnect();
        void audio?.close().catch(() => {});
        audio = null;
        analyser = null;
      }
    }
    const data = analyser ? new Uint8Array(analyser.fftSize) : null;
    let frame = 0;
    let raf = 0;
    const tick = () => {
      if (analyser && data) {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const sample of data) sum += ((sample - 128) / 128) ** 2;
        bars.push(Math.min(1, (Math.max(0, Math.sqrt(sum / data.length) - 0.006) * 8) ** 0.6));
      } else {
        bars.push(IDLE + 0.025 * Math.sin(frame / 5) ** 2);
      }
      if (bars.length > count) bars.shift();
      draw();
      frame++;
      raf = requestAnimationFrame(tick);
    };
    if (!reducedMotion) raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      source?.disconnect();
      analyser?.disconnect();
      if (audio) void audio.close().catch(() => {});
    };
  }, [stream]);

  return <canvas ref={canvasRef} aria-hidden="true" className="block h-7 w-16 text-current" />;
}
