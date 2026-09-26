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

it.each(["stream", "device"] as const)("reuses the cue player through recording, finish, and a %s reply without breaking capture", async (speechMode) => {
  const createObjectURL = vi.fn(() => "blob:shared-cue");
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
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
  const players: FakeAudio[] = [];
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public src: string) { players.push(this); }
    play = vi.fn(async () => {});
    pause = vi.fn();
    removeAttribute = vi.fn();
    load = vi.fn();
  }
  vi.stubGlobal("Audio", FakeAudio);
  let utterance: FakeUtterance | undefined;
  class FakeUtterance {
    lang = "";
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_text: string) { utterance = this; }
  }
  const speakDevice = vi.fn();
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("speechSynthesis", { speak: speakDevice, cancel: vi.fn(), speaking: false });
  const fetchMock = vi.fn(async (input: string) => input.includes("voice-transcription")
    ? { ok: true, json: async () => ({ text: "Fix the test" }) }
    : speechMode === "device" ? { ok: false, status: 404 }
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
  await waitFor(() => expect(speechMode === "stream" ? players[1]?.play : speakDevice).toHaveBeenCalledOnce());
  const cuePlayer = players[0]!;
  const player = players[1];
  expect(players).toHaveLength(speechMode === "stream" ? 2 : 1);
  expect(cuePlayer.src).toBe("blob:shared-cue");
  expect(cuePlayer.play).toHaveBeenCalledTimes(3); // page ready, capture started, finish
  expect(stopTracks).toHaveBeenCalledOnce();
  expect(slot.getByRole("button", { name: "■ Stop audio" })).toBeTruthy();
  expect(slot.queryByText("The test is fixed.")).toBeNull();
  await slot.behavior.emitRealtime("voice-drive/thread-state", { threadId: "th_2", state: "ready", hasReply: true });
  expect(speechMode === "stream" ? player!.play : speakDevice).toHaveBeenCalledOnce();
  vi.useFakeTimers();
  await act(async () => {
    if (speechMode === "stream") player!.onended?.();
    else { utterance!.onend?.(); await vi.advanceTimersByTimeAsync(1000); }
  });
  expect(cuePlayer.play).toHaveBeenCalledTimes(4); // post-reply: same player/source
  expect(createObjectURL).toHaveBeenCalledOnce();
  const pauses = cuePlayer.pause.mock.calls.length;
  if (player) expect(player.pause).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(speechMode === "stream" ? 1199 : 1499); });
  expect(cuePlayer.pause).toHaveBeenCalledTimes(pauses);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(cuePlayer.pause).toHaveBeenCalledTimes(pauses + 1);
  expect(cuePlayer.removeAttribute).not.toHaveBeenCalled();
  if (player) expect(player.pause).toHaveBeenCalledOnce();
});

