// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createVoiceCues } from "./voice-cues";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("plays two distinct cues and stops the gentle thinking loop on idle/disposal", async () => {
  vi.useFakeTimers();
  const frequencies: number[] = [];
  const gains: number[] = [];
  let created = 0;
  let closed = 0;
  class FakeAudioContext {
    constructor() { created += 1; }
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
    close() { closed += 1; return Promise.resolve(); }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  const report = vi.fn();
  const cues = createVoiceCues(report);
  const ready = cues.ready();
  await vi.waitFor(() => expect(frequencies).toEqual([523, 659]));
  expect(await ready).toEqual({ scheduled: true, audioState: "running" });
  expect(gains.filter((gain) => gain > 0.001)).toEqual([0.16, 0.16]);
  cues.finished();
  await vi.waitFor(() => expect(frequencies).toEqual([523, 659, 659, 440]));
  cues.startThinking();
  expect(frequencies).toHaveLength(4); // the confirmation tone is not overlapped
  await vi.advanceTimersByTimeAsync(1200);
  expect(frequencies.slice(-2)).toEqual([392, 440]);
  expect(gains.filter((gain) => gain > 0.001).at(-1)).toBe(0.012);
  await vi.advanceTimersByTimeAsync(5000);
  expect(frequencies.slice(-2)).toEqual([392, 440]);
  const count = frequencies.length;
  cues.stopThinking();
  await vi.advanceTimersByTimeAsync(15000);
  expect(frequencies).toHaveLength(count);
  cues.reset();
  expect(closed).toBe(1);
  expect(report).toHaveBeenCalledWith("audio-reset", "running");
  expect(await cues.ready()).toEqual({ scheduled: true, audioState: "running" });
  expect(created).toBe(2);
  const resetCount = frequencies.length;
  cues.dispose();
  expect(closed).toBe(2);
  await cues.ready();
  expect(frequencies).toHaveLength(resetCount);
});

it("resumes an iOS interrupted audio context before playing the ready cue", async () => {
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
  const ready = cues.ready();
  await vi.waitFor(() => expect(frequencies).toEqual([523, 659]));
  expect(await ready).toEqual({ scheduled: true, audioState: "running" });
  expect(resume).toHaveBeenCalledOnce();
  cues.dispose();
});
