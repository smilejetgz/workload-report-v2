import { describe, expect, test } from "vitest";
import { normalizePayload, payloadFromTranscript } from "@/server/sources/clickup-mcp";

describe("normalizePayload", () => {
  test("normalizes verbatim connector output (epoch strings, nested objects)", () => {
    const payload = normalizePayload({
      user_id: 89097306,
      tasks: [
        {
          id: "86d42gkvq",
          custom_id: "DEV-6836",
          name: "50. Line ไม่ได้รับข้อความ",
          status: "Closed",
          url: "https://app.clickup.com/t/86d42gkvq",
          priority: null,
          assignees: [{ id: 89097306, username: "Tirajet Chukleang" }],
          tags: [{ name: "cms" }],
          due_date: null,
          date_closed: "1787113189284",
          list: { id: "901606107254", name: "v. 8.7.5 (Est 18 Aug)" },
        },
      ],
      comments: [
        {
          task_id: "86d42gkvq",
          id: "c1",
          comment_text: "เทสแล้วผ่าน",
          user: { id: 89097306, username: "Tirajet" },
          date: "1787113000000",
        },
      ],
    });
    expect(payload).not.toBeNull();
    const task = payload!.tasks[0];
    expect(task.custom_id).toBe("DEV-6836");
    expect(task.status).toEqual({ status: "Closed", type: "done" });
    expect(task.list).toEqual({ name: "v. 8.7.5 (Est 18 Aug)" });
    expect(task.date_closed).toBe("1787113189284");
    expect(task.assignees).toEqual([{ id: 89097306, username: "" }]);
    expect(payload!.comments[0]).toMatchObject({
      taskId: "86d42gkvq",
      comment: { comment_text: "เทสแล้วผ่าน", date: "1787113000000" },
    });
  });

  test("accepts ISO dates and plain shapes, infers open status", () => {
    const payload = normalizePayload({
      user_id: null,
      tasks: [
        {
          id: 123,
          name: "งานเปิดอยู่",
          status: { status: "in progress" },
          assignees: [89097306],
          tags: ["backend"],
          list: "Sprint 42",
          date_updated: "2026-08-19T10:00:00Z",
        },
      ],
      comments: [],
    });
    const task = payload!.tasks[0];
    expect(task.id).toBe("123");
    expect(task.status).toEqual({ status: "in progress", type: "custom" });
    expect(task.tags).toEqual([{ name: "backend" }]);
    expect(task.date_updated).toBe(String(Date.parse("2026-08-19T10:00:00Z")));
  });

  test("drops malformed rows and dedupes, without failing the batch", () => {
    const payload = normalizePayload({
      tasks: [
        { id: "a1", name: "ok" },
        { id: "a1", name: "duplicate" },
        { name: "missing id" },
        "garbage",
      ],
      comments: [{ task_id: "a1", date: "not-a-date", comment_text: "x" }],
    });
    expect(payload!.tasks).toHaveLength(1);
    expect(payload!.comments).toHaveLength(0);
    expect(payload!.dropped).toBe(3);
  });

  test("returns null when the top-level shape is wrong", () => {
    expect(normalizePayload({ tasks: "nope" })).toBeNull();
    expect(normalizePayload(null)).toBeNull();
  });
});

describe("payloadFromTranscript", () => {
  const line = (obj: unknown) => JSON.stringify(obj);

  function transcript(): string {
    return [
      line({ type: "system", subtype: "init" }),
      line({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "mcp__claude_ai_ClickUp__clickup_resolve_assignees",
              input: { names: ["me"] },
            },
          ],
        },
      }),
      line({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: JSON.stringify({ users: [{ id: 89097306 }] }) }],
            },
          ],
        },
      }),
      line({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t2",
              name: "mcp__claude_ai_ClickUp__clickup_filter_tasks",
              input: { assignees: ["89097306"] },
            },
            {
              type: "tool_use",
              id: "t3",
              name: "mcp__claude_ai_ClickUp__clickup_get_task_comments",
              input: { task_id: "86dx1" },
            },
          ],
        },
      }),
      line({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t2",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    tasks: [
                      {
                        id: "86dx1",
                        custom_id: "DEV-1",
                        name: "งาน",
                        status: "Closed",
                        date_closed: "1787113189284",
                      },
                    ],
                  }),
                },
              ],
            },
            {
              type: "tool_result",
              tool_use_id: "t3",
              content: JSON.stringify({
                comments: [{ id: "c1", comment_text: "ok", user: { id: 89097306 }, date: "1787113000000" }],
              }),
            },
          ],
        },
      }),
      line({ type: "result", result: "done" }),
      "not-json-garbage",
    ].join("\n");
  }

  test("extracts user id, tasks, and comments from tool results", () => {
    const payload = payloadFromTranscript(transcript());
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe(89097306);
    expect(payload!.tasks).toHaveLength(1);
    expect(payload!.tasks[0].custom_id).toBe("DEV-1");
    expect(payload!.comments).toHaveLength(1);
    // comment inherits task_id from the tool_use input
    expect(payload!.comments[0].taskId).toBe("86dx1");
  });

  test("returns null when no tool results appear", () => {
    expect(payloadFromTranscript('{"type":"result","result":"done"}\n')).toBeNull();
    expect(payloadFromTranscript("")).toBeNull();
  });
});
