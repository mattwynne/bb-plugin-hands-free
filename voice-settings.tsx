import { useCallback, useEffect, useRef, useState } from "react";
import { listVoices, prepareSpeech, releaseSpeech, type CloudVoice } from "./voice-client";
export const VOICE_STORAGE = "hands-free.voice.v1";
export interface VoiceChoice extends Omit<CloudVoice, "engine"> { engine: "device" | CloudVoice["engine"]; deviceVoice?: SpeechSynthesisVoice }
export function readVoiceSettings(): { voiceId: string; speed: number } {
  try {
    const value = JSON.parse(localStorage.getItem(VOICE_STORAGE) || "{}");
    return { voiceId: typeof value.voiceId === "string" && value.voiceId.length < 1000 ? value.voiceId : "device:default",
      speed: typeof value.speed === "number" && value.speed >= .5 && value.speed <= 2 ? value.speed : 1 };
  } catch { return { voiceId: "device:default", speed: 1 }; }
}
export function useVoiceSettings() {
  const [settings, setSettings] = useState(readVoiceSettings);
  const [devices, setDevices] = useState<VoiceChoice[]>([]);
  const [cloud, setCloud] = useState<CloudVoice[]>([]);
  const [catalogNotice, setCatalogNotice] = useState("");
  useEffect(() => {
    const synth = window.speechSynthesis;
    const update = () => setDevices((synth?.getVoices?.() ?? []).map(v => ({ id: `device:${v.voiceURI}`, name: v.name, engine: "device", language: v.lang, available: true, deviceVoice: v })));
    update();
    synth?.addEventListener?.("voiceschanged", update);
    const controller = new AbortController();
    void listVoices(controller.signal).then(v => { if (!controller.signal.aborted) setCloud(v); }, e => {
      if (!controller.signal.aborted) setCatalogNotice(e instanceof Error ? e.message : "Cloud voices unavailable");
    });
    return () => { controller.abort(); synth?.removeEventListener?.("voiceschanged", update); };
  }, []);
  useEffect(() => {
    const update = () => setSettings(readVoiceSettings());
    window.addEventListener("storage", update);
    window.addEventListener(VOICE_STORAGE, update);
    return () => { window.removeEventListener("storage", update); window.removeEventListener(VOICE_STORAGE, update); };
  }, []);
  const save = (next: typeof settings) => {
    setSettings(next);
    try { localStorage.setItem(VOICE_STORAGE, JSON.stringify(next)); window.dispatchEvent(new Event(VOICE_STORAGE)); } catch { /* Private browsing may disable storage. */ }
  };
  const deviceAvailable = !!window.speechSynthesis && typeof SpeechSynthesisUtterance !== "undefined";
  const voices: VoiceChoice[] = [{ id: "device:default", name: "System default", engine: "device", language: "", available: deviceAvailable,
    unavailableReason: deviceAvailable ? undefined : "Speech synthesis is not supported on this device" }, ...devices, ...cloud];
  if (!voices.some(v => v.id === settings.voiceId)) voices.push({ id: settings.voiceId, name: settings.voiceId.replace(/^(device|edge|openai):/, ""),
    engine: settings.voiceId.startsWith("openai:") ? "openai" : settings.voiceId.startsWith("edge:") ? "edge" : "device", language: "", available: false,
    unavailableReason: "Saved voice is not available on this device or in the current catalog" });
  return { ...settings, voices, catalogNotice, selectedVoice: voices.find(v => v.id === settings.voiceId)!,
    setVoiceId: (voiceId: string) => save({ ...settings, voiceId }),
    setSpeed: (speed: number) => save({ ...settings, speed }) };
}
export function voiceLabel(voice: VoiceChoice) {
  return `${voice.name} — ${voice.engine === "device" ? "Device" : voice.engine === "edge" ? "Edge neural" : "OpenAI"}${voice.language ? ` · ${voice.language}` : ""}`;
}
export function VoiceSettings({ voice, onPreview, onStop, speaking, disabled }: {
  voice: ReturnType<typeof useVoiceSettings>; onPreview(): void; onStop(): void; speaking: boolean; disabled: boolean;
}) {
  return <section aria-label="Voice settings" className="rounded-lg border border-border p-3">
    <div className="mt-3 flex flex-col gap-3">
      <label>Voice<select aria-label="Voice" className="block w-full rounded border border-border bg-background p-2" value={voice.voiceId}
        onChange={e => { onStop(); voice.setVoiceId(e.target.value); }}>
        {voice.voices.map(v => <option key={v.id} value={v.id} disabled={!v.available}>{voiceLabel(v)}{!v.available ? ` — Unavailable: ${v.unavailableReason || "Provider unavailable"}` : ""}</option>)}
      </select></label>
      {!voice.selectedVoice.available && <p>{voice.selectedVoice.unavailableReason}. Choose an available Device voice for device fallback; your saved selection has not been changed.</p>}
      {voice.catalogNotice && <p>{voice.catalogNotice}</p>}
      <label>Speaking speed: {voice.speed}×<input aria-label="Speaking speed" className="block w-full" type="range" min="0.5" max="2" step="0.1" value={voice.speed}
        onChange={e => { onStop(); voice.setSpeed(Number(e.target.value)); }} /></label>
      <button type="button" disabled={!speaking && (disabled || !voice.selectedVoice.available)} onClick={speaking ? onStop : onPreview}>{speaking ? "Stop preview / audio" : "Preview voice"}</button>
      <p className="text-xs text-muted-foreground">Voices are AI-generated, not human speakers. Device voices depend on this browser. Cloud credentials stay on the server. Inspired by <a href="https://github.com/csells/bb-plugins/tree/HEAD/plugins/read-aloud" target="_blank" rel="noreferrer">Read Aloud</a>.</p>
    </div>
  </section>;
}

