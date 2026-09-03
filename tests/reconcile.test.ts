import { describe, expect, test } from "vitest";
import {
  decideWriteOutcome,
  planReconcile,
  type LocalCardLike,
  type RemoteTaskLike,
} from "@/server/engine/reconcile";

const local = (over: Partial<LocalCardLike> = {}): LocalCardLike => ({
  id: 1,
  tasksDate: "2026-08-19",
  durationSec: 7200,
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
  tasks_date: "2026-08-19",
  duration: 7200,
  note: "<p><b>[DEV-6395] discount</b></p><ul><li>ทำ</li></ul>",
  task_type: "Ket-CMS",
  website: null,
  clickup_task: "DEV-6395",
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
      remoteTasks: [remote({ duration: 10800, note: "<p>แก้จากหน้าเว็บ workload</p>" })],
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
      remoteTasks: [remote({ id: 777, note: "<p>กรอกมือจากหน้าเว็บ</p>" })],
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

  test("string durations from the API are compared numerically", () => {
    const actions = planReconcile({
      localCards: [local()],
      remoteTasks: [remote({ duration: "7200" })],
    });
    expect(actions).toEqual([]);
  });
});

describe("decideWriteOutcome — 0 rows affected is ambiguous", () => {
  test("rows affected > 0 is unambiguously fine", () => {
    expect(decideWriteOutcome({ affected: 1, rowStillOnRemote: null })).toBe("ok");
  });

  test("0 rows but the row is still there = a no-op write, not a failure", () => {
    expect(decideWriteOutcome({ affected: 0, rowStillOnRemote: true })).toBe("ok");
  });

  test("0 rows and the row is gone = the remote row was deleted", () => {
    expect(decideWriteOutcome({ affected: 0, rowStillOnRemote: false })).toBe("row-missing");
  });

  test("0 rows and the check failed = do not guess", () => {
    expect(decideWriteOutcome({ affected: 0, rowStillOnRemote: null })).toBe("unknown");
  });
});

describe("planReconcile — remote notes are untrusted input", () => {
  // The note column is written by 30 employees through the workload website,
  // and the app renders it as HTML. It must never reach the DB raw.
  const XSS = '<p>ok</p><img src=x onerror="alert(1)">';

  test("sanitises the note it takes from workload", () => {
    const actions = planReconcile({
      localCards: [local()],
      remoteTasks: [remote({ note: XSS })],
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
      remoteTasks: [remote({ note: '<p onclick="x()">ok</p>' })],
    });
    expect(actions).toEqual([]);
  });
});
