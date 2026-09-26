// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createVoiceCues } from "./voice-cues";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("plays two distinct cues and stops the gentle thinking loop on idle/disposal", async () => {
  vi.useFakeTimers();
  const frequencies: number[] = [];
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
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    close() { return Promise.resolve(); }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  const cues = createVoiceCues();
  cues.ready();
  await vi.waitFor(() => expect(frequencies).toEqual([523, 659]));
  cues.finished();
  await vi.waitFor(() => expect(frequencies).toEqual([523, 659, 659, 440]));
  cues.startThinking();
  expect(frequencies).toHaveLength(4); // the confirmation tone is not overlapped
  await vi.advanceTimersByTimeAsync(1200);
  expect(frequencies.slice(-2)).toEqual([392, 440]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(frequencies.slice(-2)).toEqual([392, 440]);
  const count = frequencies.length;
  cues.stopThinking();
  await vi.advanceTimersByTimeAsync(15000);
  expect(frequencies).toHaveLength(count);
  cues.dispose();
  cues.ready();
  await Promise.resolve();
  expect(frequencies).toHaveLength(count);
});
