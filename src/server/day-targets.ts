import type { DayKind, DayTarget } from "@/db/schema";
import { dateRange, isWeekend } from "./time";
import { holidayName } from "./thai-holidays";

export type ResolvedDayTarget = {
  date: string;
  targetSec: number;
  kind: DayKind;
  note: string | null;
  isOverride: boolean;
};

/**
 * Pure resolver: Mon-Fri = defaultDailySec, Sat/Sun = 0 (weekend),
 * Thai holidays = 0, explicit day_targets rows override everything.
 */
export function resolveDayTargets(
  fromYMD: string,
  toYMD: string,
  defaultDailySec: number,
  overrides: DayTarget[],
): ResolvedDayTarget[] {
  const byDate = new Map(overrides.map((o) => [o.date, o]));
  return dateRange(fromYMD, toYMD).map((date) => {
    const override = byDate.get(date);
    if (override) {
      return {
        date,
        targetSec: override.targetSec,
        kind: override.kind,
        note: override.note,
        isOverride: true,
      };
    }
    const holiday = holidayName(date);
    if (holiday) {
      return { date, targetSec: 0, kind: "holiday" as const, note: holiday, isOverride: false };
    }
    if (isWeekend(date)) {
      return { date, targetSec: 0, kind: "weekend" as const, note: null, isOverride: false };
    }
    return {
      date,
      targetSec: defaultDailySec,
      kind: "workday" as const,
      note: null,
      isOverride: false,
    };
  });
}

/**
 * Dates a range-wide target change should actually be written to.
 *
 * Weekends and Thai holidays are dropped by default: marking a Saturday as
 * "ลา" spends a leave day on a day that was never a workday, and it would show
 * up as leave in the calendar. A company-wide shutdown can override that with
 * includeNonWorkdays.
 */
export function expandTargetRange(
  fromYMD: string,
  toYMD: string,
  opts: { includeNonWorkdays?: boolean } = {},
): string[] {
  if (fromYMD > toYMD) return [];
  const dates = dateRange(fromYMD, toYMD);
  if (opts.includeNonWorkdays) return dates;
  return dates.filter((date) => !isWeekend(date) && !holidayName(date));
}
