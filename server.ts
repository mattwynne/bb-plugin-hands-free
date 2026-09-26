import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

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
});

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    latest: async ({ threadId }) => {
      const result = await bb.sdk.threads.output({ threadId });
      return { text: result.output };
    },
    send: async ({ threadId, text }) => {
      // Only start on an idle thread. Never silently steer or queue a dictated
      // instruction into an active turn; the user must see a failure and retry.
      await bb.sdk.threads.send({ threadId, mode: "start", input: [{ type: "text", text, mentions: [] }] });
      return { accepted: true };
    },
  });
  bb.events.on("thread.idle", ({ thread }) => {
    // No conversation text on the broadcast; clients opt in and fetch their
    // own currently selected thread when an idle event arrives.
    bb.realtime.publish("voice-drive/thread-idle", { threadId: thread.id });
  });
}
