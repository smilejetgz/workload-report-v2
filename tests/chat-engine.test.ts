import { describe, expect, test } from "vitest";
import type { ChatCardSnapshot } from "@/db/schema";
import {
  buildChatSystemPrompt,
  buildChatUserMessage,
  parseChatReply,
  parseScopeKey,
  scopeKeyOf,
  staleCards,
  validateChatOps,
  type ChatValidationContext,
  type RawChatOp,
} from "@/server/engine/chat";

const card = (over: Partial<ChatCardSnapshot> = {}): ChatCardSnapshot => ({
  id: 1,
  tasksDate: "2026-08-19",
  topic: "แยก discount",
  noteHtml: "<p><b>แยก discount</b></p>",
  taskType: "Ket-CMS",
  durationSec: 4 * 3600,
  status: "draft",
  remoteTaskId: null,
  updatedAt: 1000,
  ...over,
});

function ctx(over: Partial<ChatValidationContext> = {}): ChatValidationContext {
  const cards = [card(), card({ id: 2, topic: "ประชุม", taskType: "Meeting" })];
  return {
    cards: new Map(cards.map((c) => [c.id, c])),
    editableCardIds: new Set([1, 2]),
    creatableDates: new Set(["2026-08-19"]),
    targets: new Map([
      ["2026-08-19", 8 * 3600],
      ["2026-08-23", 0],
    ]),
    allowedTaskTypes: ["Ket-CMS", "Meeting"],
    knownCommitHashes: ["a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"],
    knownTaskRefs: ["DEV-6395", "86abc"],
    ...over,
  };
}

describe("scope keys", () => {
  test("round-trip the three kinds", () => {
    for (const key of ["range:2026-08-01:2026-08-31", "day:2026-08-19", "card:12"]) {
      const scope = parseScopeKey(key);
      expect(scope).not.toBeNull();
      expect(scopeKeyOf(scope!)).toBe(key);
    }
  });

  test("reject malformed keys", () => {
    for (const key of ["range:2026-08-31:2026-08-01", "day:19-08-2026", "card:x", "week:1", ""]) {
      expect(parseScopeKey(key)).toBeNull();
    }
  });
});

describe("validateChatOps — nothing reaches the user unchecked", () => {
  test("a pure text edit passes and is sanitised", () => {
    const raw: RawChatOp[] = [
      { op: "update", card_id: 1, note_html: '<p onclick="x()">ok</p><script>bad()</script>' },
    ];
    const { ops, issues } = validateChatOps(raw, ctx());
    expect(issues).toEqual([]);
    expect(ops).toHaveLength(1);
    const note = (ops[0] as { noteHtml: string }).noteHtml;
    expect(note).toContain("<p>ok</p>");
    expect(note).not.toMatch(/<script|onclick/);
  });

  test("moving hours between cards of a day keeps the day on target", () => {
    const { issues } = validateChatOps(
      [
        { op: "update", card_id: 1, hours: 5 },
        { op: "update", card_id: 2, hours: 3 },
      ],
      ctx(),
    );
    expect(issues).toEqual([]);
  });

  test("a change that breaks the day's target is refused", () => {
    const { issues } = validateChatOps([{ op: "update", card_id: 1, hours: 5 }], ctx());
    expect(issues.join(" ")).toMatch(/2026-08-19.*9.*8/);
  });

  test("adding a card must take its hours from another", () => {
    const create: RawChatOp = {
      op: "create",
      date: "2026-08-19",
      topic: "ประชุมทีม",
      note_html: "<p>x</p>",
      task_type: "meeting",
      hours: 1,
      evidence: { commits: [], tasks: [] },
    };
    expect(validateChatOps([create], ctx()).issues).toHaveLength(1);
    const { ops, issues } = validateChatOps(
      [create, { op: "update", card_id: 1, hours: 3 }],
      ctx(),
    );
    expect(issues).toEqual([]);
    // Case is normalised to the type's real name.
    expect(ops[0]).toMatchObject({ op: "create", taskType: "Meeting", durationSec: 3600 });
  });

  test("cards outside the scope are read-only", () => {
    const { issues } = validateChatOps(
      [{ op: "update", card_id: 2, topic: "x" }],
      ctx({ editableCardIds: new Set([1]) }),
    );
    expect(issues.join(" ")).toContain("#2");
  });

  test("no new cards on a date the scope does not cover, or on a day off", () => {
    const create = (date: string): RawChatOp => ({
      op: "create",
      date,
      topic: "x",
      note_html: "<p>x</p>",
      task_type: "Ket-CMS",
      hours: 1,
      evidence: { commits: [], tasks: [] },
    });
    expect(validateChatOps([create("2026-08-20")], ctx()).issues.join(" ")).toContain("2026-08-20");
    const offDay = validateChatOps(
      [create("2026-08-23")],
      ctx({ creatableDates: new Set(["2026-08-23"]) }),
    );
    expect(offDay.issues.join(" ")).toMatch(/วันหยุด/);
  });

  test("unknown task types, commits, tasks and odd hours are all named", () => {
    const { issues } = validateChatOps(
      [
        {
          op: "update",
          card_id: 1,
          task_type: "Nonexistent",
          evidence: { commits: ["deadbeef"], tasks: ["DEV-1"] },
        },
        { op: "update", card_id: 2, hours: 1.1 },
      ],
      ctx(),
    );
    const text = issues.join(" ");
    expect(text).toContain("Nonexistent");
    expect(text).toContain("deadbeef");
    expect(text).toContain("DEV-1");
    expect(text).toContain("1.1");
  });

  test("known evidence passes by short hash", () => {
    const { issues } = validateChatOps(
      [{ op: "update", card_id: 1, evidence: { commits: ["a1b2c3d4"], tasks: ["dev-6395"] } }],
      ctx(),
    );
    expect(issues).toEqual([]);
  });

  test("one card cannot be the target of two operations", () => {
    const { issues } = validateChatOps(
      [
        { op: "update", card_id: 1, topic: "a" },
        { op: "delete", card_id: 1 },
      ],
      ctx(),
    );
    expect(issues.join(" ")).toContain("ซ้ำ");
  });
});

