import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { parseHolidayText, planHolidayImport } from "@/server/engine/holiday-import";
import { fail, handle, ok, parseBody } from "@/server/http";
import { getDefaultDailySec } from "@/server/settings";
import { THAI_HOLIDAYS } from "@/server/thai-holidays";

const postSchema = z.object({
  /** Text pasted from Zoho People (ตัวติดตามการลา → วันหยุด), or a date list. */
  text: z.string().min(4),
  year: z.string().regex(/^\d{4}$/),
  /** false = preview only, nothing is written. */
  apply: z.boolean().default(false),
});

export function POST(request: Request) {
  return handle(async () => {
    const parsed = await parseBody(request, postSchema);
    if ("error" in parsed) return parsed.error;
    const { text, year, apply } = parsed.data;

    const imported = parseHolidayText(text);
    if (imported.length === 0) return fail("ไม่เจอวันที่รูปแบบ YYYY-MM-DD ในข้อความที่วาง");

    const plan = planHolidayImport({
      year,
      imported,
      bundledDates: Object.keys(THAI_HOLIDAYS),
    });
    if (plan.holidays.length === 0) {
      return fail(`ข้อความที่วางไม่มีวันหยุดของปี ${year} เลย`);
    }
    if (!apply) return ok({ ...plan, applied: false });

    const db = getDb();
    const now = new Date();
    for (const holiday of plan.holidays) {
      const values = {
        targetSec: 0,
        kind: "holiday" as const,
        note: holiday.name,
        updatedAt: now,
      };
      db.insert(schema.dayTargets)
        .values({ date: holiday.date, ...values })
        .onConflictDoUpdate({ target: schema.dayTargets.date, set: values })
        .run();
    }
    // Days our bundled list calls holidays but the company works through: they
    // need a real target again, or the report would never ask for those hours.
    const workdaySec = getDefaultDailySec();
    for (const date of plan.revertToWorkday) {
      const values = {
        targetSec: workdaySec,
        kind: "workday" as const,
        note: "บริษัทไม่ได้หยุดวันนี้ (ตาม Zoho People)",
        updatedAt: now,
      };
      db.insert(schema.dayTargets)
        .values({ date, ...values })
        .onConflictDoUpdate({ target: schema.dayTargets.date, set: values })
        .run();
    }
    return ok({ ...plan, applied: true });
  });
}
