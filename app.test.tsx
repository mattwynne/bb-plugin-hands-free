// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

const app = await loadPluginApp(() => import("./app"));
it("registers Hands-Free on the existing sidebar route", () => {
  expect(app.settingsSections).toHaveLength(1);
  expect(app.settingsSections[0]).toMatchObject({ id: "voice" });
  expect(app.settingsSections[0]?.title).toBeUndefined(); // Avoid a duplicate Voice heading.
  expect(app.navPanels).toHaveLength(1);
  expect(app.navPanels[0]).toMatchObject({ id: "hands-free", path: "hands-free", title: "Hands-Free" });
  expect(app.threadHeaderActions).toHaveLength(1);
  expect(app.threadHeaderActions[0]).toMatchObject({ id: "open-hands-free", title: "Hands-Free" });

  const page = renderSlot(app.navPanels[0]!, { subPath: "" }, { sidebarThreads: { threads: [] } });
  expect(page.getByRole("main", { name: "Hands-Free" })).toBeTruthy();
  expect(page.getByRole("heading", { name: "Hands-Free" })).toBeTruthy();
  const settingsLink = page.getByRole("link", { name: "Hands-Free settings" });
  expect(settingsLink.getAttribute("href")).toBe("/settings/plugins/hands-free");
  expect(settingsLink.querySelector('[data-icon="Settings"]')).not.toBeNull();
  expect(page.queryByRole("combobox", { name: "Voice" })).toBeNull();
  const unselectedControl = page.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement;
  expect(unselectedControl.disabled).toBe(true);
  expect(unselectedControl.querySelector('[data-icon="Mic"]')).not.toBeNull();
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
  expect(page.queryByRole("button", { name: /Open thread/ })).toBeNull();
  page.lifecycle.unmount();

  const selectedPage = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
    sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
    rpc: { state: async () => ({ state: "ready" }) },
  });
  await waitFor(() => expect(selectedPage.getByRole("status").textContent).toBe("Ready. Tap to talk."));
  expect(selectedPage.getByText("Keep BB open and unlocked while recording or listening.")).toBeTruthy();
  expect(selectedPage.queryByText(/Read Aloud is optional/i)).toBeNull();
  expect(selectedPage.queryByTestId("bb-thread-chat")).toBeNull();
  expect(selectedPage.getByRole("button", { name: "Thread activity" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(selectedPage.getByRole("button", { name: "Thread activity" }));
  const activity = selectedPage.getByTestId("bb-thread-chat");
  expect(activity.dataset).toMatchObject({ threadId: "th_1", variant: "timeline", layout: "document" });
  fireEvent.click(selectedPage.getByRole("button", { name: "Thread activity" }));
  expect(selectedPage.queryByTestId("bb-thread-chat")).toBeNull();
  fireEvent.click(selectedPage.getByRole("button", { name: "My thread Open thread" }));
  expect(selectedPage.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "th_1" }]);
  expect(selectedPage.getByRole("button", { name: "Thread activity" }).getAttribute("aria-expanded")).toBe("false");
  selectedPage.lifecycle.unmount();
});
let slot: ReturnType<typeof renderSlot> | undefined;
afterEach(() => {
  slot?.lifecycle.unmount();
  slot = undefined;
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reuses the cue player through recording, finish, and an Edge reply without breaking capture", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const createObjectURL = vi.fn().mockReturnValueOnce("blob:thinking").mockReturnValueOnce("blob:shared-cue").mockReturnValueOnce("blob:tap-cue").mockReturnValueOnce("blob:reply-cue");
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
    loop = false;
    constructor(public src: string) { players.push(this); }
    play = vi.fn(async () => {});
    pause = vi.fn();
    removeAttribute = vi.fn();
    load = vi.fn();
  }
  vi.stubGlobal("Audio", FakeAudio);
  localStorage.setItem("hands-free.voice.v1", JSON.stringify({ voiceId: "edge:en-US-AriaNeural", speed: 1 }));
  const fetchMock = vi.fn(async (input: string) => input.endsWith("/voices")
    ? { ok: true, json: async () => ({ voices: [{ id: "edge:en-US-AriaNeural", name: "Aria", engine: "edge", language: "en-US", available: true }] }) }
    : input.includes("voice-transcription")
    ? { ok: true, json: async () => ({ text: "Fix the test" }) }
    : { ok: true, json: async () => ({ audioId: "audio-1", url: "/api/v1/plugins/hands-free/http/speech/audio?id=audio-1", expiresAt: Date.now() + 120000 }) });
  vi.stubGlobal("fetch", fetchMock);

  const sent = vi.fn(async () => ({ accepted: true }));
  let latestText = "**The test** is [fixed](https://example.com).";
  slot = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
    sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
    rpc: { send: sent, latest: async () => ({ text: latestText }), state: async () => ({ state: "ready" }) },
  });
  expect(slot.queryByText("Latest agent reply")).toBeNull();
  expect(slot.queryByText("Read reply")).toBeNull();
  expect(slot.queryByText("Send this reply")).toBeNull();

  await waitFor(() => expect((slot!.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false));
  const startControl = slot.getByRole("button", { name: "Start dictating" });
  expect(startControl.getAttribute("data-control-state")).toBe("start");
  expect(startControl.className).toContain("size-28");
  expect(startControl.className).toContain("rounded-full");
  expect(startControl.className).toContain("bg-foreground");
  expect(startControl.className).toContain("text-background");
  expect(startControl.className).toContain("focus-visible:ring-2");
  expect(startControl.querySelector('[data-icon="Mic"]')).not.toBeNull();
  expect(players).toHaveLength(0); // opening an idle thread is silent
  fireEvent.click(slot.getByRole("button", { name: "Start dictating" }));
  await waitFor(() => {
    const finishControl = slot!.getByRole("button", { name: "Finish dictating" });
    expect(finishControl.getAttribute("data-control-state")).toBe("complete");
    expect(finishControl.querySelector('[data-icon="ArrowUp"]')).not.toBeNull();
    expect(finishControl.querySelector('[data-icon="ArrowUp"]')?.className).not.toContain("stroke-0");
    expect(finishControl.querySelector("canvas[aria-hidden]")).not.toBeNull();
  });
  expect(players[0]!.src).toBe("blob:tap-cue");
  await act(async () => { fireEvent.click(slot!.getByRole("button", { name: "Finish dictating" })); });
  expect(slot.container.querySelector("canvas")).toBeNull();
  await waitFor(() => expect(sent).toHaveBeenCalledWith({ threadId: "th_1", text: "Fix the test" }));
  expect(fetchMock).toHaveBeenCalledWith("/api/v1/system/voice-transcription", expect.objectContaining({ method: "POST" }));

  expect((slot.getByRole("button", { name: "Working" }) as HTMLButtonElement).disabled).toBe(true);
  Object.defineProperty(players[0]!, "ended", { value: true });
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "thinking" });
  expect(players[0]!.pause).not.toHaveBeenCalled();
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await waitFor(() => expect(players[1]?.play).toHaveBeenCalledTimes(2));
  expect(fetchMock).toHaveBeenCalledWith("/api/v1/plugins/hands-free/http/speech/prepare", expect.objectContaining({
    body: expect.stringContaining('"text":"The test is fixed."'),
  }));
  const cuePlayer = players[0]!;
  const player = players[1];
  expect(players).toHaveLength(2);
  expect(player!.src).toBe("/api/v1/plugins/hands-free/http/speech/audio?id=audio-1");
  expect(player!.loop).toBe(false);
  expect(player!.pause).not.toHaveBeenCalled();
  expect(cuePlayer.src).toBe("blob:shared-cue");
  expect(cuePlayer.play).toHaveBeenCalledTimes(2); // capture started, finish; no opening cue
  expect(stopTracks).toHaveBeenCalledOnce();
  const playbackControl = slot.getByRole("button", { name: "Stop audio" });
  expect(playbackControl.getAttribute("data-control-state")).toBe("playback");
  expect(playbackControl.querySelector('[data-icon="Square"]')?.className).toContain("fill-current");
  expect(slot.queryByText("The test is fixed.")).toBeNull();
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_2", state: "ready", hasReply: true });
  expect(player!.play).toHaveBeenCalledTimes(2);
  vi.useFakeTimers();
  Object.defineProperty(player, "ended", { value: true, configurable: true });
  await act(async () => {
    player!.onended?.();
  });
  expect(cuePlayer.play).toHaveBeenCalledTimes(3); // post-reply: distinct source, same player
  expect(cuePlayer.src).toBe("blob:reply-cue");
  expect(createObjectURL).toHaveBeenCalledTimes(4);
  const pauses = cuePlayer.pause.mock.calls.length;
  if (player) expect(player.pause).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1199); });
  expect(cuePlayer.pause).toHaveBeenCalledTimes(pauses);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(cuePlayer.pause).toHaveBeenCalledTimes(pauses);
  expect(cuePlayer.removeAttribute).not.toHaveBeenCalled();
  if (player) {
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.removeAttribute).not.toHaveBeenCalled();
    expect(player.load).not.toHaveBeenCalled();
  }
  vi.useRealTimers();
  latestText = "Another reply";
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "thinking" });
  expect(players).toHaveLength(2);
  expect(player!.src).toBe("blob:thinking");
  expect(player!.loop).toBe(true);
  Object.defineProperty(player, "ended", { value: false, configurable: true });
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await waitFor(() => expect(player!.play).toHaveBeenCalledTimes(4));
  expect(player!.loop).toBe(false);
  expect(player!.pause).not.toHaveBeenCalled();
  expect(players).toHaveLength(2);
});