describe("parseChatReply", () => {
  test("reads the reply and ops, tolerating fences", () => {
    const parsed = parseChatReply(
      '```json\n{"reply":"รวมให้แล้ว","ops":[{"op":"delete","card_id":3}]}\n```',
    );
    expect(parsed).toMatchObject({ reply: "รวมให้แล้ว", ops: [{ op: "delete", card_id: 3 }] });
  });

  test("a question with no ops is a valid answer", () => {
    expect(parseChatReply('{"reply":"หมายถึงวันไหน?"}')).toMatchObject({ reply: "หมายถึงวันไหน?", ops: [] });
  });

  test("garbage is an error", () => {
    expect(parseChatReply("sorry")).toHaveProperty("error");
  });
});

describe("prompt", () => {
  test("the system prompt is the same for every request", () => {
    expect(buildChatSystemPrompt(["Ket-CMS"])).toBe(buildChatSystemPrompt(["Ket-CMS"]));
  });

  test("the request marks what may change", () => {
    const message = buildChatUserMessage({
      scope: { kind: "card", cardId: 1 },
      days: [
        {
          date: "2026-08-19",
          targetSec: 8 * 3600,
          cards: [card(), card({ id: 2, remoteTaskId: "555" })],
          commits: [{ hash: "a1b2c3d4e5f6", hhmm: "10:30", project: "ketcms", subject: "fix" }],
          closedTasks: [],
        },
      ],
      editableCardIds: new Set([1]),
      creatableDates: new Set(),
      history: [{ role: "user", text: "สั้นลง" }],
      instruction: "เขียนใหม่",
      attachments: [
        { kind: "commit", hash: "a1b2c3d4e5f6", date: "2026-08-19", project: "ketcms", message: "fix" },
      ],
    });
    expect(message).toContain("card #1 [EDITABLE");
    expect(message).toContain("card #2 [read-only, on workload]");
    expect(message).not.toContain("CAN ADD");
    expect(message).toContain("User: สั้นลง");
    expect(message).toContain("possibly missed");
    expect(message.trim().endsWith("เขียนใหม่")).toBe(true);
  });
});

describe("staleCards", () => {
  test("flags cards edited, or deleted, after the proposal", () => {
    const before = [card({ id: 1, updatedAt: 1000 }), card({ id: 2, updatedAt: 1000 }), card({ id: 3 })];
    const current = new Map([
      [1, { updatedAt: 1000 }],
      [2, { updatedAt: 2000 }],
    ]);
    expect(staleCards(before, current)).toEqual([2, 3]);
  });
});
