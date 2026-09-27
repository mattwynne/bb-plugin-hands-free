// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { RecordingWaveform } from "./recording-waveform";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("scrolls live microphone levels, without stopping the recorder's track, and releases analysis on removal", () => {
  const strokes: number[] = [];
  let lastY = 0;
  const context = {
    setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(),
    moveTo: vi.fn((_x: number, y: number) => { lastY = y; }),
    lineTo: vi.fn((_x: number, y: number) => { strokes.push(y - lastY); }),
    stroke: vi.fn(), lineWidth: 0, lineCap: "", strokeStyle: "", globalAlpha: 1,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 50, height: 36 } as DOMRect);
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => { frames.delete(handle); });
  const disconnectSource = vi.fn();
  const disconnectAnalyser = vi.fn();
  const close = vi.fn(async () => {});
  const stopTrack = vi.fn();
  const stream = { getAudioTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  const createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: disconnectSource }));
  vi.stubGlobal("AudioContext", class {
    createMediaStreamSource = createMediaStreamSource;
    createAnalyser = () => ({ fftSize: 1024, connect: vi.fn(), disconnect: disconnectAnalyser,
      getByteTimeDomainData: (data: Uint8Array) => data.fill(192) });
    resume = vi.fn(async () => {});
    close = close;
  });
  const page = render(<RecordingWaveform stream={stream} />);
  expect(page.container.querySelector("canvas[aria-hidden=true]")).toBeTruthy();
  expect(createMediaStreamSource).toHaveBeenCalledWith(stream);
  expect(frames.size).toBe(1);
  act(() => { const callback = [...frames.values()][0]!; frames.clear(); callback(0); });
  expect(strokes.at(-1)).toBeGreaterThan(0); // signal grows the newest (rightmost) bar
  page.unmount();
  expect(frames.size).toBe(0);
  expect(disconnectSource).toHaveBeenCalledOnce();
  expect(disconnectAnalyser).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(stopTrack).not.toHaveBeenCalled(); // MediaRecorder owns the track
});

it("does not allocate analysis or animation when reduced motion is requested", () => {
  const context = { setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 50, height: 36 } as DOMRect);
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const animation = vi.fn();
  const audio = vi.fn();
  vi.stubGlobal("requestAnimationFrame", animation);
  vi.stubGlobal("AudioContext", audio);
  const page = render(<RecordingWaveform stream={{ getAudioTracks: () => [{}] } as unknown as MediaStream} />);
  expect(animation).not.toHaveBeenCalled();
  expect(audio).not.toHaveBeenCalled();
  page.unmount();
});
