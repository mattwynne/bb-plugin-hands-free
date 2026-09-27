import { describe, expect, it, vi } from "vitest";
import { MAX_AUDIO_BYTES, MISSING_KEY_REASON, readBounded, speechInput, synthesizeSpeech, voiceCatalog } from "./speech";

const input = { text: "hello", voiceId: "openai:coral", speed: 1 };
const signal = () => new AbortController().signal;
describe("speech engines", () => {
  it("includes disabled OpenAI voices without network or credentials", () => {
    const voices = voiceCatalog(false);
    expect(voices.filter(v => v.engine === "edge")).toHaveLength(4);
    expect(voices.filter(v => v.engine === "openai")).toHaveLength(13);
    expect(voices.find(v => v.id === "openai:marin")).toMatchObject({ available: false, unavailableReason: MISSING_KEY_REASON });
    expect(voiceCatalog(true).every(v => v.available && !v.unavailableReason)).toBe(true);
  });
  it("bounds input, rejects unknown fields and non-finite speeds", () => {
    for (const changes of [{ text: " " }, { text: "x".repeat(4097) }, { speed: 0.4 }, { speed: 2.1 }, { speed: NaN }, { extra: 1 }]) {
      expect(speechInput.safeParse({ ...input, ...changes }).success).toBe(false);
    }
    expect(speechInput.parse({ text: " hi ", voiceId: "edge:en-US-AriaNeural" }).speed).toBe(1);
  });
  it("uses documented OpenAI endpoint/model/format and passes abort signal", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    expect(await synthesizeSpeech(input, "test-key", signal(), { fetch: fetcher })).toEqual(new Uint8Array([1, 2, 3]));
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(options).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer test-key" } });
    expect(options!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options!.body as string)).toEqual({ input: "hello", model: "gpt-4o-mini-tts", voice: "coral", speed: 1, response_format: "mp3" });
  });
  it("does not send unavailable or invented voices upstream", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(synthesizeSpeech(input, undefined, signal(), { fetch: fetcher })).rejects.toMatchObject({ status: 409 });
    await expect(synthesizeSpeech({ ...input, voiceId: "openai:evil" }, "key", signal(), { fetch: fetcher })).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses Edge without passing an OpenAI key", async () => {
    const edge = vi.fn().mockResolvedValue(new Uint8Array([42]));
    await synthesizeSpeech({ ...input, voiceId: "edge:en-US-AriaNeural", speed: 1.5 }, "secret", signal(), { edge });
    expect(edge.mock.calls[0]![0]).toEqual({ text: "hello", voice: "en-US-AriaNeural", speed: 1.5, signal: expect.any(AbortSignal), maxBytes: MAX_AUDIO_BYTES });
  });
  it("sanitizes upstream response and transport errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("secret key and private input", { status: 401 })).mockRejectedValueOnce(new Error("secret key"));
    for (let i = 0; i < 2; i++) {
      try { await synthesizeSpeech(input, "key", signal(), { fetch: fetcher }); throw new Error("expected failure"); }
      catch (error) { expect(String(error)).not.toMatch(/secret key|private input/); expect(error).toMatchObject({ code: "upstream" }); }
    }
  });
  it("bounds output and cancels its source", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(5)); }, cancel });
    await expect(readBounded(stream, 4)).rejects.toMatchObject({ code: "too_large" });
    expect(cancel).toHaveBeenCalled();
  });
  it("rejects empty audio", async () => {
    await expect(synthesizeSpeech(input, "key", signal(), { fetch: vi.fn().mockResolvedValue(new Response(new Uint8Array())) })).rejects.toMatchObject({ code: "invalid_audio" });
  });
  it("aborts hanging response reads on timeout", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    await expect(synthesizeSpeech(input, "key", signal(), { fetch: fetcher, timeoutMs: 10 })).rejects.toMatchObject({ code: "timeout", status: 504 });
    expect(cancel).toHaveBeenCalled();
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
  it("honors already aborted caller without network work", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(synthesizeSpeech(input, "key", AbortSignal.abort(), { fetch: fetcher })).rejects.toMatchObject({ code: "aborted" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
