// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
let slot: ReturnType<typeof renderSlot> | undefined;
afterEach(() => {
  slot?.lifecycle.unmount();
  slot = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("exposes the fresh-player comparison as a distinct diagnostic variant", () => {
  vi.stubGlobal("speechSynthesis", { speaking: false, pending: false });
  vi.stubGlobal("SpeechSynthesisUtterance", undefined);
  const diagnostic = vi.fn(async (_args: unknown) => ({ recorded: true }));
  slot = renderSlot(app.navPanels.find((panel) => panel.id === "audio-test")!, { subPath: "" }, {
    rpc: { audioTestDiagnostic: diagnostic },
  });
  fireEvent.click(slot.getByRole("button", { name: "4. Fresh-player speech comparison" }));
  expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ variant: "speech-fresh", event: "start" }));
  expect(diagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ variant: "speech-fresh", event: "unavailable" }));
  expect(slot.getByText("This client cannot run the selected audio test.")).toBeTruthy();
});

it("runs from its own panel, reports only metadata, and cleans up on navigation", async () => {
  const players: FakeAudio[] = [];
  class FakeAudio {
    onplaying: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    currentTime = 0;
    play = vi.fn(async () => { this.onplaying?.(); });
    pause = vi.fn();
    removeAttribute = vi.fn();
    load = vi.fn();
    constructor() { players.push(this); }
  }
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:comparison", revokeObjectURL: vi.fn() });
  vi.stubGlobal("speechSynthesis", { speaking: false, pending: false, cancel: vi.fn() });
  const track = { readyState: "live", onended: null, stop: vi.fn() };
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const diagnostic = vi.fn(async (_args: unknown) => ({ recorded: true }));
  const panel = app.navPanels.find((panel) => panel.id === "audio-test")!;
  expect(panel).toBeTruthy();
  slot = renderSlot(panel, { subPath: "" }, { rpc: { audioTestDiagnostic: diagnostic } });
  expect(players).toHaveLength(0); // no auto-play, AudioContext, or thread access on mount
  vi.useFakeTimers();
  fireEvent.click(slot.getByRole("button", { name: "1. Tone-only control" }));
  expect((slot.getByRole("button", { name: "2. Speech comparison" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    players[0]!.onended?.();
    await vi.advanceTimersByTimeAsync(1000);
    players[0]!.onended?.();
  });
  expect(slot.getByText("Done. Compare A and B: same, B quieter, or B louder?")).toBeTruthy();
  expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ variant: "control", event: "complete" }));
  const ids = new Set(diagnostic.mock.calls.map(([args]) => (args as { session: string }).session));
  expect(ids.size).toBe(1);
  expect(getUserMedia).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(slot!.getByRole("button", { name: "3. Microphone comparison" })); });
  expect(getUserMedia).toHaveBeenCalledOnce();
  expect(slot.getByText("Tone A (microphone open)")).toBeTruthy();
  expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ variant: "capture", event: "mic-open" }));
  slot.lifecycle.unmount();
  slot = undefined;
  expect(players[1]!.pause).toHaveBeenCalledOnce();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(diagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ event: "stopped" }));
  expect(vi.getTimerCount()).toBe(0);
});
