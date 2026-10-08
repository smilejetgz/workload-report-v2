import { z } from "zod";
import { ChatError, getThread, sendChatMessage } from "@/server/chat";
import { fail, handle, ok, parseBody } from "@/server/http";

/** GET ?scope=range:<from>:<to> | day:<date> | card:<id> → the scope's latest thread. */
export function GET(request: Request) {
  return handle(() => {
    const scope = new URL(request.url).searchParams.get("scope") ?? "";
    try {
      return ok(getThread(scope));
    } catch (error) {
      if (error instanceof ChatError) return fail(error.message, error.status);
      throw error;
    }
  });
}

const attachmentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commit"),
    hash: z.string().min(7),
    date: z.string(),
    project: z.string(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("task"),
    taskId: z.string(),
    customId: z.string().nullable(),
    name: z.string(),
    date: z.string().nullable(),
  }),
]);

const postSchema = z.object({
  scope: z.string(),
  text: z.string().min(1).max(4000),
  attachments: z.array(attachmentSchema).max(100).optional(),
  newThread: z.boolean().optional(),
});

/** Send a request; answers with the thread including the AI's proposal. */
export function POST(request: Request) {
  return handle(async () => {
    const parsed = await parseBody(request, postSchema);
    if ("error" in parsed) return parsed.error;
    try {
      return ok(
        await sendChatMessage({
          scopeKey: parsed.data.scope,
          text: parsed.data.text,
          attachments: parsed.data.attachments,
          newThread: parsed.data.newThread,
        }),
      );
    } catch (error) {
      if (error instanceof ChatError) return fail(error.message, error.status);
      throw error;
    }
  });
}
