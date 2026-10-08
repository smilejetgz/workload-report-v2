// Chat edits: the user asks in words, the AI answers with a list of
// operations on cards, and code checks every operation before anyone sees it.
// Pure functions — the DB, the AI call and workload live in server/chat.ts.

import { z } from "zod";
import type { ChatAttachment, ChatCardSnapshot, ChatOp } from "@/db/schema";
import { sanitizeNoteHtml } from "@/lib/sanitize";
import { STEP_SEC } from "./allocator";
import { extractJson } from "./validator";

// --- scope -------------------------------------------------------------------

export type ChatScope =
  | { kind: "range"; from: string; to: string }
  | { kind: "day"; date: string }
  | { kind: "card"; cardId: number };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function parseScopeKey(key: string): ChatScope | null {
  const [kind, a, b] = key.split(":");
  if (kind === "range" && a && b && YMD.test(a) && YMD.test(b) && a <= b) {
    return { kind, from: a, to: b };
  }
  if (kind === "day" && a && YMD.test(a) && b === undefined) return { kind, date: a };
  if (kind === "card" && a && /^\d+$/.test(a) && b === undefined) {
    return { kind, cardId: Number(a) };
  }
  return null;
}

export function scopeKeyOf(scope: ChatScope): string {
  if (scope.kind === "range") return `range:${scope.from}:${scope.to}`;
  if (scope.kind === "day") return `day:${scope.date}`;
  return `card:${scope.cardId}`;
}

// --- prompt ------------------------------------------------------------------

export type ChatDayContext = {
  date: string;
  targetSec: number;
  cards: ChatCardSnapshot[];
  commits: { hash: string; hhmm: string; project: string; subject: string }[];
  closedTasks: { ref: string; name: string }[];
};

export type ChatHistoryEntry = {
  role: "user" | "assistant";
  text: string;
  /** For an assistant turn: what became of its proposal. */
  outcome?: "applied" | "discarded" | "pending" | null;
};

/** Same for every chat turn, so it is read from the prompt cache. */
export function buildChatSystemPrompt(taskTypeNames: string[]): string {
  return `You edit an engineer's daily workload report on request. The report is a list
of cards per day; each card is one piece of work with hours. The user tells you,
in Thai, what to change. You answer with operations on cards — code checks them,
shows the user a before/after, and applies them only if the user accepts.

Return ONLY a JSON object — no markdown fences, no commentary before or after:
{
  "reply": "short Thai answer to the user: what you changed and why, or a question if the request is unclear",
  "ops": [
    { "op": "update", "card_id": 12, "topic": "...", "note_html": "...", "task_type": "...", "hours": 2.5,
      "evidence": { "commits": ["a1b2c3d4"], "tasks": ["DEV-6395"] } },
    { "op": "create", "date": "YYYY-MM-DD", "topic": "...", "note_html": "...", "task_type": "...", "hours": 1,
      "evidence": { "commits": [], "tasks": [] } },
    { "op": "delete", "card_id": 13 }
  ]
}

## Rules
- Change only what the user asked for. In an "update", include only the fields that
  change. Never rewrite cards the request does not concern.
- Only cards marked EDITABLE may be updated or deleted; only dates marked CAN ADD
  may receive new cards. Other cards are context — read them, never touch them.
- Hours: multiples of 0.25. When a change moves hours on a day, the cards of that day
  must still add up to exactly the day's target — take the hours from or give them
  to other EDITABLE cards of the same day. If that is impossible, change nothing and
  say why in "reply".
- task_type MUST be exactly one of: ${taskTypeNames.join(", ")}.
- evidence lists the commit hashes (≥7 chars) and ClickUp ids a card covers; use only
  ids that appear in the context. When you fold a commit or task into a card, add it
  to that card's evidence (send the full new list).
- If the request is ambiguous, ask in "reply" and return an empty "ops".
- note_html: HTML only, tags <p> <b> <ul> <li> <code>. Pattern:
  <p><b>[TICKET-ID] หัวข้อ</b></p><ul><li>...</li></ul> (omit [TICKET-ID] when none).
  Each bullet under 14 words.
- READER: HR and managers who do not write code. Say what the work achieved; never
  name a file, function, database column, branch or flag.
- LANGUAGE: Thai sentences, but technical terms and loanwords stay in English, spelled
  the way engineers write them (deploy, server, API, login, bug, order, coupon) —
  never transliterate them into Thai script. Product names as the company writes them
  (Ket-CMS, LINE OA, ClickUp). No commit hashes in note_html or topic.
- topic: a short Thai headline a non-technical reader understands.`;
}

