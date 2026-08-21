import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const DB_PATH = path.join(os.tmpdir(), `workload-v2-payload-${process.pid}.db`);
process.env.WORKLOAD_DB_PATH = DB_PATH;

const { getDb, schema } = await import("@/db/client");
const { setSetting } = await import("@/server/settings");
const { buildPayload } = await import("@/server/submit");

// The workload API contract for POST /tasks/create-task-list. Pinned so a
// refactor cannot silently rename a field the server requires.
const CREATE_TASK_KEYS = [
  "tasks_date",
  "duration",
  "note",
  "task_by",
  "task_type",
  "email",
  "website",
  "clickup_task",
];

describe("create-task-list payload", () => {
  beforeAll(() => {
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(DB_PATH + suffix, { force: true });
    const db = getDb();
    setSetting("task_by", "Tirajet Chukleang");
    setSetting("email", "me@ket.com");
    db.insert(schema.cards)
      .values({
        tasksDate: "2026-08-19",
        durationSec: 7200,
        topic: "แยก discount",
        noteHtml: "<p><b>[DEV-6395] discount</b></p><ul><li>ทำ</li></ul>",
        taskType: "Ket-CMS",
        website: null,
        clickupTask: "DEV-6395",
        origin: "git",
        confidence: 0.9,
        evidence: { commits: ["a1b2c3d4"], tasks: ["DEV-6395"] },
        fingerprint: "fp-1",
        status: "draft",
      })
      .run();
  });

  afterAll(() => {
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(DB_PATH + suffix, { force: true });
  });

  test("wraps tasks in { tasks: [...] } with exactly the API's fields", () => {
    const cards = getDb().select().from(schema.cards).all();
    const payload = buildPayload(cards);
    expect("tasks" in payload).toBe(true);
    if (!("tasks" in payload)) return;
    expect(Object.keys(payload.tasks[0]).sort()).toEqual([...CREATE_TASK_KEYS].sort());
  });

  test("uses the configured workload identity for task_by / email", () => {
    const cards = getDb().select().from(schema.cards).all();
    const payload = buildPayload(cards);
    if (!("tasks" in payload)) throw new Error("expected a payload");
    expect(payload.tasks[0].task_by).toBe("Tirajet Chukleang");
    expect(payload.tasks[0].email).toBe("me@ket.com");
    expect(payload.tasks[0].duration).toBe(7200);
    expect(payload.tasks[0].tasks_date).toBe("2026-08-19");
  });
});

describe("affectedRows — 200 does not mean the row changed", () => {
  test("reads the rows-affected count the API returns", async () => {
    const { affectedRows } = await import("@/server/sources/workload");
    expect(affectedRows({ data: 1, message: "Success", status: 200 })).toBe(1);
    // The live API answers 200 { data: 0 } for an id that no longer exists —
    // treating that as success is what would silently lose a row.
    expect(affectedRows({ data: 0, message: "Success", status: 200 })).toBe(0);
    expect(affectedRows({ data: "2" })).toBe(2);
    expect(affectedRows({})).toBe(0);
    expect(affectedRows(null)).toBe(0);
  });
});

describe("isClearableCard — ล้างได้เฉพาะที่ไม่ได้อยู่บน workload", () => {
  test("a draft that was never uploaded can be cleared", async () => {
    const { isClearableCard } = await import("@/server/submit");
    expect(isClearableCard({ status: "draft", remoteTaskId: null })).toBe(true);
    expect(isClearableCard({ status: "approved", remoteTaskId: null })).toBe(true);
  });

  test("a failed upload with no remote row can be cleared", async () => {
    const { isClearableCard } = await import("@/server/submit");
    expect(isClearableCard({ status: "failed", remoteTaskId: null })).toBe(true);
  });

  // Holding a remote id means the row may exist on workload; deleting it here
  // would leave that row behind with nothing pointing at it.
  test("anything holding a remote id is kept", async () => {
    const { isClearableCard } = await import("@/server/submit");
    expect(isClearableCard({ status: "failed", remoteTaskId: "34975" })).toBe(false);
    expect(isClearableCard({ status: "draft", remoteTaskId: "34975" })).toBe(false);
  });

  test("submitted cards are kept, with or without a linked id", async () => {
    const { isClearableCard } = await import("@/server/submit");
    expect(isClearableCard({ status: "submitted", remoteTaskId: "34975" })).toBe(false);
    expect(isClearableCard({ status: "submitted", remoteTaskId: null })).toBe(false);
  });
});
