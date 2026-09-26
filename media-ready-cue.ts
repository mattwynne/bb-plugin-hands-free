import { READY_CUE_GAIN } from "./voice-cues";

// Local PCM WAV used only after device speech. iOS attenuates this media route
// even after a delay, so compensate here without changing the loud pre-speech cue.
export const POST_SPEECH_MEDIA_GAIN = READY_CUE_GAIN * 3;
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
  const noteLength = 0.28;
  const fade = 0.025;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame / sampleRate;
    let sample = 0;
    for (const [frequency, start] of notes) {
      const local = time - start;
      if (local < 0 || local >= noteLength) continue;
      const envelope = Math.min(1, local / fade, (noteLength - local) / fade);
      sample += Math.sin(2 * Math.PI * frequency * local) * envelope * POST_SPEECH_MEDIA_GAIN;
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
