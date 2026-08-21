import { getSelectedAuthors } from "@/server/authors";
import { checkIdentity } from "@/server/engine/identity";
import { fail, handle, ok } from "@/server/http";
import { getSetting } from "@/server/settings";
import { getEmployees } from "@/server/sources/workload";

/** Workload employee directory — task_by/email for create-task-list come from here. */
export function GET() {
  return handle(async () => {
    const jwt = getSetting("jwt");
    if (!jwt) return fail("ยังไม่มี JWT — ใส่ในหน้า Settings ก่อน");
    const res = await getEmployees(jwt);
    if (res.authExpired) return fail("JWT หมดอายุ — วางใหม่ในหน้า Settings", 401);
    if (!res.ok) return fail(`workload API ตอบ ${res.status}`);

    // The directory includes people who left (status_active = 0/false).
    const active = res.data.filter((e) => {
      const flag = (e as { status_active?: unknown }).status_active;
      return flag === undefined || flag === null || Boolean(Number(flag));
    });

    const identity = checkIdentity({
      workloadEmail: getSetting("email"),
      taskBy: getSetting("task_by"),
      gitAuthors: getSelectedAuthors(),
      employees: active.map((e) => ({ name: e.name, email: e.email })),
    });
    return ok({ employees: active, identity });
  });
}