it("stops Edge playback without reviving its reply cue from late events", async () => {
  vi.stubGlobal("URL", { createObjectURL: () => "blob:cue", revokeObjectURL: vi.fn() });
  const players: Array<{ play: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
  vi.stubGlobal("Audio", class {
    onended: (() => void) | null = null;
    onerror = null;
    play = vi.fn(async () => {});
    pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn();
    constructor(public src: string) { players.push(this); }
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/voices")
    ? { ok: true, json: async () => ({ voices: [{ id: "edge:en-GB-SoniaNeural", name: "Sonia", engine: "edge", language: "en-GB", available: true }] }) }
    : { ok: true, json: async () => ({ audioId: "a", url: "/api/v1/plugins/hands-free/http/speech/audio?id=a" }) }));
  slot = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
    sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
    rpc: { state: async () => ({ state: "ready" }), latest: async () => ({ text: "Reply" }) },
  });
  await waitFor(() => expect(slot!.getByRole("status").textContent).toBe("Ready. Tap to talk."));
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await waitFor(() => expect(players[0]?.play).toHaveBeenCalledOnce());
  const late = players[0]!.onended;
  fireEvent.click(slot.getByRole("button", { name: "Stop audio" }));
  act(() => late?.());
  expect(players).toHaveLength(1);
  expect(players[0]!.play).toHaveBeenCalledOnce();
});

