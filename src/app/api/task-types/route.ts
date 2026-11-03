import { fail, handle, ok } from "@/server/http";
import { getSetting } from "@/server/settings";
import { listTaskTypes, syncProjects, syncTaskTypes } from "@/server/workload-ref";

export function GET() {
  return handle(() => ok({ taskTypes: listTaskTypes() }));
}

/** POST = refresh task types and projects from the workload site. */
export function POST() {
  return handle(async () => {
    const jwt = getSetting("jwt");
    if (!jwt) return fail("ยังไม่มีโทเคน workload — ใส่ในหน้า Settings ก่อน");
    const [types, projects] = await Promise.all([syncTaskTypes(jwt), syncProjects(jwt)]);
    if (types.authExpired || projects.authExpired) {
      return fail("โทเคน workload หมดอายุ — วางใหม่ในหน้า Settings", 401);
    }
    if (!types.ok) return fail(`workload API ตอบ ${types.status}${types.message ? `: ${types.message}` : ""}`);
    if (!projects.ok) return fail(`workload API ตอบ ${projects.status}${projects.message ? `: ${projects.message}` : ""}`);
    return ok({ synced: types.data.length, projects: projects.data.length });
  });
}
