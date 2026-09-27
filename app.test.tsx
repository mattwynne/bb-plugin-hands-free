// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

const app = await loadPluginApp(() => import("./app"));
it("registers Hands-Free on the existing sidebar route", () => {
  expect(app.navPanels).toHaveLength(1);
  expect(app.navPanels[0]).toMatchObject({ id: "hands-free", path: "hands-free", title: "Hands-Free" });
  expect(app.threadHeaderActions).toHaveLength(1);
  expect(app.threadHeaderActions[0]).toMatchObject({ id: "open-hands-free", title: "Hands-Free" });

  const page = renderSlot(app.navPanels[0]!, { subPath: "" }, { sidebarThreads: { threads: [] } });
  expect(page.getByRole("main", { name: "Hands-Free" })).toBeTruthy();
  expect(page.getByRole("heading", { name: "Hands-Free" })).toBeTruthy();
  page.lifecycle.unmount();

  const header = renderSlot(app.threadHeaderActions[0]!, {
    threadId: "th_1", projectId: "prj_1", isCompactViewport: false,
  });
  expect(header.getByRole("button", { name: "Open Hands-Free for this thread" })).toBeTruthy();
  header.lifecycle.unmount();
});

it("keeps page guidance concise and relevant to the selected thread", async () => {
  const page = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
  });
  expect(page.getByRole("status").textContent).toBe("Choose a thread to begin.");
  expect(page.queryByText("Keep BB open and unlocked while recording or listening.")).toBeNull();
  expect(page.queryByText(/tone confirms recording/i)).toBeNull();
  page.lifecycle.unmount();

  const selectedPage = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
    sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
    rpc: { state: async () => ({ state: "ready" }) },
  });
  await waitFor(() => expect(selectedPage.getByRole("status").textContent).toBe("Ready. Tap to talk."));
  expect(selectedPage.getByText("Keep BB open and unlocked while recording or listening.")).toBeTruthy();
  expect(selectedPage.queryByText(/Read Aloud is optional/i)).toBeNull();
  selectedPage.lifecycle.unmount();
});
let slot: ReturnType<typeof renderSlot> | undefined;
afterEach(() => {
  slot?.lifecycle.unmount();
  slot = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["stream", "device"] as const)("reuses the cue player through recording, finish, and a %s reply without breaking capture", async (speechMode) => {
  const createObjectURL = vi.fn().mockReturnValueOnce("blob:shared-cue").mockReturnValueOnce("blob:tap-cue").mockReturnValueOnce("blob:reply-cue");
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
  expect(players).toHaveLength(0); // opening an idle thread is silent
  fireEvent.click(slot.getByRole("button", { name: "Start dictating" }));
  await waitFor(() => expect(slot!.getByRole("button", { name: "Finish dictating" })).toBeTruthy());
  expect(players[0]!.src).toBe("blob:tap-cue");
  await act(async () => { fireEvent.click(slot!.getByRole("button", { name: "Finish dictating" })); });
  await waitFor(() => expect(sent).toHaveBeenCalledWith({ threadId: "th_1", text: "Fix the test" }));
  expect(fetchMock).toHaveBeenCalledWith("/api/v1/system/voice-transcription", expect.objectContaining({ method: "POST" }));

  expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(true);
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await waitFor(() => expect(speechMode === "stream" ? players[1]?.play : speakDevice).toHaveBeenCalledOnce());
  const cuePlayer = players[0]!;
  const player = players[1];
  expect(players).toHaveLength(speechMode === "stream" ? 2 : 1);
  expect(cuePlayer.src).toBe("blob:shared-cue");
  expect(cuePlayer.play).toHaveBeenCalledTimes(2); // capture started, finish; no opening cue
  expect(stopTracks).toHaveBeenCalledOnce();
  expect(slot.getByRole("button", { name: "■ Stop audio" })).toBeTruthy();
  expect(slot.queryByText("The test is fixed.")).toBeNull();
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_2", state: "ready", hasReply: true });
  expect(speechMode === "stream" ? player!.play : speakDevice).toHaveBeenCalledOnce();
  vi.useFakeTimers();
  await act(async () => {
    if (speechMode === "stream") player!.onended?.();
    else { utterance!.onend?.(); await vi.advanceTimersByTimeAsync(1000); }
  });
  expect(cuePlayer.play).toHaveBeenCalledTimes(3); // post-reply: distinct source, same player
  expect(cuePlayer.src).toBe("blob:reply-cue");
  expect(createObjectURL).toHaveBeenCalledTimes(3); // cached finish, tap, and reply WAVs
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
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await waitFor(() => expect(utterance).not.toBeNull());
  const priorCancelCalls = cancelSpeech.mock.calls.length;
  expect(play).not.toHaveBeenCalled(); // no opening cue, and this scenario has no dictation
  vi.useFakeTimers();
  await act(async () => { utterance!.onend?.(); });
  expect(cancelSpeech).toHaveBeenCalledTimes(priorCancelCalls + 1);
  await act(async () => { await vi.advanceTimersByTimeAsync(999); });
  expect(play).not.toHaveBeenCalled(); // existing post-speech delay stays unchanged
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(play).toHaveBeenCalledOnce();
  expect(players).toHaveLength(1);
  const cuePlayer = players[0]!;
  expect(cuePlayer.src).toBe("blob:local-ready-cue");
  expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "audio/wav" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(revokeObjectURL).not.toHaveBeenCalled();

  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await act(async () => { utterance!.onend?.(); await vi.advanceTimersByTimeAsync(1000); });
  expect(play).toHaveBeenCalledTimes(2);
  fireEvent.click(slot.getByRole("button", { name: "■ Stop audio" }));
  await act(async () => { utterance!.onend?.(); await vi.advanceTimersByTimeAsync(3000); });
  expect(play).toHaveBeenCalledTimes(2); // a late speech callback cannot revive stopped playback

  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await act(async () => { utterance!.onend?.(); });
  fireEvent.click(slot.getByRole("button", { name: "■ Stop audio" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(play).toHaveBeenCalledTimes(2); // Stop also cancels the pending delayed cue
  expect(cuePlayer.removeAttribute).not.toHaveBeenCalled();
  expect(cuePlayer.load).not.toHaveBeenCalled();
  expect(players).toHaveLength(1);
  expect(createObjectURL).toHaveBeenCalledTimes(2); // normal + falling reply; no recording in this scenario
  slot.lifecycle.unmount();
  slot = undefined;
  expect(cuePlayer.removeAttribute).toHaveBeenCalledWith("src");
  expect(revokeObjectURL).toHaveBeenCalledTimes(2);
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
    slot = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
      sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
      rpc: {
        state: async () => ({ state: "ready" }),
        latest: async () => ({ text: "Private reply" }),
      },
    });
    await waitFor(() => expect((slot!.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false));
    vi.useFakeTimers();
    await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
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
    expect(play).toHaveBeenCalledTimes(mode === "stopped" ? 0 : 1); // no opening/duplicate cues
    expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false);
    // A callback already queued by the browser must be harmless even after detachment.
    await act(async () => {
      for (let i = 0; i < 40; i++) queuedError?.({ error: "interrupted", message: "Private detail" });
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(play).toHaveBeenCalledTimes(mode === "stopped" ? 0 : 1);
    if (!mode.endsWith("error")) expect(slot.queryByText("Speech playback failed. Read the reply on screen.")).toBeNull();
    expect(slot.inspection.rpcCalls).toHaveLength(2); // initial state + latest reply only, no diagnostics
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
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "attention" });
  expect(slot.getByText("Needs attention")).toBeTruthy();
  expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(true);
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "ready", hasReply: false });
  expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false);
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "thinking" });
  expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(true);
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "failed" });
  expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false);
});
