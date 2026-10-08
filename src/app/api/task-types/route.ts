import { getDb, schema } from "@/db/client";
import { fail, handle, ok } from "@/server/http";
import { syncAllowedTaskTypes, workloadAccount } from "@/server/workload-account";

export function GET() {
  return handle(() => {
    const taskTypes = getDb().select().from(schema.taskTypes).all();
    return ok({ taskTypes });
  });
}

/** POST = sync from workload API (only the types this user's positions may log). */
export function POST() {
  return handle(async () => {
    const account = workloadAccount();
    if ("missing" in account) return fail(`ยังไม่ได้ตั้งค่า ${account.missing} — ใส่ในหน้า Settings ก่อน`);
    const res = await syncAllowedTaskTypes(account.jwt);
    if (!res.ok) {
      return res.authExpired
        ? fail("JWT หมดอายุ — วางใหม่ในหน้า Settings", 401)
        : fail(`workload API: ${res.error}`, 502);
    }
    return ok({ synced: res.count });
  });
}
