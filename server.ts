import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerSpeechHttp } from "./speech-http";

const threadId = z.string().min(1).max(200);
const replyEvent = z.object({
  turnId: z.string(),
  itemId: z.string(),
  kind: z.enum(["start", "delta", "complete"]),
  text: z.string(),
});
const audioEvent = z.enum(["thinking", "thinking-play", "thinking-playing", "thinking-pause", "thinking-failed", "pulse", "context", "cue-play", "cue-stop", "speech-prepare", "speech-ready", "speech-play", "speech-playing", "speech-pause", "speech-ended", "speech-error", "speech-cancel", "speech-failed"]);
const audioDetail = z.enum(["none", "running", "suspended", "interrupted", "closed", "playing", "paused", "ended", "aborted", "not-allowed", "network", "other"]);
export const rpcContract = defineRpcContract({
  audioDiagnostic: {
    input: z.object({ session: z.string().uuid(), event: audioEvent, detail: audioDetail, elapsedMs: z.number().int().min(0).max(3_600_000) }).strict(),
    output: z.object({ recorded: z.boolean() }),
  },
  replies: {
    input: z.object({ threadId, after: z.number().int().nonnegative().optional() }),
    output: z.object({
      state: z.enum(["ready", "thinking", "attention", "failed"]),
      archived: z.boolean(),
      cursor: z.number().int().nonnegative(),
      more: z.boolean(),
      events: z.array(replyEvent),
    }),
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
  async function getState(threadId: string, status: string): Promise<"ready" | "attention" | "thinking"> {
    if (status === "idle" || status === "pending" || status === "error") return "ready";
    const interactions = await bb.sdk.threads.interactions.list({ threadId });
    return interactions.length > 0 ? "attention" : "thinking";
  }
  bb.rpc.register(rpcContract, {
    audioDiagnostic: ({ session, event, detail, elapsedMs }) => {
      if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); count = 0; }
      if (++count > 120) return { recorded: false };
      bb.log.info(`audio session=${session} event=${event} detail=${detail} elapsedMs=${elapsedMs}`);
      return { recorded: true };
    },
    replies: async ({ threadId, after }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const state = thread.status === "error" ? "failed" as const : await getState(threadId, thread.status);
      if (after === undefined) {
        const rows = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "1" });
        return { state, archived: thread.archivedAt !== null, cursor: rows[0]?.seq ?? 0, more: false, events: [] };
      }
      const rows = await bb.sdk.threads.events.list({
        threadId, afterSeq: String(after), order: "asc", limit: "50",
        types: ["item/started", "item/agentMessage/delta", "item/completed"],
      });
      const events: z.infer<typeof replyEvent>[] = [];
      for (const row of rows) {
        if (row.scope.kind !== "turn") continue;
        const turnId = row.scope.turnId;
        if (row.type === "item/agentMessage/delta" && !row.data.parentToolCallId) {
          events.push({ turnId, itemId: row.data.itemId, kind: "delta", text: row.data.delta });
        }
        if (row.type === "item/started" || row.type === "item/completed") {
          const { item } = row.data;
          if (item.type === "agentMessage" && !item.parentToolCallId) {
            events.push({ turnId, itemId: item.id, kind: row.type === "item/started" ? "start" : "complete", text: item.text });
          }
        }
      }
      return { state, archived: thread.archivedAt !== null, cursor: rows.at(-1)?.seq ?? after, more: rows.length === 50, events };
    },
    state: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      return { state: await getState(threadId, thread.status) };
    },
    send: async ({ threadId, text }) => {
      // Only start on an idle thread. Never silently steer or queue a dictated
      // instruction into an active turn; the user must see a failure and retry.
      await bb.sdk.threads.send({ threadId, mode: "start", input: [{ type: "text", text, mentions: [] }] });
      return { accepted: true };
    },
  });
  const notify = (thread: { id: string }) => bb.realtime.publish("hands-free/thread-state", { threadId: thread.id });
  bb.events.on("experimental_thread.events", ({ thread }) => notify(thread));
  bb.events.on("thread.active", ({ thread }) => notify(thread));
  bb.events.on("thread.idle", ({ thread }) => notify(thread));
  bb.events.on("thread.archived", ({ thread }) => notify(thread));
  bb.events.on("thread.failed", ({ thread }) => notify(thread));
  bb.events.on("interaction.pending", ({ thread }) => notify(thread));
}
