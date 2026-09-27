import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_VOICE_ID } from "./voice-default";
import { listVoices, prepareSpeech, releaseSpeech, type CloudVoice } from "./voice-client";
export const VOICE_STORAGE = "hands-free.voice.v1";
export type VoiceChoice = CloudVoice;
export function readVoiceSettings(): { voiceId: string; speed: number } {
  try {
    const value = JSON.parse(localStorage.getItem(VOICE_STORAGE) || "{}");
    // Migrate retired device/OpenAI selections without losing speaking speed.
    return { voiceId: typeof value.voiceId === "string" && value.voiceId.startsWith("edge:") && value.voiceId.length < 100
      ? value.voiceId : DEFAULT_VOICE_ID,
      speed: typeof value.speed === "number" && value.speed >= .5 && value.speed <= 2 ? value.speed : 1 };
  } catch { return { voiceId: DEFAULT_VOICE_ID, speed: 1 }; }
}
export function useVoiceSettings() {
  const [settings, setSettings] = useState(readVoiceSettings);
  const [cloud, setCloud] = useState<CloudVoice[]>([]);
  const [catalogNotice, setCatalogNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void listVoices(controller.signal).then(v => { if (!controller.signal.aborted) setCloud(v); }, e => {
      if (!controller.signal.aborted) setCatalogNotice(e instanceof Error ? e.message : "Cloud voices unavailable");
    });
    return () => { controller.abort(); };
  }, []);
  useEffect(() => {
    // Persist migration so other tabs and future versions see the Edge choice.
    const migrate = () => {
      try {
        const saved = JSON.parse(localStorage.getItem(VOICE_STORAGE) || "{}");
        if (typeof saved.voiceId === "string" && !saved.voiceId.startsWith("edge:")) {
          localStorage.setItem(VOICE_STORAGE, JSON.stringify(readVoiceSettings()));
        }
      } catch { /* Storage may be unavailable. */ }
    };
    migrate();
    const update = () => { migrate(); setSettings(readVoiceSettings()); };
    window.addEventListener("storage", update);
    window.addEventListener(VOICE_STORAGE, update);
    return () => { window.removeEventListener("storage", update); window.removeEventListener(VOICE_STORAGE, update); };
  }, []);
  const save = (next: typeof settings) => {
    setSettings(next);
    try { localStorage.setItem(VOICE_STORAGE, JSON.stringify(next)); window.dispatchEvent(new Event(VOICE_STORAGE)); } catch { /* Private browsing may disable storage. */ }
  };
  const voices: VoiceChoice[] = [...cloud];
  if (!voices.some(v => v.id === settings.voiceId)) voices.push({ id: settings.voiceId, name: settings.voiceId.replace(/^edge:/, ""),
    engine: "edge", language: "", available: false,
    unavailableReason: "Saved voice is not available in the current catalog" });
  return { ...settings, voices, catalogNotice, selectedVoice: voices.find(v => v.id === settings.voiceId)!,
    setVoiceId: (voiceId: string) => save({ ...settings, voiceId }),
    setSpeed: (speed: number) => save({ ...settings, speed }) };
}
export function voiceLabel(voice: VoiceChoice) {
  return `${voice.name} — Edge neural${voice.language ? ` · ${voice.language}` : ""}`;
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
      {!voice.selectedVoice.available && <p>{voice.selectedVoice.unavailableReason}. Choose an available Edge voice.</p>}
      {voice.catalogNotice && <p>{voice.catalogNotice}</p>}
      <label>Speaking speed: {voice.speed}×<input aria-label="Speaking speed" className="block w-full" type="range" min="0.5" max="2" step="0.1" value={voice.speed}
        onChange={e => { onStop(); voice.setSpeed(Number(e.target.value)); }} /></label>
      <button type="button" disabled={!speaking && (disabled || !voice.selectedVoice.available)} onClick={speaking ? onStop : onPreview}>{speaking ? "Stop preview / audio" : "Preview voice"}</button>
      <p className="text-xs text-muted-foreground">Voices are AI-generated, not human speakers. Edge synthesis sends text to Microsoft. Inspired by <a href="https://github.com/csells/bb-plugins/tree/HEAD/plugins/read-aloud" target="_blank" rel="noreferrer">Read Aloud</a>.</p>
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
  const audioId = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = useCallback(() => {
    generation.current++;
    request.current?.abort(); request.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (player.current) { player.current.onended = player.current.onerror = null; player.current.pause(); player.current.removeAttribute("src"); player.current.load(); player.current = null; }
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
      stop(); setNotice(failed ? "Preview failed. Choose another voice." : "Preview finished.");
    };
    setSpeaking(true); setNotice(`Previewing ${voiceLabel(voice.selectedVoice)}…`);
    // Bound cleanup even in WebViews that omit terminal media events.
    timer.current = setTimeout(() => finish(true), 45000);
    try {
      const controller = new AbortController(); request.current = controller;
      const data = await prepareSpeech(text, voice.voiceId, voice.speed, controller.signal);
      if (mine !== generation.current) { releaseSpeech(data.audioId); return; }
      audioId.current = data.audioId;
      const audio = new Audio(data.url); player.current = audio;
      audio.onended = () => finish(); audio.onerror = () => finish(true);
      await audio.play();
    } catch (error) {
      if (mine !== generation.current) return;
      stop(); setNotice(`${error instanceof Error ? error.message : "Preview failed"}. Try again or choose another Edge voice.`);
    }
  };
  return <><VoiceSettings voice={voice} speaking={speaking} disabled={false} onStop={stop} onPreview={() => void preview()} />
    <p className="text-sm text-muted-foreground">Voice and speed are saved for this browser and used for replies and previews.</p>
    {notice && <p role="status">{notice}</p>}</>;
}
