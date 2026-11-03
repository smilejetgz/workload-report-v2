import { getSelectedAuthors } from "@/server/authors";
import { checkIdentity } from "@/server/engine/identity";
import { fail, handle, ok } from "@/server/http";
import { cachedAccount, refreshMe } from "@/server/me";
import { getSetting } from "@/server/settings";

/** Who the stored workload token belongs to — every uploaded row lands under them. */
export function GET() {
  return handle(async () => {
    const jwt = getSetting("jwt");
    if (!jwt) return fail("ยังไม่มีโทเคน workload — ใส่ในหน้า Settings ก่อน");
    const res = await refreshMe(jwt);
    if (res.authExpired) return fail("โทเคน workload หมดอายุ — วางใหม่ในหน้า Settings", 401);
    if (!res.ok || !res.data) return fail(`workload API ตอบ ${res.status}`);
    const identity = checkIdentity({ account: cachedAccount(), gitAuthors: getSelectedAuthors() });
    return ok({ account: res.data, identity });
  });
}
