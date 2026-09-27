// Edge protocol adapted from Chris Sells’ Read Aloud (MIT).
// See THIRD_PARTY_NOTICES.md for full attribution and license.
import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";

/** Published client token shared by every Read Aloud client. */
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
/** Upstream's pinned Edge client version; this unofficial API may change. */
export const DEFAULT_CLIENT_VERSION = "143.0.3650.75";
const BASE = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";

export const DEFAULT_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

/** Seconds between the Windows FILETIME epoch (1601) and the Unix epoch. */
const WINDOWS_EPOCH_OFFSET_SECONDS = 11_644_473_600n;
/** FILETIME is in 100ns units, so five minutes is 3e9 of them. */
const FIVE_MINUTES_IN_TICKS = 3_000_000_000n;

/**
 * The Sec-MS-GEC token: SHA-256 of the current Windows FILETIME rounded down to
 * a five-minute boundary, concatenated with the trusted client token.
 *
 * BigInt is not optional here. The tick count is ~1.3e17, well past
 * Number.MAX_SAFE_INTEGER, so computing it in floating point silently loses
 * low-order digits and hashes to a token the service rejects.
 */
function secMsGec(): string {
  const unixSeconds = BigInt(Math.floor(Date.now() / 1000));
  const ticks = (unixSeconds + WINDOWS_EPOCH_OFFSET_SECONDS) * 10_000_000n;
  const rounded = ticks - (ticks % FIVE_MINUTES_IN_TICKS);
  return createHash("sha256")
    .update(`${rounded}${TRUSTED_CLIENT_TOKEN}`)
    .digest("hex")
    .toUpperCase();
}

function authQuery(version: string): string {
  return `Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${version}`;
}

/** Headers the service checks on the upgrade request. */
function handshakeHeaders(version: string): Record<string, string> {
  const major = version.split(".")[0] ?? "143";
  return {
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" +
      ` (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` +
      ` Edg/${major}.0.0.0`,
    "Sec-CH-UA": `" Not;A Brand";v="99", "Microsoft Edge";v="${major}", "Chromium";v="${major}"`,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
  };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** "en-US-AndrewMultilingualNeural" -> "en-US" */
function localeOf(voice: string): string {
  const parts = voice.split("-");
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : "en-US";
}


export interface EdgeInput {
  text: string; voice: string; speed: number; signal: AbortSignal; maxBytes: number;
}

/** One bounded synthesis turn; abort covers connection, messages and shutdown. */
export function synthesizeEdge(input: EdgeInput): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) { reject(new Error("aborted")); return; }
    const url = `wss://${BASE}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&${authQuery(DEFAULT_CLIENT_VERSION)}&ConnectionId=${randomUUID().replace(/-/g, "")}`;
    const socket = new WebSocket(url, {
      headers: handshakeHeaders(DEFAULT_CLIENT_VERSION), handshakeTimeout: 10_000,
      maxPayload: 1024 * 1024, followRedirects: false,
    });
    socket.binaryType = "nodebuffer";
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", abort);
      socket.terminate();
      if (error) reject(error);
      else resolve(new Uint8Array(Buffer.concat(chunks, size)));
      chunks.length = 0;
    };
    const abort = () => finish(new Error("aborted"));
    input.signal.addEventListener("abort", abort, { once: true });
    // Keep an error listener attached even after terminate() during handshake.
    socket.on("error", () => finish(new Error("Edge connection failed")));
    socket.on("close", () => finish(new Error("Edge closed before turn.end")));
    socket.on("unexpected-response", (_request, response) => {
      response.destroy();
      finish(new Error("Edge handshake refused"));
    });
    socket.on("open", () => {
      if (settled) return;
      const timestamp = new Date().toString();
      socket.send(`X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" }, outputFormat: DEFAULT_OUTPUT_FORMAT } } } }));
      const rate = `${Math.round((input.speed - 1) * 100) >= 0 ? "+" : ""}${Math.round((input.speed - 1) * 100)}%`;
      socket.send(`X-RequestId:${randomUUID().replace(/-/g, "")}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}Z\r\nPath:ssml\r\n\r\n` +
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${localeOf(input.voice)}'><voice name='${escapeXml(input.voice)}'><prosody rate='${rate}'>${escapeXml(input.text)}</prosody></voice></speak>`);
    });
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (settled) return;
      if (!isBinary) {
        if (data.toString("utf8").includes("Path:turn.end")) finish();
        return;
      }
      if (data.length < 2) { finish(new Error("Invalid Edge frame")); return; }
      const end = 2 + data.readUInt16BE(0);
      if (end > data.length) { finish(new Error("Invalid Edge frame")); return; }
      if (!data.subarray(2, end).toString("utf8").includes("Path:audio")) return;
      const bytes = data.subarray(end);
      size += bytes.length;
      if (size > input.maxBytes) { finish(new Error("Edge audio size limit")); return; }
      chunks.push(bytes);
    });
  });
}