it("retains the same local cue player across device replies, Stop, and late speech callbacks", async () => {
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
      latest: vi.fn().mockResolvedValueOnce({ text: "Device speech reply" })
        .mockResolvedValueOnce({ text: "Next reply" }).mockResolvedValue({ text: "Final reply" }),
      send: async () => ({ accepted: true }),
    },
  });
  await waitFor(() => expect((slot!.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false));
  await slot.behavior.emitRealtime("voice-drive/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await waitFor(() => expect(utterance).not.toBeNull());
  const priorCancelCalls = cancelSpeech.mock.calls.length;
  const cuePlayer = players[0]!;
  expect(play).toHaveBeenCalledOnce(); // ready before speech actually played this element
  vi.useFakeTimers();
  await act(async () => { utterance!.onend?.(); });
  expect(cancelSpeech).toHaveBeenCalledTimes(priorCancelCalls + 1);
  await act(async () => { await vi.advanceTimersByTimeAsync(999); });
  expect(play).toHaveBeenCalledOnce(); // existing post-speech delay stays unchanged
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(play).toHaveBeenCalledTimes(2);
  expect(players).toHaveLength(1);
  expect(cuePlayer.src).toBe("blob:local-ready-cue");
  expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "audio/wav" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(revokeObjectURL).not.toHaveBeenCalled();

  await slot.behavior.emitRealtime("voice-drive/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await act(async () => { utterance!.onend?.(); await vi.advanceTimersByTimeAsync(1000); });
  expect(play).toHaveBeenCalledTimes(3);
  fireEvent.click(slot.getByRole("button", { name: "■ Stop audio" }));
  await act(async () => { utterance!.onend?.(); await vi.advanceTimersByTimeAsync(3000); });
  expect(play).toHaveBeenCalledTimes(3); // a late speech callback cannot revive stopped playback

  await slot.behavior.emitRealtime("voice-drive/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await act(async () => { utterance!.onend?.(); });
  fireEvent.click(slot.getByRole("button", { name: "■ Stop audio" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(play).toHaveBeenCalledTimes(3); // Stop also cancels the pending delayed cue
  expect(cuePlayer.removeAttribute).not.toHaveBeenCalled();
  expect(cuePlayer.load).not.toHaveBeenCalled();
  expect(players).toHaveLength(1);
  expect(createObjectURL).toHaveBeenCalledOnce();
  slot.lifecycle.unmount();
  slot = undefined;
  expect(cuePlayer.removeAttribute).toHaveBeenCalledWith("src");
  expect(revokeObjectURL).toHaveBeenCalledOnce();
});

it.each(["end-sync", "end-queued", "silence-sync", "silence-queued", "active-error", "active-interrupted-error", "unknown-error", "speak-sync-error", "stopped"] as const)(
  "settles device speech once and distinguishes cleanup cancellation from failure: %s", async (mode) => {
    const play = vi.fn(async () => {});
    vi.stubGlobal("URL", { createObjectURL: () => "blob:cue", revokeObjectURL: vi.fn() });
    vi.stubGlobal("Audio", class {
      play = play;
      pause() {} removeAttribute() {} load() {}
    });
    type SpeechError = { error: string; message?: string };
    let utterance: FakeUtterance | undefined;
    let queuedError: ((event: SpeechError) => void) | null = null;
    class FakeUtterance {
      lang = "";
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: SpeechError) => void) | null = null;
      constructor(_text: string) { utterance = this; }
    }
    let cancellationDelivered = false;
    const synth = {
      speaking: false,
      speak: vi.fn((value: FakeUtterance) => {
        queuedError = value.onerror;
        synth.speaking = true;
        value.onstart?.();
        if (mode === "speak-sync-error") value.onerror?.({ error: "synthesis-failed" });
      }),
      cancel: vi.fn(() => {
        synth.speaking = false;
        if (!utterance || cancellationDelivered) return;
        cancellationDelivered = true;
        const callback = mode.endsWith("queued") ? queuedError : utterance.onerror;
        const notify = () => callback?.({ error: "interrupted" });
        if (mode.endsWith("queued")) queueMicrotask(notify);
        else notify();
      }),
    };
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", synth);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    const diagnostic = vi.fn(async (_args: unknown) => ({ recorded: true }));
    slot = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
      sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
      rpc: {
        state: async () => ({ state: "ready" }),
        latest: async () => ({ text: "Private reply" }),
        speechDiagnostic: diagnostic,
      },
    });
    await waitFor(() => expect((slot!.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false));
    vi.useFakeTimers();
    await slot.behavior.emitRealtime("voice-drive/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
    expect(synth.speak).toHaveBeenCalledOnce();
    await act(async () => {
      if (mode.startsWith("silence")) {
        await vi.advanceTimersByTimeAsync(300); // observe speech before testing the fallback
        synth.speaking = false;
        await vi.advanceTimersByTimeAsync(1200);
      } else if (mode.startsWith("active-") || mode === "unknown-error") {
        utterance!.onerror?.({
          error: mode === "active-error" ? "synthesis-failed" : mode === "active-interrupted-error" ? "interrupted" : "Private error",
          message: "Private detail",
        });
      } else if (mode === "stopped") {
        fireEvent.click(slot!.getByRole("button", { name: "■ Stop audio" }));
      } else {
        utterance!.onend?.();
      }
      await vi.advanceTimersByTimeAsync(3000);
    });
    const failure = slot.queryByText("Speech playback failed. Read the reply on screen.");
    if (mode.endsWith("error")) expect(failure).not.toBeNull();
    else expect(failure).toBeNull();
    expect(play).toHaveBeenCalledTimes(mode === "stopped" ? 1 : 2); // never schedule duplicate ready cues
    expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false);
    // A callback already queued by the browser must be harmless even after detachment.
    await act(async () => {
      for (let i = 0; i < 40; i++) queuedError?.({ error: "interrupted", message: "Private detail" });
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(play).toHaveBeenCalledTimes(mode === "stopped" ? 1 : 2);
    if (!mode.endsWith("error")) expect(slot.queryByText("Speech playback failed. Read the reply on screen.")).toBeNull();
    expect(diagnostic).toHaveBeenCalled();
    expect(diagnostic.mock.calls.length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("Private");
    if (mode.endsWith("error")) {
      expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
        event: "error", errorCode: mode === "unknown-error" ? "unknown" : mode === "active-interrupted-error" ? "interrupted" : "synthesis-failed",
      }));
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

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