it("keeps the final reply playing when its thread archives", async () => {
  vi.stubGlobal("URL", { createObjectURL: () => "blob:cue", revokeObjectURL: vi.fn() });
  const players: Array<{ play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
  vi.stubGlobal("Audio", class {
    onended: (() => void) | null = null;
    onerror = null; onplaying = null; onpause = null;
    play = vi.fn(async () => {});
    pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn();
    constructor(public src: string) { players.push(this); }
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/voices")
    ? { ok: true, json: async () => ({ voices: [{ id: "edge:en-GB-SoniaNeural", name: "Sonia", engine: "edge", language: "en-GB", available: true }] }) }
    : { ok: true, json: async () => ({ audioId: "a", url: "/api/v1/plugins/hands-free/http/speech/audio?id=a" }) }));
  slot = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
    sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
    rpc: { state: async () => ({ state: "ready" }), latest: async () => ({ text: "Final reply" }) },
  });
  await waitFor(() => expect(slot!.getByRole("status").textContent).toBe("Ready. Tap to talk."));
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "archived" });
  expect(slot.getByText(/Thread archived.*final reply can still play/i)).toBeTruthy();
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await waitFor(() => expect(players[0]?.play).toHaveBeenCalledOnce());
  expect(slot.getByText(/Thread archived.*reply is still playing/i)).toBeTruthy();
  expect((slot.getByRole("button", { name: "Stop audio" }) as HTMLButtonElement).disabled).toBe(false);
  expect(players[0]!.pause).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Stop audio" }));
  expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(true);
});

it("reports a browser playback abort without leaking the reply", async () => {
  vi.stubGlobal("URL", { createObjectURL: () => "blob:cue", revokeObjectURL: vi.fn() });
  vi.stubGlobal("Audio", class {
    onended = null; onerror = null; onplaying = null; onpause = null;
    play = vi.fn(async () => { throw new DOMException("The operation was aborted", "AbortError"); });
    pause() {} removeAttribute() {} load() {}
    constructor(public src: string) {}
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/voices")
    ? { ok: true, json: async () => ({ voices: [{ id: "edge:en-GB-SoniaNeural", name: "Sonia", engine: "edge", language: "en-GB", available: true }] }) }
    : { ok: true, json: async () => ({ audioId: "a", url: "/api/v1/plugins/hands-free/http/speech/audio?id=a" }) }));
  const diagnostic = vi.fn(async () => ({ recorded: true }));
  slot = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
    sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
    rpc: { state: async () => ({ state: "ready" }), latest: async () => ({ text: "Private answer" }), audioDiagnostic: diagnostic },
  });
  await waitFor(() => expect(slot!.getByRole("status").textContent).toBe("Ready. Tap to talk."));
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await waitFor(() => expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: "speech-failed", detail: "aborted" })));
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("Private answer");
});

