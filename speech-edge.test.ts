import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const sockets = vi.hoisted(() => [] as any[]);
vi.mock("ws", () => ({ default: class extends EventEmitter {
  binaryType = "";
  send = vi.fn();
  terminate = vi.fn();
  constructor(public url: string, public options: unknown) { super(); sockets.push(this); }
} }));
import { synthesizeEdge } from "./speech-edge";
const options = (signal = new AbortController().signal) => ({ text: "<hello & 'world'>", voice: "en-US-AriaNeural", speed: 1.5, maxBytes: 4, signal });
const frame = (bytes: number[]) => {
  const headers = Buffer.from("Path:audio\r\n");
  const length = Buffer.alloc(2); length.writeUInt16BE(headers.length);
  return Buffer.concat([length, headers, Buffer.from(bytes)]);
};
beforeEach(() => { sockets.length = 0; });
describe("Edge transport", () => {
  it("escapes SSML, maps speed and completes only on turn.end", async () => {
    const result = synthesizeEdge(options());
    const socket = sockets[0]!;
    expect(socket.options).toMatchObject({ handshakeTimeout: 10000, maxPayload: 1024 * 1024, followRedirects: false });
    socket.emit("open");
    expect(socket.send.mock.calls[1][0]).toContain("rate='+50%'");
    expect(socket.send.mock.calls[1][0]).toContain("&lt;hello &amp; &apos;world&apos;&gt;");
    socket.emit("message", frame([1, 2]), true);
    socket.emit("message", frame([3]), true);
    socket.emit("message", Buffer.from("Path:turn.end\r\n"), false);
    expect(await result).toEqual(new Uint8Array([1, 2, 3]));
    expect(socket.terminate).toHaveBeenCalledOnce();
    socket.emit("error", new Error("late close error"));
  });
  it.each(["before open", "after open"])("terminates on cancellation %s", async when => {
    const controller = new AbortController();
    const result = synthesizeEdge(options(controller.signal));
    const socket = sockets[0]!;
    if (when === "after open") socket.emit("open");
    controller.abort();
    await expect(result).rejects.toThrow("aborted");
    expect(socket.terminate).toHaveBeenCalledOnce();
  });
  it("does not connect if already aborted", async () => {
    await expect(synthesizeEdge(options(AbortSignal.abort()))).rejects.toThrow("aborted");
    expect(sockets).toHaveLength(0);
  });
  it("rejects truncated frames and oversized output", async () => {
    for (const bytes of [Buffer.from([0, 10]), frame([1, 2, 3, 4, 5])]) {
      const result = synthesizeEdge(options());
      const socket = sockets.at(-1)!;
      socket.emit("message", bytes, true);
      await expect(result).rejects.toThrow();
      expect(socket.terminate).toHaveBeenCalled();
    }
  });
  it("does not treat unexpected socket close as completed audio", async () => {
    const result = synthesizeEdge(options());
    sockets[0]!.emit("message", frame([1]), true);
    sockets[0]!.emit("close");
    await expect(result).rejects.toThrow("before turn.end");
  });
  it("destroys refused handshake response", async () => {
    const result = synthesizeEdge(options());
    const destroy = vi.fn();
    sockets[0]!.emit("unexpected-response", {}, { destroy });
    await expect(result).rejects.toThrow("handshake refused");
    expect(destroy).toHaveBeenCalled();
  });
});
