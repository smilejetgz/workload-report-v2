import { afterEach, describe, expect, test, vi } from "vitest";
import {
  allowedTaskTypes,
  clickupTaskIdForUpload,
  jwtIdentity,
  listMyTasks,
  matchProject,
  titleForUpload,
  v2TaskId,
  type RemoteTaskType,
} from "@/server/sources/workload";

const type = (id: number, positionIds: number[], isActive = true): RemoteTaskType => ({
  id,
  name: `type-${id}`,
  color: null,
  isActive,
  sortOrder: id,
  positionIds,
});

describe("allowedTaskTypes — the same rule the server enforces on write", () => {
  const types = [type(1, [10]), type(2, [20]), type(3, []), type(4, [10], false)];

  test("only active types linked to a held position", () => {
    expect(allowedTaskTypes(types, [10]).map((t) => t.id)).toEqual([1]);
  });

  test("no position at all may log every active type", () => {
    expect(allowedTaskTypes(types, []).map((t) => t.id)).toEqual([1, 2, 3]);
  });

  test("a held position no type is linked to may log every active type", () => {
    expect(allowedTaskTypes(types, [99]).map((t) => t.id)).toEqual([1, 2, 3]);
  });
});

describe("matchProject — card website/project text → v2 project", () => {
  const projects = [
    { id: 1, name: "Ket Shop", websiteUrl: "https://www.ketshop.co/", isActive: true },
    { id: 2, name: "Old", websiteUrl: "https://old.example", isActive: false },
  ];

  test("by project name, ignoring case", () => {
    expect(matchProject("ket shop", projects)?.id).toBe(1);
  });

  test("by website host", () => {
    expect(matchProject("ketshop.co", projects)?.id).toBe(1);
    expect(matchProject("http://ketshop.co/admin", projects)?.id).toBe(1);
  });

  test("never a closed project, never a guess", () => {
    expect(matchProject("old.example", projects)).toBeNull();
    expect(matchProject("unknown", projects)).toBeNull();
    expect(matchProject(null, projects)).toBeNull();
  });
});

describe("field mapping", () => {
  test("ClickUp ids the server accepts; anything else is left out rather than 400 the day", () => {
    expect(clickupTaskIdForUpload("DEV-6395")).toBe("DEV-6395");
    expect(clickupTaskIdForUpload("https://app.clickup.com/t/86abc123")).toBe("86abc123");
    expect(clickupTaskIdForUpload("https://app.clickup.com/t/9018/DEV-1")).toBe("DEV-1");
    expect(clickupTaskIdForUpload("not an id")).toBeNull();
    expect(clickupTaskIdForUpload("")).toBeNull();
  });

  test("title is trimmed and fits varchar(255)", () => {
    expect(titleForUpload("  a   b ")).toBe("a b");
    expect(titleForUpload("x".repeat(300))).toHaveLength(255);
    expect(titleForUpload("   ")).toBeUndefined();
  });

  test("only a plain number is a v2 task id", () => {
    expect(v2TaskId("555")).toBe(555);
    expect(v2TaskId("v1:555")).toBeNull();
    expect(v2TaskId(null)).toBeNull();
  });
});

describe("jwtIdentity", () => {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");

  test("reads the v2 claims", () => {
    const jwt = `${b64({})}.${b64({ sub: 7, email: "me@ket.com", name: "Me", role: "staff" })}.x`;
    expect(jwtIdentity(jwt)).toEqual({ userId: 7, email: "me@ket.com", name: "Me", role: "staff" });
  });

  test("a token without a numeric sub is not a v2 token", () => {
    expect(jwtIdentity(`${b64({})}.${b64({ email: "me@ket.com" })}.x`)).toBeNull();
    expect(jwtIdentity("garbage")).toBeNull();
  });
});

describe("listMyTasks", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("follows pages and keeps only the caller's own hours", async () => {
    const row = (id: number) => ({
      id,
      workDate: "2026-08-19",
      title: `t${id}`,
      agendaNote: null,
      taskTypeId: 11,
      projectId: null,
      clickupTaskId: null,
      legacyId: id === 1 ? 34975 : null,
      assignees: [
        { userId: 3, durationSec: 999 },
        { userId: 7, durationSec: 1800 },
      ],
    });
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const offset = Number(new URL(url).searchParams.get("offset"));
        const items = offset === 0 ? Array.from({ length: 500 }, (_, i) => row(i + 1)) : [row(501)];
        return new Response(JSON.stringify({ items, total: 501, limit: 500, offset }));
      }),
    );

    const res = await listMyTasks({ jwt: "x", userId: 7, from: "2026-08-01", to: "2026-08-31" });

    expect(res.ok).toBe(true);
    expect(res.data).toHaveLength(501);
    expect(res.data[0]).toEqual({
      id: 1,
      workDate: "2026-08-19",
      durationSec: 1800,
      title: "t1",
      noteHtml: "",
      taskTypeId: 11,
      projectId: null,
      clickupTaskId: null,
      legacyId: 34975,
    });
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]).searchParams.get("user_ids")).toBe("7");
  });
});
