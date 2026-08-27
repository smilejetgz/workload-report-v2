import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";

export const SETTING_KEYS = [
  "jwt",
  "task_by",
  "email",
  "clickup_token",
  "clickup_team_id",
  "clickup_user_id",
  "ai_model",
  "default_daily_hours",
  "rules_md",
  "git_authors", // JSON array of git emails/names that count as "me"
  "clickup_enabled", // "0" to generate from commits alone
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

// Keys whose values are secrets — masked when listed via the API.
export const SECRET_KEYS: SettingKey[] = ["jwt", "clickup_token"];

export function getSetting(key: SettingKey): string | null {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  if (row) return row.value;
  // .env fallback for secrets so the UI isn't required for initial setup.
  if (key === "clickup_token") return process.env.CLICKUP_TOKEN ?? null;
  if (key === "jwt") return process.env.WORKLOAD_JWT ?? null;
  return null;
}

export function setSetting(key: SettingKey, value: string): void {
  getDb()
    .insert(schema.settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value, updatedAt: new Date() },
    })
    .run();
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb().select().from(schema.settings).all();
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export function getDefaultDailySec(): number {
  const hours = Number(getSetting("default_daily_hours") ?? "8");
  return (Number.isFinite(hours) && hours > 0 ? hours : 8) * 3600;
}

/**
 * Whether a run should go and look in ClickUp.
 *
 * Off means the report is written from commits alone, which is quick; the
 * ClickUp pull goes through a headless CLI session and can take minutes.
 * WORKLOAD_SKIP_CLICKUP_SYNC still wins, so tests and git-only machines can
 * never spawn it.
 */
export function shouldSyncClickup(input: {
  setting: string | null;
  envSkip: boolean;
}): boolean {
  if (input.envSkip) return false;
  if (input.setting === null) return true; // never configured: keep it on
  return input.setting !== "0" && input.setting.toLowerCase() !== "false";
}

export function isClickupEnabled(): boolean {
  return shouldSyncClickup({
    setting: getSetting("clickup_enabled"),
    envSkip: process.env.WORKLOAD_SKIP_CLICKUP_SYNC === "1",
  });
}
