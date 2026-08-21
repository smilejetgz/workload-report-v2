import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import type { DayKind } from "@/db/schema";
import { expandTargetRange, resolveDayTargets } from "@/server/day-targets";
import { fail, handle, ok, parseBody } from "@/server/http";
import { getDefaultDailySec } from "@/server/settings";
import { isValidYMD } from "@/server/time";

export function GET(request: Request) {
  return handle(() => {
    const url = new URL(request.url);
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if (!isValidYMD(from) || !isValidYMD(to) || from > to) return fail("from/to ไม่ถูกต้อง");
    const overrides = getDb().select().from(schema.dayTargets).all();
    const days = resolveDayTargets(from, to, getDefaultDailySec(), overrides);
    return ok({ days });
  });
}

const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Accepts one day (date) or a span (from/to) — taking three days of leave is
// one action, not three.
const putSchema = z
  .object({
    date: YMD.optional(),
    from: YMD.optional(),
    to: YMD.optional(),
    targetHours: z.number().min(0).max(24),
    kind: z.enum(["workday", "half", "weekend", "holiday", "leave"]),
    note: z.string().nullish(),
    /** Also write weekends/holidays inside the span (company shutdown). */
    includeNonWorkdays: z.boolean().default(false),
  })
  .refine((v) => Boolean(v.date) || (Boolean(v.from) && Boolean(v.to)), {
    message: "ต้องระบุ date หรือ from+to",
  });

export function PUT(request: Request) {
  return handle(async () => {
    const parsed = await parseBody(request, putSchema);
    if ("error" in parsed) return parsed.error;
    const { date, from, to, targetHours, kind, note, includeNonWorkdays } = parsed.data;

    const dates = date
      ? [date]
      : expandTargetRange(from!, to!, { includeNonWorkdays });
    if (dates.length === 0) {
      return fail("ช่วงนี้ไม่มีวันทำงานให้ตั้งค่า (เสาร์-อาทิตย์/วันหยุดถูกข้าม)");
    }

    const targetSec = Math.round(targetHours * 3600);
    const values = { targetSec, kind: kind as DayKind, note: note ?? null, updatedAt: new Date() };
    const db = getDb();
    for (const d of dates) {
      db.insert(schema.dayTargets)
        .values({ date: d, ...values })
        .onConflictDoUpdate({ target: schema.dayTargets.date, set: values })
        .run();
    }
    return ok({ dates });
  });
}

const deleteSchema = z.object({ date: YMD.optional(), from: YMD.optional(), to: YMD.optional() })
  .refine((v) => Boolean(v.date) || (Boolean(v.from) && Boolean(v.to)), {
    message: "ต้องระบุ date หรือ from+to",
  });

/** Remove overrides so the days fall back to the default rules. */
export function DELETE(request: Request) {
  return handle(async () => {
    const parsed = await parseBody(request, deleteSchema);
    if ("error" in parsed) return parsed.error;
    const { date, from, to } = parsed.data;
    const db = getDb();
    const dates = date ? [date] : expandTargetRange(from!, to!, { includeNonWorkdays: true });
    for (const d of dates) {
      db.delete(schema.dayTargets).where(eq(schema.dayTargets.date, d)).run();
    }
    return ok({ dates });
  });
}
