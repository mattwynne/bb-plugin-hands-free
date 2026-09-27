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
  id: string; name: string; engine: "edge"; language: string;
  available: boolean; unavailableReason?: string;
}
export { DEFAULT_VOICE_ID } from "./voice-default";
const EDGE_VOICES = ["en-US-AriaNeural", "en-US-GuyNeural", "en-GB-SoniaNeural", "en-GB-RyanNeural"];
export function voiceCatalog(): Voice[] {
  return EDGE_VOICES.map((name): Voice => ({ id: `edge:${name}`, name, engine: "edge", language: name.slice(0, 5), available: true }));
}
export class SpeechError extends Error {
  constructor(public code: string, message: string, public status: 400 | 429 | 502 | 504 = 502) { super(message); }
}
export function validateVoice(input: SpeechInput): Voice {
  const voice = voiceCatalog().find(v => v.id === input.voiceId);
  if (!voice) throw new SpeechError("invalid_voice", "Unknown voice.", 400);
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
  edge?: typeof synthesizeEdge;
  timeoutMs?: number;
}
/** No upstream response text/errors are exposed: they can contain credentials or input. */
export async function synthesizeSpeech(input: SpeechInput, signal: AbortSignal, dependencies: SpeechDependencies = {}): Promise<Uint8Array> {
  validateVoice(input);
  const timeout = new AbortController();
  const combined = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(), dependencies.timeoutMs ?? SYNTHESIS_TIMEOUT_MS);
  try {
    combined.throwIfAborted();
    const audio = await (dependencies.edge ?? synthesizeEdge)({ text: input.text, voice: input.voiceId.slice(5), speed: input.speed, signal: combined, maxBytes: MAX_AUDIO_BYTES });
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
