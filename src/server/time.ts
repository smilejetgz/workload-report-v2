// Date helpers pinned to Asia/Bangkok (UTC+7, no DST).

export const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Calendar date (YYYY-MM-DD) of an instant, in Asia/Bangkok. */
export function toBangkokYMD(d: Date): string {
  return new Date(d.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Hour of day (0-23) of an instant, in Asia/Bangkok. */
export function bangkokHour(d: Date): number {
  return new Date(d.getTime() + BANGKOK_OFFSET_MS).getUTCHours();
}

export function timeOfDay(d: Date): "morning" | "afternoon" | "evening" {
  const h = bangkokHour(d);
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

/** Inclusive list of YYYY-MM-DD dates between from and to. */
export function dateRange(fromYMD: string, toYMD: string): string[] {
  const out: string[] = [];
  const from = new Date(`${fromYMD}T00:00:00Z`);
  const to = new Date(`${toYMD}T00:00:00Z`);
  for (let t = from.getTime(); t <= to.getTime(); t += 24 * 60 * 60 * 1000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Day of week for a YYYY-MM-DD date: 0=Sunday … 6=Saturday. */
export function dayOfWeek(ymd: string): number {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

export function isWeekend(ymd: string): boolean {
  const dow = dayOfWeek(ymd);
  return dow === 0 || dow === 6;
}

export function isValidYMD(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}
