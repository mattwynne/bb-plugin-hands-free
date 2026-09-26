// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createVoiceCues } from "./voice-cues";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("reports an interrupted audio context whose resume never completes", async () => {
  vi.useFakeTimers();
  class StuckContext {
    state = "interrupted";
    resume() { return new Promise<void>(() => {}); }
    close() { return Promise.resolve(); }
  }
  vi.stubGlobal("AudioContext", StuckContext);
  const cues = createVoiceCues();
  const ready = cues.ready();
  await vi.advanceTimersByTimeAsync(900);
  expect(await ready).toEqual({ scheduled: false, audioState: "interrupted" });
  cues.dispose();
});
