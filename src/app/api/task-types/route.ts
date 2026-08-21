import { getDb, schema } from "@/db/client";
import { fail, handle, ok } from "@/server/http";
import { getSetting } from "@/server/settings";
import { getTaskTypes } from "@/server/sources/workload";

export function GET() {
  return handle(() => {
    const taskTypes = getDb().select().from(schema.taskTypes).all();
    return ok({ taskTypes });
  });
}

/** POST = sync from workload API. */
export function POST() {
  return handle(async () => {
    const jwt = getSetting("jwt");
    if (!jwt) return fail("ยังไม่มี JWT — ใส่ในหน้า Settings ก่อน");
    const res = await getTaskTypes(jwt);
    if (res.authExpired) return fail("JWT หมดอายุ — วางใหม่ในหน้า Settings", 401);
    if (!res.ok) return fail(`workload API ตอบ ${res.status}`);
    const db = getDb();
    for (const t of res.data) {
      db.insert(schema.taskTypes)
        .values({ id: t.id, name: t.tasks_propose, color: t.color, syncedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.taskTypes.id,
          set: { name: t.tasks_propose, color: t.color, syncedAt: new Date() },
        })
        .run();
    }
    return ok({ synced: res.data.length });
  });
}
