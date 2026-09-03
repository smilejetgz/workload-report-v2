import { z } from "zod";
import { fail, handle, ok, parseBody } from "@/server/http";
import { cancelRun, getRun, resumeRun } from "@/server/runs";

type Ctx = { params: Promise<{ id: string }> };

export function GET(_request: Request, ctx: Ctx) {
  return handle(async () => {
    const { id } = await ctx.params;
    const run = getRun(Number(id));
    if (!run) return fail("ไม่พบ run", 404);
    return ok({ run });
  });
}

const postSchema = z.object({ action: z.enum(["cancel", "resume"]) });

export function POST(request: Request, ctx: Ctx) {
  return handle(async () => {
    const { id } = await ctx.params;
    const parsed = await parseBody(request, postSchema);
    if ("error" in parsed) return parsed.error;
    if (parsed.data.action === "cancel") cancelRun(Number(id));
    else resumeRun(Number(id));
    return ok({ runId: Number(id), action: parsed.data.action });
  });
}
