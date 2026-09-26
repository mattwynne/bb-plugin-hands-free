// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createMediaReadyCue } from "./media-ready-cue";

afterEach(() => { vi.unstubAllGlobals(); });

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
  expect(cue).not.toBeNull();
  expect(players[0]?.src).toBe("blob:ready-cue");
  expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "audio/wav" }));
  cue?.dispose();
  expect(players[0]?.pause).toHaveBeenCalledOnce();
  expect(players[0]?.removeAttribute).toHaveBeenCalledWith("src");
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:ready-cue");
});
