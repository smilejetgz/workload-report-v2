import { z } from "zod";
import { getSelectedAuthors } from "@/server/authors";
import { checkIdentity } from "@/server/engine/identity";
import { fail, handle, ok, parseBody } from "@/server/http";
import {
  getAllSettings,
  getSetting,
  SECRET_KEYS,
  SETTING_KEYS,
  setSetting,
  type SettingKey,
} from "@/server/settings";
import { jwtExpiry } from "@/server/sources/workload";

export function GET() {
  return handle(() => {
    const values = getAllSettings();
    const out: Record<string, string | null> = {};
    for (const key of SETTING_KEYS) {
      const value = values[key] ?? getSetting(key);
      if (value && (SECRET_KEYS as string[]).includes(key)) {
        out[key] = `${value.slice(0, 8)}…(${value.length} chars)`;
      } else {
        out[key] = value ?? null;
      }
    }
    const jwt = getSetting("jwt");
    const expiry = jwt ? jwtExpiry(jwt) : null;
    // employees: null → skip the directory checks here (that needs a live API
    // call; /api/employees does the full version).
    const identity = checkIdentity({
      workloadEmail: getSetting("email"),
      taskBy: getSetting("task_by"),
      gitAuthors: getSelectedAuthors(),
      employees: null,
    });
    return ok({
      settings: out,
      gitAuthors: getSelectedAuthors(),
      identity,
      jwtExpiresAt: expiry?.toISOString() ?? null,
      jwtExpired: expiry ? expiry.getTime() < Date.now() : null,
    });
  });
}

// partialRecord: a plain z.record over an enum key demands EVERY key be present
// (Zod v4 exhaustiveness) — saving a single field must be allowed.
const putSchema = z.object({
  values: z.partialRecord(z.enum(SETTING_KEYS), z.string()),
});

export function PUT(request: Request) {
  return handle(async () => {
    const parsed = await parseBody(request, putSchema);
    if ("error" in parsed) return parsed.error;
    const entries = Object.entries(parsed.data.values) as [SettingKey, string][];
    if (entries.length === 0) return fail("ไม่มีค่าให้บันทึก");
    for (const [key, value] of entries) setSetting(key, value.trim());
    return ok({ saved: entries.map(([k]) => k) });
  });
}
