import { describe, expect, test } from "vitest";
import { matchCommitsToTasks } from "@/server/engine/matcher";

const tasks = [
  { taskId: "86czb2y7w", customId: "DEV-6395" },
  { taskId: "86czxxxxx", customId: "ISSUE-7709" },
  { taskId: "86cznocust", customId: null },
];

describe("matchCommitsToTasks", () => {
  test("matches by custom id from commit tickets", () => {
    const links = matchCommitsToTasks(
      [{ hash: "abc", projectId: 1, ticketIds: ["DEV-6395"] }],
      tasks,
    );
    expect(links).toEqual([
      { commitHash: "abc", projectId: 1, taskId: "86czb2y7w", source: "id_match", confidence: 1 },
    ]);
  });

  test("matches case-insensitively", () => {
    const links = matchCommitsToTasks(
      [{ hash: "abc", projectId: 1, ticketIds: ["dev-6395".toUpperCase()] }],
      tasks,
    );
    expect(links).toHaveLength(1);
  });

  test("matches raw ClickUp refs (#id / CU-id)", () => {
    const links = matchCommitsToTasks(
      [{ hash: "abc", projectId: 1, ticketIds: ["#86cznocust", "CU-86czxxxxx"] }],
      tasks,
    );
    expect(links.map((l) => l.taskId).sort()).toEqual(["86cznocust", "86czxxxxx"]);
  });

  test("ignores unknown tickets and dedupes", () => {
    const links = matchCommitsToTasks(
      [{ hash: "abc", projectId: 1, ticketIds: ["DEV-6395", "DEV-6395", "NOPE-1"] }],
      tasks,
    );
    expect(links).toHaveLength(1);
  });
});
