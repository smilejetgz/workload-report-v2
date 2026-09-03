import { describe, expect, test } from "vitest";
import { parseHolidayText, planHolidayImport } from "@/server/engine/holiday-import";

// Copied straight out of the Zoho People holiday table (ตัวติดตามการลา → วันหยุด).
const ZOHO_PASTE = `ชื่อ	วันที่	ตำแหน่งตั้ง	กะ	การจัดประเภท
วันจักรี	2026-04-06, Mon	Head Office	General	วันหยุด
วันหยุดสงกรานต์	2026-04-13, Mon
2026-04-14, Tue
2026-04-15, Wed	Head Office	General	วันหยุด
วันหยุดแรงงาน	2026-05-01, Fri	ตำแหน่งที่ตั้งทั้งหมด	กะทั้งหมด	วันหยุด`;

describe("parseHolidayText", () => {
  test("reads name + date out of a pasted Zoho table", () => {
    const rows = parseHolidayText(ZOHO_PASTE);
    expect(rows[0]).toEqual({ date: "2026-04-06", name: "วันจักรี" });
    expect(rows.at(-1)).toEqual({ date: "2026-05-01", name: "วันหยุดแรงงาน" });
  });

  // Zoho puts a multi-day holiday's extra dates on their own lines.
  test("continuation lines inherit the holiday name above them", () => {
    const rows = parseHolidayText(ZOHO_PASTE);
    const songkran = rows.filter((r) => r.date.startsWith("2026-04-1"));
    expect(songkran).toHaveLength(3);
    expect(songkran.every((r) => r.name === "วันหยุดสงกรานต์")).toBe(true);
  });

  test("accepts a plain 'date name' list too", () => {
    expect(parseHolidayText("2026-01-02 วันหยุดเทศกาลปีใหม่\n2026-12-30  วันหยุดสิ้นปี")).toEqual([
      { date: "2026-01-02", name: "วันหยุดเทศกาลปีใหม่" },
      { date: "2026-12-30", name: "วันหยุดสิ้นปี" },
    ]);
  });

  test("drops the day-of-week and trailing columns from the name", () => {
    const [row] = parseHolidayText("วันแม่แห่งชาติ\t2026-08-12, Wed\tกะทั้งหมด\tวันหยุด");
    expect(row.name).toBe("วันแม่แห่งชาติ");
  });

  test("ignores the header row and blank lines", () => {
    expect(parseHolidayText("ชื่อ\tวันที่\n\n   \n")).toEqual([]);
  });

  test("a date with no name anywhere still imports", () => {
    expect(parseHolidayText("2026-05-01")).toEqual([{ date: "2026-05-01", name: "วันหยุด" }]);
  });

  test("de-duplicates repeated dates", () => {
    expect(parseHolidayText("2026-05-01 วันแรงงาน\n2026-05-01 วันแรงงาน")).toHaveLength(1);
  });
});

describe("planHolidayImport — the company calendar replaces our guesses", () => {
  const imported = [
    { date: "2026-01-02", name: "วันหยุดเทศกาลปีใหม่" },
    { date: "2026-08-12", name: "วันแม่แห่งชาติ" },
  ];
  // What the bundled list believes about 2026.
  const bundled = ["2026-01-01", "2026-03-03", "2026-08-12"];

  test("writes every imported date as a holiday", () => {
    const plan = planHolidayImport({ year: "2026", imported, bundledDates: bundled });
    expect(plan.holidays).toEqual(imported);
  });

  // Working on a day the bundled list calls a holiday must still be reported,
  // so those days have to be forced back to workdays.
  test("reverts bundled holidays the company does not observe", () => {
    const plan = planHolidayImport({ year: "2026", imported, bundledDates: bundled });
    expect(plan.revertToWorkday).toEqual(["2026-01-01", "2026-03-03"]);
  });

  test("a bundled date that is also imported is not reverted", () => {
    const plan = planHolidayImport({ year: "2026", imported, bundledDates: bundled });
    expect(plan.revertToWorkday).not.toContain("2026-08-12");
  });

  test("only touches the year being imported", () => {
    const plan = planHolidayImport({
      year: "2026",
      imported: [...imported, { date: "2027-01-01", name: "ปีหน้า" }],
      bundledDates: [...bundled, "2025-12-31"],
    });
    expect(plan.holidays.map((h) => h.date)).toEqual(["2026-01-02", "2026-08-12"]);
    expect(plan.revertToWorkday).not.toContain("2025-12-31");
    expect(plan.skipped).toContain("2027-01-01");
  });

  test("an empty import changes nothing — never wipes the calendar by accident", () => {
    const plan = planHolidayImport({ year: "2026", imported: [], bundledDates: bundled });
    expect(plan.holidays).toEqual([]);
    expect(plan.revertToWorkday).toEqual([]);
  });
});
