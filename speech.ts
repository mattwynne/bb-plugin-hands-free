import { z } from "zod";
import { synthesizeEdge } from "./speech-edge";

export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const SYNTHESIS_TIMEOUT_MS = 60_000;
export const speechInput = z.object({
  text: z.string().trim().min(1).max(4096),
  voiceId: z.string().max(100),
  speed: z.number().min(0.5).max(2).default(1),
}).strict();
export type SpeechInput = z.infer<typeof speechInput>;
export interface Voice {
  id: string; name: string; engine: "edge" | "openai"; language: string;
  available: boolean; unavailableReason?: string;
}
export const MISSING_KEY_REASON = "Add an OpenAI API key in Hands-Free plugin settings. BB does not expose configured credentials or TTS through the public SDK.";
const EDGE_VOICES = ["en-US-AriaNeural", "en-US-GuyNeural", "en-GB-SoniaNeural", "en-GB-RyanNeural"];
const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];
export function voiceCatalog(hasOpenAIKey: boolean): Voice[] {
  return [
    ...EDGE_VOICES.map((name): Voice => ({ id: `edge:${name}`, name, engine: "edge", language: name.slice(0, 5), available: true })),
    ...OPENAI_VOICES.map((name): Voice => ({ id: `openai:${name}`, name: name[0]!.toUpperCase() + name.slice(1), engine: "openai", language: "multilingual", available: hasOpenAIKey, ...(!hasOpenAIKey ? { unavailableReason: MISSING_KEY_REASON } : {}) })),
  ];
}
export class SpeechError extends Error {
  constructor(public code: string, message: string, public status: 400 | 409 | 429 | 502 | 504 = 502) { super(message); }
}
export function validateVoice(input: SpeechInput, key?: string): Voice {
  const voice = voiceCatalog(Boolean(key?.trim())).find(v => v.id === input.voiceId);
  if (!voice) throw new SpeechError("invalid_voice", "Unknown voice.", 400);
  if (!voice.available) throw new SpeechError("unavailable", MISSING_KEY_REASON, 409);
  return voice;
}

/** Read untrusted streaming data without allowing an unbounded arrayBuffer(). */
export async function readBounded(body: ReadableStream<Uint8Array>, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  const reader = body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal?.aborted) throw new Error("aborted");
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Error("aborted");
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new SpeechError("too_large", "Speech response exceeded the size limit.");
      chunks.push(value);
    }
    const output = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { output.set(chunk, at); at += chunk.byteLength; }
    return output;
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export interface SpeechDependencies {
  fetch?: typeof fetch;
  edge?: typeof synthesizeEdge;
  timeoutMs?: number;
}
/** No upstream response text/errors are exposed: they can contain credentials or input. */
export async function synthesizeSpeech(input: SpeechInput, key: string | undefined, signal: AbortSignal, dependencies: SpeechDependencies = {}): Promise<Uint8Array> {
  const voice = validateVoice(input, key);
  const timeout = new AbortController();
  const combined = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(), dependencies.timeoutMs ?? SYNTHESIS_TIMEOUT_MS);
  try {
    combined.throwIfAborted();
    let audio: Uint8Array;
    if (voice.engine === "edge") {
      audio = await (dependencies.edge ?? synthesizeEdge)({ text: input.text, voice: input.voiceId.slice(5), speed: input.speed, signal: combined, maxBytes: MAX_AUDIO_BYTES });
    } else {
      const response = await (dependencies.fetch ?? fetch)("https://api.openai.com/v1/audio/speech", {
        method: "POST", redirect: "error", signal: combined,
        headers: { "Authorization": `Bearer ${key!.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: input.voiceId.slice(7), input: input.text, speed: input.speed, response_format: "mp3" }),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new SpeechError("upstream", "OpenAI speech failed. Check the API key, billing and service availability.");
      }
      audio = await readBounded(response.body, MAX_AUDIO_BYTES, combined);
    }
    combined.throwIfAborted();
    if (audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_BYTES) throw new SpeechError("invalid_audio", "Speech service returned invalid audio.");
    return audio;
  } catch (error) {
    if (timeout.signal.aborted) throw new SpeechError("timeout", "Speech synthesis timed out. Try shorter text.", 504);
    if (signal.aborted) throw new SpeechError("aborted", "Speech synthesis cancelled.", 400);
    if (error instanceof SpeechError) throw error;
    throw new SpeechError("upstream", "Speech synthesis failed. Try again or choose another voice.");
  } finally { clearTimeout(timer); }
}
