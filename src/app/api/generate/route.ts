import { z } from "zod";
import { fail, handle, ok, parseBody } from "@/server/http";
import { startRun, validateRangeParams } from "@/server/runs";

const postSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hoursPerDay: z.number().min(0.5).max(24).nullish(),
  regenerateDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish(),
});

export function POST(request: Request) {
  return handle(async () => {
    const parsed = await parseBody(request, postSchema);
    if ("error" in parsed) return parsed.error;
    const params = {
      fromYMD: parsed.data.from,
      toYMD: parsed.data.to,
      hoursPerDay: parsed.data.hoursPerDay ?? null,
      regenerateDates: parsed.data.regenerateDates ?? null,
    };
    const invalid = validateRangeParams(params);
    if (invalid) return fail(invalid);
    const { runId } = startRun(params);
    return ok({ runId }, 202);
  });
}
