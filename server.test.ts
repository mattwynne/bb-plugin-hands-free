import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { fileURLToPath } from "node:url";
import plugin from "./server";

describe("hands-free", () => {
  it("uses only public SDK surfaces and declared public dependencies", () => {
    const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), {
      allow: [/^ws$/, /^vitest$/, /^react(?:\/.*)?$/, /^@testing-library\/react$/, /^marked$/, /^html-entities$/],
    });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });

  it("does not register the retired diagnostic RPCs", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "hands-free" });
    plugin(bb);
    await expect(harness.behavior.callRpc("audioTestDiagnostic", {
      session: "test-run-123", variant: "speech", event: "start", elapsedMs: 0, sessionType: "auto",
    })).rejects.toThrow();
    await expect(harness.behavior.callRpc("speechDiagnostic", {
      session: "speech-run-123", event: "end", errorCode: "none", elapsedMs: 1000,
    })).rejects.toThrow();
    await harness.lifecycle.dispose();
  });

  it("records bounded audio lifecycle events without accepting reply text or arbitrary errors", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "hands-free" });
    plugin(bb);
    const input = { session: "51c0b6db-5c61-4094-bbc3-ae5373abc18d", event: "speech-failed", detail: "aborted", elapsedMs: 123 };
    expect(await harness.behavior.callRpc("audioDiagnostic", input)).toEqual({ recorded: true });
    expect(harness.logEntries.some(entry => entry.message.includes("event=speech-failed detail=aborted elapsedMs=123"))).toBe(true);
    await expect(harness.behavior.callRpc("audioDiagnostic", { ...input, text: "Private answer" })).rejects.toThrow();
    await expect(harness.behavior.callRpc("audioDiagnostic", { ...input, detail: "Private error details" })).rejects.toThrow();
    for (let i = 1; i < 120; i++) await harness.behavior.callRpc("audioDiagnostic", input);
    expect(await harness.behavior.callRpc("audioDiagnostic", input)).toEqual({ recorded: false });
    await harness.lifecycle.dispose();
  });

  it("reads only the requested thread and broadcasts an id without content", async () => {
    const output = vi.fn(async () => ({ output: "Private answer" }));
    const { bb, harness } = createFakePluginHost({ pluginId: "hands-free", sdk: { threads: { output } } });
    plugin(bb);
    expect(await harness.behavior.callRpc("latest", { threadId: "th_1" })).toEqual({ text: "Private answer" });
    expect(output).toHaveBeenCalledWith({ threadId: "th_1" });
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "th_1" }), lastAssistantText: "Private answer" });
    expect(harness.realtimeSignals).toContainEqual({ channel: "hands-free/thread-state", payload: { threadId: "th_1", state: "ready", hasReply: true } });
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "th_1" }), lastAssistantText: null });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "hands-free/thread-state", payload: { threadId: "th_1", state: "ready", hasReply: false } });
    await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "th_1" }) });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "hands-free/thread-state", payload: { threadId: "th_1", state: "archived" } });
    await harness.lifecycle.dispose();
  });

  it("checks live thread state and signals thinking, attention, and failure", async () => {
    const get = vi.fn(async () => makeThreadResponse({ id: "th_1", status: "active" }));
    const pending = vi.fn(async (): Promise<unknown[]> => []);
    const { bb, harness } = createFakePluginHost({ pluginId: "hands-free", sdk: {
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
    expect(harness.realtimeSignals).toContainEqual({ channel: "hands-free/thread-state", payload: { threadId: "th_1", state: "thinking" } });
    expect(harness.realtimeSignals).toContainEqual({ channel: "hands-free/thread-state", payload: { threadId: "th_1", state: "failed" } });
    await harness.lifecycle.dispose();
  });

  it("sends reviewed text only as a new turn and refuses empty/oversized text", async () => {
    const send = vi.fn(async () => ({ status: "active" }));
    const { bb, harness } = createFakePluginHost({ pluginId: "hands-free", sdk: { threads: { send } } });
    plugin(bb);
    await expect(harness.behavior.callRpc("send", { threadId: "th_1", text: "  Hello  " })).resolves.toEqual({ accepted: true });
    expect(send).toHaveBeenCalledWith({ threadId: "th_1", mode: "start", input: [{ type: "text", text: "Hello", mentions: [] }] });
    await expect(harness.behavior.callRpc("send", { threadId: "th_1", text: "   " })).rejects.toThrow();
    await expect(harness.behavior.callRpc("send", { threadId: "th_1", text: "x".repeat(12001) })).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    await harness.lifecycle.dispose();
  });
});
