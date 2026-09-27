import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerSpeechHttp } from "./speech-http";
import { type SpeechInput } from "./speech";
import plugin from "./server";

const request = (body: unknown = { text: "Hello", voiceId: "edge:en-US-AriaNeural" }): RequestInit => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
function setup(synthesize = vi.fn(async (_input: SpeechInput, _key: string | undefined, _signal: AbortSignal) => new Uint8Array([1, 2, 3]))) {
  const host = createFakePluginHost({ pluginId: "hands-free" }); hosts.push(host);
  const controls = registerSpeechHttp(host.bb, async () => undefined, synthesize);
  return { ...host, synthesize, controls, fetch: host.harness.behavior.fetchHttp };
}
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); vi.useRealTimers(); });

describe("speech HTTP", () => {
  it("registers local-auth routes and keeps optional OpenAI secret server-side", async () => {
    const host = createFakePluginHost({ pluginId: "hands-free" }); hosts.push(host);
    plugin(host.bb);
    expect(host.harness.registrations.httpRoutes).toHaveLength(4);
    for (const route of host.harness.registrations.httpRoutes) expect(route.auth).toBe("local");
    expect(host.harness.registrations.settingsDescriptors.openaiApiKey).toMatchObject({ secret: true, type: "string" });
    let res = await host.harness.behavior.fetchHttp("GET", "/voices");
    expect(res.headers.get("cache-control")).toBe("no-store");
    let body = await res.json();
    expect(body.voices.find((v: any) => v.id === "openai:coral").available).toBe(false);
    await host.harness.behavior.setSettings({ openaiApiKey: "TEST_ONLY_NOT_A_REAL_KEY" });
    res = await host.harness.behavior.fetchHttp("GET", "/voices");
    body = await res.json();
    expect(body.voices.find((v: any) => v.id === "openai:coral").available).toBe(true);
    expect(JSON.stringify(body)).not.toContain("TEST_ONLY_NOT_A_REAL_KEY");
  });
  it("prepares, retrieves reusable MP3, deletes and expires bounded audio", async () => {
    vi.useFakeTimers();
    const { fetch, synthesize } = setup();
    const res = await fetch("POST", "/speech/prepare", request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ audioId: expect.any(String), url: `/api/v1/plugins/hands-free/http/speech/audio?id=${body.audioId}`, expiresAt: Date.now() + 120000 });
    expect(synthesize.mock.calls[0]![0]).toMatchObject({ speed: 1 });
    for (let i = 0; i < 2; i++) {
      const audio = await fetch("GET", `/speech/audio?id=${body.audioId}`);
      expect(audio.headers.get("content-type")).toBe("audio/mpeg");
      expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    }
    await fetch("DELETE", `/speech/audio?id=${body.audioId}`, { headers: { "content-type": "application/json" } });
    expect((await fetch("GET", `/speech/audio?id=${body.audioId}`)).status).toBe(404);
    const another = await (await fetch("POST", "/speech/prepare", request())).json();
    await vi.advanceTimersByTimeAsync(120000);
    expect((await fetch("GET", `/speech/audio?id=${another.audioId}`)).status).toBe(404);
  });
  it("validates body size, voice, credentials and speed before synthesis", async () => {
    const { fetch, synthesize } = setup();
    for (const body of [null, {}, { text: " ", voiceId: "edge:en-US-AriaNeural" }, { text: "x".repeat(4097), voiceId: "edge:en-US-AriaNeural" }, { text: "x", voiceId: "unknown" }, { text: "x", voiceId: "edge:en-US-AriaNeural", speed: 4 }, { text: "x".repeat(40000) }]) {
      expect((await fetch("POST", "/speech/prepare", request(body))).status).toBe(400);
    }
    expect((await fetch("POST", "/speech/prepare", request({ text: "x", voiceId: "openai:coral" }))).status).toBe(409);
    expect((await fetch("POST", "/speech/prepare", { body: "{}" })).status).toBe(400);
    expect(synthesize).not.toHaveBeenCalled();
  });
  it("caps retained jobs without evicting an active player", async () => {
    const { fetch } = setup();
    for (let i = 0; i < 8; i++) expect((await fetch("POST", "/speech/prepare", request())).status).toBe(200);
    expect((await fetch("POST", "/speech/prepare", request())).status).toBe(429);
  });
  it("caps concurrent synthesis and aborts work on disposal", async () => {
    const synthesize = vi.fn((_input: SpeechInput, _key: string | undefined, signal: AbortSignal) => new Promise<Uint8Array>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("private upstream text")), { once: true })));
    const { fetch, harness } = setup(synthesize);
    const first = fetch("POST", "/speech/prepare", request());
    const second = fetch("POST", "/speech/prepare", request());
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2));
    expect((await fetch("POST", "/speech/prepare", request())).status).toBe(429);
    await harness.lifecycle.dispose();
    for (const pending of [first, second]) {
      const res = await pending;
      expect(await res.text()).not.toContain("private upstream text");
    }
    expect(synthesize.mock.calls.every(call => call[2].aborted)).toBe(true);
  });
  it("clears cached audio and pending work when settings change", async () => {
    const { fetch, controls } = setup();
    const { audioId } = await (await fetch("POST", "/speech/prepare", request())).json();
    controls.clear();
    expect((await fetch("GET", `/speech/audio?id=${audioId}`)).status).toBe(404);
  });
  it("propagates request cancellation", async () => {
    const synthesize = vi.fn((_input: SpeechInput, _key: string | undefined, signal: AbortSignal) => new Promise<Uint8Array>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    const { fetch } = setup(synthesize);
    const controller = new AbortController();
    const pending = fetch("POST", "/speech/prepare", { ...request(), signal: controller.signal });
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledOnce());
    controller.abort();
    await pending;
    expect(synthesize.mock.calls[0]![2].aborted).toBe(true);
  });
});
