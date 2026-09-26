import { READY_CUE_GAIN } from "./voice-cues";

// Local PCM WAV used only after device speech. iOS attenuates this media route
// even after a delay, so compensate here without changing the loud pre-speech cue.
export const POST_SPEECH_MEDIA_GAIN = READY_CUE_GAIN * 3;
const NOTE_LENGTH = 0.28;
const FADE_IN = 0.025;
const MIN_GAIN = 0.0001;

// Match voice-cues.ts: exponential attack to READY_CUE_GAIN followed by an
// exponential decay to MIN_GAIN. Compensation scales this canonical shape.
export function readyCueEnvelope(localTime: number): number {
  if (localTime < 0 || localTime >= NOTE_LENGTH) return 0;
  if (localTime <= FADE_IN) {
    return MIN_GAIN * ((READY_CUE_GAIN / MIN_GAIN) ** (localTime / FADE_IN));
  }
  return READY_CUE_GAIN * ((MIN_GAIN / READY_CUE_GAIN) ** ((localTime - FADE_IN) / (NOTE_LENGTH - FADE_IN)));
}

export interface MediaReadyCue {
  audio: HTMLAudioElement;
  dispose(): void;
}

export function createMediaReadyCue(): MediaReadyCue | null {
  if (typeof Audio === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  const sampleRate = 16000;
  const duration = 0.54;
  const frameCount = Math.ceil(sampleRate * duration);
  const buffer = new ArrayBuffer(44 + frameCount * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + frameCount * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frameCount * 2, true);

  const notes: readonly [frequency: number, start: number][] = [[523, 0], [659, 0.23]];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame / sampleRate;
    let sample = 0;
    for (const [frequency, start] of notes) {
      const local = time - start;
      if (local < 0 || local >= NOTE_LENGTH) continue;
      const gain = readyCueEnvelope(local) * (POST_SPEECH_MEDIA_GAIN / READY_CUE_GAIN);
      sample += Math.sin(2 * Math.PI * frequency * local) * gain;
    }
    view.setInt16(44 + frame * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff), true);
  }

  const url = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  const audio = new Audio(url);
  let disposed = false;
  return {
    audio,
    dispose() {
      if (disposed) return;
      disposed = true;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
    },
  };
}
