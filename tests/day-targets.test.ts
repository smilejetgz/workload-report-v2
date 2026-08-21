import { describe, expect, test } from "vitest";
import { expandTargetRange, resolveDayTargets } from "@/server/day-targets";
import { dateRange, isWeekend, timeOfDay, toBangkokYMD } from "@/server/time";

const H = 3600;

describe("time helpers", () => {
  test("toBangkokYMD shifts UTC evening into next Bangkok day", () => {
    // 2026-08-03 18:30 UTC = 2026-08-04 01:30 Bangkok
    expect(toBangkokYMD(new Date("2026-08-03T18:30:00Z"))).toBe("2026-08-04");
    expect(toBangkokYMD(new Date("2026-08-03T10:00:00Z"))).toBe("2026-08-03");
  });

  test("timeOfDay uses Bangkok hours", () => {
    // 03:00 UTC = 10:00 Bangkok → morning; 07:00 UTC = 14:00 → afternoon
    expect(timeOfDay(new Date("2026-08-03T03:00:00Z"))).toBe("morning");
    expect(timeOfDay(new Date("2026-08-03T07:00:00Z"))).toBe("afternoon");
    expect(timeOfDay(new Date("2026-08-03T12:00:00Z"))).toBe("evening");
  });

  test("dateRange is inclusive", () => {
    expect(dateRange("2026-08-01", "2026-08-03")).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
  });

  test("isWeekend", () => {
    expect(isWeekend("2026-08-08")).toBe(true); // Sat
    expect(isWeekend("2026-08-09")).toBe(true); // Sun
    expect(isWeekend("2026-08-10")).toBe(false); // Mon
  });
});

describe("resolveDayTargets", () => {
  test("weekdays get default, weekends zero, Thai holiday zero", () => {
    // 2026-08-10 (Mon) … 2026-08-16 (Sun), with วันแม่ 2026-08-12 (Wed)
    const targets = resolveDayTargets("2026-08-10", "2026-08-16", 8 * H, []);
    const byDate = Object.fromEntries(targets.map((t) => [t.date, t]));
    expect(byDate["2026-08-10"]).toMatchObject({ targetSec: 8 * H, kind: "workday" });
    expect(byDate["2026-08-12"]).toMatchObject({ targetSec: 0, kind: "holiday" });
    expect(byDate["2026-08-15"]).toMatchObject({ targetSec: 0, kind: "weekend" });
    expect(byDate["2026-08-16"]).toMatchObject({ targetSec: 0, kind: "weekend" });
  });

  test("explicit overrides win over defaults and holidays", () => {
    const targets = resolveDayTargets("2026-08-12", "2026-08-13", 8 * H, [
      {
        date: "2026-08-12",
        targetSec: 4 * H,
        kind: "half",
        note: "ทำงานครึ่งวัน",
        updatedAt: new Date(),
      },
      { date: "2026-08-13", targetSec: 0, kind: "leave", note: "ลาป่วย", updatedAt: new Date() },
    ]);
    expect(targets[0]).toMatchObject({ targetSec: 4 * H, kind: "half", isOverride: true });
    expect(targets[1]).toMatchObject({ targetSec: 0, kind: "leave", isOverride: true });
  });
});

describe("expandTargetRange — marking leave over several days", () => {
  test("a single day expands to just that day", () => {
    expect(expandTargetRange("2026-08-24", "2026-08-24")).toEqual(["2026-08-24"]);
  });

  test("Mon–Fri expands to five workdays", () => {
    expect(expandTargetRange("2026-08-24", "2026-08-28")).toEqual([
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
      "2026-08-28",
    ]);
  });

  // Marking a Saturday as "ลา" would burn a leave day that was never a workday.
  test("skips weekends inside the range", () => {
    expect(expandTargetRange("2026-08-21", "2026-08-24")).toEqual(["2026-08-21", "2026-08-24"]);
  });

  test("skips Thai holidays inside the range", () => {
    // 2026-08-12 = วันแม่
    expect(expandTargetRange("2026-08-11", "2026-08-13")).toEqual(["2026-08-11", "2026-08-13"]);
  });

  test("includeNonWorkdays covers every date, for a company-wide shutdown", () => {
    expect(expandTargetRange("2026-08-21", "2026-08-24", { includeNonWorkdays: true })).toEqual([
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
    ]);
  });

  test("a reversed range yields nothing", () => {
    expect(expandTargetRange("2026-08-24", "2026-08-21")).toEqual([]);
  });

  test("a range that is entirely weekend yields nothing to write", () => {
    expect(expandTargetRange("2026-08-22", "2026-08-23")).toEqual([]);
  });
});
