import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

describe("voice-drive", () => {
  it("logs only schema-validated bounded comparison metadata", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "voice-drive" });
    plugin(bb);
    const event = { session: "test-session-123", variant: "speech", event: "speech-ended", elapsedMs: 321, sessionType: "auto" };
    expect(await harness.behavior.callRpc("audioTestDiagnostic", event)).toEqual({ recorded: true });
    expect(JSON.stringify(harness.logEntries)).toContain("audio-test session=test-session-123 variant=speech event=speech-ended elapsedMs=321 sessionType=auto");
    await expect(harness.behavior.callRpc("audioTestDiagnostic", { ...event, text: "private reply" })).rejects.toThrow();
    await expect(harness.behavior.callRpc("audioTestDiagnostic", { ...event, event: "private reply" })).rejects.toThrow();
    for (let i = 1; i < 120; i++) await harness.behavior.callRpc("audioTestDiagnostic", event);
    expect(await harness.behavior.callRpc("audioTestDiagnostic", event)).toEqual({ recorded: false });
    expect(JSON.stringify(harness.logEntries)).not.toContain("private reply");
    await harness.lifecycle.dispose();
  });

  it("accepts only bounded microphone-comparison metadata", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "voice-drive" });
    plugin(bb);
    const entry = { session: "capture-run-123", variant: "capture", event: "mic-stopped", elapsedMs: 600, sessionType: "auto" };
    expect(await harness.behavior.callRpc("audioTestDiagnostic", entry)).toEqual({ recorded: true });
    expect(JSON.stringify(harness.logEntries)).toContain("variant=capture event=mic-stopped");
    expect(await harness.behavior.callRpc("audioTestDiagnostic", { ...entry, variant: "speech-fresh", event: "player-recreated" })).toEqual({ recorded: true });
    await expect(harness.behavior.callRpc("audioTestDiagnostic", { ...entry, recording: "private audio" })).rejects.toThrow();
    await harness.lifecycle.dispose();
  });

  it("reads only the requested thread and broadcasts an id without content", async () => {
    const output = vi.fn(async () => ({ output: "Private answer" }));
    const { bb, harness } = createFakePluginHost({ pluginId: "voice-drive", sdk: { threads: { output } } });
    plugin(bb);
    expect(await harness.behavior.callRpc("latest", { threadId: "th_1" })).toEqual({ text: "Private answer" });
    expect(output).toHaveBeenCalledWith({ threadId: "th_1" });
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "th_1" }), lastAssistantText: "Private answer" });
    expect(harness.realtimeSignals).toContainEqual({ channel: "voice-drive/thread-state", payload: { threadId: "th_1", state: "ready", hasReply: true } });
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "th_1" }), lastAssistantText: null });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "voice-drive/thread-state", payload: { threadId: "th_1", state: "ready", hasReply: false } });
    await harness.lifecycle.dispose();
  });

  it("checks live thread state and signals thinking, attention, and failure", async () => {
    const get = vi.fn(async () => makeThreadResponse({ id: "th_1", status: "active" }));
    const pending = vi.fn(async (): Promise<unknown[]> => []);
    const { bb, harness } = createFakePluginHost({ pluginId: "voice-drive", sdk: {
      threads: { get, interactions: { list: pending } },
    } });
    plugin(bb);
    expect(await harness.behavior.callRpc("state", { threadId: "th_1" })).toEqual({ state: "thinking" });
    pending.mockResolvedValueOnce([{}]);
    expect(await harness.behavior.callRpc("state", { threadId: "th_1" })).toEqual({ state: "attention" });
    get.mockResolvedValueOnce(makeThreadResponse({ id: "th_1", status: "idle" }));
    expect(await harness.behavior.callRpc("state", { threadId: "th_1" })).toEqual({ state: "ready" });
    await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "th_1" }) });
    await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "th_1" }), error: "oops" });
    expect(harness.realtimeSignals).toContainEqual({ channel: "voice-drive/thread-state", payload: { threadId: "th_1", state: "thinking" } });
    expect(harness.realtimeSignals).toContainEqual({ channel: "voice-drive/thread-state", payload: { threadId: "th_1", state: "failed" } });
    await harness.lifecycle.dispose();
  });

  it("sends reviewed text only as a new turn and refuses empty/oversized text", async () => {
    const send = vi.fn(async () => ({ status: "active" }));
    const { bb, harness } = createFakePluginHost({ pluginId: "voice-drive", sdk: { threads: { send } } });
    plugin(bb);
    await expect(harness.behavior.callRpc("send", { threadId: "th_1", text: "  Hello  " })).resolves.toEqual({ accepted: true });
    expect(send).toHaveBeenCalledWith({ threadId: "th_1", mode: "start", input: [{ type: "text", text: "Hello", mentions: [] }] });
    await expect(harness.behavior.callRpc("send", { threadId: "th_1", text: "   " })).rejects.toThrow();
    await expect(harness.behavior.callRpc("send", { threadId: "th_1", text: "x".repeat(12001) })).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    await harness.lifecycle.dispose();
  });
});
