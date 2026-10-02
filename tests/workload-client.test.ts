import { afterEach, describe, expect, test, vi } from "vitest";
import {
  batchDay,
  getMyDay,
  getMyDays,
  getMyRange,
  listDates,
  toRemoteMe,
  toRemoteTask,
  toRemoteTaskType,
} from "@/server/sources/workload";
import { matchDayRows } from "@/server/engine/day-match";

// Shapes as the live site returned them on 2 Oct 2026.
const ME = {
  id: 82,
  email: "tirajet.c@ketshopweb.com",
  name: "Tirajet",
  role: "staff",
  positions: [{ positionId: 19, name: "Developer", isPrimary: true }],
};
const TASK_TYPE = {
  id: 41,
  name: "Ket-CMS",
  color: "#fc0303",
  isActive: true,
  isFallback: false,
  formKind: "plain",
  positionIds: [19, 20, 21],
};
// A my-day item: `taskId`, seconds inline, no date (the day is the query).
const ROW = {
  taskId: 901,
  taskTypeId: 41,
  taskTypeName: "Ket-CMS",
  projectId: null,
  projectName: null,
  durationSec: 7200,
  title: "แยก discount",
  agendaNote: "<p>หัวข้อ</p>",
  loggedBy: 82,
  loggedByName: "Tirajet",
  clickupTaskId: "DEV-6395",
};
// The same row from GET /tasks: `id`, per-assignee seconds, legacyId, workDate.
const LIST_ROW = {
  id: 901,
  title: "แยก discount",
  workDate: "2026-10-01",
  taskTypeId: 41,
  projectId: null,
  agendaNote: "<p>หัวข้อ</p>",
  clickupTaskId: "DEV-6395",
  legacyId: 35487,
  createdBy: 82,
  deletedAt: null,
  assignees: [{ id: 1, taskId: 901, userId: 82, name: "Tirajet", durationSec: 7200 }],
};

describe("normalisers pin the new site's shapes", () => {
  test("auth/me → id, email, name and position ids", () => {
    expect(toRemoteMe(ME)).toEqual({
      id: 82,
      email: "tirajet.c@ketshopweb.com",
      name: "Tirajet",
      role: "staff",
      positionIds: [19],
    });
    expect(toRemoteMe({})).toBeNull();
  });

  test("task type keeps the position restriction and fallback flag", () => {
    expect(toRemoteTaskType(TASK_TYPE)).toMatchObject({
      id: 41,
      name: "Ket-CMS",
      isFallback: false,
      positionIds: [19, 20, 21],
    });
    expect(toRemoteTaskType({ id: 51, name: "Others", isFallback: true })).toMatchObject({
      isActive: true,
      isFallback: true,
      positionIds: [],
    });
  });

  test("my-day item: taskId is the id, agendaNote the note, the day comes from the query", () => {
    expect(toRemoteTask(ROW, "2026-10-01")).toEqual({
      id: 901,
      userId: 82,
      workDate: "2026-10-01",
      title: "แยก discount",
      taskTypeId: 41,
      taskTypeName: "Ket-CMS",
      projectId: null,
      projectName: null,
      durationSec: 7200,
      note: "<p>หัวข้อ</p>",
      clickupTaskId: "DEV-6395",
      clickupUrl: null,
      legacyId: null,
    });
  });

  test("list item: seconds come from the assignee, legacyId is kept, deleted rows vanish", () => {
    expect(toRemoteTask(LIST_ROW)).toMatchObject({
      id: 901,
      userId: 82,
      workDate: "2026-10-01",
      durationSec: 7200,
      legacyId: 35487,
      taskTypeName: null,
    });
    expect(toRemoteTask({ ...LIST_ROW, deletedAt: "2026-10-01T00:00:00Z" })).toBeNull();
    expect(toRemoteTask({ title: "no id" })).toBeNull();
  });
});

