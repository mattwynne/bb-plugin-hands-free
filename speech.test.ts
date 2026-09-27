import { describe, expect, it, vi } from "vitest";
import { MAX_AUDIO_BYTES, DEFAULT_VOICE_ID, readBounded, speechInput, synthesizeSpeech, voiceCatalog } from "./speech";

const input = { text: "hello", voiceId: "edge:en-US-AriaNeural", speed: 1 };
const signal = () => new AbortController().signal;
describe("speech engines", () => {
  it("lists only available Edge voices with Sonia as default", () => {
    const voices = voiceCatalog();
    expect(voices).toHaveLength(4);
    expect(voices.every(v => v.engine === "edge" && v.available)).toBe(true);
    expect(voices.some(v => v.id === DEFAULT_VOICE_ID)).toBe(true);
  });
  it("bounds input, rejects unknown fields and non-finite speeds", () => {
    for (const changes of [{ text: " " }, { text: "x".repeat(4097) }, { speed: 0.4 }, { speed: 2.1 }, { speed: NaN }, { extra: 1 }]) {
      expect(speechInput.safeParse({ ...input, ...changes }).success).toBe(false);
    }
    expect(speechInput.parse({ text: " hi ", voiceId: "edge:en-US-AriaNeural" }).speed).toBe(1);
  });
  it("rejects retired or invented voices before upstream work", async () => {
    const edge = vi.fn();
    for (const voiceId of ["device:default", "openai:coral", "edge:invented"]) {
      await expect(synthesizeSpeech({ ...input, voiceId }, signal(), { edge })).rejects.toMatchObject({ status: 400 });
    }
    expect(edge).not.toHaveBeenCalled();
  });
  it("synthesizes Edge with a bounded, cancellable request", async () => {
    const edge = vi.fn().mockResolvedValue(new Uint8Array([42]));
    expect(await synthesizeSpeech({ ...input, speed: 1.5 }, signal(), { edge })).toEqual(new Uint8Array([42]));
    expect(edge.mock.calls[0]![0]).toEqual({ text: "hello", voice: "en-US-AriaNeural", speed: 1.5, signal: expect.any(AbortSignal), maxBytes: MAX_AUDIO_BYTES });
  });
  it("sanitizes upstream transport errors", async () => {
    const edge = vi.fn().mockRejectedValue(new Error("private upstream text"));
    await expect(synthesizeSpeech(input, signal(), { edge })).rejects.toMatchObject({ code: "upstream" });
  });
  it("bounds output and cancels its source", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(5)); }, cancel });
    await expect(readBounded(stream, 4)).rejects.toMatchObject({ code: "too_large" });
    expect(cancel).toHaveBeenCalled();
  });
  it("rejects empty or oversized audio", async () => {
    for (const bytes of [new Uint8Array(), new Uint8Array(MAX_AUDIO_BYTES + 1)]) {
      await expect(synthesizeSpeech(input, signal(), { edge: vi.fn().mockResolvedValue(bytes) })).rejects.toMatchObject({ code: "invalid_audio" });
    }
  });
  it("aborts hanging Edge synthesis on timeout", async () => {
    const edge = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<Uint8Array>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    await expect(synthesizeSpeech(input, signal(), { edge, timeoutMs: 10 })).rejects.toMatchObject({ code: "timeout", status: 504 });
    expect(edge.mock.calls[0]![0].signal.aborted).toBe(true);
  });
  it("honors already aborted caller without upstream work", async () => {
    const edge = vi.fn();
    await expect(synthesizeSpeech(input, AbortSignal.abort(), { edge })).rejects.toMatchObject({ code: "aborted" });
    expect(edge).not.toHaveBeenCalled();
  });
});
