// Who the stored workload token belongs to. GET /auth/me is called whenever a
// token is saved (and on demand), and the answer is cached in settings so the
// identity check and the UI can show it without a network call.

import type { WorkloadAccount } from "./engine/identity";
import { getSetting, setSetting } from "./settings";
import { getMe, type RemoteMe, type WorkloadResult } from "./sources/workload";

export async function refreshMe(jwt: string): Promise<WorkloadResult<RemoteMe | null>> {
  const res = await getMe(jwt);
  if (res.ok && res.data) {
    setSetting("email", res.data.email);
    setSetting("task_by", res.data.name);
    setSetting("workload_user_id", String(res.data.id));
    setSetting("workload_position_ids", JSON.stringify(res.data.positionIds));
  }
  return res;
}

/** The cached account, or null when no token has ever been verified. */
export function cachedAccount(): WorkloadAccount | null {
  const email = getSetting("email");
  const name = getSetting("task_by");
  if (!email && !name) return null;
  return { email: email ?? "", name: name ?? "" };
}
