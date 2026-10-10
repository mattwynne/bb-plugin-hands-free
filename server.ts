import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerSpeechHttp } from "./speech-http";

const threadId = z.string().min(1).max(200);
const audioEvent = z.enum(["thinking", "thinking-play", "thinking-playing", "thinking-pause", "thinking-failed", "pulse", "context", "cue-play", "cue-stop", "speech-prepare", "speech-ready", "speech-play", "speech-playing", "speech-pause", "speech-ended", "speech-error", "speech-cancel", "speech-failed"]);
const audioDetail = z.enum(["none", "running", "suspended", "interrupted", "closed", "playing", "paused", "ended", "aborted", "not-allowed", "network", "other"]);
export const rpcContract = defineRpcContract({
  audioDiagnostic: {
    input: z.object({ session: z.string().uuid(), event: audioEvent, detail: audioDetail, elapsedMs: z.number().int().min(0).max(3_600_000) }).strict(),
    output: z.object({ recorded: z.boolean() }),
  },
  latest: {
    input: z.object({ threadId }),
    output: z.object({ text: z.string().nullable() }),
  },
  send: {
    input: z.object({ threadId, text: z.string().trim().min(1).max(12000) }),
    output: z.object({ accepted: z.boolean() }),
  },
  state: {
    input: z.object({ threadId }),
    output: z.object({ state: z.enum(["ready", "thinking", "attention"]) }),
  },
});

export default function plugin(bb: BbPluginApi) {
  registerSpeechHttp(bb);
  let windowStart = Date.now();
  let count = 0;
  bb.rpc.register(rpcContract, {
    audioDiagnostic: ({ session, event, detail, elapsedMs }) => {
      if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); count = 0; }
      if (++count > 120) return { recorded: false };
      bb.log.info(`audio session=${session} event=${event} detail=${detail} elapsedMs=${elapsedMs}`);
      return { recorded: true };
    },
    latest: async ({ threadId }) => {
      const result = await bb.sdk.threads.output({ threadId });
      return { text: result.output };
    },
    state: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status === "idle" || thread.status === "error") return { state: "ready" as const };
      const interactions = await bb.sdk.threads.interactions.list({ threadId });
      return { state: interactions.length > 0 ? "attention" as const : "thinking" as const };
    },
    send: async ({ threadId, text }) => {
      // Only start on an idle thread. Never silently steer or queue a dictated
      // instruction into an active turn; the user must see a failure and retry.
      await bb.sdk.threads.send({ threadId, mode: "start", input: [{ type: "text", text, mentions: [] }] });
      return { accepted: true };
    },
  });
  bb.events.on("thread.active", ({ thread }) => {
    bb.realtime.publish("hands-free/thread-state", { threadId: thread.id, state: "thinking" });
  });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    // Even an idle transition without a reply must release the talk button.
    // Never broadcast conversation text to other clients.
    bb.realtime.publish("hands-free/thread-state", {
      threadId: thread.id, state: "ready", hasReply: Boolean(lastAssistantText?.trim()),
    });
  });
  bb.events.on("thread.failed", ({ thread }) => {
    bb.realtime.publish("hands-free/thread-state", { threadId: thread.id, state: "failed" });
  });
  bb.events.on("interaction.pending", ({ thread }) => {
    bb.realtime.publish("hands-free/thread-state", { threadId: thread.id, state: "attention" });
  });
}