it("shows the scrolling indicator during browser recognition and removes it on cancellation", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:cue", revokeObjectURL: vi.fn() });
  vi.stubGlobal("Audio", class { play = vi.fn(async () => {}); pause() {} removeAttribute() {} load() {} });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  const abort = vi.fn();
  class FakeRecognition {
    lang = ""; interimResults = false; continuous = false;
    onresult = null; onerror = null; onend = null;
    start = vi.fn(); stop = vi.fn(); abort = abort;
  }
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  slot = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
    sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
    rpc: { state: async () => ({ state: "ready" }) },
  });
  await waitFor(() => expect((slot!.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(slot.getByRole("button", { name: "Start dictating" }));
  expect(slot.getByRole("button", { name: "Finish dictating" }).querySelector("canvas")).not.toBeNull();
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "thinking" });
  expect(abort).toHaveBeenCalledOnce();
  expect(slot.container.querySelector("canvas")).toBeNull();
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
  await waitFor(() => expect(slot!.getByRole("status").textContent).toBe("Agent is thinking. Talk is disabled until it finishes."));
  const workingControl = slot.getByRole("button", { name: "Working" }) as HTMLButtonElement;
  expect(workingControl.disabled).toBe(true);
  expect(workingControl.getAttribute("data-control-state")).toBe("working");
  expect(workingControl.querySelector('[data-icon="Spinner"]')?.className).toContain("animate-spin");
  expect(workingControl.querySelector('[data-icon="Spinner"]')?.className).toContain("motion-reduce:animate-none");
  fireEvent.click(slot.getByRole("button", { name: "Thread activity" }));
  expect(slot.getByTestId("bb-thread-chat").dataset.variant).toBe("timeline");
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "attention" });
  const attentionControl = slot.getByRole("button", { name: "Needs attention" }) as HTMLButtonElement;
  expect(attentionControl.disabled).toBe(true);
  expect(attentionControl.querySelector('[data-icon="AlertTriangle"]')).not.toBeNull();
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "ready", hasReply: false });
  expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false);
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "thinking" });
  expect((slot.getByRole("button", { name: "Working" }) as HTMLButtonElement).disabled).toBe(true);
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "failed" });
  expect((slot.getByRole("button", { name: "Start dictating" }) as HTMLButtonElement).disabled).toBe(false);
});


it("migrates a retired selection for Edge replies", async () => {
  localStorage.setItem("hands-free.voice.v1", JSON.stringify({ voiceId: "openai:coral", speed: 1.2 }));
  vi.stubGlobal("URL", { createObjectURL: () => "blob:cue", revokeObjectURL: vi.fn() });
  const play = vi.fn(async () => {});
  vi.stubGlobal("Audio", class { play = play; pause() {} removeAttribute() {} load() {} });
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => url.endsWith("/voices")
    ? { ok: true, json: async () => ({ voices: [{ id: "edge:en-GB-SoniaNeural", name: "Sonia", engine: "edge", language: "en-GB", available: true }] }) }
    : { ok: true, json: async () => ({ audioId: "a", url: "/api/v1/plugins/hands-free/http/speech/audio?id=a" }) });
  vi.stubGlobal("fetch", fetcher);
  slot = renderSlot(app.navPanels[0]!, { subPath: "th_1" }, {
    sidebarThreads: { threads: [{ id: "th_1", title: "My thread" } as PluginSidebarThread] },
    rpc: { state: async () => ({ state: "ready" }), latest: async () => ({ text: "Hello there" }) },
  });
  await waitFor(() => expect(slot!.getByRole("status").textContent).toBe("Ready. Tap to talk."));
  await slot.behavior.emitRealtime("hands-free/thread-state", { threadId: "th_1", state: "ready", hasReply: true });
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/speech/prepare"), expect.objectContaining({ body: expect.stringContaining('"voiceId":"edge:en-GB-SoniaNeural"') })));
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/speech/prepare"), expect.objectContaining({ body: expect.stringContaining('"speed":1.2') }));
});