function hours(sec: number): string {
  return String(sec / 3600);
}

function describeAttachment(a: ChatAttachment): string {
  return a.kind === "commit"
    ? `- commit ${a.hash.slice(0, 8)} (${a.date}, ${a.project}): ${a.message}`
    : `- task ${a.customId ?? a.taskId}${a.date ? ` (closed ${a.date})` : ""}: ${a.name}`;
}

export function buildChatUserMessage(input: {
  scope: ChatScope;
  days: ChatDayContext[];
  editableCardIds: Set<number>;
  creatableDates: Set<string>;
  history: ChatHistoryEntry[];
  instruction: string;
  attachments: ChatAttachment[];
}): string {
  const scopeLine =
    input.scope.kind === "range"
      ? `The whole range ${input.scope.from} → ${input.scope.to}.`
      : input.scope.kind === "day"
        ? `One day: ${input.scope.date}.`
        : `One card: #${input.scope.cardId}. Edit that card only (its hours cannot change unless the user asks — then rebalance is impossible, so say so).`;

  const dayBlocks = input.days.map((day) => {
    const total = day.cards.reduce((sum, c) => sum + c.durationSec, 0);
    const lines = [
      `### ${day.date} — target ${hours(day.targetSec)}h, cards now total ${hours(total)}h` +
        (input.creatableDates.has(day.date) ? " — CAN ADD" : ""),
    ];
    for (const c of day.cards) {
      const flags = [
        input.editableCardIds.has(c.id) ? "EDITABLE" : "read-only",
        c.remoteTaskId ? "on workload" : c.status,
      ].join(", ");
      lines.push(
        `- card #${c.id} [${flags}] ${hours(c.durationSec)}h · ${c.taskType} · ${c.topic}\n  note_html: ${c.noteHtml}`,
      );
    }
    if (day.cards.length === 0) lines.push("- (no cards)");
    if (day.commits.length > 0) {
      lines.push("Commits:");
      for (const c of day.commits) {
        lines.push(`- ${c.hash.slice(0, 8)} ${c.hhmm} ${c.project}: ${c.subject}`);
      }
    }
    if (day.closedTasks.length > 0) {
      lines.push("ClickUp tasks closed:");
      for (const t of day.closedTasks) lines.push(`- ${t.ref}: ${t.name}`);
    }
    return lines.join("\n");
  });

  const history = input.history
    .slice(-10)
    .map((h) =>
      h.role === "user"
        ? `User: ${h.text}`
        : `You: ${h.text}${h.outcome ? ` (proposal ${h.outcome})` : ""}`,
    );

  return [
    `## Scope\n${scopeLine}`,
    `## Report now\n${dayBlocks.join("\n\n")}`,
    history.length > 0 ? `## Conversation so far\n${history.join("\n")}` : "",
    input.attachments.length > 0
      ? `## Items the user picked from "possibly missed" — work them into the report\n${input.attachments.map(describeAttachment).join("\n")}`
      : "",
    `## Request\n${input.instruction}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// --- reply -------------------------------------------------------------------

const evidenceSchema = z.object({
  commits: z.array(z.string()).default([]),
  tasks: z.array(z.string()).default([]),
});

const rawOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("update"),
    card_id: z.number().int(),
    topic: z.string().optional(),
    note_html: z.string().optional(),
    task_type: z.string().optional(),
    hours: z.number().optional(),
    evidence: evidenceSchema.optional(),
  }),
  z.object({
    op: z.literal("create"),
    date: z.string(),
    topic: z.string(),
    note_html: z.string(),
    task_type: z.string(),
    hours: z.number(),
    evidence: evidenceSchema.default({ commits: [], tasks: [] }),
  }),
  z.object({ op: z.literal("delete"), card_id: z.number().int() }),
]);

const replySchema = z.object({
  reply: z.string().default(""),
  ops: z.array(rawOpSchema).default([]),
});

export type RawChatOp = z.infer<typeof rawOpSchema>;

export function parseChatReply(
  raw: string,
): { reply: string; ops: RawChatOp[]; error: null } | { error: string } {
  const json = extractJson(raw);
  if (json === null) return { error: "ไม่พบ JSON ใน output" };
  const parsed = replySchema.safeParse(json);
  if (!parsed.success) return { error: z.prettifyError(parsed.error).slice(0, 500) };
  return { reply: parsed.data.reply.trim(), ops: parsed.data.ops, error: null };
}

// --- validation --------------------------------------------------------------

export type ChatValidationContext = {
  /** Every card on the days in view, by id — the scope's and their neighbours. */
  cards: Map<number, ChatCardSnapshot>;
  editableCardIds: Set<number>;
  creatableDates: Set<string>;
  targets: Map<string, number>;
  allowedTaskTypes: string[];
  knownCommitHashes: string[];
  knownTaskRefs: string[];
};

const MAX_CARD_HOURS_SEC = 12 * 3600;

function toSec(hoursValue: number): number | null {
  const sec = Math.round(hoursValue * 3600);
  if (sec <= 0 || sec > MAX_CARD_HOURS_SEC || sec % STEP_SEC !== 0) return null;
  return sec;
}

/**
 * Turn the model's operations into checked ones. Anything wrong is reported
 * in `issues` (Thai, sent back to the model for one more try); the ops that
 * survive are only used when there are no issues at all.
 */
export function validateChatOps(
  raw: RawChatOp[],
  ctx: ChatValidationContext,
): { ops: ChatOp[]; issues: string[] } {
  const issues: string[] = [];
  const ops: ChatOp[] = [];
  const touchedCards = new Set<number>();
  const allowed = new Map(ctx.allowedTaskTypes.map((t) => [t.toLowerCase(), t]));
  const known = ctx.knownCommitHashes.map((h) => h.toLowerCase());
  const knownRefs = new Set(ctx.knownTaskRefs.map((r) => r.toLowerCase()));

  const taskType = (value: string, where: string) => {
    const canonical = allowed.get(value.trim().toLowerCase());
    if (!canonical) issues.push(`${where}: task_type "${value}" ไม่อยู่ในรายการที่อนุญาต`);
    return canonical ?? value;
  };
  const evidence = (value: { commits: string[]; tasks: string[] }, where: string) => {
    for (const hash of value.commits) {
      const h = hash.toLowerCase();
      if (h.length < 7 || !known.some((k) => k.startsWith(h))) {
        issues.push(`${where}: ไม่รู้จัก commit ${hash}`);
      }
    }
    for (const ref of value.tasks) {
      if (!knownRefs.has(ref.toLowerCase())) issues.push(`${where}: ไม่รู้จัก task ${ref}`);
    }
    return { commits: value.commits, tasks: value.tasks };
  };
  const duration = (value: number, where: string) => {
    const sec = toSec(value);
    if (sec === null) issues.push(`${where}: hours ${value} ต้องเป็นทวีคูณของ 0.25 และไม่เกิน 12`);
    return sec ?? 0;
  };
  const claim = (cardId: number, where: string) => {
    if (!ctx.editableCardIds.has(cardId)) {
      issues.push(`${where}: card #${cardId} แก้ไม่ได้ในขอบเขตนี้`);
      return false;
    }
    if (touchedCards.has(cardId)) {
      issues.push(`${where}: card #${cardId} ถูกอ้างซ้ำ`);
      return false;
    }
    touchedCards.add(cardId);
    return true;
  };

  for (const [i, op] of raw.entries()) {
    const where = `ops[${i}]`;
    if (op.op === "delete") {
      if (claim(op.card_id, where)) ops.push({ op: "delete", cardId: op.card_id });
      continue;
    }
    if (op.op === "update") {
      if (!claim(op.card_id, where)) continue;
      const next: ChatOp = { op: "update", cardId: op.card_id };
      if (op.topic !== undefined) next.topic = op.topic.trim();
      if (op.note_html !== undefined) next.noteHtml = sanitizeNoteHtml(op.note_html);
      if (op.task_type !== undefined) next.taskType = taskType(op.task_type, where);
      if (op.hours !== undefined) next.durationSec = duration(op.hours, where);
      if (op.evidence !== undefined) next.evidence = evidence(op.evidence, where);
      ops.push(next);
      continue;
    }
    if (!ctx.creatableDates.has(op.date)) {
      issues.push(`${where}: เพิ่ม card วันที่ ${op.date} ไม่ได้ในขอบเขตนี้`);
      continue;
    }
    ops.push({
      op: "create",
      date: op.date,
      topic: op.topic.trim(),
      noteHtml: sanitizeNoteHtml(op.note_html),
      taskType: taskType(op.task_type, where),
      durationSec: duration(op.hours, where),
      evidence: evidence(op.evidence, where),
    });
  }

  for (const [date, totalSec] of dayTotalsAfter(ops, ctx.cards)) {
    const target = ctx.targets.get(date) ?? 0;
    if (target === 0) {
      issues.push(`${date} เป็นวันหยุด/เป้า 0 ชม. — ให้ผู้ใช้ตั้งเป้าวันนั้นก่อน`);
    } else if (totalSec !== target) {
      issues.push(
        `${date}: รวมหลังแก้ ${totalSec / 3600} ชม. แต่เป้าคือ ${target / 3600} ชม. — ต้องเท่ากันพอดี`,
      );
    }
  }
  return { ops, issues };
}

