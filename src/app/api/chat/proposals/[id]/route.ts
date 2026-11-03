import { z } from "zod";
import { applyProposal, ChatError, discardProposal } from "@/server/chat";
import { fail, handle, ok, parseBody } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const postSchema = z.object({ action: z.enum(["apply", "discard"]) });

/** Accept (apply to the cards, and to workload for submitted ones) or drop a proposal. */
export function POST(request: Request, ctx: Ctx) {
  return handle(async () => {
    const { id } = await ctx.params;
    const parsed = await parseBody(request, postSchema);
    if ("error" in parsed) return parsed.error;
    try {
      if (parsed.data.action === "discard") {
        discardProposal(Number(id));
        return ok({ applied: 0, failed: [] });
      }
      return ok(await applyProposal(Number(id)));
    } catch (error) {
      if (error instanceof ChatError) return fail(error.message, error.status);
      throw error;
    }
  });
}
