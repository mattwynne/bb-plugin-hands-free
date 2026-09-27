import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readBounded, speechInput, SpeechError, synthesizeSpeech, validateVoice, voiceCatalog } from "./speech";

const TTL_MS = 120_000;
const MAX_JOBS = 8;
const MAX_ACTIVE = 2;
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
interface AudioJob { audio: Uint8Array; expiresAt: number }
export function registerSpeechHttp(bb: BbPluginApi, getKey: () => Promise<string | undefined>, synthesize = synthesizeSpeech) {
  const jobs = new Map<string, AudioJob>();
  const active = new Set<AbortController>();
  let disposed = false;
  const sweep = () => { for (const [id, job] of jobs) if (job.expiresAt <= Date.now()) jobs.delete(id); };
  const timer = setInterval(sweep, 30_000);
  timer.unref();
  const clear = () => { jobs.clear(); for (const controller of active) controller.abort(); };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...HEADERS, "Content-Type": "application/json" } });

  bb.http.route("GET", "/voices", async () => json({ voices: voiceCatalog(Boolean((await getKey())?.trim())) }), { auth: "local" });
  bb.http.route("POST", "/speech/prepare", async context => {
    sweep();
    if (disposed || active.size >= MAX_ACTIVE || jobs.size + active.size >= MAX_JOBS) return json({ error: "Speech is busy. Try again shortly.", code: "busy" }, 429);
    const controller = new AbortController();
    active.add(controller);
    const request = context.req.raw;
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) controller.abort();
    const inputTimer = setTimeout(abort, 10_000);
    try {
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new SpeechError("invalid_input", "Expected application/json.", 400);
      if (!request.body) throw new SpeechError("invalid_input", "Expected a speech request.", 400);
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(await readBounded(request.body, 32_768, controller.signal))); }
      catch { throw new SpeechError("invalid_input", "Invalid or oversized speech request.", 400); }
      const parsed = speechInput.safeParse(body);
      if (!parsed.success) throw new SpeechError("invalid_input", "Expected text (1–4096 characters), voiceId, and speed (0.5–2).", 400);
      clearTimeout(inputTimer);
      const key = await getKey();
      validateVoice(parsed.data, key);
      const audio = await synthesize(parsed.data, key, controller.signal);
      if (controller.signal.aborted || disposed) throw new SpeechError("aborted", "Speech synthesis cancelled.", 400);
      const audioId = randomUUID();
      const expiresAt = Date.now() + TTL_MS;
      jobs.set(audioId, { audio, expiresAt });
      return json({ audioId, url: `/api/v1/plugins/${encodeURIComponent(bb.pluginId)}/http/speech/audio?id=${audioId}`, expiresAt });
    } catch (error) {
      const safe = error instanceof SpeechError ? error : new SpeechError("upstream", "Speech synthesis failed. Try again.");
      return json({ error: safe.message, code: safe.code }, safe.status);
    } finally {
      clearTimeout(inputTimer);
      request.signal.removeEventListener("abort", abort);
      active.delete(controller);
    }
  }, { auth: "local" });
  bb.http.route("GET", "/speech/audio", context => {
    sweep();
    const job = jobs.get(context.req.query("id") ?? "");
    if (!job) return json({ error: "Unknown or expired audio.", code: "not_found" }, 404);
    return new Response(job.audio as BodyInit, { headers: { ...HEADERS, "Content-Type": "audio/mpeg", "Content-Length": String(job.audio.byteLength) } });
  }, { auth: "local" });
  bb.http.route("DELETE", "/speech/audio", context => {
    jobs.delete(context.req.query("id") ?? "");
    return json({ deleted: true });
  }, { auth: "local" });
  bb.onDispose(() => { disposed = true; clearInterval(timer); clear(); });
  return { clear };
}
