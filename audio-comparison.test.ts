// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startAudioComparison } from "./audio-comparison";

class FakeAudio {
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  currentTime = 0;
  play = vi.fn(async () => { this.onplaying?.(); });
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();
  constructor(public src: string) { players.push(this); }
}
class FakeUtterance {
  lang = "";
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) { utterances.push(this); }
}
let players: FakeAudio[];
let utterances: FakeUtterance[];
const speak = vi.fn();
const cancel = vi.fn();
const getUserMedia = vi.fn();
const fetchMock = vi.fn();
const sessionWrite = vi.fn();
const revokeObjectURL = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  players = [];
  utterances = [];
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("speechSynthesis", { speak, cancel, speaking: false, pending: false });
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:one-tone"), revokeObjectURL });
  vi.stubGlobal("navigator", { language: "en-US", mediaDevices: { getUserMedia },
    audioSession: { get type() { return "auto"; }, set type(_value) { sessionWrite(); } },
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("reuses identical media before/after fixed device speech without capture, session writes, or fetching", async () => {
  const events = vi.fn();
  startAudioComparison("speech", events);
  const player = players[0]!;
  expect(player.play).toHaveBeenCalledOnce(); // first playback happens in the tap handler
  expect(speak).not.toHaveBeenCalled();
  player.onended?.();
  expect(speak).toHaveBeenCalledOnce();
  expect(utterances[0]?.text).toBe("Test.");
  utterances[0]!.onstart?.();
  utterances[0]!.onend?.();
  expect(player.play).toHaveBeenCalledTimes(2);
  expect(player.src).toBe("blob:one-tone");
  expect(player.currentTime).toBe(0);
  player.onended?.();
  expect(events.mock.calls.map(([event]) => event)).toEqual([
    "start", "before-request", "before-playing", "before-ended",
    "speech-request", "speech-start", "speech-ended",
    "after-request", "after-playing", "after-ended", "complete",
  ]);
  expect(players).toHaveLength(1);
  expect(revokeObjectURL).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled(); // don't change the natural completion path
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(sessionWrite).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("also tests automatic second playback without speech", async () => {
  const events = vi.fn();
  startAudioComparison("control", events);
  players[0]!.onended?.();
  await vi.advanceTimersByTimeAsync(999);
  expect(players[0]!.play).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(players[0]!.play).toHaveBeenCalledTimes(2);
  players[0]!.onended?.();
  expect(events).toHaveBeenLastCalledWith("complete");
  expect(speak).not.toHaveBeenCalled();
});

it("cancels only its own active speech and ignores late callbacks", () => {
  const events = vi.fn();
  const comparison = startAudioComparison("speech", events);
  players[0]!.onended?.();
  const lateEnd = utterances[0]!.onend;
  comparison.stop();
  expect(cancel).toHaveBeenCalledOnce();
  lateEnd?.();
  expect(players[0]!.play).toHaveBeenCalledOnce();
  expect(events).toHaveBeenLastCalledWith("stopped");
  comparison.stop();
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("clears a pending control replay on stop", async () => {
  const comparison = startAudioComparison("control", vi.fn());
  players[0]!.onended?.();
  comparison.stop();
  await vi.advanceTimersByTimeAsync(2000);
  expect(players[0]!.play).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
});

it("reports automatic autoplay rejection instead of calling it a quiet tone", async () => {
  const events = vi.fn();
  startAudioComparison("speech", events);
  players[0]!.onended?.();
  players[0]!.play.mockRejectedValueOnce(new DOMException("private message", "NotAllowedError"));
  utterances[0]!.onend?.();
  await Promise.resolve();
  expect(events).toHaveBeenLastCalledWith("play-blocked");
  expect(JSON.stringify(events.mock.calls)).not.toContain("private message");
});

it("times out missing speech completion rather than silently using a guessed end", async () => {
  const events = vi.fn();
  startAudioComparison("speech", events);
  players[0]!.onended?.();
  await vi.advanceTimersByTimeAsync(20000);
  expect(events).toHaveBeenLastCalledWith("timeout");
  expect(players[0]!.play).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
});

it("refuses to run over existing speech without cancelling it", () => {
  vi.stubGlobal("speechSynthesis", { speak, cancel, speaking: true, pending: false });
  const events = vi.fn();
  startAudioComparison("speech", events);
  expect(events).toHaveBeenLastCalledWith("busy");
  expect(players).toHaveLength(0);
  expect(cancel).not.toHaveBeenCalled();
});
