import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

describe("voice-drive", () => {
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
