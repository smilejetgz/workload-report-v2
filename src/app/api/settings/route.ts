import { z } from "zod";
import { getSelectedAuthors } from "@/server/authors";
import { checkIdentity } from "@/server/engine/identity";
import { fail, handle, ok, parseBody } from "@/server/http";
import { cachedAccount, refreshMe } from "@/server/me";
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
    const identity = checkIdentity({ account: cachedAccount(), gitAuthors: getSelectedAuthors() });
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

    // A new token means a possibly different person: look them up right away
    // so the page can say whose name the reports will land under.
    const jwt = parsed.data.values.jwt?.trim();
    if (jwt) {
      const me = await refreshMe(jwt);
      if (me.authExpired) return fail("โทเคนนี้ใช้กับ workload ไม่ได้ (401) — คัดลอกใหม่จากเว็บ", 401);
      if (!me.ok) return fail(`บันทึกแล้ว แต่เช็คบัญชีกับ workload ไม่สำเร็จ (${me.status})`, 502);
      return ok({ saved: entries.map(([k]) => k), account: me.data });
    }
    return ok({ saved: entries.map(([k]) => k) });
  });
}
