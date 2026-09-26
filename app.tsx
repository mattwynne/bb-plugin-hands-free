import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, experimental_useSidebarThreads, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { mountThreadMenuLink } from "./menu-link";

// Web Speech is not part of every iOS WebView. Keep the keyboard-dictation
// path usable when SpeechRecognition is absent or permission is denied.
interface RecognitionResult { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEvent { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface Recognition {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecognitionConstructor = new () => Recognition;
function recognitionConstructor(): RecognitionConstructor | undefined {
  const browser = window as Window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

const READ_ALOUD = "/api/v1/plugins/read-aloud/http";
const MAX_SPEAK = 12000;
function VoicePage({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { threads, status: threadsStatus } = experimental_useSidebarThreads();
  let selectedId = "";
  try { selectedId = decodeURIComponent(subPath.split("/")[0] ?? ""); } catch { /* Invalid URL: leave selection empty. */ }
  const selected = threads.find((thread) => thread.id === selectedId);
  const [draft, setDraft] = useState("");
  const [latest, setLatest] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [autoRead, setAutoRead] = useState(false);
  const [notice, setNotice] = useState("");
  const recognition = useRef<Recognition | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recordingStream = useRef<MediaStream | null>(null);
  const recordingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const sequence = useRef(0);
  const captureGeneration = useRef(0);
  const baseDraft = useRef("");
  const speakingRef = useRef(false);
  const autoReadRef = useRef(false);
  autoReadRef.current = autoRead;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const stopAudio = useCallback(() => {
    sequence.current += 1;
    if (audio.current) {
      audio.current.pause();
      audio.current.removeAttribute("src");
      audio.current.load();
      audio.current = null;
    }
    window.speechSynthesis?.cancel();
    speakingRef.current = false;
    setSpeaking(false);
  }, []);

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) { setNotice("No reply to read yet."); return; }
    if (text.length > MAX_SPEAK) {
      setNotice("This reply is too long for the voice view. Open the thread to review it.");
      return;
    }
    stopAudio();
    const mine = sequence.current;
    speakingRef.current = true;
    setSpeaking(true);
    setNotice("Preparing audio…");
    try {
      // Reuse the installed Read Aloud plugin's neural voice if available.
      const prepared = await fetch(`${READ_ALOUD}/prepare`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!prepared.ok) throw new Error(`Read Aloud unavailable (${prepared.status})`);
      const data: unknown = await prepared.json();
      if (!data || typeof data !== "object" || !("id" in data) || typeof data.id !== "string") {
        throw new Error("Invalid audio response");
      }
      if (mine !== sequence.current) return;
      const player = new Audio(`${READ_ALOUD}/stream?id=${encodeURIComponent(data.id)}`);
      audio.current = player;
      player.onended = () => { if (mine === sequence.current) stopAudio(); };
      player.onerror = () => { if (mine === sequence.current) { stopAudio(); setNotice("Audio interrupted. Tap Read reply to try again."); } };
      await player.play();
      if (mine === sequence.current) setNotice("Reading aloud. Tap Stop audio at any time.");
    } catch {
      if (mine !== sequence.current) return;
      // No network/service or audio autoplay denied: browser TTS may work in a
      // WebView, but is also optional. Do not claim success if neither does.
      if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") {
        stopAudio(); setNotice("Speech playback is unavailable. Install Read Aloud or review the reply on screen.");
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = navigator.language || "en-US";
      utterance.onend = () => { if (mine === sequence.current) stopAudio(); };
      utterance.onerror = () => { if (mine === sequence.current) { stopAudio(); setNotice("Speech playback failed. Read the reply on screen."); } };
      window.speechSynthesis.speak(utterance);
      setNotice("Reading with device voice.");
    }
  }, [stopAudio]);

  useEffect(() => {
    captureGeneration.current += 1;
    recognition.current?.abort();
    recognition.current = null;
    if (recorder.current?.state === "recording") { recorder.current.onstop = null; recorder.current.stop(); }
    recorder.current = null;
    recordingStream.current?.getTracks().forEach((track) => track.stop());
    recordingStream.current = null;
    if (recordingTimer.current) clearTimeout(recordingTimer.current);
    setListening(false);
    setBusy(false);
    setDraft("");
    setLatest(null);
    setAutoRead(false);
    setNotice("");
    stopAudio();
    return () => {
      captureGeneration.current += 1;
      recognition.current?.abort(); recognition.current = null;
      if (recorder.current?.state === "recording") { recorder.current.onstop = null; recorder.current.stop(); }
      recordingStream.current?.getTracks().forEach((track) => track.stop());
      if (recordingTimer.current) clearTimeout(recordingTimer.current);
      stopAudio();
    };
  }, [selectedId, stopAudio]);

