import { z } from "zod";
import { fail, handle, ok, parseBody } from "@/server/http";
import { buildPayload, selectSubmittableCards, submitCards } from "@/server/submit";
import { isValidYMD } from "@/server/time";

const postSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ids: z.array(z.number()).nullish(),
});

export function POST(request: Request) {
  return handle(async () => {
    const parsed = await parseBody(request, postSchema);
    if ("error" in parsed) return parsed.error;
    const { from, to, ids } = parsed.data;
    const cards = selectSubmittableCards(from, to, ids ?? undefined);
    if (cards.length === 0) return fail("ไม่มี card ที่ส่งได้ในช่วงนี้");
    const result = await submitCards(cards);
    if ("missing" in result) return fail(`ยังไม่ได้ตั้งค่า ${result.missing} ในหน้า Settings`);
    if (result.authExpired) return fail("JWT หมดอายุ — วางใหม่ในหน้า Settings", 401);
    return ok(result);
  });
}

/** GET ?from&to → payload for manual copy-paste submission. */
export function GET(request: Request) {
  return handle(() => {
    const url = new URL(request.url);
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if (!isValidYMD(from) || !isValidYMD(to)) return fail("from/to ไม่ถูกต้อง");
    const cards = selectSubmittableCards(from, to);
    const payload = buildPayload(cards);
    if ("missing" in payload) return fail(`ยังไม่ได้ตั้งค่า ${payload.missing}`);
    return ok({ payload, count: cards.length });
  });
}
