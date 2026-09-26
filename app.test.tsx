// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

const app = await loadPluginApp(() => import("./app"));
let slot: ReturnType<typeof renderSlot> | undefined;
afterEach(() => {
  slot?.lifecycle.unmount();
  slot = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("sends recorded speech on finish and automatically reads the agent reply", async () => {
  const stopTracks = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTracks }] }) },
  });
  class FakeRecorder {
    static isTypeSupported() { return true; }
    mimeType = "audio/mp4";
    state: RecordingState = "inactive";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/mp4" }) });
      this.onstop?.();
    }
  }
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  const play = vi.fn(async () => {});
  const players: FakeAudio[] = [];
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public src: string) { players.push(this); }
    play = play;
    pause = vi.fn();
    removeAttribute = vi.fn();
    load = vi.fn();
  }
  vi.stubGlobal("Audio", FakeAudio);
  const fetchMock = vi.fn(async (input: string) => input.includes("voice-transcription")
    ? { ok: true, json: async () => ({ text: "Fix the test" }) }
    : { ok: true, json: async () => ({ id: "audio-1" }) });
  vi.stubGlobal("fetch", fetchMock);

  const sent = vi.fn(async () => ({ accepted: true }));
  slot = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
    sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
    rpc: { send: sent, latest: async () => ({ text: "The test is fixed." }), state: async () => ({ state: "ready" }) },
  });
  expect(slot.queryByText("Latest agent reply")).toBeNull();
  expect(slot.queryByText("Read reply")).toBeNull();
  expect(slot.queryByText("Send this reply")).toBeNull();

  await waitFor(() => expect((slot!.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(slot.getByRole("button", { name: "Start dictating" }));
  await waitFor(() => expect(slot!.getByRole("button", { name: "Finish dictating" })).toBeTruthy());
  await act(async () => { fireEvent.click(slot!.getByRole("button", { name: "Finish dictating" })); });
  await waitFor(() => expect(sent).toHaveBeenCalledWith({ threadId: "th_1", text: "Fix the test" }));
  expect(fetchMock).toHaveBeenCalledWith("/api/v1/system/voice-transcription", expect.objectContaining({ method: "POST" }));

  expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(true);
  await slot.behavior.emitRealtime("voice-drive/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  expect(slot.getByRole("button", { name: "■ Stop audio" })).toBeTruthy();
  expect(slot.queryByText("The test is fixed.")).toBeNull();
  await slot.behavior.emitRealtime("voice-drive/thread-state", { threadId: "th_2", state: "ready", hasReply: true });
  expect(play).toHaveBeenCalledTimes(1);
  const player = players.at(-1)!;
  vi.useFakeTimers();
  await act(async () => { player.onended?.(); });
  expect(player.pause).not.toHaveBeenCalled(); // don't tear audio down before the ready cue
  await act(async () => { await vi.advanceTimersByTimeAsync(1199); });
  expect(player.pause).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(player.pause).toHaveBeenCalledOnce();
});

it("uses only a local media element for the ready cue after device speech", async () => {
  const createObjectURL = vi.fn(() => "blob:local-ready-cue");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const play = vi.fn(async () => {});
  const players: FakeAudio[] = [];
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    pause = vi.fn();
    removeAttribute = vi.fn();
    load = vi.fn();
    constructor(public src: string) { players.push(this); }
    play = play;
  }
  vi.stubGlobal("Audio", FakeAudio);
  let utterance: FakeUtterance | null = null;
  class FakeUtterance {
    lang = "";
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public text: string) { utterance = this; }
  }
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  const cancelSpeech = vi.fn();
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: { speak: vi.fn(), cancel: cancelSpeech, speaking: false },
  });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Read Aloud unavailable"); }));

  slot = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
    sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
    rpc: {
      state: async () => ({ state: "ready" }),
      latest: async () => ({ text: "Device speech reply" }),
      send: async () => ({ accepted: true }),
    },
  });
  await waitFor(() => expect((slot!.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false));
  await slot.behavior.emitRealtime("voice-drive/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await waitFor(() => expect(utterance).not.toBeNull());
  const priorCancelCalls = cancelSpeech.mock.calls.length;
  vi.useFakeTimers();
  await act(async () => { utterance!.onend?.(); });
  expect(cancelSpeech).toHaveBeenCalledTimes(priorCancelCalls + 1);
  expect(play).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(999); });
  expect(play).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(play).toHaveBeenCalledOnce();
  expect(players).toHaveLength(1);
  expect(players[0]?.src).toBe("blob:local-ready-cue");
  expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "audio/wav" }));
});

it("locks the microphone during agent work and unlocks it after a silent idle or failure", async () => {
  slot = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
    sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
    rpc: {
      state: async () => ({ state: "thinking" }),
      latest: async () => ({ text: null }),
      send: async () => ({ accepted: true }),
    },
  });
  await waitFor(() => expect(slot!.getByText("Agent thinking…")).toBeTruthy());
  expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(true);
  await slot.behavior.emitRealtime("voice-drive/thread-state", { threadId: "th_1", state: "attention" });
  expect(slot.getByText("Needs attention")).toBeTruthy();
  expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(true);
  await slot.behavior.emitRealtime("voice-drive/thread-state", { threadId: "th_1", state: "ready", hasReply: false });
  expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false);
  await slot.behavior.emitRealtime("voice-drive/thread-state", { threadId: "th_1", state: "thinking" });
  expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(true);
  await slot.behavior.emitRealtime("voice-drive/thread-state", { threadId: "th_1", state: "failed" });
  expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false);
});
