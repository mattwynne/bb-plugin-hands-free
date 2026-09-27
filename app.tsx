import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, experimental_Icon as Icon, experimental_useSidebarThreads, ThreadChat, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { createVoiceCues, type VoiceCues } from "./voice-cues";
import { RecordingWaveform } from "./recording-waveform";

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
function HandsFreePage({ subPath }: { subPath: string }) {
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
  const [waveformStream, setWaveformStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "thinking" | "attention">("loading");
  const [notice, setNotice] = useState("");
  const [showActivity, setShowActivity] = useState(false);
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
    cues.current?.stopCue(); // stop playback, but keep the already-used cue player
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  const finishPlayback = useCallback((deviceSpeech = false) => {
    if (!active.current || phaseRef.current !== "ready") { stopAudio(); return; }
    if (playbackCleanupTimer.current !== null) return;
    const mine = sequence.current;
    const playReadyCue = () => {
      if (mine !== sequence.current || !active.current) return;
      // Play the distinct local reply chime through the established cue
      // player, keeping that player allocated for subsequent replies as well.
      void cues.current?.ready().then((played) => {
        if (!played && mine === sequence.current && active.current) {
          setNotice("Ready tone unavailable or blocked by iOS.");
        }
      });
    };
    if (deviceSpeech) {
      // Keep the established device-speech cleanup and gap before the reply cue.
      window.speechSynthesis?.cancel();
      window.setTimeout(playReadyCue, 1000);
    } else {
      playReadyCue();
    }
    playbackCleanupTimer.current = setTimeout(() => {
      playbackCleanupTimer.current = null;
      if (mine === sequence.current) stopAudio();
    }, deviceSpeech ? 2500 : 1200);
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
    setWaveformStream(null);
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
      let completed = false;
      const stopMonitoring = () => {
        if (speechMonitor.current !== null) clearInterval(speechMonitor.current);
        speechMonitor.current = null;
      };
      const completeSpeech = (failed = false) => {
        if (completed || mine !== sequence.current) return;
        completed = true; // latch BEFORE finishPlayback can call speechSynthesis.cancel()
        stopMonitoring();
        utterance.onend = utterance.onerror = null;
        finishPlayback(true);
        if (failed) setNotice("Speech playback failed. Read the reply on screen.");
      };
      utterance.onend = () => completeSpeech();
      utterance.onerror = () => completeSpeech(true);
      window.speechSynthesis.speak(utterance);
      // A synchronous terminal callback must not install a new monitor or
      // overwrite a genuine failure notice when speak() returns.
      if (completed || mine !== sequence.current) return;
      // Some iOS WebViews omit utterance.onend. Once speech has actually
      // started, four consecutive silent checks are a fallback completion.
      let heardSpeech = false;
      let silentChecks = 0;
      speechMonitor.current = setInterval(() => {
        if (mine !== sequence.current) { stopMonitoring(); return; }
        if (window.speechSynthesis.speaking) { heardSpeech = true; silentChecks = 0; }
        else if (heardSpeech && ++silentChecks >= 4) completeSpeech();
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
        // Opening/selecting a ready thread is not a recording or reply event.
        if (state === "ready") setNotice("Ready. Tap to talk.");
        else if (state === "attention") setNotice("Agent needs your attention. Open the thread to respond.");
        else setNotice("Agent is thinking. Talk is disabled until it finishes.");
      }, () => {
        if (active.current && selectedRef.current === selectedId && phaseToken.current === token) {
          transition("attention");
          setNotice("Could not check thread status. Reopen Hands-Free to retry.");
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
  useRealtime("hands-free/thread-state", (payload) => {
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
      window.setTimeout(() => document.getElementById("hands-free-fallback")?.focus(), 0);
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
      setWaveformStream(null);
      if (!failed && recognized) void sendText(recognized, owner);
      else { setBusy(false); if (!failed) setNotice("No words heard. Tap to talk and try again."); }
    };
    try {
      instance.start(); // Synchronous tap gesture, required by iOS permissions.
      cues.current?.started();
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
        setWaveformStream(null);
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
      cues.current?.started();
      setBusy(false);
      setWaveformStream(stream);
      setListening(true);
      setNotice("Recording. Tap Finish dictating; recording ends automatically after one minute.");
      recordingTimer.current = setTimeout(() => {
        if (instance.state === "recording") { cues.current?.finished(); setBusy(true); setListening(false); setWaveformStream(null); instance.stop(); }
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
    setWaveformStream(null);
  };
  const controlState = !selected
    ? "start"
    : speaking
      ? "playback"
      : listening
        ? "complete"
        : busy || phase === "loading" || phase === "thinking"
          ? "working"
          : phase === "attention"
            ? "attention"
            : "start";
  const controlLabel = controlState === "playback"
    ? "Stop audio"
    : controlState === "complete"
      ? "Finish dictating"
      : controlState === "working"
        ? phase === "loading" ? "Checking thread" : "Working"
        : controlState === "attention"
          ? "Needs attention"
          : "Start dictating";
  const controlIcon = controlState === "playback"
    ? "Square"
    : controlState === "complete"
      ? "Square"
      : controlState === "working"
        ? "Spinner"
        : controlState === "attention"
          ? "AlertTriangle"
          : "Mic";
  const controlDisabled = !selected || (!speaking && (busy || phase !== "ready"));
  return (
    <main className="h-full min-h-0 overflow-y-auto px-4 py-5" aria-label="Hands-Free">
      <div className="mx-auto max-w-xl space-y-5 pb-12">
        <h1 className="text-2xl font-bold">Hands-Free</h1>
        <label className="block text-base font-semibold" htmlFor="hands-free-thread">Thread</label>
        <select id="hands-free-thread" className="w-full min-h-14 rounded-xl border bg-background px-3 text-base" value={selectedId} onChange={(event) => navigate.toPluginPanel("hands-free", { subPath: encodeURIComponent(event.target.value) })}>
          <option value="">Choose a thread</option>
          {threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title || thread.titleFallback || thread.id}</option>)}
        </select>
        {threadsStatus === "error" && <p role="alert">Unable to load threads.</p>}
        {selectedId && !selected && threadsStatus !== "loading" && <p role="alert">Thread not in the current list. Select another thread.</p>}
        <div className="flex justify-center py-2">
          <button type="button" disabled={controlDisabled} onClick={speaking ? stopAudio : listening ? stopListening : startListening}
            className="inline-flex size-28 shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-full bg-foreground text-background transition-colors duration-150 hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-40"
            aria-pressed={listening} aria-label={controlLabel} data-control-state={controlState}>
            <Icon name={controlIcon} className={`size-9 ${controlState === "working" ? "animate-spin motion-reduce:animate-none" : controlState === "complete" || controlState === "playback" ? "fill-current [&_*]:stroke-0" : ""}`} aria-hidden />
            {listening && <RecordingWaveform stream={waveformStream} />}
          </button>
        </div>
        {retryText && <button type="button" disabled={busy || phase !== "ready"} onClick={() => void sendText(retryText, selectedId)} className="min-h-16 w-full rounded-xl border px-3 text-lg font-semibold disabled:opacity-40">Retry sending</button>}
        {showFallback && <div className="space-y-3 rounded-xl border p-4">
          <label htmlFor="hands-free-fallback" className="block font-semibold">Keyboard dictation fallback</label>
          <textarea id="hands-free-fallback" rows={3} maxLength={12000} value={fallbackText} onChange={(event) => setFallbackText(event.target.value)} placeholder="Use the iPhone keyboard microphone" className="w-full rounded-xl border bg-background p-4 text-lg" />
          <button type="button" disabled={!selected || !fallbackText.trim() || busy || phase !== "ready"} onClick={() => {
            const text = fallbackText;
            setFallbackText("");
            void sendText(text, selectedId);
          }} className="min-h-16 w-full rounded-xl bg-primary px-3 text-lg font-bold text-primary-foreground disabled:opacity-40">Send dictated text</button>
        </div>}
        {notice && <p role="status" aria-live="polite" className="rounded-xl border p-3 text-sm">{notice}</p>}
        {selected && <section aria-label="Thread activity" className="rounded-xl border">
          <button type="button" aria-expanded={showActivity} aria-controls="hands-free-activity" onClick={() => setShowActivity((value) => !value)} className="flex min-h-12 w-full items-center justify-between px-3 text-left text-sm font-semibold">
            Thread activity <span aria-hidden="true">{showActivity ? "▾" : "▸"}</span>
          </button>
          <div id="hands-free-activity" hidden={!showActivity} className="border-t px-2 py-2">
            {/* Host timeline owns live reasoning/tool events and history; do not proxy them through voice RPC. */}
            {showActivity && <ThreadChat key={selectedId} threadId={selectedId} variant="timeline" layout="document" />}
          </div>
        </section>}
        {selected && <p className="text-xs text-muted-foreground">Keep BB open and unlocked while recording or listening.</p>}
      </div>
    </main>
  );
}

function OpenHandsFree({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  return <button type="button" aria-label="Open Hands-Free for this thread" title="Hands-Free" onClick={() => navigate.toPluginPanel("hands-free", { subPath: encodeURIComponent(threadId) })} className="rounded-md border px-2 text-sm font-bold">🎙 Hands-Free</button>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "hands-free", title: "Hands-Free", icon: "Mic", path: "hands-free", component: HandsFreePage });
  app.slots.experimental_threadHeaderAction({ id: "open-hands-free", title: "Hands-Free", component: OpenHandsFree });
});
