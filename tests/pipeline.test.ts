import { eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const DB_PATH = path.join(os.tmpdir(), `workload-v2-test-${process.pid}.db`);
process.env.WORKLOAD_DB_PATH = DB_PATH;

// Dynamic imports so WORKLOAD_DB_PATH is set before the db client loads.
const { getDb, schema } = await import("@/db/client");
const { executeRun } = await import("@/server/pipeline");
const { FakeProvider } = await import("@/server/ai/fake");
const { ClaudeCliError } = await import("@/server/ai/cli");

const H = 3600;

function fakePlanFor(prompt: string, hours: number[]): string {
  const date = prompt.match(/"date" MUST be "(\d{4}-\d{2}-\d{2})"/)?.[1] ?? "1970-01-01";
  // Read the hashes the prompt demands coverage of — a valid answer cites them.
  const listed = prompt.match(/evidence\.commits: ([0-9a-f, ]+)/)?.[1] ?? "";
  const commits = listed.split(",").map((h) => h.trim()).filter(Boolean);
  return JSON.stringify({
    date,
    cards: hours.map((h, i) => ({
      topic: `งานที่ ${i + 1} ของ ${date}`,
      task_type: "Ket-CMS",
      note_html: `<p><b>งานที่ ${i + 1}</b></p><ul><li>ทำ feature</li></ul>`,
      hours: h,
      origin: "git",
      // First card carries every commit; the rest cite none. Valid either way.
      evidence: { commits: i === 0 ? commits : [], tasks: [] },
      confidence: 0.8,
    })),
    reviewer_notes: null,
  });
}

describe("executeRun (integration, FakeProvider)", () => {
  beforeAll(() => {
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(DB_PATH + suffix, { force: true });
    }
    const db = getDb();
    db.insert(schema.taskTypes).values({ id: 1, name: "Ket-CMS", color: "#333" }).run();

    // Days are only planned when something verifiable happened, so the dates
    // these tests plan need a commit behind them.
    const project = db
      .insert(schema.projects)
      .values({ path: "/tmp/fake-repo", name: "fake-repo" })
      .returning()
      .get();
    const WORKED_DATES = [
      "2026-08-10", "2026-08-11", "2026-08-13", "2026-08-14",
      "2026-08-17", "2026-08-18", "2026-08-24", "2026-08-25",
    ];
    for (const [i, date] of WORKED_DATES.entries()) {
      db.insert(schema.commits)
        .values({
          projectId: project.id,
          hash: `${i}`.repeat(4) + "aaaabbbbccccdddd1111222233334444".slice(4),
          authorDate: new Date(`${date}T10:00:00+07:00`),
          authorEmail: "me@example.com",
          authorName: "Me",
          message: `feat: งานของ ${date}`,
          branch: "main",
          ticketIds: [],
          filesSummary: { topDirs: ["src"], topFiles: ["src/index.ts"] },
          insertions: 10,
          deletions: 2,
          filesChanged: 1,
        })
        .run();
    }
  });

  afterAll(() => {
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(DB_PATH + suffix, { force: true });
    }
  });

  test("plans workdays only, hits exact targets, and fills shortfalls", async () => {
    const db = getDb();
    const run = db
      .insert(schema.runs)
      .values({ fromDate: "2026-08-10", toDate: "2026-08-16", status: "pending" })
      .returning()
      .get();

    const provider = new FakeProvider();
    // AI proposes only 3h+2h = 5h — allocator must stretch + filler to 8h.
    provider.respondWith((prompt) => fakePlanFor(prompt, [3, 2]));

    // 2026-08-10 (Mon) … 2026-08-16 (Sun); 2026-08-12 = วันแม่ (holiday)
    await executeRun(
      run.id,
      { fromYMD: "2026-08-10", toYMD: "2026-08-16", hoursPerDay: 8 },
      provider,
    );

    const finished = db.select().from(schema.runs).all().find((r) => r.id === run.id)!;
    expect(finished.status).toBe("done");
    expect(finished.progress?.total).toBe(4); // Mon, Tue, Thu, Fri (Wed=holiday, Sat/Sun=weekend)

    const cards = db.select().from(schema.cards).all();
    const dates = [...new Set(cards.map((c) => c.tasksDate))].sort();
    expect(dates).toEqual(["2026-08-10", "2026-08-11", "2026-08-13", "2026-08-14"]);

    for (const date of dates) {
      const dayTotal = cards
        .filter((c) => c.tasksDate === date)
        .reduce((s, c) => s + c.durationSec, 0);
      expect(dayTotal).toBe(8 * H);
    }
    // 3h+2h proposals maxed at 4h each = 8h → allocator reaches target without filler.
    expect(cards.every((c) => c.status === "draft")).toBe(true);
    expect(provider.prompts.length).toBe(4);
  });

  test("a workday with no evidence gets no cards and no AI call", async () => {
    const db = getDb();
    // 2026-08-27 (Thu) — nothing was scanned for it: no commits, no ClickUp.
    const run = db
      .insert(schema.runs)
      .values({ fromDate: "2026-08-27", toDate: "2026-08-27", status: "pending" })
      .returning()
      .get();
    const provider = new FakeProvider();
    provider.respondWith((prompt) => fakePlanFor(prompt, [4, 4]));

    await executeRun(
      run.id,
      { fromYMD: "2026-08-27", toYMD: "2026-08-27", hoursPerDay: 8 },
      provider,
    );

    // Inventing 8h from an empty day is worse than reporting nothing.
    expect(provider.prompts.length).toBe(0);
    expect(db.select().from(schema.cards).all().filter((c) => c.tasksDate === "2026-08-27")).toEqual(
      [],
    );
    const finished = db.select().from(schema.runs).all().find((r) => r.id === run.id)!;
    expect(finished.status).toBe("done");
    expect(finished.progress?.dayStatus["2026-08-27"]).toBe("empty");
  });

  test("a day with ClickUp activity but no commits is still planned", async () => {
    const db = getDb();
    db.insert(schema.clickupTasks)
      .values({
        taskId: "cu-empty-day",
        customId: "DEV-1",
        name: "ปิดงานโดยไม่มี commit",
        status: "closed",
        statusType: "done",
        dateClosed: new Date("2026-08-26T10:00:00+07:00"),
      })
      .run();

    const run = db
      .insert(schema.runs)
      .values({ fromDate: "2026-08-26", toDate: "2026-08-26", status: "pending" })
      .returning()
      .get();
    const provider = new FakeProvider();
    provider.respondWith((prompt) => fakePlanFor(prompt, [4, 4]));

    await executeRun(
      run.id,
      { fromYMD: "2026-08-26", toYMD: "2026-08-26", hoursPerDay: 8 },
      provider,
    );

    expect(provider.prompts.length).toBe(1);
    const cards = db.select().from(schema.cards).all().filter((c) => c.tasksDate === "2026-08-26");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.reduce((s, c) => s + c.durationSec, 0)).toBe(8 * H);
  });

  test("resume skips days that already have drafts", async () => {
    const db = getDb();
    const run = db
      .insert(schema.runs)
      .values({ fromDate: "2026-08-10", toDate: "2026-08-16", status: "pending" })
      .returning()
      .get();
    const provider = new FakeProvider();
    provider.respondWith((prompt) => fakePlanFor(prompt, [4, 4]));

    await executeRun(
      run.id,
      { fromYMD: "2026-08-10", toYMD: "2026-08-16", hoursPerDay: 8 },
      provider,
    );
    // All 4 workdays already have drafts from the previous test → zero AI calls.
    expect(provider.prompts.length).toBe(0);
    const finished = db.select().from(schema.runs).all().find((r) => r.id === run.id)!;
    expect(finished.status).toBe("done");
    expect(Object.values(finished.progress!.dayStatus).every((s) => s === "skipped")).toBe(true);
  });

  test("regenerating one day leaves the rest of the range alone", async () => {
    const db = getDb();
    // 08-10 already has drafts from the first test; 08-11/13/14 are workdays in
    // the same range. Asking to redo 08-10 must not touch or plan the others.
    const before = db.select().from(schema.cards).all();
    const otherDates = ["2026-08-11", "2026-08-13", "2026-08-14"];
    for (const date of otherDates) {
      db.delete(schema.cards).where(eq(schema.cards.tasksDate, date)).run();
    }

    const run = db
      .insert(schema.runs)
      .values({ fromDate: "2026-08-10", toDate: "2026-08-16", status: "pending" })
      .returning()
      .get();
    const provider = new FakeProvider();
    provider.respondWith((prompt) => fakePlanFor(prompt, [4, 4]));

    await executeRun(
      run.id,
      {
        fromYMD: "2026-08-10",
        toYMD: "2026-08-16",
        hoursPerDay: 8,
        regenerateDates: ["2026-08-10"],
      },
      provider,
    );

    const finished = db.select().from(schema.runs).all().find((r) => r.id === run.id)!;
    expect(Object.keys(finished.progress!.dayStatus)).toEqual(["2026-08-10"]);
    expect(finished.progress?.total).toBe(1);
    expect(provider.prompts.length).toBe(1);

    const after = db.select().from(schema.cards).all();
    for (const date of otherDates) {
      expect(after.filter((c) => c.tasksDate === date)).toEqual([]);
    }
    expect(after.filter((c) => c.tasksDate === "2026-08-10").length).toBeGreaterThan(0);
    expect(before.length).toBeGreaterThan(0);
  });

  test("retrying several failed days plans exactly those days", async () => {
    const db = getDb();
    for (const date of ["2026-08-11", "2026-08-14"]) {
      db.delete(schema.cards).where(eq(schema.cards.tasksDate, date)).run();
    }
    const run = db
      .insert(schema.runs)
      .values({ fromDate: "2026-08-10", toDate: "2026-08-16", status: "pending" })
      .returning()
      .get();
    const provider = new FakeProvider();
    provider.respondWith((prompt) => fakePlanFor(prompt, [4, 4]));

    await executeRun(
      run.id,
      {
        fromYMD: "2026-08-10",
        toYMD: "2026-08-16",
        hoursPerDay: 8,
        // 08-13 sits between them and must stay untouched.
        regenerateDates: ["2026-08-11", "2026-08-14"],
      },
      provider,
    );

    const finished = db.select().from(schema.runs).all().find((r) => r.id === run.id)!;
    expect(Object.keys(finished.progress!.dayStatus).sort()).toEqual([
      "2026-08-11",
      "2026-08-14",
    ]);
  });

  test("regenerateDates drops old drafts and re-plans that day", async () => {
    const db = getDb();
    const before = db.select().from(schema.cards).all().filter((c) => c.tasksDate === "2026-08-10");
    expect(before.length).toBeGreaterThan(0);

    const run = db
      .insert(schema.runs)
      .values({ fromDate: "2026-08-10", toDate: "2026-08-10", status: "pending" })
      .returning()
      .get();
    const provider = new FakeProvider();
    provider.respondWith((prompt) => fakePlanFor(prompt, [4, 4]));

    await executeRun(
      run.id,
      {
        fromYMD: "2026-08-10",
        toYMD: "2026-08-10",
        hoursPerDay: 8,
        regenerateDates: ["2026-08-10"],
      },
      provider,
    );
    expect(provider.prompts.length).toBe(1);
    const after = db.select().from(schema.cards).all().filter((c) => c.tasksDate === "2026-08-10");
    const total = after.reduce((s, c) => s + c.durationSec, 0);
    expect(total).toBe(8 * H);
    expect(after.every((c) => c.runId === run.id)).toBe(true);
  });

  test("filler card appears when AI output cannot reach target", async () => {
    const db = getDb();
    const run = db
      .insert(schema.runs)
      .values({ fromDate: "2026-08-17", toDate: "2026-08-17", status: "pending" })
      .returning()
      .get();
    const provider = new FakeProvider();
    // Two cards at max 4h each can only cover 8h — target 10h → 2h filler needed.
    provider.respondWith((prompt) => fakePlanFor(prompt, [4, 4]));

    await executeRun(
      run.id,
      { fromYMD: "2026-08-17", toYMD: "2026-08-17", hoursPerDay: 10 },
      provider,
    );
    const cards = db.select().from(schema.cards).all().filter((c) => c.tasksDate === "2026-08-17");
    const total = cards.reduce((s, c) => s + c.durationSec, 0);
    expect(total).toBe(10 * H);
    expect(cards.some((c) => c.origin === "inferred" && c.internalNote.includes("เติม"))).toBe(
      true,
    );
  });

  test("transient CLI failure is retried without burning the repair budget", async () => {
    const db = getDb();
    const run = db
      .insert(schema.runs)
      .values({ fromDate: "2026-08-24", toDate: "2026-08-24", status: "pending" })
      .returning()
      .get();
    const provider = new FakeProvider();
    // Credentials rotating mid-run: the CLI dies before reaching the model.
    provider.enqueueError(
      new ClaudeCliError("claude CLI ตอบ error", "envelope"),
      new ClaudeCliError("claude CLI ตอบ error", "envelope"),
    );
    provider.respondWith((prompt) => {
      // A transient failure must NOT produce a "fix your JSON" repair note.
      expect(prompt).not.toContain("Fix these problems");
      return fakePlanFor(prompt, [4, 4]);
    });

    await executeRun(
      run.id,
      { fromYMD: "2026-08-24", toYMD: "2026-08-24", hoursPerDay: 8 },
      provider,
    );

    const finished = db.select().from(schema.runs).all().find((r) => r.id === run.id)!;
    expect(finished.status).toBe("done");
    expect(finished.progress?.dayStatus["2026-08-24"]).toBe("done");
    const cards = db.select().from(schema.cards).all().filter((c) => c.tasksDate === "2026-08-24");
    expect(cards.reduce((s, c) => s + c.durationSec, 0)).toBe(8 * H);
  }, 30_000);

  test("day fails with a readable message when the CLI never recovers", async () => {
    const db = getDb();
    const run = db
      .insert(schema.runs)
      .values({ fromDate: "2026-08-25", toDate: "2026-08-25", status: "pending" })
      .returning()
      .get();
    const provider = new FakeProvider();
    provider.enqueueError(
      ...Array.from({ length: 6 }, () => new ClaudeCliError("auth หมดอายุชั่วคราว", "envelope")),
    );

    await executeRun(
      run.id,
      { fromYMD: "2026-08-25", toYMD: "2026-08-25", hoursPerDay: 8 },
      provider,
    );

    const finished = db.select().from(schema.runs).all().find((r) => r.id === run.id)!;
    expect(finished.progress?.dayStatus["2026-08-25"]).toBe("failed");
    expect(finished.error).toContain("auth หมดอายุชั่วคราว");
    // Readable Thai summary, not a raw JSON envelope dump.
    expect(finished.error).not.toContain('"is_error"');
  }, 120_000);

  test("invalid AI output triggers repair prompt then succeeds", async () => {
    const db = getDb();
    const run = db
      .insert(schema.runs)
      .values({ fromDate: "2026-08-18", toDate: "2026-08-18", status: "pending" })
      .returning()
      .get();
    const provider = new FakeProvider();
    provider.enqueue("this is not json at all");
    provider.respondWith((prompt) => {
      expect(prompt).toContain("Fix these problems");
      return fakePlanFor(prompt, [4, 4]);
    });

    await executeRun(
      run.id,
      { fromYMD: "2026-08-18", toYMD: "2026-08-18", hoursPerDay: 8 },
      provider,
    );
    const finished = db.select().from(schema.runs).all().find((r) => r.id === run.id)!;
    expect(finished.status).toBe("done");
    const calls = db.select().from(schema.aiCalls).all().filter((c) => c.runId === run.id);
    expect(calls.length).toBe(2);
    expect(calls[0].status).toBe("invalid");
    expect(calls[1].status).toBe("ok");
  });
});
