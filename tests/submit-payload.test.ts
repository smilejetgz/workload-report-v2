import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const DB_PATH = path.join(os.tmpdir(), `workload-v2-payload-${process.pid}.db`);
process.env.WORKLOAD_DB_PATH = DB_PATH;

const { getDb, schema } = await import("@/db/client");
const { setSetting } = await import("@/server/settings");
const { buildPayload, isClearableCard, submitCards } = await import("@/server/submit");

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
// Unsigned is fine: the app only reads the payload; the server verifies it.
const JWT = `${b64({ alg: "HS256" })}.${b64({ sub: 7, email: "me@ket.com", name: "Me", role: "staff", exp: 4102444800 })}.sig`;

const TASK_TYPES = [
  { id: 11, name: "Ket-CMS", color: "#f00", isActive: true, sortOrder: 1, positionIds: [] },
  { id: 12, name: "Meeting", color: "#0f0", isActive: true, sortOrder: 2, positionIds: [] },
];
const PROJECTS = [{ id: 40, name: "Ket Shop", websiteUrl: "https://ketshop.co", isActive: true }];

type Call = { method: string; path: string; body: unknown };

function card(over: Partial<typeof schema.cards.$inferInsert> = {}) {
  return getDb()
    .insert(schema.cards)
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
      fingerprint: `fp-${Math.random()}`,
      status: "draft",
      ...over,
    })
    .returning()
    .get();
}

const reload = (id: number) =>
  getDb()
    .select()
    .from(schema.cards)
    .all()
    .find((c) => c.id === id)!;

/** A fake workload v2 API. `batch` decides the answer to POST /tasks/batch. */
function mockServer(batch: (body: { workDate: string; items: { taskId?: number }[] }) => {
  status: number;
  body: unknown;
}) {
  const calls: Call[] = [];
  let nextId = 1000;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const { pathname } = new URL(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: pathname.replace(/^\/api/, ""), body });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status });
      if (pathname.endsWith("/task-types")) return json(200, TASK_TYPES);
      if (pathname.endsWith("/projects")) return json(200, PROJECTS);
      if (pathname.endsWith("/tasks/batch")) {
        const answer = batch(body);
        if (answer.status !== 200) return json(answer.status, answer.body);
        const created = body.items.filter((i: { taskId?: number }) => i.taskId === undefined).map(() => nextId++);
        const updated = body.items.flatMap((i: { taskId?: number }) => (i.taskId ? [i.taskId] : []));
        return json(200, { created, updated, removed: [], dayTotalSec: 0 });
      }
      return json(404, { message: "not mocked" });
    }),
  );
  return calls;
}

beforeEach(() => {
  for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(DB_PATH + suffix, { force: true });
  delete (globalThis as { __workloadDb?: unknown }).__workloadDb;
  setSetting("jwt", JWT);
});

afterEach(() => vi.unstubAllGlobals());

