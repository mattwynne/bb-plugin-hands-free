// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createMediaReadyCue, createThinkingLoopUrl, READY_CUE_GAIN, readyCueEnvelope } from "./media-ready-cue";
import { Blob as NodeBlob } from "node:buffer";

afterEach(() => { vi.unstubAllGlobals(); });

it("keeps the default normal cue byte-identical to the explicit unboosted gain without clipping", async () => {
  const blobs: Blob[] = [];
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("URL", {
    createObjectURL: (blob: Blob) => { blobs.push(blob); return "blob:test"; },
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal("Audio", class { pause() {} removeAttribute() {} load() {} });
  createMediaReadyCue(READY_CUE_GAIN)?.dispose();
  createMediaReadyCue()?.dispose();
  const peaks = await Promise.all(blobs.map(async (blob) => {
    const view = new DataView(await blob.arrayBuffer());
    let peak = 0;
    for (let i = 44; i < view.byteLength; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
    return peak / 32767;
  }));
  expect(peaks[0]).toBeGreaterThan(0.13);
  expect(peaks[0]).toBeLessThanOrEqual(READY_CUE_GAIN);
  expect(peaks[1]).toBe(peaks[0]);
  expect(await blobs[1]!.arrayBuffer()).toEqual(await blobs[0]!.arrayBuffer());
});

it("attenuates only the tap PCM and restores the cached normal source on the same player", async () => {
  const blobs: Blob[] = [];
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("URL", {
    createObjectURL: (blob: Blob) => { blobs.push(blob); return `blob:cue-${blobs.length}`; },
    revokeObjectURL,
  });
  const srcWrites: string[] = [];
  const audio = vi.fn(function (this: HTMLAudioElement, src: string) {
    let source = src;
    Object.defineProperty(this, "src", {
      get: () => source, set: (value: string) => { source = value; srcWrites.push(value); },
    });
    this.pause = vi.fn(); this.removeAttribute = vi.fn(); this.load = vi.fn();
  });
  vi.stubGlobal("Audio", audio);
  const cue = createMediaReadyCue()!;
  cue.selectLevel("tap");
  expect(cue.audio.src).toBe("blob:cue-2");
  cue.selectLevel("normal");
  expect(cue.audio.src).toBe("blob:cue-1");
  cue.selectLevel("normal"); // repeated selection must not reload a cached source
  expect(srcWrites).toEqual(["blob:cue-2", "blob:cue-1"]);
  cue.selectLevel("tap");
  expect(audio).toHaveBeenCalledOnce();
  expect(blobs).toHaveLength(2);
  const normal = new DataView(await blobs[0]!.arrayBuffer());
  const tap = new DataView(await blobs[1]!.arrayBuffer());
  expect(tap.byteLength).toBe(normal.byteLength);
  expect(new Uint8Array(tap.buffer, 0, 44)).toEqual(new Uint8Array(normal.buffer, 0, 44));
  for (let i = 44; i < normal.byteLength; i += 2) {
    expect(Math.abs(tap.getInt16(i, true) - normal.getInt16(i, true) * 0.85)).toBeLessThanOrEqual(1);
  }
  cue.dispose();
  cue.dispose();
  cue.selectLevel("normal");
  expect(revokeObjectURL.mock.calls).toEqual([["blob:cue-1"], ["blob:cue-2"]]);
  expect(srcWrites).toHaveLength(3);
});

it("uses a cached falling 659→523 Hz reply cue without creating another player or boosting gain", async () => {
  const blobs: Blob[] = [];
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("URL", {
    createObjectURL: (blob: Blob) => { blobs.push(blob); return `blob:cue-${blobs.length}`; },
    revokeObjectURL,
  });
  const audio = vi.fn(function (this: HTMLAudioElement, src: string) {
    this.src = src; this.pause = vi.fn(); this.removeAttribute = vi.fn(); this.load = vi.fn();
  });
  vi.stubGlobal("Audio", audio);
  const cue = createMediaReadyCue()!;
  cue.selectLevel("reply");
  cue.selectLevel("normal");
  cue.selectLevel("reply");
  expect(audio).toHaveBeenCalledOnce();
  expect(blobs).toHaveLength(2);
  expect(cue.audio.src).toBe("blob:cue-2");
  const view = new DataView(await blobs[1]!.arrayBuffer());
  const frequency = (from: number, to: number) => {
    let crossings = 0;
    for (let frame = Math.round(from * 16000) + 1; frame < Math.round(to * 16000); frame++) {
      if (view.getInt16(44 + (frame - 1) * 2, true) <= 0 && view.getInt16(44 + frame * 2, true) > 0) crossings++;
    }
    return crossings / (to - from);
  };
  expect(Math.abs(frequency(0.01, 0.20) - 659)).toBeLessThan(6);
  expect(Math.abs(frequency(0.29, 0.49) - 523)).toBeLessThan(6);
  let peak = 0;
  for (let i = 44; i < view.byteLength; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
  expect(peak / 32767).toBeLessThanOrEqual(READY_CUE_GAIN);
  cue.dispose();
  cue.dispose();
  expect(revokeObjectURL.mock.calls).toEqual([["blob:cue-1"], ["blob:cue-2"]]);
});

it("keeps a five-second quiet media track active between thinking notes", async () => {
  let blob: Blob | null = null;
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("URL", { createObjectURL: (value: Blob) => { blob = value; return "blob:thinking"; }, revokeObjectURL: vi.fn() });
  expect(createThinkingLoopUrl()).toBe("blob:thinking");
  const view = new DataView(await blob!.arrayBuffer());
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.byteLength).toBe(44 + 5 * 16000 * 2);
  let peak = 0;
  let firstNotePeak = 0;
  let tailPeak = 0;
  for (let frame = 0; frame < 5 * 16000; frame++) {
    const amplitude = Math.abs(view.getInt16(44 + frame * 2, true));
    peak = Math.max(peak, amplitude);
    if (frame >= 16000 * 1.2 && frame < 16000 * 1.4) firstNotePeak = Math.max(firstNotePeak, amplitude);
    if (frame >= 16000 * 2) tailPeak = Math.max(tailPeak, amplitude);
  }
  expect(tailPeak).toBe(0);
  expect(firstNotePeak).toBeGreaterThan(2800);
  expect(peak / 32767).toBeGreaterThan(0.13);
  expect(peak / 32767).toBeLessThanOrEqual(READY_CUE_GAIN);
});

it("creates and disposes a local WAV media element without Web Audio", () => {
  const createObjectURL = vi.fn(() => "blob:ready-cue");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const players: FakeAudio[] = [];
  class FakeAudio {
    pause = vi.fn();
    removeAttribute = vi.fn();
    load = vi.fn();
    constructor(public src: string) { players.push(this); }
  }
  vi.stubGlobal("Audio", FakeAudio);

  const cue = createMediaReadyCue();
  expect(readyCueEnvelope(0)).toBeCloseTo(0.0001);
  expect(readyCueEnvelope(0.025)).toBeCloseTo(READY_CUE_GAIN);
  expect(readyCueEnvelope(0.279)).toBeGreaterThan(0.0001);
  expect(readyCueEnvelope(0.28)).toBe(0);
  expect(cue).not.toBeNull();
  expect(players[0]?.src).toBe("blob:ready-cue");
  expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "audio/wav" }));
  cue?.dispose();
  expect(players[0]?.pause).toHaveBeenCalledOnce();
  expect(players[0]?.removeAttribute).toHaveBeenCalledWith("src");
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:ready-cue");
});
