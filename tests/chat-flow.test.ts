import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const DB_PATH = path.join(os.tmpdir(), `workload-v2-chat-${process.pid}.db`);
process.env.WORKLOAD_DB_PATH = DB_PATH;

const { getDb, schema } = await import("@/db/client");
const { setSetting } = await import("@/server/settings");
const { applyProposal, discardProposal, sendChatMessage } = await import("@/server/chat");
const { FakeProvider } = await import("@/server/ai/fake");

const DATE = "2026-08-19"; // a Wednesday — default 8h target

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
const JWT = `${b64({})}.${b64({ sub: 7, email: "me@ket.com", name: "Me", role: "staff" })}.sig`;

function card(over: Partial<typeof schema.cards.$inferInsert> = {}) {
  return getDb()
    .insert(schema.cards)
    .values({
      tasksDate: DATE,
      durationSec: 4 * 3600,
      topic: "แยก discount",
      noteHtml: "<p><b>แยก discount</b></p>",
      taskType: "Ket-CMS",
      origin: "git",
      confidence: 0.9,
      evidence: { commits: [], tasks: [] },
      fingerprint: `fp-${Math.random()}`,
      status: "draft",
      updatedAt: new Date(1_000_000),
      ...over,
    })
    .returning()
    .get();
}

const reload = (id: number) =>
  getDb().select().from(schema.cards).where(eq(schema.cards.id, id)).get();

const reply = (ops: unknown[], text = "แก้ให้แล้ว") => JSON.stringify({ reply: text, ops });

