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
    expect(harness.realtimeSignals).toContainEqual({ channel: "voice-drive/thread-idle", payload: { threadId: "th_1" } });
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
