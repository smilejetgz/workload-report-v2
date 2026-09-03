// ClickUp sync WITHOUT a personal token: a headless `claude -p` session uses
// the user's already-authenticated claude.ai ClickUp MCP connector to fetch
// tasks/comments and returns them VERBATIM as JSON — the model only copies
// tool output (reliable for small models); all normalization happens here.

import { z } from "zod";
import { ClaudeCliProvider } from "@/server/ai/cli";
import type { ClickupApiTask, ClickupComment } from "./clickup";

const MCP_TOOLS = [
  "mcp__claude_ai_ClickUp__clickup_resolve_assignees",
  "mcp__claude_ai_ClickUp__clickup_filter_tasks",
  "mcp__claude_ai_ClickUp__clickup_get_task",
  "mcp__claude_ai_ClickUp__clickup_get_task_comments",
];
const SYNC_TIMEOUT_MS = 8 * 60 * 1000;
// Mechanical copy-tool-output work — a small/fast model is plenty.
const SYNC_MODEL = "haiku";

// ---------------------------------------------------------------------------
// Lenient schemas: accept whatever shape the connector returns.
// ---------------------------------------------------------------------------

const idObj = z.object({ id: z.number() }).loose();
const nameObj = z.object({ name: z.string().nullish() }).loose();

const mcpTaskSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    custom_id: z.string().nullish(),
    name: z.string(),
    status: z.union([z.string(), z.object({ status: z.string().nullish() }).loose()]).nullish(),
    status_type: z.string().nullish(),
    url: z.string().nullish(),
    assignees: z.array(z.union([z.number(), idObj])).default([]),
    tags: z.array(z.union([z.string(), nameObj])).default([]),
    list: z.union([z.string(), nameObj]).nullish(),
    date_updated: z.union([z.string(), z.number()]).nullish(),
    date_closed: z.union([z.string(), z.number()]).nullish(),
    due_date: z.union([z.string(), z.number()]).nullish(),
  })
  .loose();

const mcpCommentSchema = z
  .object({
    task_id: z.union([z.string(), z.number()]).transform(String),
    date: z.union([z.string(), z.number()]),
    user: idObj.nullish(),
    user_id: z.number().nullish(),
    comment_text: z.string().nullish(),
    text: z.string().nullish(),
  })
  .loose();

const mcpPayloadSchema = z.object({
  user_id: z.number().nullish(),
  tasks: z.array(z.unknown()).default([]),
  comments: z.array(z.unknown()).default([]),
});

export type McpSyncPayload = {
  userId: number | null;
  tasks: ClickupApiTask[];
  comments: { taskId: string; comment: ClickupComment }[];
  dropped: number;
};

const DONE_STATUS_RE = /closed|done|complete|cancel/i;

/** Epoch-ms (string/number) or ISO 8601 → epoch-ms string (REST style). */
function toEpochString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return String(value);
  if (/^\d{10,}$/.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? String(ms) : null;
}

function normalizeTask(raw: unknown): ClickupApiTask | null {
  const parsed = mcpTaskSchema.safeParse(raw);
  if (!parsed.success) return null;
  const t = parsed.data;
  const statusName = typeof t.status === "string" ? t.status : (t.status?.status ?? null);
  const dateClosed = toEpochString(t.date_closed);
  return {
    id: t.id,
    custom_id: t.custom_id ?? null,
    name: t.name,
    status: statusName
      ? {
          status: statusName,
          type:
            t.status_type ??
            (dateClosed || DONE_STATUS_RE.test(statusName) ? "done" : "custom"),
        }
      : undefined,
    url: t.url ?? undefined,
    assignees: t.assignees.map((a) => ({
      id: typeof a === "number" ? a : a.id,
      username: "",
    })),
    tags: t.tags
      .map((tag) => ({ name: typeof tag === "string" ? tag : (tag.name ?? "") }))
      .filter((tag) => tag.name),
    list:
      typeof t.list === "string"
        ? { name: t.list }
        : t.list?.name
          ? { name: t.list.name }
          : undefined,
    date_updated: toEpochString(t.date_updated) ?? undefined,
    date_closed: dateClosed,
    due_date: toEpochString(t.due_date),
  };
}

export function normalizePayload(json: unknown): McpSyncPayload | null {
  const parsed = mcpPayloadSchema.safeParse(json);
  if (!parsed.success) return null;
  let dropped = 0;

  const tasks: ClickupApiTask[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.data.tasks) {
    const task = normalizeTask(raw);
    if (!task) {
      dropped++;
      continue;
    }
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    tasks.push(task);
  }

  const comments: McpSyncPayload["comments"] = [];
  for (const raw of parsed.data.comments) {
    const c = mcpCommentSchema.safeParse(raw);
    if (!c.success) {
      dropped++;
      continue;
    }
    const date = toEpochString(c.data.date);
    const text = c.data.comment_text ?? c.data.text;
    if (!date || !text) {
      dropped++;
      continue;
    }
    comments.push({
      taskId: c.data.task_id,
      comment: {
        id: `${c.data.task_id}-${date}`,
        comment_text: text,
        user: { id: c.data.user?.id ?? c.data.user_id ?? 0, username: "" },
        date,
      },
    });
  }

  return { userId: parsed.data.user_id ?? null, tasks, comments, dropped };
}

