import { describe, expect, test } from "vitest";
import {
  buildDayEvidence,
  formatEvidenceText,
  hasDayEvidence,
  stripHtml,
} from "@/server/engine/evidence";
import { buildDayPrompt } from "@/server/engine/prompt";
import type { ClickupTask, Commit } from "@/db/schema";

const DATE = "2026-08-19";
const bkk = (hhmm: string) => new Date(`${DATE}T${hhmm}:00+07:00`);

function commit(over: Partial<Commit> = {}): Commit {
  return {
    id: 1,
    projectId: 1,
    hash: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    authorDate: bkk("10:30"),
    authorEmail: "me@example.com",
    authorName: "Me",
    message: "DEV-6395 แยก discount ของ LineShop\n\nbody",
    branch: "feature/DEV-6395-discount",
    ticketIds: ["DEV-6395"],
    filesSummary: { topDirs: ["src/order"], topFiles: ["src/order/discount.ts", "src/api/order.ts"] },
    insertions: 120,
    deletions: 8,
    filesChanged: 3,
    ...over,
  } as Commit;
}

function task(over: Partial<ClickupTask> = {}): ClickupTask {
  return {
    taskId: "t1",
    customId: "DEV-1",
    name: "งานหนึ่ง",
    status: "in progress",
    statusType: "custom",
    listName: "Sprint",
    folderName: null,
    spaceName: null,
    tags: [],
    assignees: [],
    url: null,
    dateCreated: null,
    dateUpdated: bkk("09:00"),
    dateClosed: null,
    dueDate: null,
    priority: null,
    description: null,
    syncedAt: null,
    ...over,
  } as ClickupTask;
}

function build(over: Partial<Parameters<typeof buildDayEvidence>[0]> = {}) {
  return buildDayEvidence({
    date: DATE,
    targetSec: 8 * 3600,
    commits: [],
    projectNames: new Map([[1, "ketcms"]]),
    tasks: [],
    events: [],
    remoteTasks: [],
    ...over,
  });
}

describe("buildDayEvidence — commits drive ClickUp selection", () => {
  test("marks tasks whose ticket id appears in the day's commits", () => {
    const ev = build({
      commits: [commit()],
      tasks: [task({ taskId: "t1", customId: "DEV-6395" }), task({ taskId: "t2", customId: "DEV-999" })],
    });
    const linked = ev.tasksActive.find((t) => t.customId === "DEV-6395");
    const other = ev.tasksActive.find((t) => t.customId === "DEV-999");
    expect(linked?.linkedToCommits).toBe(true);
    expect(other?.linkedToCommits).toBe(false);
  });

  test("commit-linked tasks come first even when others were updated later", () => {
    const ev = build({
      commits: [commit()],
      tasks: [
        task({ taskId: "t2", customId: "DEV-999", dateUpdated: bkk("23:00") }),
        task({ taskId: "t1", customId: "DEV-6395", dateUpdated: bkk("01:00") }),
      ],
    });
    expect(ev.tasksActive[0].customId).toBe("DEV-6395");
  });

  test("keeps fewer unlinked distractors on days that have commits", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      task({ taskId: `x${i}`, customId: `DEV-${100 + i}` }),
    );
    const withCommits = build({ commits: [commit()], tasks: many });
    const withoutCommits = build({ tasks: many });
    expect(withCommits.tasksActive.length).toBeLessThan(withoutCommits.tasksActive.length);
  });

  test("flags closed tasks that the day's commits back", () => {
    const ev = build({
      commits: [commit()],
      tasks: [
        task({ taskId: "t1", customId: "DEV-6395", dateClosed: bkk("17:00"), statusType: "done" }),
        task({ taskId: "t2", customId: "DEV-42", dateClosed: bkk("17:30"), statusType: "done" }),
      ],
    });
    expect(ev.tasksClosed.find((t) => t.customId === "DEV-6395")?.linkedToCommits).toBe(true);
    expect(ev.tasksClosed.find((t) => t.customId === "DEV-42")?.linkedToCommits).toBe(false);
  });

  test("exposes changed file names from the commit", () => {
    const ev = build({ commits: [commit()] });
    expect(ev.commits[0].files).toContain("src/order/discount.ts");
  });
});

