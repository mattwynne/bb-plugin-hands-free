import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadId = z.string().min(1).max(200);
const diagnosticEvent = z.enum([
  "view-open", "thread-state", "reply-start", "reply-end", "cue-request",
  "audio-context", "audio-resume-start", "audio-resume-result", "audio-reset",
  "cue-scheduled", "cue-ended", "cue-unavailable", "manual-test", "playback-cleanup",
]);
const diagnosticDetail = z.enum([
  "loading", "ready", "thinking", "attention", "media-ended", "media-error",
  "speech-ended", "speech-error", "speech-status", "speech-unavailable",
  "automatic", "manual", "failed", "succeeded",
]);
export type DiagnosticEvent = z.infer<typeof diagnosticEvent>;
export type DiagnosticDetail = z.infer<typeof diagnosticDetail>;
export const rpcContract = defineRpcContract({
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
  diagnostic: {
    input: z.object({
      session: z.string().regex(/^[a-zA-Z0-9-]{8,40}$/),
      event: diagnosticEvent,
      detail: diagnosticDetail.optional(),
      audioState: z.enum(["running", "suspended", "interrupted", "closed", "unavailable", "unknown"]).optional(),
      elapsedMs: z.number().int().min(0).max(30000).optional(),
    }),
    output: z.object({ recorded: z.boolean() }),
  },
});

export default function plugin(bb: BbPluginApi) {
  // Bounded even if a buggy client floods diagnostics. No audio, prompt text,
  // response text, thread ids, or freeform strings ever enter these logs.
  let logWindowStart = Date.now();
  let logCount = 0;
  bb.rpc.register(rpcContract, {
    diagnostic: async ({ session, event, detail, audioState, elapsedMs }) => {
      const now = Date.now();
      if (now - logWindowStart >= 60_000) { logWindowStart = now; logCount = 0; }
      if (logCount >= 120) return { recorded: false };
      logCount += 1;
      bb.log.info(`voice session=${session} event=${event} detail=${detail ?? "-"} audio=${audioState ?? "-"} elapsedMs=${elapsedMs ?? "-"}`);
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
    bb.realtime.publish("voice-drive/thread-state", { threadId: thread.id, state: "thinking" });
  });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    // Even an idle transition without a reply must release the talk button.
    // Never broadcast conversation text to other clients.
    bb.realtime.publish("voice-drive/thread-state", {
      threadId: thread.id, state: "ready", hasReply: Boolean(lastAssistantText?.trim()),
    });
  });
  bb.events.on("thread.failed", ({ thread }) => {
    bb.realtime.publish("voice-drive/thread-state", { threadId: thread.id, state: "failed" });
  });
  bb.events.on("interaction.pending", ({ thread }) => {
    bb.realtime.publish("voice-drive/thread-state", { threadId: thread.id, state: "attention" });
  });
}
