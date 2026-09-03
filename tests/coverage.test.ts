import { describe, expect, test } from "vitest";
import { buildCoverage } from "@/server/engine/coverage";

const H = 3600;

describe("buildCoverage", () => {
  const days = [
    { date: "2026-08-03", targetSec: 8 * H },
    { date: "2026-08-04", targetSec: 8 * H },
    { date: "2026-08-08", targetSec: 0 }, // Saturday
  ];

  test("day statuses: ok / under / off / empty", () => {
    const report = buildCoverage({
      days,
      cards: [
        {
          tasksDate: "2026-08-03",
          durationSec: 8 * H,
          status: "draft",
          evidence: { commits: [], tasks: [] },
        },
        {
          tasksDate: "2026-08-04",
          durationSec: 4 * H,
          status: "draft",
          evidence: { commits: [], tasks: [] },
        },
      ],
      commits: [],
      closedTasks: [],
    });
    expect(report.days.map((d) => d.status)).toEqual(["ok", "under", "off"]);
    expect(report.totalTargetSec).toBe(16 * H);
    expect(report.totalPlannedSec).toBe(12 * H);
  });

  test("finds unreferenced commits with prefix matching", () => {
    const report = buildCoverage({
      days,
      cards: [
        {
          tasksDate: "2026-08-03",
          durationSec: 8 * H,
          status: "draft",
          evidence: { commits: ["a1b2c3d"], tasks: [] },
        },
      ],
      commits: [
        { hash: "a1b2c3d4e5f6a7b8", date: "2026-08-03", message: "covered", project: "ketcms" },
        { hash: "deadbeef00000000", date: "2026-08-03", message: "missed", project: "ketcms" },
      ],
      closedTasks: [],
    });
    expect(report.unreferencedCommits.map((c) => c.message)).toEqual(["missed"]);
  });

  test("finds closed tasks without a card (by custom id or task id)", () => {
    const report = buildCoverage({
      days,
      cards: [
        {
          tasksDate: "2026-08-03",
          durationSec: 8 * H,
          status: "draft",
          evidence: { commits: [], tasks: ["DEV-6395"] },
        },
      ],
      commits: [],
      closedTasks: [
        { taskId: "86cz1", customId: "DEV-6395", name: "covered", closedDate: "2026-08-03" },
        { taskId: "86cz2", customId: "DEV-9999", name: "missed", closedDate: "2026-08-04" },
      ],
    });
    expect(report.closedTasksWithoutCard.map((t) => t.name)).toEqual(["missed"]);
  });

  test("flags off-days that still have commit evidence", () => {
    const report = buildCoverage({
      days,
      cards: [],
      commits: [{ hash: "aaa", date: "2026-08-08", message: "weekend fix", project: "ketcms" }],
      closedTasks: [],
    });
    expect(report.offDaysWithEvidence).toEqual(["2026-08-08"]);
  });
});
