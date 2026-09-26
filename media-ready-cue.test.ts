// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createMediaReadyCue, READY_CUE_GAIN, readyCueEnvelope } from "./media-ready-cue";
import { Blob as NodeBlob } from "node:buffer";

afterEach(() => { vi.unstubAllGlobals(); });

it("uses identical unboosted WAV bytes for production and diagnostics without clipping", async () => {
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
