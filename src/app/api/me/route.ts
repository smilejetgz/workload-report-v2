import { getSelectedAuthors } from "@/server/authors";
import { checkIdentity } from "@/server/engine/identity";
import { fail, handle, ok } from "@/server/http";
import { describeFailure, getMe } from "@/server/sources/workload";
import { workloadAccount } from "@/server/workload-account";

/** The workload account the JWT belongs to — every submitted row lands under it. */
export function GET() {
  return handle(async () => {
    const account = workloadAccount();
    if ("missing" in account) return fail(`ยังไม่ได้ตั้งค่า ${account.missing} — วางในหน้า Settings ก่อน`);
    const res = await getMe(account.jwt);
    if (res.authExpired) return fail("JWT หมดอายุ — วางใหม่ในหน้า Settings", 401);
    if (!res.ok || !res.data) return fail(describeFailure("workload auth/me", res), 502);

    const identity = checkIdentity({
      workloadEmail: res.data.email,
      workloadName: res.data.name,
      gitAuthors: getSelectedAuthors(),
    });
    return ok({ me: res.data, identity });
  });
}