export function VoiceSettingsPage() {
  const voice = useVoiceSettings();
  const [speaking, setSpeaking] = useState(false);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const audioId = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = useCallback(() => {
    generation.current++;
    request.current?.abort(); request.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (player.current) { player.current.onended = player.current.onerror = null; player.current.pause(); player.current.removeAttribute("src"); player.current.load(); player.current = null; }
    if (utterance.current) { utterance.current.onend = utterance.current.onerror = null; utterance.current = null; window.speechSynthesis?.cancel(); }
    if (audioId.current) releaseSpeech(audioId.current);
    audioId.current = null;
    setSpeaking(false);
  }, []);
  useEffect(() => stop, [stop]);
  const preview = async () => {
    stop();
    if (!voice.selectedVoice.available) return;
    const mine = generation.current;
    const text = "Hello! This is your Hands-Free voice. I am ready when you are.";
    const finish = (failed = false) => {
      if (mine !== generation.current) return;
      stop(); setNotice(failed ? "Preview failed. Choose another voice; no device fallback was used." : "Preview finished.");
    };
    setSpeaking(true); setNotice(`Previewing ${voiceLabel(voice.selectedVoice)}…`);
    // Bound cleanup even in WebViews that omit terminal media events.
    timer.current = setTimeout(() => finish(true), 45000);
    try {
      if (voice.selectedVoice.engine === "device") {
        const speech = new SpeechSynthesisUtterance(text);
        utterance.current = speech;
        speech.voice = voice.selectedVoice.deviceVoice ?? null;
        speech.lang = voice.selectedVoice.language || navigator.language;
        speech.rate = voice.speed;
        speech.onend = () => finish(); speech.onerror = () => finish(true);
        window.speechSynthesis.speak(speech);
      } else {
        const controller = new AbortController(); request.current = controller;
        const data = await prepareSpeech(text, voice.voiceId, voice.speed, controller.signal);
        if (mine !== generation.current) { releaseSpeech(data.audioId); return; }
        audioId.current = data.audioId;
        const audio = new Audio(data.url); player.current = audio;
        audio.onended = () => finish(); audio.onerror = () => finish(true);
        await audio.play();
      }
    } catch (error) {
      if (mine !== generation.current) return;
      stop(); setNotice(`${error instanceof Error ? error.message : "Preview failed"}. No device fallback was used.`);
    }
  };
  return <><VoiceSettings voice={voice} speaking={speaking} disabled={false} onStop={stop} onPreview={() => void preview()} />
    <p className="text-sm text-muted-foreground">Voice and speed are saved for this browser and used for replies and previews.</p>
    {notice && <p role="status">{notice}</p>}</>;
}
