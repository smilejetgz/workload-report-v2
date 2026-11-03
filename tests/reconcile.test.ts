import { describe, expect, test } from "vitest";
import {
  noteHtmlFromRemote,
  planReconcile,
  topicForImport,
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
  title: "แยก discount",
  note: "<p><b>[DEV-6395] discount</b></p><ul><li>ทำ</li></ul>",
  taskType: "Ket-CMS",
  durationSec: 7200,
  website: null,
  clickupTask: "DEV-6395",
  ...over,
});

describe("planReconcile — the list must match what is really on workload", () => {
  test("identical pair produces no action", () => {
    expect(planReconcile({ localCards: [local()], remoteTasks: [remote()] })).toEqual([]);
  });

  test("a note the site holds as plain text with the same words is not drift", () => {
    const actions = planReconcile({
      localCards: [local()],
      remoteTasks: [remote({ note: "[DEV-6395] discount\n- ทำ" })],
    });
    expect(actions).toEqual([]);
  });

  // The migration kept the old id as legacyId and set the title to the note's
  // text with the spaces squeezed out. Those rows must pair with the cards
  // uploaded to the old system, and must not count as drift.
  test("a card holding the old id is linked through legacyId and moved to the new id", () => {
    const migrated = remote({
      id: 56966,
      legacyId: 555,
      title: "[DEV-6395]discountทำ",
    });
    const actions = planReconcile({ localCards: [local()], remoteTasks: [migrated] });
    expect(actions).toEqual([{ kind: "link", cardId: 1, remoteTaskId: "56966" }]);
  });

  test("a migrated title cut off at the column limit still counts as an echo", () => {
    const note =
      "<p><b>[ISSUE-7531] เพิ่ม flow confirm free_item หมดสต็อก</b></p><ul><li>เพิ่ม confirm_free_item_out_of_stock ให้ order-link รองรับ resubmit</li></ul>";
    const migrated = remote({
      id: 56966,
      legacyId: 555,
      note,
      title: "[ISSUE-7531] เพิ่ม flow confirm free_item หมดสต็อก เพิ่ม confirm_free_item_out_of_stock ให้",
    });
    const card = local({ topic: "เพิ่ม flow ยืนยันของแถมหมดสต็อก", noteHtml: note });
    expect(planReconcile({ localCards: [card], remoteTasks: [migrated] })).toEqual([
      { kind: "link", cardId: 1, remoteTaskId: "56966" },
    ]);
  });

  test("a short real title that happens to start the note is still a title", () => {
    const actions = planReconcile({
      localCards: [local({ topic: "อื่น" })],
      remoteTasks: [remote({ title: "[DEV-6395]" })],
    });
    expect(actions[0]).toMatchObject({ kind: "update-local", fields: { topic: "[DEV-6395]" } });
  });

  test("a migrated title that merely echoes the note keeps the card's own topic", () => {
    const migrated = remote({ id: 56966, legacyId: 555, title: "[DEV-6395]discountทำ", durationSec: 3600 });
    const actions = planReconcile({ localCards: [local()], remoteTasks: [migrated] });
    const update = actions.find((a) => a.kind === "update-local");
    expect(update).toMatchObject({ fields: { durationSec: 3600, topic: "แยก discount" } });
  });

  test("links a submitted card that has no remote id yet (matched by date+duration+title)", () => {
    const actions = planReconcile({
      localCards: [local({ remoteTaskId: null })],
      remoteTasks: [remote()],
    });
    expect(actions).toEqual([{ kind: "link", cardId: 1, remoteTaskId: "555" }]);
  });

  test("remote wins when a submitted card drifted from the real row", () => {
    const actions = planReconcile({
      localCards: [local()],
      remoteTasks: [remote({ durationSec: 10800, title: "แก้จากหน้าเว็บ", note: "แก้จากหน้าเว็บ workload" })],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "update-local",
      cardId: 1,
      fields: {
        durationSec: 10800,
        topic: "แก้จากหน้าเว็บ",
        noteHtml: "<p>แก้จากหน้าเว็บ workload</p>",
      },
    });
  });

  test("an HTML note edited on the site comes back sanitised", () => {
    const actions = planReconcile({
      localCards: [local()],
      remoteTasks: [remote({ note: '<p>แก้แล้ว</p><script>alert(1)</script>' })],
    });
    expect(actions[0]).toMatchObject({
      kind: "update-local",
      fields: { noteHtml: "<p>แก้แล้ว</p>alert(1)" },
    });
  });

  test("keeps the card's own markup when only other fields drifted", () => {
    const actions = planReconcile({
      localCards: [local()],
      remoteTasks: [remote({ durationSec: 3600 })],
    });
    expect(actions[0]).toMatchObject({
      kind: "update-local",
      fields: { durationSec: 3600, noteHtml: local().noteHtml },
    });
  });

  test("website is compared as a host, not as the typed URL", () => {
    const actions = planReconcile({
      localCards: [local({ website: "https://pet-vet-store.com/" })],
      remoteTasks: [remote({ website: "pet-vet-store.com" })],
    });
    expect(actions).toEqual([]);
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
      remoteTasks: [remote({ id: 777, title: "กรอกมือจากหน้าเว็บ" })],
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
});

describe("remote notes are untrusted input", () => {
  // The note box is typed into by 30 employees on the website and the app
  // renders notes as HTML. Markup from the site must never run here.
  const XSS = '<p>ok</p><img src=x onerror="alert(1)">';

  test("an HTML note keeps the allowed tags and drops the rest", () => {
    const html = noteHtmlFromRemote(XSS);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).toContain("<p>ok</p>");
  });

  test("a plain-text note is escaped and shaped into paragraphs", () => {
    expect(noteHtmlFromRemote("หัวข้อ\n- ก")).toBe("<p><b>หัวข้อ</b></p><ul><li>ก</li></ul>");
    expect(noteHtmlFromRemote("2 < 3")).toBe("<p>2 &lt; 3</p>");
  });

  test("topicForImport reads a headline out of a migrated echo title", () => {
    expect(topicForImport(remote({ title: "[DEV-6395]discountทำ" }))).toBe("[DEV-6395] discount");
    expect(topicForImport(remote({ title: "  ชื่อจริง  " }))).toBe("ชื่อจริง");
    expect(topicForImport(remote({ title: "", note: "" }))).toBe("งานจาก workload");
  });

  test("update-local carries the escaped form", () => {
    const actions = planReconcile({
      localCards: [local()],
      remoteTasks: [remote({ note: XSS })],
    });
    const update = actions.find((a) => a.kind === "update-local");
    expect(update).toBeDefined();
    if (update?.kind !== "update-local") return;
    expect(update.fields.noteHtml).not.toContain("<img");
  });
});
