// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createVoiceCues } from "./voice-cues";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fakeMedia() {
  const createObjectURL = vi.fn(() => "blob:shared-cue");
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

it("reuses one media player and WAV for tap, finish, and post-reply cues, including after Stop", async () => {
  const { players, createObjectURL, revokeObjectURL } = fakeMedia();
  const audioContext = vi.fn();
  vi.stubGlobal("AudioContext", audioContext);
  const cues = createVoiceCues();
  expect(await cues.ready()).toBe(true);
  const player = players[0]!;
  player.currentTime = 0.5;
  cues.finished();
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
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(audioContext).not.toHaveBeenCalled(); // Web Audio is reserved for thinking
  cues.dispose();
  cues.dispose();
  expect(player.removeAttribute).toHaveBeenCalledWith("src");
  expect(revokeObjectURL).toHaveBeenCalledOnce();
  expect(await cues.ready()).toBe(false);
  expect(player.play).toHaveBeenCalledTimes(4);
});

it("retains the same player after an autoplay rejection so a later tap can retry it", async () => {
  const { players, createObjectURL } = fakeMedia();
  const cues = createVoiceCues();
  await cues.ready();
  players[0]!.play.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
  expect(await cues.ready()).toBe(false);
  expect(await cues.ready()).toBe(true);
  expect(players).toHaveLength(1);
  expect(createObjectURL).toHaveBeenCalledOnce();
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
  expect(revokeObjectURL).toHaveBeenCalledOnce();
  expect(players).toHaveLength(1);
});

it("keeps the delayed thinking pulse quiet and stops its loop on idle/disposal", async () => {
  vi.useFakeTimers();
  const frequencies: number[] = [];
  const gains: number[] = [];
  class FakeAudioContext {
    state = "running";
    currentTime = 1;
    destination = {};
    createOscillator() {
      return {
        type: "sine", frequency: { setValueAtTime: (hz: number) => { frequencies.push(hz); } },
        connect() {}, start() {}, stop() {}, disconnect() {}, onended: null,
      };
    }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime(value: number) { gains.push(value); } }, connect() {}, disconnect() {} }; }
    close() { return Promise.resolve(); }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  const cues = createVoiceCues();
  cues.startThinking();
  expect(frequencies).toHaveLength(0); // don't overlap the finish cue
  await vi.advanceTimersByTimeAsync(1200);
  expect(frequencies).toEqual([392, 440]);
  expect(gains.filter((gain) => gain > 0.001)).toEqual([0.012, 0.012]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(frequencies).toEqual([392, 440, 392, 440]);
  cues.stopThinking();
  await vi.advanceTimersByTimeAsync(15000);
  expect(frequencies).toHaveLength(4);
  cues.startThinking();
  cues.dispose();
  await vi.advanceTimersByTimeAsync(15000);
  expect(frequencies).toHaveLength(4);
});

it("resumes an iOS interrupted audio context for the thinking pulse", async () => {
  vi.useFakeTimers();
  const resume = vi.fn(async () => {});
  const frequencies: number[] = [];
  class InterruptedContext {
    state = "interrupted";
    currentTime = 0;
    destination = {};
    async resume() { await resume(); this.state = "running"; }
    createOscillator() { return {
      type: "sine", frequency: { setValueAtTime: (hz: number) => frequencies.push(hz) },
      connect() {}, start() {}, stop() {}, disconnect() {}, onended: null,
    }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    close() { return Promise.resolve(); }
  }
  vi.stubGlobal("AudioContext", InterruptedContext);
  const cues = createVoiceCues();
  cues.startThinking();
  await vi.advanceTimersByTimeAsync(1200);
  expect(frequencies).toEqual([392, 440]);
  expect(resume).toHaveBeenCalledOnce();
  cues.dispose();
});
