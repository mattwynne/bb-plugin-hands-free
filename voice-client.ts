// Only same-origin plugin endpoints are used.
export const VOICE_API = "/api/v1/plugins/hands-free/http";
export interface CloudVoice {
  id: string; name: string; engine: "edge"; language: string;
  available: boolean; unavailableReason?: string;
}
export async function listVoices(signal: AbortSignal): Promise<CloudVoice[]> {
  const response = await fetch(`${VOICE_API}/voices`, { signal });
  if (!response.ok) throw new Error("Edge voice catalog unavailable.");
  const data = await response.json();
  if (!Array.isArray(data?.voices)) throw new Error("Invalid voice catalog");
  return data.voices.filter((v: CloudVoice) => v && typeof v.id === "string" && typeof v.name === "string" &&
    v.engine === "edge" && typeof v.language === "string" && typeof v.available === "boolean" &&
    (v.unavailableReason === undefined || typeof v.unavailableReason === "string"));
}
export async function prepareSpeech(text: string, voiceId: string, speed: number, signal: AbortSignal) {
  const response = await fetch(`${VOICE_API}/speech/prepare`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ text, voiceId, speed }),
  });
  if (!response.ok) throw new Error(`Selected voice unavailable (${response.status}). Try again or choose another Edge voice.`);
  const data = await response.json();
  if (typeof data?.audioId !== "string" || typeof data?.url !== "string" ||
      !data.url.startsWith(`${VOICE_API}/speech/`) || data.url.includes("..")) throw new Error("Invalid speech response");
  return { audioId: data.audioId as string, url: data.url as string };
}
export function releaseSpeech(id: string) {
  void fetch(`${VOICE_API}/speech/audio?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: { "Content-Type": "application/json" } }).catch(() => {});
}
