// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
installTestPluginRuntime();
const { VoiceSettingsPage, VOICE_STORAGE, readVoiceSettings, voiceLabel } = await import("./voice-settings");
import { prepareSpeech, VOICE_API } from "./voice-client";

const cloud = [
  { id: "edge:en-GB-SoniaNeural", name: "Sonia", engine: "edge", language: "en-GB", available: true },
  { id: "edge:en-US-AriaNeural", name: "Aria", engine: "edge", language: "en-US", available: true },
];
function setup() {
  const fetcher = vi.fn(async (url: string, _options?: RequestInit) => ({ ok: true, json: async () => url.endsWith("/voices") ? { voices: cloud } : { audioId: "a", url: `${VOICE_API}/speech/audio?id=a` } }));
  vi.stubGlobal("fetch", fetcher);
  return { fetcher };
}
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["device:default", "device:samantha", "openai:coral"])('migrates retired voice %s to Sonia, keeping speed', async voiceId => {
  setup(); localStorage.setItem(VOICE_STORAGE, JSON.stringify({ voiceId, speed: 1.3 }));
  expect(readVoiceSettings()).toEqual({ voiceId: cloud[0]!.id, speed: 1.3 });
  const page = render(<VoiceSettingsPage />);
  await page.findByRole("option", { name: /Aria/ });
  expect((page.getByRole("combobox") as HTMLSelectElement).value).toBe(cloud[0]!.id);
  expect(JSON.parse(localStorage.getItem(VOICE_STORAGE)!)).toEqual({ voiceId: cloud[0]!.id, speed: 1.3 });
  expect(page.getAllByRole("option")).toHaveLength(2);
});

it("keeps an unavailable saved Edge voice visible without changing it", async () => {
  setup(); localStorage.setItem(VOICE_STORAGE, JSON.stringify({ voiceId: "edge:retired", speed: 1.3 }));
  const page = render(<VoiceSettingsPage />);
  const option = await page.findByRole("option", { name: /retired.*Unavailable/ });
  expect((option as HTMLOptionElement).disabled).toBe(true);
  expect(readVoiceSettings()).toEqual({ voiceId: "edge:retired", speed: 1.3 });
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
  fireEvent.click(page.getByRole("button", { name: "Stop preview" }));
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
  const { fetcher } = setup();
  const page = render(<VoiceSettingsPage />);
  await page.findByRole("option", { name: /Aria/ });
  fireEvent.change(page.getByRole("combobox"), { target: { value: cloud[0]!.id } });
  fetcher.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(page.getByRole("button", { name: "Preview voice" }));
  await page.findByText(/offline. Try again or choose another Edge voice/);
  expect(readVoiceSettings().voiceId).toBe(cloud[0]!.id);
});

it("uses human-readable names without repeating the engine or locale", () => {
  expect(voiceLabel({ id: "edge:en-GB-RyanNeural", name: "en-GB-RyanNeural", engine: "edge", language: "en-GB", available: true })).toBe("Ryan · British English");
  expect(voiceLabel({ id: "edge:en-US-AriaNeural", name: "Aria", engine: "edge", language: "en-US", available: true })).toBe("Aria · American English");
});

it("validates persisted settings and rejects external stream URLs", async () => {
  setup(); localStorage.setItem(VOICE_STORAGE, '{"speed":99,"voiceId":5}');
  expect(readVoiceSettings()).toEqual({ voiceId: cloud[0]!.id, speed: 1 });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ audioId: "a", url: "https://other.example/audio" }) })));
  await expect(prepareSpeech("hello", cloud[0]!.id, 1, new AbortController().signal)).rejects.toThrow("Invalid speech response");
});
