import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, experimental_useSidebarThreads, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { createVoiceCues, type VoiceCues } from "./voice-cues";

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
  const [fallbackText, setFallbackText] = useState("");
  const [showFallback, setShowFallback] = useState(false);
  const [retryText, setRetryText] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "thinking" | "attention">("loading");
  const [notice, setNotice] = useState("");
  const recognition = useRef<Recognition | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recordingStream = useRef<MediaStream | null>(null);
  const recordingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const playbackCleanupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechMonitor = useRef<ReturnType<typeof setInterval> | null>(null);
  const sequence = useRef(0);
  const captureGeneration = useRef(0);
  const sending = useRef(false);
  const active = useRef(false);
  const lastSpoken = useRef<string | null>(null);
  const cues = useRef<VoiceCues | null>(null);
  const phaseRef = useRef<typeof phase>("loading");
  const phaseToken = useRef(0);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  useEffect(() => {
    cues.current = createVoiceCues();
    return () => { cues.current?.dispose(); cues.current = null; };
  }, []);
  const transition = useCallback((next: typeof phase) => {
    phaseToken.current += 1;
    phaseRef.current = next;
    setPhase(next);
    if (next === "thinking") cues.current?.startThinking();
    else cues.current?.stopThinking();
    return phaseToken.current;
  }, []);

  const stopAudio = useCallback(() => {
    sequence.current += 1;
    if (playbackCleanupTimer.current !== null) clearTimeout(playbackCleanupTimer.current);
    if (speechMonitor.current !== null) clearInterval(speechMonitor.current);
    playbackCleanupTimer.current = null;
    speechMonitor.current = null;
    if (audio.current) {
      audio.current.pause();
      audio.current.removeAttribute("src");
      audio.current.load();
      audio.current = null;
    }
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  const finishPlayback = useCallback(() => {
    if (!active.current || phaseRef.current !== "ready") { stopAudio(); return; }
    if (playbackCleanupTimer.current !== null) return;
    // Start while the speech audio session still exists. A delayed cue can be
    // blocked when iOS interrupts Web Audio after the media source ends.
    // Keep the speech player alive until the longer tone has finished.
    const mine = sequence.current;
    cues.current?.ready();
    playbackCleanupTimer.current = setTimeout(() => {
      playbackCleanupTimer.current = null;
      if (mine === sequence.current) stopAudio();
    }, 1200);
  }, [stopAudio]);
  const cancelCapture = useCallback(() => {
    captureGeneration.current += 1;
    recognition.current?.abort();
    recognition.current = null;
    if (recorder.current?.state === "recording") { recorder.current.onstop = null; recorder.current.stop(); }
    recorder.current = null;
    recordingStream.current?.getTracks().forEach((track) => track.stop());
    recordingStream.current = null;
    if (recordingTimer.current) clearTimeout(recordingTimer.current);
    recordingTimer.current = null;
    setListening(false);
    setBusy(false);
  }, []);

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) { setNotice("No reply to read yet."); return; }
    if (text.length > MAX_SPEAK) {
      setNotice("This reply is too long for the voice view. Open the thread to review it.");
      return;
    }
    stopAudio();
    const mine = sequence.current;
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
      player.onended = () => { if (mine === sequence.current) finishPlayback(); };
      player.onerror = () => { if (mine === sequence.current) { finishPlayback(); setNotice("Audio interrupted. Open the thread to read this reply."); } };
      await player.play();
      if (mine === sequence.current) setNotice("Reading aloud. Tap Stop audio at any time.");
    } catch {
      if (mine !== sequence.current) return;
      if (audio.current) {
        audio.current.pause();
        audio.current.removeAttribute("src");
        audio.current.load();
        audio.current = null;
      }
      // No network/service or audio autoplay denied: browser TTS may work in a
      // WebView, but is also optional. Do not claim success if neither does.
      if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") {
        finishPlayback(); setNotice("Speech playback is unavailable. Install Read Aloud or review the reply on screen.");
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = navigator.language || "en-US";
      const stopMonitoring = () => {
        if (speechMonitor.current !== null) clearInterval(speechMonitor.current);
        speechMonitor.current = null;
      };
      utterance.onend = () => { if (mine === sequence.current) { stopMonitoring(); finishPlayback(); } };
      utterance.onerror = () => { if (mine === sequence.current) { stopMonitoring(); finishPlayback(); setNotice("Speech playback failed. Read the reply on screen."); } };
      window.speechSynthesis.speak(utterance);
      // Some iOS WebViews omit utterance.onend. Once speech has actually
      // started, four consecutive silent checks are a fallback completion.
      let heardSpeech = false;
      let silentChecks = 0;
      speechMonitor.current = setInterval(() => {
        if (mine !== sequence.current) { stopMonitoring(); return; }
        if (window.speechSynthesis.speaking) { heardSpeech = true; silentChecks = 0; }
        else if (heardSpeech && ++silentChecks >= 4) { stopMonitoring(); finishPlayback(); }
      }, 300);
      setNotice("Reading with device voice.");
    }
  }, [stopAudio, finishPlayback]);

  useEffect(() => {
    cancelCapture();
    setFallbackText("");
    setShowFallback(false);
    setRetryText(null);
    lastSpoken.current = null;
    active.current = true;
    const token = transition("loading");
    setNotice(selectedId ? "Checking thread status…" : "Choose a thread to begin.");
    stopAudio();
    if (selectedId) {
      void rpc.call("state", { threadId: selectedId }).then(({ state }) => {
        if (!active.current || selectedRef.current !== selectedId || phaseToken.current !== token) return;
        transition(state);
        if (state === "ready") { cues.current?.ready(); setNotice("Ready. Tap to talk."); }
        else if (state === "attention") setNotice("Agent needs your attention. Open the thread to respond.");
        else setNotice("Agent is thinking. Talk is disabled until it finishes.");
      }, () => {
        if (active.current && selectedRef.current === selectedId && phaseToken.current === token) {
          transition("attention");
          setNotice("Could not check thread status. Reopen Voice Drive to retry.");
        }
      });
    }
    return () => {
      active.current = false;
      cues.current?.stopThinking();
      phaseToken.current += 1;
      cancelCapture();
      stopAudio();
    };
  }, [selectedId, stopAudio, rpc, transition, cancelCapture]);

  const readNewReply = useCallback(async (threadId: string, token: number) => {
    try {
      const result = await rpc.call("latest", { threadId });
      if (!active.current || selectedRef.current !== threadId || phaseToken.current !== token || !result.text) return;
      if (lastSpoken.current === result.text) { cues.current?.ready(); return; }
      lastSpoken.current = result.text;
      await speak(result.text);
    } catch (error) {
      if (active.current && selectedRef.current === threadId && phaseToken.current === token) {
        cues.current?.ready();
        setNotice(error instanceof Error ? `Could not read reply: ${error.message}` : "Could not read reply.");
      }
    }
  }, [rpc, speak]);
  useRealtime("voice-drive/thread-state", (payload) => {
    if (!payload || typeof payload !== "object" || !("threadId" in payload) || !("state" in payload)) return;
    if (typeof payload.threadId !== "string" || payload.threadId !== selectedRef.current || !active.current) return;
    if (payload.state === "thinking") {
      if (listening || recorder.current || recognition.current) cancelCapture();
      stopAudio();
      transition("thinking");
      setNotice("Agent is thinking. Talk is disabled until it finishes.");
    } else if (payload.state === "attention") {
      if (listening || recorder.current || recognition.current) cancelCapture();
      transition("attention");
      setNotice("Agent needs your attention. Open the thread to respond.");
    } else if (payload.state === "failed") {
      transition("ready");
      cues.current?.ready();
      setNotice("Agent stopped with an error. Open the thread to inspect it.");
    } else if (payload.state === "ready") {
      const token = transition("ready");
      if ("hasReply" in payload && payload.hasReply === true) void readNewReply(payload.threadId, token);
      else { cues.current?.ready(); setNotice("Ready. Tap to talk."); }
    }
  });

  const sendText = async (text: string, threadId: string) => {
    const message = text.trim();
    if (!message || message.length > 12000 || !active.current || selectedRef.current !== threadId || sending.current) {
      if (message.length > 12000) setNotice("Dictation is too long to send. Try a shorter message.");
      return;
    }
    sending.current = true;
    setBusy(true);
    setRetryText(null);
    const token = transition("thinking");
    setNotice("Sending your words…");
    try {
      await rpc.call("send", { threadId, text: message });
      if (active.current && selectedRef.current === threadId && phaseRef.current === "thinking") {
        setNotice("Sent. Agent is thinking…");
      }
    } catch (error) {
      if (active.current && selectedRef.current === threadId) {
        setRetryText(message);
        // A rejected send may mean the thread was already running. Query the
        // real state instead of enabling the microphone over an active turn.
        try {
          const current = await rpc.call("state", { threadId });
          if (phaseToken.current === token) {
            transition(current.state);
            if (current.state === "ready") cues.current?.ready();
          }
        } catch { if (phaseToken.current === token) transition("attention"); }
        setNotice(error instanceof Error ? `Not sent: ${error.message}` : "Not sent. Try again.");
      }
    } finally {
      sending.current = false;
      if (active.current && selectedRef.current === threadId) setBusy(false);
    }
  };

  const startBrowserRecognition = () => {
    const Constructor = recognitionConstructor();
    if (!Constructor) {
      setShowFallback(true);
      setNotice("Microphone unavailable. Use the iPhone keyboard microphone below, then tap Send.");
      window.setTimeout(() => document.getElementById("voice-drive-fallback")?.focus(), 0);
      return;
    }
    stopAudio();
    const instance = new Constructor();
    recognition.current = instance;
    const owner = selectedId;
    let recognized = "";
    let failed = false;
    instance.lang = navigator.language || "en-US";
    instance.interimResults = true;
    instance.continuous = false;
    instance.onresult = (event) => {
      recognized = Array.from(event.results)
        .filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ").trim();
    };
    instance.onerror = (event) => {
      failed = true;
      setBusy(false);
      setShowFallback(true);
      setNotice(`Microphone unavailable (${event.error}). Use the iPhone keyboard microphone below.`);
    };
    instance.onend = () => {
      if (recognition.current !== instance) return; // cancelled or changed thread
      recognition.current = null;
      setListening(false);
      if (!failed && recognized) void sendText(recognized, owner);
      else { setBusy(false); if (!failed) setNotice("No words heard. Tap to talk and try again."); }
    };
    try {
      instance.start(); // Synchronous tap gesture, required by iOS permissions.
      cues.current?.ready();
      setListening(true);
      setNotice("Listening. Tap Finish dictating to send your words.");
    } catch {
      recognition.current = null;
      setShowFallback(true);
      setNotice("Could not start the microphone. Use the iPhone keyboard microphone below.");
    }
  };
  const startListening = async () => {
    cues.current?.unlock(); // Called synchronously from the user's tap on iOS.
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
      let recordingFailed = false;
      recorder.current = instance;
      recordingStream.current = stream;
      instance.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      instance.onerror = () => {
        recordingFailed = true;
        if (instance.state === "recording") instance.stop();
        setShowFallback(true);
        setNotice("Recording failed. Use the iPhone keyboard microphone below.");
      };
      instance.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        if (recordingTimer.current) clearTimeout(recordingTimer.current);
        recordingStream.current = null;
        recorder.current = null;
        setListening(false);
        if (capture !== captureGeneration.current || selectedRef.current !== owner) return;
        if (recordingFailed) { setBusy(false); return; }
        const blob = new Blob(chunks, { type: instance.mimeType || "audio/mp4" });
        if (!blob.size) { setBusy(false); setNotice("No audio was recorded. Try again."); return; }
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
          if (!data.text.trim()) { setNotice("No words heard. Tap to talk and try again."); return; }
          await sendText(data.text, owner);
        } catch (error) {
          if (capture === captureGeneration.current && active.current) {
            setShowFallback(true);
            setNotice(`${error instanceof Error ? error.message : "Transcription unavailable"}. Use the iPhone keyboard microphone below. Check BB voice transcription settings.`);
          }
        } finally { if (capture === captureGeneration.current && active.current) setBusy(false); }
      };
      instance.start();
      cues.current?.ready();
      setBusy(false);
      setListening(true);
      setNotice("Recording. Tap Finish dictating; recording ends automatically after one minute.");
      recordingTimer.current = setTimeout(() => {
        if (instance.state === "recording") { cues.current?.finished(); setBusy(true); instance.stop(); }
      }, 60000);
    } catch {
      if (capture === captureGeneration.current) {
        recordingStream.current?.getTracks().forEach((track) => track.stop());
        recordingStream.current = null;
        setShowFallback(true);
        setNotice("Microphone permission or recording unavailable. Use the iPhone keyboard microphone below.");
      }
    } finally { if (capture === captureGeneration.current && !recorder.current) setBusy(false); }
  };
  const stopListening = () => {
    cues.current?.finished();
    setBusy(true);
    if (recorder.current?.state === "recording") recorder.current.stop();
    else recognition.current?.stop();
    setListening(false);
  };
  return (
    <main className="h-full min-h-0 overflow-y-auto px-4 py-5" aria-label="Voice Drive">
      <div className="mx-auto max-w-xl space-y-5 pb-12">
        <h1 className="text-2xl font-bold">Voice Drive</h1>
        <p className="text-sm text-muted-foreground">Listen for the ready tone, then tap to dictate. The finish tone confirms your words are being sent. Quiet notes play while the agent works. Pull over to review code or approve permissions.</p>
        <label className="block text-base font-semibold" htmlFor="voice-drive-thread">Thread</label>
        <select id="voice-drive-thread" className="w-full min-h-14 rounded-xl border bg-background px-3 text-base" value={selectedId} onChange={(event) => navigate.toPluginPanel("drive", { subPath: encodeURIComponent(event.target.value) })}>
          <option value="">Choose a thread</option>
          {threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title || thread.titleFallback || thread.id}</option>)}
        </select>
        {threadsStatus === "error" && <p role="alert">Unable to load threads.</p>}
        {selectedId && !selected && threadsStatus !== "loading" && <p role="alert">Thread not in the current list. Select another thread.</p>}
        <button type="button" disabled={!selected || busy || speaking || phase !== "ready"} onClick={listening ? stopListening : startListening}
          className="flex min-h-28 w-full items-center justify-center rounded-3xl bg-primary px-5 text-2xl font-bold text-primary-foreground shadow-lg disabled:opacity-40"
          aria-pressed={listening} aria-label={listening ? "Finish dictating" : "Start dictating"}>
          {listening ? "■  Finish dictating" : phase === "thinking" ? "Agent thinking…" : phase === "attention" ? "Needs attention" : phase === "loading" ? "Checking thread…" : speaking ? "Reading reply…" : "🎙  Tap to talk"}
        </button>
        {retryText && <button type="button" disabled={busy || phase !== "ready"} onClick={() => void sendText(retryText, selectedId)} className="min-h-16 w-full rounded-xl border px-3 text-lg font-semibold disabled:opacity-40">Retry sending</button>}
        {showFallback && <div className="space-y-3 rounded-xl border p-4">
          <label htmlFor="voice-drive-fallback" className="block font-semibold">Keyboard dictation fallback</label>
          <textarea id="voice-drive-fallback" rows={3} maxLength={12000} value={fallbackText} onChange={(event) => setFallbackText(event.target.value)} placeholder="Use the iPhone keyboard microphone" className="w-full rounded-xl border bg-background p-4 text-lg" />
          <button type="button" disabled={!selected || !fallbackText.trim() || busy || phase !== "ready"} onClick={() => {
            const text = fallbackText;
            setFallbackText("");
            void sendText(text, selectedId);
          }} className="min-h-16 w-full rounded-xl bg-primary px-3 text-lg font-bold text-primary-foreground disabled:opacity-40">Send dictated text</button>
        </div>}
        {speaking && <button type="button" onClick={stopAudio} className="min-h-16 w-full rounded-xl border px-3 text-lg font-semibold">■ Stop audio</button>}
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
  app.slots.navPanel({ id: "drive", title: "Voice Drive", icon: "Mic", path: "drive", component: VoicePage });
  app.slots.experimental_threadHeaderAction({ id: "open-drive", title: "Voice Drive", component: OpenVoiceDrive });
});