beforeEach(() => {
  for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(DB_PATH + suffix, { force: true });
  delete (globalThis as { __workloadDb?: unknown }).__workloadDb;
  getDb()
    .insert(schema.taskTypes)
    .values([
      { id: 11, name: "Ket-CMS" },
      { id: 12, name: "Meeting" },
    ])
    .run();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(() => {
  for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe("sendChatMessage", () => {
  test("stores the request and a checked proposal; nothing changes yet", async () => {
    const a = card();
    const b = card({ topic: "ประชุม", taskType: "Meeting" });
    const ai = new FakeProvider();
    ai.enqueue(reply([{ op: "update", card_id: a.id, topic: "แยก discount ตามสาขา" }]));

    const { messages } = await sendChatMessage(
      { scopeKey: `day:${DATE}`, text: "หัวข้อแรกให้ชัดขึ้น" },
      ai,
    );

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const proposal = messages[1];
    expect(proposal.proposalStatus).toBe("pending");
    expect(proposal.proposal?.ops).toEqual([
      { op: "update", cardId: a.id, topic: "แยก discount ตามสาขา" },
    ]);
    expect(proposal.proposal?.before.map((c) => c.id)).toEqual([a.id]);
    expect(reload(a.id)?.topic).toBe("แยก discount");
    // The instructions travel as the cached system prompt, the day as the message.
    expect(ai.systems[0]).toContain("task_type MUST be exactly one of: Ket-CMS, Meeting");
    expect(ai.prompts[0]).toContain(`card #${b.id} [EDITABLE`);
    expect(ai.closed).toBe(1);
  });

  test("an answer that breaks a rule goes back to the AI with the reasons", async () => {
    const a = card();
    card();
    const ai = new FakeProvider();
    ai.enqueue(
      reply([{ op: "update", card_id: a.id, hours: 5 }]),
      reply([{ op: "update", card_id: a.id, topic: "ok" }]),
    );

    const { messages } = await sendChatMessage({ scopeKey: `day:${DATE}`, text: "x" }, ai);

    expect(ai.prompts).toHaveLength(2);
    expect(ai.prompts[1]).toMatch(/rejected[\s\S]*เป้าคือ 8/);
    expect(messages[1].proposal?.ops).toEqual([{ op: "update", cardId: a.id, topic: "ok" }]);
  });

  test("gives up after three bad answers and says so", async () => {
    const a = card();
    const ai = new FakeProvider();
    ai.respondWith(() => reply([{ op: "update", card_id: a.id, hours: 5 }]));

    const { messages } = await sendChatMessage({ scopeKey: `day:${DATE}`, text: "x" }, ai);

    expect(ai.prompts).toHaveLength(3);
    expect(messages[1].error).toMatch(/เป้า/);
    expect(messages[1].proposal).toBeNull();
  });

  test("the card scope cannot reach the other cards of the day", async () => {
    const a = card();
    const b = card();
    const ai = new FakeProvider();
    ai.respondWith(() => reply([{ op: "update", card_id: b.id, topic: "x" }]));

    const { messages } = await sendChatMessage({ scopeKey: `card:${a.id}`, text: "x" }, ai);

    expect(ai.prompts[0]).toContain(`card #${b.id} [read-only`);
    expect(messages[1].error).toContain(`#${b.id}`);
  });

  test("the conversation continues in the same thread with history", async () => {
    card();
    const ai = new FakeProvider();
    ai.enqueue(reply([], "หมายถึงรายการไหน?"), reply([], "ok"));
    await sendChatMessage({ scopeKey: `day:${DATE}`, text: "สั้นลง" }, ai);
    const { messages } = await sendChatMessage({ scopeKey: `day:${DATE}`, text: "รายการแรก" }, ai);
    expect(messages).toHaveLength(4);
    expect(ai.prompts[1]).toContain("You: หมายถึงรายการไหน?");
  });
});

describe("applyProposal", () => {
  async function propose(ops: unknown[]) {
    const ai = new FakeProvider();
    ai.enqueue(reply(ops));
    const { messages } = await sendChatMessage({ scopeKey: `day:${DATE}`, text: "x" }, ai);
    const message = messages.at(-1)!;
    expect(message.error).toBeNull();
    return message.id;
  }

  test("applies updates, creates and deletes to local cards", async () => {
    const a = card();
    const b = card({ topic: "ทิ้ง" });
    const id = await propose([
      { op: "update", card_id: a.id, hours: 7 },
      { op: "delete", card_id: b.id },
      {
        op: "create",
        date: DATE,
        topic: "ประชุมทีม",
        note_html: "<p>ประชุม</p>",
        task_type: "Meeting",
        hours: 1,
      },
    ]);

    const result = await applyProposal(id);

    expect(result).toEqual({ applied: 3, failed: [] });
    expect(reload(a.id)?.durationSec).toBe(7 * 3600);
    expect(reload(b.id)).toBeUndefined();
    const created = getDb().select().from(schema.cards).all().find((c) => c.topic === "ประชุมทีม");
    expect(created).toMatchObject({ status: "draft", durationSec: 3600, taskType: "Meeting" });
    await expect(applyProposal(id)).rejects.toThrow(/ใช้ไปแล้ว/);
  });

  test("refuses when a card changed after the proposal", async () => {
    const a = card();
    card();
    const id = await propose([{ op: "update", card_id: a.id, topic: "ใหม่" }]);
    getDb()
      .update(schema.cards)
      .set({ topic: "แก้มือ", updatedAt: new Date(2_000_000) })
      .where(eq(schema.cards.id, a.id))
      .run();

    await expect(applyProposal(id)).rejects.toThrow(/ถูกแก้ไปหลังจาก AI เสนอ/);
    expect(reload(a.id)?.topic).toBe("แก้มือ");
  });

  test("a submitted card is changed on workload too", async () => {
    setSetting("jwt", JWT);
    const a = card({ status: "submitted", remoteTaskId: "555" });
    card({ status: "submitted", remoteTaskId: "556" });
    const calls: { path: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const { pathname } = new URL(url);
        calls.push({ path: pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (pathname.endsWith("/task-types")) {
          return new Response(JSON.stringify([{ id: 11, name: "Ket-CMS", isActive: true }]));
        }
        if (pathname.endsWith("/projects")) return new Response("[]");
        return new Response(JSON.stringify({ created: [], updated: [555], removed: [] }));
      }),
    );
    const id = await propose([{ op: "update", card_id: a.id, topic: "หัวข้อใหม่" }]);

    const result = await applyProposal(id);

    expect(result.failed).toEqual([]);
    const batch = calls.find((c) => c.path.endsWith("/tasks/batch"));
    expect(batch?.body).toMatchObject({ workDate: DATE, items: [{ taskId: 555, title: "หัวข้อใหม่" }] });
    expect(reload(a.id)).toMatchObject({ topic: "หัวข้อใหม่", status: "submitted" });
  });

  test("a failed workload sync keeps the edit, marks the card failed and reports it", async () => {
    setSetting("jwt", JWT);
    const a = card({ status: "submitted", remoteTaskId: "555" });
    card({ status: "submitted", remoteTaskId: "556" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const { pathname } = new URL(url);
        if (pathname.endsWith("/task-types")) {
          return new Response(JSON.stringify([{ id: 11, name: "Ket-CMS", isActive: true }]));
        }
        if (pathname.endsWith("/projects")) return new Response("[]");
        return new Response(JSON.stringify({ message: "แก้ได้เฉพาะ 7 วันล่าสุด" }), { status: 423 });
      }),
    );
    const id = await propose([{ op: "update", card_id: a.id, topic: "หัวข้อใหม่" }]);

    const result = await applyProposal(id);

    expect(result.failed.join(" ")).toContain("แก้ได้เฉพาะ 7 วันล่าสุด");
    expect(reload(a.id)).toMatchObject({ topic: "หัวข้อใหม่", status: "failed" });
    const message = getDb().select().from(schema.chatMessages).where(eq(schema.chatMessages.id, id)).get();
    expect(message?.applyNote).toContain("423");
  });

  test("discard leaves the cards alone", async () => {
    const a = card();
    card();
    const id = await propose([{ op: "update", card_id: a.id, topic: "ใหม่" }]);
    discardProposal(id);
    expect(reload(a.id)?.topic).toBe("แยก discount");
    await expect(applyProposal(id)).rejects.toThrow(/ทิ้งไปแล้ว/);
  });
});