describe("formatEvidenceText", () => {
  test("labels commits as primary and ClickUp as supplementary", () => {
    const text = formatEvidenceText(
      build({ commits: [commit()], tasks: [task({ taskId: "t9", customId: "DEV-7" })] }),
    );
    const commitAt = text.indexOf("PRIMARY");
    const clickupAt = text.indexOf("SUPPLEMENTARY");
    expect(commitAt).toBeGreaterThanOrEqual(0);
    expect(clickupAt).toBeGreaterThan(commitAt);
  });

  test("says explicitly when there are no commits to work from", () => {
    const text = formatEvidenceText(build({ tasks: [task()] }));
    expect(text).toMatch(/no commits/i);
  });

  test("marks which supplementary tasks the commits back", () => {
    const text = formatEvidenceText(
      build({ commits: [commit()], tasks: [task({ taskId: "t1", customId: "DEV-6395" })] }),
    );
    expect(text).toMatch(/linked to today's commits/i);
  });
});

describe("buildDayPrompt", () => {
  const promptFor = (over: Partial<Parameters<typeof buildDayEvidence>[0]> = {}) =>
    buildDayPrompt({
      evidence: build(over),
      taskTypeNames: ["Ket-CMS"],
      rulesMd: null,
      styleExamples: [],
    });

  test("states that commits are the ground truth, before ClickUp", () => {
    const prompt = promptFor({ commits: [commit()] });
    expect(prompt).toMatch(/Evidence priority/i);
    expect(prompt.indexOf("Evidence priority")).toBeLessThan(prompt.indexOf("PRIMARY"));
  });

  test("lists every commit hash that the cards must cover", () => {
    const prompt = promptFor({
      commits: [commit(), commit({ id: 2, hash: "ffee0011223344556677889900aabbccddeeff00" })],
    });
    expect(prompt).toContain("a1b2c3d4");
    expect(prompt).toContain("ffee0011");
    expect(prompt).toMatch(/MUST.*cover/i);
  });

  test("omits the commit-coverage rule when the day has no commits", () => {
    expect(promptFor()).not.toMatch(/MUST all be covered/i);
  });
});

describe("hasDayEvidence — what counts as proof that work happened", () => {
  test("commits are evidence", () => {
    expect(hasDayEvidence(build({ commits: [commit()] }))).toBe(true);
  });

  test("a task closed that day is evidence, even with no commits", () => {
    const ev = build({ tasks: [task({ dateClosed: bkk("17:00"), statusType: "done" })] });
    expect(hasDayEvidence(ev)).toBe(true);
  });

  test("a comment I wrote that day is evidence", () => {
    const ev = build({
      tasks: [task()],
      events: [
        {
          id: 1,
          taskId: "t1",
          kind: "comment",
          at: bkk("14:00"),
          actorId: "1",
          text: "อัปเดตงาน",
        },
      ],
    });
    expect(hasDayEvidence(ev)).toBe(true);
  });

  // An open ticket proves a ticket exists, not that anything was done today —
  // it may have been sitting there for months.
  test("open tasks in progress are NOT evidence on their own", () => {
    const ev = build({ tasks: [task({ status: "on process" }), task({ taskId: "t2" })] });
    expect(ev.tasksActive.length).toBeGreaterThan(0);
    expect(hasDayEvidence(ev)).toBe(false);
  });

  test("a day already reported on workload is not evidence to re-report", () => {
    const ev = build({
      remoteTasks: [
        {
          id: 1,
          tasks_date: DATE,
          duration: 3600,
          note: "<p>x</p>",
          website: null,
          task_by: "me",
          task_type: "Ket-CMS",
          email: null,
          clickup_task: null,
        },
      ],
    });
    expect(hasDayEvidence(ev)).toBe(false);
  });

  test("a completely empty day has no evidence", () => {
    expect(hasDayEvidence(build())).toBe(false);
  });
});


describe("stripHtml — workload notes arrive with entity-encoded Thai", () => {
  test("decodes numeric entities into real characters", () => {
    // What the workload API actually stores for "เพิ่ม".
    expect(stripHtml("<p>&#3648;&#3614;&#3636;&#3656;&#3617;</p>")).toBe("เพิ่ม");
  });

  test("decodes hex entities too", () => {
    expect(stripHtml("&#x0E01;&#x0E32;&#x0E23;")).toBe("การ");
  });

  test("decodes the common named entities", () => {
    expect(stripHtml("<p>a &amp; b&nbsp;c &quot;d&quot; &#39;e&#39;</p>")).toBe(`a & b c "d" 'e'`);
  });

  test("still removes tags and collapses whitespace", () => {
    expect(stripHtml("<p>หนึ่ง</p>\n<ul><li>สอง</li></ul>")).toBe("หนึ่ง สอง");
  });

  test("leaves plain text untouched", () => {
    expect(stripHtml("แก้ Export Order")).toBe("แก้ Export Order");
  });

  test("an unknown entity is left as written rather than mangled", () => {
    expect(stripHtml("A &bogus; B")).toBe("A &bogus; B");
  });
});