describe("HTTP layer", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (handler: (url: string, init?: RequestInit) => Response) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    });
    return calls;
  };

  test("my-day sends the bearer token, unwraps items and stamps the date", async () => {
    const calls = stub(() => Response.json({ date: "2026-10-01", userId: 82, totalSec: 7200, items: [ROW] }));
    const res = await getMyDay("tok", "2026-10-01");
    expect(res.ok).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]).toMatchObject({ id: 901, workDate: "2026-10-01" });
    expect(calls[0].url).toContain("/tasks/my-day?date=2026-10-01");
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  test("a range is read from GET /tasks and follows the pages", async () => {
    const calls = stub((url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      const items = offset === 0 ? [LIST_ROW, { ...LIST_ROW, id: 902 }] : [{ ...LIST_ROW, id: 903 }];
      return Response.json({ items, total: 3, limit: 2, offset, maxLimit: 500 });
    });
    const res = await getMyRange("tok", "2026-09-29", "2026-10-01");
    expect(res.ok).toBe(true);
    expect(res.data.map((r) => r.id)).toEqual([901, 902, 903]);
    expect(calls).toHaveLength(2);
    const first = new URL(calls[0].url);
    expect(first.pathname).toMatch(/\/tasks$/);
    expect(first.searchParams.get("from")).toBe("2026-09-29");
    expect(first.searchParams.get("to")).toBe("2026-10-01");
    expect(first.searchParams.has("userId")).toBe(false);
  });

  test("a dead token fails the range read instead of looking empty", async () => {
    stub(() => Response.json({ message: "token ใช้ไม่ได้" }, { status: 401 }));
    const res = await getMyRange("dead", "2026-09-29", "2026-10-01");
    expect(res.ok).toBe(false);
    expect(res.authExpired).toBe(true);
    expect(res.data).toEqual([]);
  });

  test("401 is reported as authExpired with the server's message", async () => {
    stub(() => Response.json({ message: "token ใช้ไม่ได้", statusCode: 401 }, { status: 401 }));
    const res = await getMyDay("dead", "2026-10-01");
    expect(res.ok).toBe(false);
    expect(res.authExpired).toBe(true);
    expect(res.message).toBe("token ใช้ไม่ได้");
  });

  test("batch posts { workDate, items } and only adds remove when given", async () => {
    const calls = stub(() => Response.json({ ok: true }));
    const item = { taskTypeId: 41, projectId: null, durationSec: 900, title: "t", note: "", clickupTaskId: null };
    await batchDay("tok", { workDate: "2026-10-01", items: [item] });
    await batchDay("tok", { workDate: "2026-10-01", items: [], remove: [901] });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ workDate: "2026-10-01", items: [item] });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ workDate: "2026-10-01", items: [], remove: [901] });
    expect(calls[0].url).toMatch(/\/tasks\/batch$/);
    expect(calls[0].init?.method).toBe("POST");
  });

  test("getMyDays reads day by day and a dead token fails the whole range", async () => {
    let n = 0;
    stub((url) => {
      n++;
      if (url.includes("2026-10-02")) return Response.json({ message: "x" }, { status: 401 });
      return Response.json({ items: [{ ...ROW, taskId: n }] });
    });
    const okRange = await getMyDays("tok", "2026-09-30", "2026-10-01");
    expect(okRange.ok).toBe(true);
    expect(okRange.data).toHaveLength(2);
    const dead = await getMyDays("tok", "2026-10-01", "2026-10-03");
    expect(dead.ok).toBe(false);
    expect(dead.authExpired).toBe(true);
    expect(dead.data).toEqual([]);
  });

  test("listDates is inclusive", () => {
    expect(listDates("2026-09-29", "2026-10-02")).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
    expect(listDates("bad", "2026-10-02")).toEqual([]);
  });
});

describe("matchDayRows — pairing sent cards with the rows read back", () => {
  const row = (over: Partial<ReturnType<typeof toRemoteTask> & object> = {}) =>
    ({ ...toRemoteTask(ROW, "2026-10-01")!, ...over });
  const item = (over: Partial<DayItem> = {}): DayItem => ({
    taskTypeId: 41,
    projectId: null,
    durationSec: 7200,
    title: "แยก discount",
    note: "",
    clickupTaskId: null,
    ...over,
  });
  type DayItem = Parameters<typeof matchDayRows>[0][number]["item"];

  test("known ids pair by id even when the title changed", () => {
    const m = matchDayRows(
      [{ cardId: 1, remoteTaskId: "901", item: item({ title: "ชื่อใหม่" }) }],
      [row()],
    );
    expect(m.get(1)?.id).toBe(901);
  });

  test("new cards pair by title + duration + type, each row used once", () => {
    const m = matchDayRows(
      [
        { cardId: 1, remoteTaskId: null, item: item() },
        { cardId: 2, remoteTaskId: null, item: item() },
      ],
      [row({ id: 1 }), row({ id: 2 })],
    );
    expect(new Set([m.get(1)?.id, m.get(2)?.id])).toEqual(new Set([1, 2]));
  });

  test("falls back to duration + type when that is unambiguous", () => {
    const m = matchDayRows(
      [{ cardId: 1, remoteTaskId: null, item: item({ title: "ชื่อที่ server ตัดคำ" }) }],
      [row({ id: 5, title: "ชื่อที่ server ตัดคำ…" })],
    );
    expect(m.get(1)?.id).toBe(5);
  });

  test("leaves a card unmatched rather than guessing between two rows", () => {
    const m = matchDayRows(
      [{ cardId: 1, remoteTaskId: null, item: item({ title: "x" }) }],
      [row({ id: 5, title: "a" }), row({ id: 6, title: "b" })],
    );
    expect(m.size).toBe(0);
  });
});
