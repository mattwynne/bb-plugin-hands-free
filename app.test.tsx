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
  const diagnostics = vi.fn(async () => ({ recorded: true }));
  slot = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
    sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
    rpc: { send: sent, latest: async () => ({ text: "The test is fixed." }), state: async () => ({ state: "ready" }), diagnostic: diagnostics },
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
  expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: "reply-end", detail: "media-ended" }));
  await act(async () => { await Promise.resolve(); });
  expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: "cue-unavailable", detail: "automatic" }));
  expect(player.pause).not.toHaveBeenCalled(); // don't tear audio down before the ready cue
  await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
  expect(player.pause).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(player.pause).toHaveBeenCalledOnce();
  fireEvent.click(slot.getByRole("button", { name: "Test ready tone (diagnostic)" }));
  expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: "manual-test", detail: "manual" }));
  fireEvent.click(slot.getByRole("button", { name: "Reset audio & test tone (diagnostic)" }));
  expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ event: "audio-reset", audioState: "unavailable" }));
});

it("locks the microphone during agent work and unlocks it after a silent idle or failure", async () => {
  slot = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
    sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
    rpc: {
      state: async () => ({ state: "thinking" }),
      latest: async () => ({ text: null }),
      send: async () => ({ accepted: true }),
      diagnostic: async () => ({ recorded: true }),
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