/** Totals of the days whose hours the ops change (other days are not judged). */
export function dayTotalsAfter(
  ops: ChatOp[],
  cards: Map<number, ChatCardSnapshot>,
): Map<string, number> {
  const touched = new Set<string>();
  const secById = new Map([...cards.values()].map((c) => [c.id, c.durationSec]));
  const added: { date: string; sec: number }[] = [];
  for (const op of ops) {
    if (op.op === "create") {
      touched.add(op.date);
      added.push({ date: op.date, sec: op.durationSec });
      continue;
    }
    const card = cards.get(op.cardId);
    if (!card) continue;
    if (op.op === "delete") {
      touched.add(card.tasksDate);
      secById.delete(op.cardId);
    } else if (op.durationSec !== undefined && op.durationSec !== card.durationSec) {
      touched.add(card.tasksDate);
      secById.set(op.cardId, op.durationSec);
    }
  }
  const totals = new Map<string, number>();
  for (const date of touched) {
    const existing = [...cards.values()]
      .filter((c) => c.tasksDate === date && secById.has(c.id))
      .reduce((sum, c) => sum + (secById.get(c.id) ?? 0), 0);
    const fresh = added.filter((a) => a.date === date).reduce((sum, a) => sum + a.sec, 0);
    totals.set(date, existing + fresh);
  }
  return totals;
}

/** Cards the proposal touches whose row changed after it was made. */
export function staleCards(
  before: ChatCardSnapshot[],
  current: Map<number, { updatedAt: number | null }>,
): number[] {
  return before
    .filter((snap) => {
      const now = current.get(snap.id);
      return !now || now.updatedAt !== snap.updatedAt;
    })
    .map((snap) => snap.id);
}
