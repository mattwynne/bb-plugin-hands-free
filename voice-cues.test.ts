// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createVoiceCues } from "./voice-cues";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fakeMedia() {
  let urls = 0;
  const createObjectURL = vi.fn(() => `blob:cue-${++urls}`);
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const players: FakeAudio[] = [];
  class FakeAudio {
    currentTime = 0;
    play = vi.fn(async () => {});
    pause = vi.fn();
    removeAttribute = vi.fn();
    load = vi.fn();
    constructor(public src: string) { players.push(this); }
  }
  vi.stubGlobal("Audio", FakeAudio);
  return { players, createObjectURL, revokeObjectURL };
}

it("reuses one player for the tap, finish, and distinct post-reply cues, including after Stop", async () => {
  const { players, createObjectURL, revokeObjectURL } = fakeMedia();
  const cues = createVoiceCues();
  cues.started();
  await Promise.resolve();
  const player = players[0]!;
  expect(player.src).toBe("blob:cue-2"); // quieter tap
  player.currentTime = 0.5;
  cues.finished();
  expect(player.src).toBe("blob:cue-1"); // normal level restored before speech
  expect(player.currentTime).toBe(0);
  expect(await cues.ready()).toBe(true);
  expect(player.play).toHaveBeenCalledTimes(3);
  cues.stopCue();
  expect(player.pause).toHaveBeenCalledOnce();
  expect(player.removeAttribute).not.toHaveBeenCalled();
  expect(player.load).not.toHaveBeenCalled();
  expect(revokeObjectURL).not.toHaveBeenCalled();
  expect(await cues.ready()).toBe(true);
  expect(players).toHaveLength(1);
  expect(createObjectURL).toHaveBeenCalledTimes(3);
  expect(player.src).toBe("blob:cue-3"); // falling reply cue
  cues.dispose();
  cues.dispose();
  expect(player.removeAttribute).toHaveBeenCalledWith("src");
  expect(revokeObjectURL).toHaveBeenCalledTimes(3);
  expect(await cues.ready()).toBe(false);
  expect(player.play).toHaveBeenCalledTimes(4);
});

it("does not pause an already-ended cue when preparing the next reply", async () => {
  const { players } = fakeMedia();
  const cues = createVoiceCues();
  await cues.ready();
  const player = players[0]!;
  Object.defineProperty(player, "ended", { value: true });
  cues.stopCue();
  expect(player.pause).not.toHaveBeenCalled();
  cues.dispose();
});

it("retains the same player after an autoplay rejection so a later tap can retry it", async () => {
  const { players, createObjectURL } = fakeMedia();
  const cues = createVoiceCues();
  await cues.ready();
  players[0]!.play.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
  expect(await cues.ready()).toBe(false);
  expect(await cues.ready()).toBe(true);
  expect(players).toHaveLength(1);
  expect(createObjectURL).toHaveBeenCalledTimes(2);
  cues.dispose();
});

it("does not revive a disposed cue when a pending play resolves", async () => {
  const { players, revokeObjectURL } = fakeMedia();
  const cues = createVoiceCues();
  await cues.ready();
  let resolve!: () => void;
  players[0]!.play.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
  const pending = cues.ready();
  cues.dispose();
  resolve();
  expect(await pending).toBe(false);
  expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  expect(players).toHaveLength(1);
});