  const refresh = useCallback(async (read = false) => {
    if (!selectedId) return;
    try {
      const result = await rpc.call("latest", { threadId: selectedId });
      if (selectedRef.current !== selectedId) return;
      setLatest(result.text);
      if (read && result.text) await speak(result.text);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load reply.");
    }
  }, [rpc, selectedId, speak]);
  useEffect(() => { void refresh(); }, [refresh]);
  useRealtime("voice-drive/thread-idle", (payload) => {
    if (!payload || typeof payload !== "object" || !("threadId" in payload)) return;
    if (payload.threadId !== selectedRef.current) return;
    void refresh(autoReadRef.current);
  });

  const startBrowserRecognition = () => {
    const Constructor = recognitionConstructor();
    if (!Constructor) {
      setNotice("This iPhone view does not expose speech recognition. Tap the text box and use the iPhone keyboard microphone instead.");
      document.getElementById("voice-drive-draft")?.focus();
      return;
    }
    stopAudio();
    const instance = new Constructor();
    recognition.current = instance;
    baseDraft.current = draft.trim();
    instance.lang = navigator.language || "en-US";
    instance.interimResults = true;
    instance.continuous = false;
    instance.onresult = (event) => {
      const parts: string[] = [];
      for (let index = 0; index < event.results.length; index += 1) {
        parts.push(event.results[index]?.[0]?.transcript ?? "");
      }
      setDraft([baseDraft.current, parts.join(" ").trim()].filter(Boolean).join(" "));
    };
    instance.onerror = (event) => {
      setNotice(`Microphone unavailable (${event.error}). You can use the iPhone keyboard microphone in the text box.`);
    };
    instance.onend = () => {
      if (recognition.current === instance) recognition.current = null;
      setListening(false);
    };
    try {
      instance.start(); // Synchronous tap gesture, required by iOS permissions.
      setListening(true);
      setNotice("Listening. Tap the button again to finish, then review your words.");
    } catch {
      recognition.current = null;
      setNotice("Could not start the microphone. Use the iPhone keyboard microphone in the text box.");
    }
  };
  const startListening = async () => {
    stopAudio();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      startBrowserRecognition();
      return;
    }
    const owner = selectedId;
    const capture = ++captureGeneration.current;
    setBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (capture !== captureGeneration.current || selectedRef.current !== owner) { stream.getTracks().forEach((track) => track.stop()); return; }
      const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      const instance = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];
      recorder.current = instance;
      recordingStream.current = stream;
      baseDraft.current = draft.trim();
      instance.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      instance.onerror = () => {
        if (instance.state === "recording") instance.stop();
        setNotice("Recording failed. Use the iPhone keyboard microphone instead.");
      };
      instance.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        if (recordingTimer.current) clearTimeout(recordingTimer.current);
        recordingStream.current = null;
        recorder.current = null;
        setListening(false);
        if (capture !== captureGeneration.current || selectedRef.current !== owner) return;
        const blob = new Blob(chunks, { type: instance.mimeType || "audio/mp4" });
        if (!blob.size) { setNotice("No audio was recorded. Try again."); return; }
        setBusy(true);
        setNotice("Transcribing…");
        try {
          const form = new FormData();
          form.set("file", blob, instance.mimeType.includes("webm") ? "dictation.webm" : "dictation.mp4");
          const response = await fetch("/api/v1/system/voice-transcription", { method: "POST", body: form });
          if (!response.ok) throw new Error(`Transcription failed (${response.status})`);
          const data: unknown = await response.json();
          if (!data || typeof data !== "object" || !("text" in data) || typeof data.text !== "string") throw new Error("Invalid transcription response");
          if (capture !== captureGeneration.current || selectedRef.current !== owner) return;
          setDraft([baseDraft.current, data.text.trim()].filter(Boolean).join(" "));
          setNotice("Review the transcript, then tap Send this reply.");
        } catch (error) {
          setNotice(`${error instanceof Error ? error.message : "Transcription unavailable"}. Use the iPhone keyboard microphone instead. Check BB voice transcription settings.`);
        } finally { setBusy(false); }
      };
      instance.start();
      setBusy(false);
      setListening(true);
      setNotice("Recording. Tap Finish dictating; recording ends automatically after one minute.");
      recordingTimer.current = setTimeout(() => { if (instance.state === "recording") instance.stop(); }, 60000);
    } catch {
      if (capture === captureGeneration.current) {
        recordingStream.current?.getTracks().forEach((track) => track.stop());
        recordingStream.current = null;
        setNotice("Microphone permission or recording unavailable. Try the iPhone keyboard microphone.");
        document.getElementById("voice-drive-draft")?.focus();
      }
    } finally { if (capture === captureGeneration.current && !recorder.current) setBusy(false); }
  };
  const stopListening = () => {
    if (recorder.current?.state === "recording") recorder.current.stop();
    else recognition.current?.stop();
    setListening(false);
  };
  const send = async () => {
    if (busy || listening || !selectedId || !draft.trim()) return;
    setBusy(true);
    try {
      await rpc.call("send", { threadId: selectedId, text: draft.trim() });
      setDraft("");
      setNotice("Sent. Waiting for the agent; tap Read reply when it finishes.");
    } catch (error) {
      setNotice(error instanceof Error ? `Not sent: ${error.message}` : "Not sent. Try again.");
    } finally { setBusy(false); }
  };

  return (
    <main className="h-full min-h-0 overflow-y-auto px-4 py-5" aria-label="Voice Drive">
      <div className="mx-auto max-w-xl space-y-5 pb-12">
        <h1 className="text-2xl font-bold">Voice Drive</h1>
        <p className="text-sm text-muted-foreground">One tap to dictate. Review before sending. Never use this to approve permissions or review code while driving.</p>
        <label className="block text-base font-semibold" htmlFor="voice-drive-thread">Thread</label>
        <select id="voice-drive-thread" className="w-full min-h-14 rounded-xl border bg-background px-3 text-base" value={selectedId} onChange={(event) => navigate.toPluginPanel("drive", { subPath: encodeURIComponent(event.target.value) })}>
          <option value="">Choose a thread</option>
          {threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title || thread.titleFallback || thread.id}</option>)}
        </select>
        {threadsStatus === "error" && <p role="alert">Unable to load threads.</p>}
        {selectedId && !selected && threadsStatus !== "loading" && <p role="alert">Thread not in the current list. Select another thread.</p>}
        <button type="button" disabled={!selected || busy} onClick={listening ? stopListening : startListening}
          className="flex min-h-28 w-full items-center justify-center rounded-3xl bg-primary px-5 text-2xl font-bold text-primary-foreground shadow-lg disabled:opacity-40"
          aria-pressed={listening} aria-label={listening ? "Finish dictating" : "Start dictating"}>
          {listening ? "■  Finish dictating" : "🎙  Tap to talk"}
        </button>
        <label htmlFor="voice-drive-draft" className="block text-base font-semibold">Your reply — review before sending</label>
        <textarea id="voice-drive-draft" rows={5} maxLength={12000} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Dictate, or tap here and use the iPhone keyboard microphone" className="w-full rounded-xl border bg-background p-4 text-lg" />
        <div className="grid grid-cols-2 gap-3">
          <button type="button" disabled={!draft.trim()} onClick={() => void speak(draft)} className="min-h-16 rounded-xl border px-3 text-lg font-semibold disabled:opacity-40">Read my words</button>
          <button type="button" disabled={!selected || !draft.trim() || busy || listening} onClick={() => void send()} className="min-h-16 rounded-xl bg-primary px-3 text-lg font-bold text-primary-foreground disabled:opacity-40">{busy ? "Sending…" : "Send this reply"}</button>
        </div>
        <section className="space-y-3 rounded-xl border p-4" aria-label="Latest agent reply">
          <h2 className="text-lg font-bold">Latest agent reply</h2>
          <p className="max-h-44 overflow-y-auto whitespace-pre-wrap text-sm">{latest || "No reply yet."}</p>
          <div className="grid grid-cols-2 gap-3">
            <button type="button" disabled={!selected} onClick={() => void refresh(true)} className="min-h-16 rounded-xl bg-primary px-3 text-lg font-bold text-primary-foreground disabled:opacity-40">▶ Read reply</button>
            <button type="button" disabled={!speaking} onClick={stopAudio} className="min-h-16 rounded-xl border px-3 text-lg font-semibold disabled:opacity-40">■ Stop audio</button>
          </div>
          <label className="flex min-h-12 items-center gap-3 text-sm"><input type="checkbox" checked={autoRead} onChange={(event) => setAutoRead(event.target.checked)} className="size-6" /> Read new replies automatically while this page is open</label>
        </section>
        {notice && <p role="status" aria-live="polite" className="rounded-xl border p-3 text-sm">{notice}</p>}
        <p className="text-xs text-muted-foreground">Keep BB open and unlocked. iOS may pause audio or the microphone when the app is backgrounded. Read Aloud is optional; device speech is used if its service is unavailable. This is not CarPlay.</p>
      </div>
    </main>
  );
}

function OpenVoiceDrive({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  return <button type="button" aria-label="Open Voice Drive for this thread" title="Voice Drive" onClick={() => navigate.toPluginPanel("drive", { subPath: encodeURIComponent(threadId) })} className="rounded-md border px-2 text-sm font-bold">🎙 Voice</button>;
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "thread-actions-entry",
    mount: ({ signal }) => mountThreadMenuLink(signal),
  });
  app.slots.navPanel({ id: "drive", title: "Voice Drive", icon: "Mic", path: "drive", component: VoicePage });
  app.slots.experimental_threadHeaderAction({ id: "open-drive", title: "Voice Drive", component: OpenVoiceDrive });
});
