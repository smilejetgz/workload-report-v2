import { describe, expect, test } from "vitest";
import {
  extractJson,
  parseDayPlan,
  sanitizeNoteHtml,
  validateDayPlan,
  type DayPlan,
} from "@/server/engine/validator";

const validPlan = {
  date: "2026-08-03",
  cards: [
    {
      topic: "แยก discount ของ LineShop",
      task_type: "Ket-CMS",
      website: null,
      clickup_task: "DEV-6395",
      note_html: "<p><b>[DEV-6395] แยก discount</b></p><ul><li>แสดง discount LINE</li></ul>",
      hours: 2.5,
      time_of_day: "morning",
      origin: "git",
      evidence: { commits: ["a1b2c3d4"], tasks: ["DEV-6395"] },
      confidence: 0.9,
    },
  ],
  reviewer_notes: null,
};

describe("extractJson", () => {
  test("parses bare JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  test("parses JSON inside code fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test("parses JSON surrounded by prose", () => {
    expect(extractJson('Here you go:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  test("returns null for garbage", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});

describe("parseDayPlan", () => {
  test("accepts a valid plan", () => {
    const { plan, error } = parseDayPlan(JSON.stringify(validPlan));
    expect(error).toBeNull();
    expect(plan?.cards).toHaveLength(1);
  });

  test("rejects invalid hours", () => {
    const bad = { ...validPlan, cards: [{ ...validPlan.cards[0], hours: 20 }] };
    const { plan, error } = parseDayPlan(JSON.stringify(bad));
    expect(plan).toBeNull();
    expect(error).toBeTruthy();
  });

  test("applies defaults for optional fields", () => {
    const minimal = {
      date: "2026-08-03",
      cards: [
        {
          topic: "งานทั่วไป",
          task_type: "Ket-CMS",
          note_html: "<p>ทำงาน</p>",
          hours: 2,
        },
      ],
    };
    const { plan } = parseDayPlan(JSON.stringify(minimal));
    expect(plan?.cards[0].evidence).toEqual({ commits: [], tasks: [] });
    expect(plan?.cards[0].origin).toBe("git");
  });
});

describe("sanitizeNoteHtml", () => {
  test("keeps whitelisted tags", () => {
    const html = "<p><b>หัวข้อ</b></p><ul><li>รายการ <code>fn()</code></li></ul>";
    expect(sanitizeNoteHtml(html)).toBe(html);
  });

  test("strips script tags and attributes", () => {
    const dirty = '<p onclick="x()">ok</p><script>alert(1)</script><img src=x>';
    const clean = sanitizeNoteHtml(dirty);
    expect(clean).toContain("<p>ok</p>");
    expect(clean).not.toContain("script");
    expect(clean).not.toContain("img");
    expect(clean).not.toContain("onclick");
  });
});

describe("validateDayPlan", () => {
  const ctx = {
    date: "2026-08-03",
    allowedTaskTypes: ["Ket-CMS", "Meeting"],
    knownCommitHashes: ["a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"],
    knownTaskRefs: ["DEV-6395", "86czb2y7w"],
  };

  test("valid plan passes untouched", () => {
    const { plan, issues, needsRepair } = validateDayPlan(validPlan as DayPlan, ctx);
    expect(needsRepair).toBe(false);
    expect(issues).toEqual([]);
    expect(plan.cards[0].task_type).toBe("Ket-CMS");
  });

  test("normalizes task_type case-insensitively", () => {
    const p = {
      ...validPlan,
      cards: [{ ...validPlan.cards[0], task_type: "ket-cms" }],
    } as DayPlan;
    const { plan, needsRepair } = validateDayPlan(p, ctx);
    expect(plan.cards[0].task_type).toBe("Ket-CMS");
    expect(needsRepair).toBe(false);
  });

  test("unknown task_type flags repair", () => {
    const p = {
      ...validPlan,
      cards: [{ ...validPlan.cards[0], task_type: "Nonexistent" }],
    } as DayPlan;
    const { needsRepair, issues } = validateDayPlan(p, ctx);
    expect(needsRepair).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
  });

  test("strips hallucinated evidence but keeps real refs", () => {
    const p = {
      ...validPlan,
      cards: [
        {
          ...validPlan.cards[0],
          evidence: { commits: ["a1b2c3d4", "ffffffff"], tasks: ["DEV-6395", "FAKE-1"] },
        },
      ],
    } as DayPlan;
    const { plan, issues } = validateDayPlan(p, ctx);
    expect(plan.cards[0].evidence.commits).toEqual(["a1b2c3d4"]);
    expect(plan.cards[0].evidence.tasks).toEqual(["DEV-6395"]);
    expect(issues.length).toBe(2);
  });

  test("fixes wrong date silently", () => {
    const p = { ...validPlan, date: "2026-08-04" } as DayPlan;
    const { plan, needsRepair } = validateDayPlan(p, ctx);
    expect(plan.date).toBe("2026-08-03");
    expect(needsRepair).toBe(false);
  });

  test("more than 5 cards flags repair", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      ...validPlan.cards[0],
      topic: `งาน ${i}`,
    }));
    const { needsRepair } = validateDayPlan({ ...validPlan, cards: many } as DayPlan, ctx);
    expect(needsRepair).toBe(true);
  });
});

describe("validateDayPlan — commit coverage (commits are the real work)", () => {
  const HASH_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const HASH_B = "ffee0011223344556677889900aabbccddeeff00";
  const ctx = {
    date: "2026-08-03",
    allowedTaskTypes: ["Ket-CMS", "Meeting"],
    knownCommitHashes: [HASH_A, HASH_B],
    knownTaskRefs: ["DEV-6395", "86czb2y7w"],
    dayCommitHashes: [HASH_A, HASH_B],
  };

  test("flags repair when a commit of the day is left out", () => {
    const { needsRepair, issues } = validateDayPlan(validPlan as DayPlan, ctx);
    expect(needsRepair).toBe(true);
    expect(issues.join(" ")).toContain("ffee0011");
  });

  test("passes when every commit is covered by some card", () => {
    const p = {
      ...validPlan,
      cards: [
        validPlan.cards[0],
        {
          ...validPlan.cards[0],
          topic: "งานที่สอง",
          evidence: { commits: [HASH_B], tasks: [] },
        },
      ],
    } as DayPlan;
    const { needsRepair, issues } = validateDayPlan(p, ctx);
    expect(issues).toEqual([]);
    expect(needsRepair).toBe(false);
  });

  test("flags repair when a day with commits has no git-origin card", () => {
    const p = {
      ...validPlan,
      cards: [
        { ...validPlan.cards[0], origin: "clickup", evidence: { commits: [], tasks: ["DEV-6395"] } },
        { ...validPlan.cards[0], topic: "อื่น ๆ", origin: "clickup", evidence: { commits: [], tasks: [] } },
      ],
    } as DayPlan;
    const { needsRepair, issues } = validateDayPlan(p, ctx);
    expect(needsRepair).toBe(true);
    expect(issues.some((i) => /git/i.test(i))).toBe(true);
  });

  test("no commits that day → no coverage requirement", () => {
    const p = {
      ...validPlan,
      cards: [{ ...validPlan.cards[0], origin: "clickup", evidence: { commits: [], tasks: ["DEV-6395"] } }],
    } as DayPlan;
    const { needsRepair, issues } = validateDayPlan(p, {
      ...ctx,
      knownCommitHashes: [],
      dayCommitHashes: [],
    });
    expect(issues).toEqual([]);
    expect(needsRepair).toBe(false);
  });
});

describe("validateDayPlan — the note has to read as work, not as code", () => {
  const ctx = {
    date: "2026-08-03",
    allowedTaskTypes: ["Ket-CMS"],
    knownCommitHashes: [],
    knownTaskRefs: [],
  };
  // No evidence refs here: this block is about wording, and unknown refs would
  // raise issues of their own.
  const withNote = (noteHtml: string) =>
    ({
      ...validPlan,
      cards: [
        {
          ...validPlan.cards[0],
          note_html: noteHtml,
          clickup_task: null,
          evidence: { commits: [], tasks: [] },
        },
      ],
    }) as DayPlan;

  test("a plain-language note passes untouched", () => {
    const { needsRepair, issues } = validateDayPlan(
      withNote("<p><b>[DEV-1] แก้ที่อยู่ออเดอร์</b></p><ul><li>ลูกค้าแก้ที่อยู่เองได้แล้ว</li></ul>"),
      ctx,
    );
    expect(issues).toEqual([]);
    expect(needsRepair).toBe(false);
  });

  // HR reads these reports. A function name tells them nothing about the work.
  test("an identifier copied out of the code is sent back for a rewrite", () => {
    const { needsRepair, issues } = validateDayPlan(
      withNote("<p><b>งาน</b></p><ul><li>ปรับเงื่อนไขใน edit_order_shipping_address</li></ul>"),
      ctx,
    );
    expect(needsRepair).toBe(true);
    expect(issues.join(" ")).toContain("edit_order_shipping_address");
  });

  test("a file path is sent back too", () => {
    const { needsRepair } = validateDayPlan(
      withNote("<p><b>งาน</b></p><ul><li>แก้ src/app/order/list.ts ให้กรองถูก</li></ul>"),
      ctx,
    );
    expect(needsRepair).toBe(true);
  });

  test("a function call is sent back too", () => {
    const { needsRepair } = validateDayPlan(
      withNote("<p><b>งาน</b></p><ul><li>เรียก createOrder() ซ้ำ</li></ul>"),
      ctx,
    );
    expect(needsRepair).toBe(true);
  });

  // Product names are what HR actually recognises — they must survive.
  test("product and feature names are not treated as code", () => {
    const { needsRepair, issues } = validateDayPlan(
      withNote(
        "<p><b>Ket-CMS</b></p><ul><li>เชื่อม LINE OA กับ ClickUp ให้ LineShop ใช้ได้</li></ul>",
      ),
      ctx,
    );
    expect(issues).toEqual([]);
    expect(needsRepair).toBe(false);
  });

  test("an English word on its own is fine", () => {
    const { needsRepair } = validateDayPlan(
      withNote("<p><b>งาน</b></p><ul><li>เพิ่มปุ่ม export ในหน้า order</li></ul>"),
      ctx,
    );
    expect(needsRepair).toBe(false);
  });
});
