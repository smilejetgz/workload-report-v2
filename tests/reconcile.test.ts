import { describe, expect, test } from "vitest";
import {
  planReconcile,
  type LocalCardLike,
  type RemoteTaskLike,
} from "@/server/engine/reconcile";

const local = (over: Partial<LocalCardLike> = {}): LocalCardLike => ({
  id: 1,
  tasksDate: "2026-08-19",
  durationSec: 7200,
  topic: "แยก discount",
  noteHtml: "<p><b>[DEV-6395] discount</b></p><ul><li>ทำ</li></ul>",
  taskType: "Ket-CMS",
  website: null,
  clickupTask: "DEV-6395",
  status: "submitted",
  remoteTaskId: "555",
  ...over,
});

const remote = (over: Partial<RemoteTaskLike> = {}): RemoteTaskLike => ({
  id: 555,
  legacyId: null,
  workDate: "2026-08-19",
  durationSec: 7200,
  title: "แยก discount",
  noteHtml: "<p><b>[DEV-6395] discount</b></p><ul><li>ทำ</li></ul>",
  taskType: "Ket-CMS",
  website: null,
  clickupTask: "DEV-6395",
  ...over,
});

describe("planReconcile — the list must match what is really on workload", () => {
  test("identical pair produces no action", () => {
    expect(planReconcile({ localCards: [local()], remoteTasks: [remote()] })).toEqual([]);
  });

  test("links a submitted card that has no remote id yet (matched by date+duration+note)", () => {
    const actions = planReconcile({
      localCards: [local({ remoteTaskId: null })],
      remoteTasks: [remote()],
    });
    expect(actions).toEqual([{ kind: "link", cardId: 1, remoteTaskId: "555" }]);
  });

  test("remote wins when a submitted card drifted from the real row", () => {
    const actions = planReconcile({
      localCards: [local()],
      remoteTasks: [remote({ durationSec: 10800, noteHtml: "<p>แก้จากหน้าเว็บ workload</p>" })],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "update-local",
      cardId: 1,
      fields: { durationSec: 10800, noteHtml: "<p>แก้จากหน้าเว็บ workload</p>" },
    });
  });

  test("does not overwrite a local edit that has not been pushed yet", () => {
    const actions = planReconcile({
      localCards: [local({ status: "failed", noteHtml: "<p>แก้ในแอป รอ push</p>" })],
      remoteTasks: [remote()],
    });
    expect(actions).toEqual([]);
  });

  test("imports rows that exist on workload but not locally", () => {
    const actions = planReconcile({
      localCards: [],
      remoteTasks: [remote({ id: 777, noteHtml: "<p>กรอกมือจากหน้าเว็บ</p>" })],
    });
    expect(actions).toEqual([{ kind: "import", remote: expect.objectContaining({ id: 777 }) }]);
  });

  test("flags a submitted card whose remote row is gone", () => {
    const actions = planReconcile({ localCards: [local()], remoteTasks: [] });
    expect(actions).toEqual([{ kind: "orphan", cardId: 1 }]);
  });

  test("drafts are left alone — they were never on workload", () => {
    const actions = planReconcile({
      localCards: [local({ status: "draft", remoteTaskId: null })],
      remoteTasks: [],
    });
    expect(actions).toEqual([]);
  });

  test("a draft is not linked to a remote row it happens to resemble", () => {
    const actions = planReconcile({
      localCards: [local({ status: "draft", remoteTaskId: null })],
      remoteTasks: [remote()],
    });
    expect(actions).toEqual([{ kind: "import", remote: expect.objectContaining({ id: 555 }) }]);
  });

  test("one remote row is never matched to two cards", () => {
    const actions = planReconcile({
      localCards: [local({ id: 1, remoteTaskId: null }), local({ id: 2, remoteTaskId: null })],
      remoteTasks: [remote()],
    });
    expect(actions.filter((a) => a.kind === "link")).toHaveLength(1);
    expect(actions.filter((a) => a.kind === "orphan")).toHaveLength(1);
  });

  test("a title edited on the website is taken back", () => {
    const actions = planReconcile({
      localCards: [local()],
      remoteTasks: [remote({ title: "ชื่อใหม่จากหน้าเว็บ" })],
    });
    expect(actions).toEqual([
      expect.objectContaining({ kind: "update-local", fields: expect.objectContaining({ topic: "ชื่อใหม่จากหน้าเว็บ" }) }),
    ]);
  });

  test("a topic that was only trimmed on upload is not drift", () => {
    const actions = planReconcile({
      localCards: [local({ topic: "  แยก   discount " })],
      remoteTasks: [remote()],
    });
    expect(actions).toEqual([]);
  });
});

describe("planReconcile — cards submitted to the old workload", () => {
  test("re-links a v1 id through the legacyId the migrated v2 row keeps", () => {
    const actions = planReconcile({
      localCards: [local({ remoteTaskId: "v1:34975" })],
      remoteTasks: [remote({ id: 9001, legacyId: 34975 })],
    });
    expect(actions).toEqual([{ kind: "link", cardId: 1, remoteTaskId: "9001" }]);
  });

  test("a v1 id is never matched to a v2 row that merely has the same number", () => {
    const actions = planReconcile({
      localCards: [local({ remoteTaskId: "v1:555", noteHtml: "<p>อย่างอื่น</p>" })],
      remoteTasks: [remote({ id: 555, legacyId: null })],
    });
    expect(actions).toContainEqual({ kind: "orphan", cardId: 1 });
    expect(actions).toContainEqual({ kind: "import", remote: expect.objectContaining({ id: 555 }) });
  });

  test("keeps the card's topic over the title the migration cut out of the note", () => {
    const actions = planReconcile({
      localCards: [local({ remoteTaskId: "9001" })],
      remoteTasks: [remote({ id: 9001, legacyId: 34975, title: "[DEV-6395] discountทำ" })],
    });
    expect(actions).toEqual([]);
  });

  test("a re-linked card that drifted takes the v2 values in the same pass", () => {
    const actions = planReconcile({
      localCards: [local({ remoteTaskId: "v1:34975" })],
      remoteTasks: [remote({ id: 9001, legacyId: 34975, durationSec: 3600 })],
    });
    expect(actions).toEqual([
      { kind: "link", cardId: 1, remoteTaskId: "9001" },
      expect.objectContaining({ kind: "update-local", remoteTaskId: "9001", fields: expect.objectContaining({ durationSec: 3600 }) }),
    ]);
  });
});

describe("planReconcile — remote notes are untrusted input", () => {
  // The note column is written by 30 employees through the workload website,
  // and the app renders it as HTML. It must never reach the DB raw.
  const XSS = '<p>ok</p><img src=x onerror="alert(1)">';

  test("sanitises the note it takes from workload", () => {
    const actions = planReconcile({
      localCards: [local()],
      remoteTasks: [remote({ noteHtml: XSS })],
    });
    const update = actions.find((a) => a.kind === "update-local");
    expect(update).toBeDefined();
    if (update?.kind !== "update-local") return;
    expect(update.fields.noteHtml).not.toContain("onerror");
    expect(update.fields.noteHtml).toContain("<p>ok</p>");
  });

  test("a note that only differs by markup we strip is not endless drift", () => {
    // Local already holds the sanitised form; the remote raw form must compare
    // equal, or every sync would rewrite the same card forever.
    const sanitised = "<p>ok</p>";
    const actions = planReconcile({
      localCards: [local({ noteHtml: sanitised })],
      remoteTasks: [remote({ noteHtml: '<p onclick="x()">ok</p>' })],
    });
    expect(actions).toEqual([]);
  });
});
