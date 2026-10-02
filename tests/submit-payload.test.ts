import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const DB_PATH = path.join(os.tmpdir(), `workload-v2-payload-${process.pid}.db`);
process.env.WORKLOAD_DB_PATH = DB_PATH;

const { getDb, schema } = await import("@/db/client");
const { buildPayload, cardTitle, toBatchItem } = await import("@/server/submit");

// The workload site's contract for one row of POST /tasks/batch. Pinned so a
// refactor cannot silently rename a field the server requires.
const BATCH_ITEM_KEYS = ["taskTypeId", "projectId", "durationSec", "title", "note", "clickupTaskId"];

const card = (over: Partial<typeof schema.cards.$inferInsert> = {}): typeof schema.cards.$inferInsert => ({
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
  ...over,
});

describe("tasks/batch payload", () => {
  beforeAll(() => {
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(DB_PATH + suffix, { force: true });
    const db = getDb();
    db.insert(schema.taskTypes).values({ id: 41, name: "Ket-CMS", color: "#f00" }).run();
    db.insert(schema.taskTypes).values({ id: 51, name: "Others", isFallback: true }).run();
    db.insert(schema.workloadProjects)
      .values({ id: 3769, name: "pet-vet-store.com", kind: "website", websiteUrl: "pet-vet-store.com" })
      .run();
    db.insert(schema.cards).values(card()).run();
    db.insert(schema.cards)
      .values(card({ tasksDate: "2026-08-20", website: "http://pet-vet-store.com/", remoteTaskId: "901", fingerprint: "fp-2" }))
      .run();
    db.insert(schema.cards).values(card({ taskType: "ไม่มีจริง", fingerprint: "fp-3" })).run();
  });

  afterAll(() => {
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(DB_PATH + suffix, { force: true });
  });

  test("groups cards by day with exactly the site's item fields", () => {
    const cards = getDb().select().from(schema.cards).all();
    const payload = buildPayload(cards);
    expect(payload.days.map((d) => d.workDate)).toEqual(["2026-08-19", "2026-08-20"]);
    expect(Object.keys(payload.days[0].items[0]).sort()).toEqual([...BATCH_ITEM_KEYS].sort());
  });

  test("names become ids, the note stays HTML, the topic is the title", () => {
    const cards = getDb().select().from(schema.cards).all();
    const { days } = buildPayload(cards);
    expect(days[0].items[0]).toEqual({
      taskTypeId: 41,
      projectId: null,
      durationSec: 7200,
      title: "แยก discount",
      note: "<p><b>[DEV-6395] discount</b></p><ul><li>ทำ</li></ul>",
      clickupTaskId: "DEV-6395",
    });
  });

  test("a known remote id rides along so the batch updates instead of creating", () => {
    const cards = getDb().select().from(schema.cards).all();
    const { days } = buildPayload(cards);
    expect(days[1].items[0]).toMatchObject({ id: 901, projectId: 3769 });
  });

  test("a task type the site does not have is kept out of the batch and reported", () => {
    const cards = getDb().select().from(schema.cards).all();
    const payload = buildPayload(cards);
    expect(payload.skipped).toHaveLength(1);
    expect(payload.skipped[0]).toContain("ไม่มีจริง");
    expect(payload.days[0].items).toHaveLength(1);
  });

  test("toBatchItem resolves the type name case-insensitively", () => {
    const refs = { taskTypes: getDb().select().from(schema.taskTypes).all(), projects: [] };
    const [c] = getDb().select().from(schema.cards).all();
    const item = toBatchItem({ ...c, taskType: "ket-cms" }, refs);
    expect("error" in item).toBe(false);
    if ("error" in item) return;
    expect(item.taskTypeId).toBe(41);
  });

  test("cardTitle falls back to the note when the topic is blank, and is capped", () => {
    expect(cardTitle({ topic: "  ", noteHtml: "<p><b>หัวข้อจากโน้ต</b></p>" })).toBe("หัวข้อจากโน้ต");
    expect(cardTitle({ topic: "x".repeat(500), noteHtml: "" })).toHaveLength(200);
    expect(cardTitle({ topic: "", noteHtml: "" })).toBe("งาน");
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
    expect(isClearableCard({ status: "failed", remoteTaskId: "901" })).toBe(false);
    expect(isClearableCard({ status: "draft", remoteTaskId: "901" })).toBe(false);
  });

  test("submitted cards are kept, with or without a linked id", async () => {
    const { isClearableCard } = await import("@/server/submit");
    expect(isClearableCard({ status: "submitted", remoteTaskId: "901" })).toBe(false);
    expect(isClearableCard({ status: "submitted", remoteTaskId: null })).toBe(false);
  });
});