// ---------------------------------------------------------------------------
// Prompt + fetch
// ---------------------------------------------------------------------------

function shiftYMD(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildSyncPrompt(fromYMD: string, toYMD: string, ticketIds: string[]): string {
  const closedFrom = shiftYMD(fromYMD, -7);
  const closedTo = shiftYMD(toYMD, 7);
  const ticketStep = ticketIds.length
    ? `4. For each of these ids call clickup_get_task (they appear in my git commits; skip any that errors): ${ticketIds.join(", ")}.`
    : "4. (skip — no extra ids)";

  return `You are a silent data-sync agent. Execute ALL steps in order using the ClickUp tools. Do NOT summarise or repeat any tool output.

1. Call clickup_resolve_assignees with "me" → note my numeric user id.
2. Call clickup_filter_tasks with: assignees=["<my id as string>"], include_closed=true, date_closed_from="${closedFrom}", date_closed_to="${closedTo}".
3. Call clickup_filter_tasks with: assignees=["<my id as string>"], include_closed=false (page 0 only).
${ticketStep}
5. Pick up to 8 tasks from step 2 plus up to 4 from step 4 and call clickup_get_task_comments for each.

If a tool call fails, continue with the remaining steps. When every step is complete, reply with exactly one word: done`;
}

// ---------------------------------------------------------------------------
// Transcript parsing: pull tool_result payloads straight from the NDJSON
// stream — the model only drives tool calls, data never round-trips through it.
// ---------------------------------------------------------------------------

type TranscriptBlock = {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  text?: string;
};

function resultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = (content as TranscriptBlock[])
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    return texts.length ? texts.join("\n") : null;
  }
  return null;
}

function findFirstNumericId(value: unknown): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstNumericId(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.id === "number") return obj.id;
    for (const nested of Object.values(obj)) {
      const found = findFirstNumericId(nested);
      if (found !== null) return found;
    }
  }
  return null;
}

export function payloadFromTranscript(ndjson: string): McpSyncPayload | null {
  const toolUses = new Map<string, { name: string; input: Record<string, unknown> }>();
  const rawTasks: unknown[] = [];
  const rawComments: unknown[] = [];
  let userId: number | null = null;
  let sawToolResult = false;

  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: { message?: { content?: unknown } };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      continue;
    }
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content as TranscriptBlock[]) {
      if (block?.type === "tool_use" && typeof block.id === "string") {
        toolUses.set(block.id, { name: block.name ?? "", input: block.input ?? {} });
        continue;
      }
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const use = toolUses.get(block.tool_use_id);
      if (!use || block.is_error) continue;
      const text = resultText(block.content);
      if (!text) continue;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        continue;
      }
      sawToolResult = true;
      const obj = json as Record<string, unknown>;

      if (use.name.endsWith("clickup_filter_tasks") && Array.isArray(obj.tasks)) {
        rawTasks.push(...(obj.tasks as unknown[]));
      } else if (use.name.endsWith("clickup_get_task")) {
        const task = (obj.task ?? obj) as Record<string, unknown>;
        if (task && typeof task === "object" && task.id && task.name) rawTasks.push(task);
      } else if (use.name.endsWith("clickup_get_task_comments") && Array.isArray(obj.comments)) {
        const taskId = use.input.task_id ?? use.input.taskId ?? null;
        for (const c of obj.comments as Record<string, unknown>[]) {
          rawComments.push({ task_id: c.task_id ?? taskId, ...c });
        }
      } else if (use.name.endsWith("clickup_resolve_assignees") && userId === null) {
        userId = findFirstNumericId(json);
      }
    }
  }

  if (!sawToolResult) return null;
  return normalizePayload({ user_id: userId, tasks: rawTasks, comments: rawComments });
}

export async function fetchClickupViaMcp(
  fromYMD: string,
  toYMD: string,
  ticketIds: string[] = [],
): Promise<{ payload: McpSyncPayload | null; error: string | null }> {
  const provider = new ClaudeCliProvider();
  try {
    const transcript = await provider.generateTranscript(
      buildSyncPrompt(fromYMD, toYMD, ticketIds),
      { model: SYNC_MODEL, allowedTools: MCP_TOOLS, timeoutMs: SYNC_TIMEOUT_MS },
    );
    const payload = payloadFromTranscript(transcript);
    if (!payload) {
      return { payload: null, error: "MCP sync ไม่มีผลลัพธ์ tool ใน transcript เลย" };
    }
    return { payload, error: null };
  } catch (error) {
    return { payload: null, error: error instanceof Error ? error.message : String(error) };
  }
}
