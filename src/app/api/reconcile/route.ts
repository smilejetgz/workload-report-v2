import { z } from "zod";
import { fail, handle, ok, parseBody } from "@/server/http";
import { reconcileRange } from "@/server/remote-sync";

const postSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Pull the real workload rows for a range and make the local list match them. */
export function POST(request: Request) {
  return handle(async () => {
    const parsed = await parseBody(request, postSchema);
    if ("error" in parsed) return parsed.error;
    const { from, to } = parsed.data;
    if (from > to) return fail("from/to ไม่ถูกต้อง");

    const result = await reconcileRange(from, to);
    if ("missing" in result) return fail(`ยังไม่ได้ตั้งค่า ${result.missing} ในหน้า Settings`);
    if ("error" in result) return fail(result.error, result.authExpired ? 401 : 502);
    return ok(result);
  });
}
