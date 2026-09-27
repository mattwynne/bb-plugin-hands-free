// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { VoiceSettingsPage, VOICE_STORAGE, readVoiceSettings } from "./voice-settings";
import { prepareSpeech, VOICE_API } from "./voice-client";

const cloud = [
  { id: "edge:en-US-AriaNeural", name: "Aria", engine: "edge", language: "en-US", available: true },
  { id: "openai:coral", name: "Coral", engine: "openai", language: "multilingual", available: false, unavailableReason: "Add an API key in plugin settings" },
];
function setup() {
  const events = new EventTarget();
  const synth = { getVoices: vi.fn(() => [] as SpeechSynthesisVoice[]), speak: vi.fn(), cancel: vi.fn(),
    addEventListener: vi.fn(events.addEventListener.bind(events)), removeEventListener: vi.fn(events.removeEventListener.bind(events)) };
  vi.stubGlobal("speechSynthesis", synth);
  class Utterance { constructor(public text: string) {} }
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  const fetcher = vi.fn(async (url: string, _options?: RequestInit) => ({ ok: true, json: async () => url.endsWith("/voices") ? { voices: cloud } : { audioId: "a", url: `${VOICE_API}/speech/audio?id=a` } }));
  vi.stubGlobal("fetch", fetcher);
  return { synth, events, fetcher };
}
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("keeps unavailable saved voices visible and disabled without overwriting preference", async () => {
  setup(); localStorage.setItem(VOICE_STORAGE, JSON.stringify({ voiceId: "openai:coral", speed: 1.3 }));
  const page = render(<VoiceSettingsPage />);
  const option = await page.findByRole("option", { name: /Coral — OpenAI.*Unavailable: Add an API key/ });
  expect((option as HTMLOptionElement).disabled).toBe(true);
  expect((page.getByRole("button", { name: "Preview voice" }) as HTMLButtonElement).disabled).toBe(true);
  expect(page.getByText(/your saved selection has not been changed/)).toBeTruthy();
  expect(readVoiceSettings()).toEqual({ voiceId: "openai:coral", speed: 1.3 });
  expect(page.getAllByRole("combobox")).toHaveLength(1);
});

it("loads device voices asynchronously, previews the selected voice and speed, and cleans listeners/speech", async () => {
  const { synth, events } = setup();
  const page = render(<VoiceSettingsPage />);
  const device = { voiceURI: "samantha", name: "Samantha", lang: "en-US" } as SpeechSynthesisVoice;
  synth.getVoices.mockReturnValue([device]);
  act(() => { events.dispatchEvent(new Event("voiceschanged")); });
  fireEvent.change(page.getByRole("combobox"), { target: { value: "device:samantha" } });
  fireEvent.change(page.getByRole("slider"), { target: { value: "1.4" } });
  fireEvent.click(page.getByRole("button", { name: "Preview voice" }));
  expect(synth.speak).toHaveBeenCalledWith(expect.objectContaining({ voice: device, rate: 1.4 }));
  expect(readVoiceSettings()).toEqual({ voiceId: "device:samantha", speed: 1.4 });
  page.unmount();
  expect(synth.cancel).toHaveBeenCalled();
  expect(synth.removeEventListener).toHaveBeenCalledWith("voiceschanged", expect.any(Function));
  const again = render(<VoiceSettingsPage />);
  expect((again.getByRole("combobox") as HTMLSelectElement).value).toBe("device:samantha");
  synth.getVoices.mockReturnValue([]);
  act(() => { events.dispatchEvent(new Event("voiceschanged")); });
  expect((again.getByRole("option", { name: /samantha.*Unavailable/ }) as HTMLOptionElement).disabled).toBe(true);
  expect(readVoiceSettings().voiceId).toBe("device:samantha");
});

it("previews cloud selection, forwards speed, and releases audio on stop", async () => {
  const { fetcher } = setup();
  const audio = { play: vi.fn(async () => {}), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), onended: null, onerror: null };
  vi.stubGlobal("Audio", vi.fn(function () { return audio; }));
  const page = render(<VoiceSettingsPage />);
  await page.findByRole("option", { name: /Aria/ });
  fireEvent.change(page.getByRole("combobox"), { target: { value: cloud[0]!.id } });
  fireEvent.change(page.getByRole("slider"), { target: { value: "0.8" } });
  fireEvent.click(page.getByRole("button", { name: "Preview voice" }));
  await waitFor(() => expect(audio.play).toHaveBeenCalled());
  expect(fetcher).toHaveBeenCalledWith(`${VOICE_API}/speech/prepare`, expect.objectContaining({ body: expect.stringContaining('"speed":0.8') }));
  fireEvent.click(page.getByRole("button", { name: "Stop preview / audio" }));
  expect(audio.pause).toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledWith(`${VOICE_API}/speech/audio?id=a`, expect.objectContaining({ method: "DELETE" }));
});

it("aborts in-flight preview and releases late responses without playing after unmount", async () => {
  const { fetcher } = setup();
  let resolve!: (v: any) => void;
  const audio = vi.fn(); vi.stubGlobal("Audio", audio);
  const page = render(<VoiceSettingsPage />);
  await page.findByRole("option", { name: /Aria/ });
  fireEvent.change(page.getByRole("combobox"), { target: { value: cloud[0]!.id } });
  fetcher.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  fireEvent.click(page.getByRole("button", { name: "Preview voice" }));
  const options = fetcher.mock.calls.find(([url]) => url.endsWith("/prepare"))![1]!;
  page.unmount();
  expect(options.signal?.aborted).toBe(true);
  await act(async () => { resolve({ ok: true, json: async () => ({ audioId: "late", url: `${VOICE_API}/speech/audio?id=late` }) }); });
  expect(audio).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledWith(`${VOICE_API}/speech/audio?id=late`, expect.objectContaining({ method: "DELETE" }));
});

it("does not silently downgrade failed cloud preview", async () => {
  const { synth, fetcher } = setup();
  const page = render(<VoiceSettingsPage />);
  await page.findByRole("option", { name: /Aria/ });
  fireEvent.change(page.getByRole("combobox"), { target: { value: cloud[0]!.id } });
  fetcher.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(page.getByRole("button", { name: "Preview voice" }));
  await page.findByText(/offline. No device fallback was used/);
  expect(synth.speak).not.toHaveBeenCalled();
  expect(readVoiceSettings().voiceId).toBe(cloud[0]!.id);
});

it("validates persisted settings and rejects external stream URLs", async () => {
  setup(); localStorage.setItem(VOICE_STORAGE, '{"speed":99,"voiceId":5}');
  expect(readVoiceSettings()).toEqual({ voiceId: "device:default", speed: 1 });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ audioId: "a", url: "https://other.example/audio" }) })));
  await expect(prepareSpeech("hello", "openai:coral", 1, new AbortController().signal)).rejects.toThrow("Invalid speech response");
});