afterAll(() => {
  for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe("submitCards — one POST /tasks/batch per day", () => {
  test("sends the v2 batch shape and stores the ids the server created", async () => {
    const a = card({ website: "ketshop.co" });
    const b = card({ topic: "ประชุม", taskType: "Meeting", clickupTask: null, durationSec: 3600 });
    const calls = mockServer(() => ({ status: 200, body: null }));

    const result = await submitCards([a, b]);

    expect(result).toMatchObject({ submitted: 2, updated: 0, failed: 0, authExpired: false });
    const batches = calls.filter((c) => c.path === "/tasks/batch");
    expect(batches).toHaveLength(1);
    expect(batches[0].body).toEqual({
      workDate: "2026-08-19",
      items: [
        {
          taskTypeId: 11,
          projectId: 40,
          durationSec: 7200,
          title: "แยก discount",
          note: a.noteHtml,
          clickupTaskId: "DEV-6395",
        },
        { taskTypeId: 12, durationSec: 3600, title: "ประชุม", note: b.noteHtml },
      ],
    });
    // Identity is the token's, never the body's.
    expect(JSON.stringify(batches[0].body)).not.toMatch(/userId|email|task_by/);
    expect(reload(a.id)).toMatchObject({ status: "submitted", remoteTaskId: "1000" });
    expect(reload(b.id)).toMatchObject({ status: "submitted", remoteTaskId: "1001" });
  });

  test("a card already on workload is sent as an edit of that row", async () => {
    const a = card({ remoteTaskId: "555", status: "failed" });
    const calls = mockServer(() => ({ status: 200, body: null }));

    const result = await submitCards([a]);

    expect(result).toMatchObject({ submitted: 0, updated: 1, failed: 0 });
    const batch = calls.find((c) => c.path === "/tasks/batch")!;
    expect((batch.body as { items: { taskId?: number }[] }).items[0].taskId).toBe(555);
    expect(reload(a.id)).toMatchObject({ status: "submitted", remoteTaskId: "555" });
  });

  test("days are sent separately", async () => {
    const calls = mockServer(() => ({ status: 200, body: null }));
    await submitCards([card({ tasksDate: "2026-08-20" }), card({ tasksDate: "2026-08-19" })]);
    expect(
      calls.filter((c) => c.path === "/tasks/batch").map((c) => (c.body as { workDate: string }).workDate),
    ).toEqual(["2026-08-19", "2026-08-20"]);
  });

  test("the server's all-or-nothing refusal fails the whole day, naming the culprit", async () => {
    const a = card({ topic: "ดี" });
    const b = card({ topic: "ผิด" });
    mockServer(() => ({
      status: 403,
      body: { message: "ตำแหน่งนี้ลงประเภทงานนี้ไม่ได้", statusCode: 403, index: 1 },
    }));

    const result = await submitCards([a, b]);

    expect(result).toMatchObject({ submitted: 0, failed: 2, authExpired: false });
    expect(reload(a.id).status).toBe("failed");
    expect(reload(a.id).error).toContain('"ผิด"');
    expect(reload(b.id).error).toContain("ตำแหน่งนี้ลงประเภทงานนี้ไม่ได้");
  });

  test("an edit whose row is gone drops the stale id so the next submit creates it", async () => {
    const a = card({ remoteTaskId: "555", status: "failed" });
    mockServer(() => ({ status: 404, body: { message: "ไม่พบงาน", statusCode: 404, index: 0 } }));

    await submitCards([a]);

    expect(reload(a.id)).toMatchObject({ status: "failed", remoteTaskId: null });
  });

  test("only 401 means the token is dead", async () => {
    const a = card();
    mockServer(() => ({ status: 401, body: { message: "token ใช้ไม่ได้" } }));
    const result = await submitCards([a]);
    expect(result).toMatchObject({ authExpired: true });
    expect(reload(a.id).status).toBe("draft");
  });

  test("a card still holding an old-workload id is never sent as a v2 task id", async () => {
    const a = card({ remoteTaskId: "v1:34975", status: "failed" });
    const calls = mockServer(() => ({ status: 200, body: null }));

    const result = await submitCards([a]);

    expect(calls.some((c) => c.path === "/tasks/batch")).toBe(false);
    expect(result).toMatchObject({ failed: 1 });
    expect(reload(a.id)).toMatchObject({ status: "failed", remoteTaskId: "v1:34975" });
  });

  test("a task type workload does not have fails just that card", async () => {
    const a = card({ taskType: "ไม่มีจริง" });
    const b = card();
    const calls = mockServer(() => ({ status: 200, body: null }));

    const result = await submitCards([a, b]);

    expect(result).toMatchObject({ submitted: 1, failed: 1 });
    expect(reload(a.id).error).toContain("ไม่มีจริง");
    const batch = calls.find((c) => c.path === "/tasks/batch")!;
    expect((batch.body as { items: unknown[] }).items).toHaveLength(1);
  });

  test("a token that is not a v2 token is reported as missing", async () => {
    setSetting("jwt", "not-a-jwt");
    const result = await submitCards([card()]);
    expect(result).toMatchObject({ missing: expect.stringContaining("jwt") });
  });
});

describe("buildPayload — offline copy of the batch bodies", () => {
  test("one body per day, task type ids from the synced list", () => {
    getDb().insert(schema.taskTypes).values({ id: 11, name: "Ket-CMS" }).run();
    const a = card();
    const b = card({ taskType: "ไม่ได้ sync" });
    const payload = buildPayload([a, b]);
    expect(payload.days).toEqual([
      {
        workDate: "2026-08-19",
        items: [
          {
            taskTypeId: 11,
            durationSec: 7200,
            title: "แยก discount",
            note: a.noteHtml,
            clickupTaskId: "DEV-6395",
          },
        ],
      },
    ]);
    expect(payload.skipped).toHaveLength(1);
  });
});

describe("isClearableCard — ล้างได้เฉพาะที่ไม่ได้อยู่บน workload", () => {
  test("a draft that was never uploaded can be cleared", () => {
    expect(isClearableCard({ status: "draft", remoteTaskId: null })).toBe(true);
    expect(isClearableCard({ status: "approved", remoteTaskId: null })).toBe(true);
  });

  test("a failed upload with no remote row can be cleared", () => {
    expect(isClearableCard({ status: "failed", remoteTaskId: null })).toBe(true);
  });

  // Holding a remote id means the row may exist on workload; deleting it here
  // would leave that row behind with nothing pointing at it.
  test("anything holding a remote id (v2 or old-workload) is kept", () => {
    expect(isClearableCard({ status: "failed", remoteTaskId: "34975" })).toBe(false);
    expect(isClearableCard({ status: "draft", remoteTaskId: "v1:34975" })).toBe(false);
  });

  test("submitted cards are kept, with or without a linked id", () => {
    expect(isClearableCard({ status: "submitted", remoteTaskId: "34975" })).toBe(false);
    expect(isClearableCard({ status: "submitted", remoteTaskId: null })).toBe(false);
  });
});
