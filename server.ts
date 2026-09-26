import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { AUDIO_COMPARISON_EVENTS, AUDIO_SESSION_TYPES } from "./audio-comparison-events";

const threadId = z.string().min(1).max(200);
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
  audioTestDiagnostic: {
    input: z.object({
      session: z.string().regex(/^[a-zA-Z0-9-]{8,40}$/),
      variant: z.enum(["control", "speech", "capture"]),
      event: z.enum(AUDIO_COMPARISON_EVENTS),
      elapsedMs: z.number().int().min(0).max(60000),
      sessionType: z.enum(AUDIO_SESSION_TYPES),
    }).strict(),
    output: z.object({ recorded: z.boolean() }),
  },
});

export default function plugin(bb: BbPluginApi) {
  let diagnosticWindow = Date.now();
  let diagnosticCount = 0;
  bb.rpc.register(rpcContract, {
    audioTestDiagnostic: async ({ session, variant, event, elapsedMs, sessionType }) => {
      const now = Date.now();
      if (now - diagnosticWindow >= 60000) { diagnosticWindow = now; diagnosticCount = 0; }
      if (diagnosticCount++ >= 120) return { recorded: false };
      bb.log.info(`audio-test session=${session} variant=${variant} event=${event} elapsedMs=${elapsedMs} sessionType=${sessionType}`);
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
