// Chat edits, server side: gather the cards and evidence of a scope, ask the
// AI for operations, keep them as a proposal, and apply one when the user
// accepts — including on workload for cards that are already there.

import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type {
  Card,
  ChatAttachment,
  ChatCardSnapshot,
  ChatMessage,
  ChatOp,
  ChatProposal,
} from "@/db/schema";
import { DEFAULT_AI_MODEL } from "@/lib/ai-defaults";
import { ClaudeCliProvider } from "./ai/cli";
import type { AiProvider } from "./ai/provider";
import { filterMyCommits } from "./authors";
import { resolveDayTargets } from "./day-targets";
import {
  buildChatSystemPrompt,
  buildChatUserMessage,
  parseChatReply,
  parseScopeKey,
  staleCards,
  validateChatOps,
  type ChatDayContext,
  type ChatHistoryEntry,
  type ChatScope,
} from "./engine/chat";
import { resolveClickupLink } from "./engine/clickup-link";
import { fingerprintCard } from "./pipeline";
import { deleteCardRemote, pushCardUpdate } from "./remote-sync";
import { getDefaultDailySec, getSetting } from "./settings";
import { dateRange, toBangkokYMD } from "./time";

const MAX_ATTEMPTS = 3;
const CHAT_TIMEOUT_MS = 5 * 60 * 1000;

export class ChatError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

// --- context -----------------------------------------------------------------

function snapshotOf(card: Card): ChatCardSnapshot {
  return {
    id: card.id,
    tasksDate: card.tasksDate,
    topic: card.topic,
    noteHtml: card.noteHtml,
    taskType: card.taskType,
    durationSec: card.durationSec,
    status: card.status,
    remoteTaskId: card.remoteTaskId,
    updatedAt: card.updatedAt ? card.updatedAt.getTime() : null,
  };
}

type ScopeContext = {
  days: ChatDayContext[];
  cards: Map<number, ChatCardSnapshot>;
  editableCardIds: Set<number>;
  creatableDates: Set<string>;
  targets: Map<string, number>;
  knownCommitHashes: string[];
  knownTaskRefs: string[];
  /** For resolving the ClickUp link of a card from the commits it cites. */
  commitTickets: { hash: string; ticketIds: string[] }[];
  linkableTasks: { taskId: string; customId: string | null; url: string | null }[];
};

function loadScopeContext(scope: ChatScope): ScopeContext {
  const db = getDb();
  let dates: string[];
  if (scope.kind === "range") dates = dateRange(scope.from, scope.to);
  else if (scope.kind === "day") dates = [scope.date];
  else {
    const card = db.select().from(schema.cards).where(eq(schema.cards.id, scope.cardId)).get();
    if (!card) throw new ChatError("ไม่พบ card นี้แล้ว", 404);
    dates = [card.tasksDate];
  }
  const from = dates[0];
  const to = dates[dates.length - 1];

  const cards = db
    .select()
    .from(schema.cards)
    .where(and(gte(schema.cards.tasksDate, from), lte(schema.cards.tasksDate, to)))
    .orderBy(asc(schema.cards.tasksDate), asc(schema.cards.id))
    .all();
  const targets = new Map(
    resolveDayTargets(from, to, getDefaultDailySec(), db.select().from(schema.dayTargets).all()).map(
      (d) => [d.date, d.targetSec],
    ),
  );

  const commits = filterMyCommits(
    db
      .select()
      .from(schema.commits)
      .where(
        and(
          gte(schema.commits.authorDate, new Date(`${from}T00:00:00+07:00`)),
          lte(schema.commits.authorDate, new Date(`${to}T23:59:59+07:00`)),
        ),
      )
      .orderBy(asc(schema.commits.authorDate))
      .all(),
  );
  const projectName = new Map(db.select().from(schema.projects).all().map((p) => [p.id, p.name]));
  const tasks = db.select().from(schema.clickupTasks).all();

  const days: ChatDayContext[] = dates.map((date) => ({
    date,
    targetSec: targets.get(date) ?? 0,
    cards: cards.filter((c) => c.tasksDate === date).map(snapshotOf),
    commits: commits
      .filter((c) => toBangkokYMD(c.authorDate) === date)
      .map((c) => ({
        hash: c.hash,
        hhmm: new Date(c.authorDate.getTime() + 7 * 3600_000).toISOString().slice(11, 16),
        project: projectName.get(c.projectId) ?? "",
        subject: c.message.split("\n")[0].slice(0, 160),
      })),
    closedTasks: tasks
      .filter((t) => t.dateClosed && toBangkokYMD(t.dateClosed) === date)
      .map((t) => ({ ref: t.customId ?? t.taskId, name: t.name })),
  }));

  const editableCardIds = new Set(
    scope.kind === "card" ? [scope.cardId] : cards.map((c) => c.id),
  );
  return {
    days,
    cards: new Map(cards.map((c) => [c.id, snapshotOf(c)])),
    editableCardIds,
    creatableDates: new Set(scope.kind === "card" ? [] : dates),
    targets,
    knownCommitHashes: commits.map((c) => c.hash),
    knownTaskRefs: tasks.flatMap((t) => [t.taskId, ...(t.customId ? [t.customId] : [])]),
    commitTickets: commits.map((c) => ({ hash: c.hash, ticketIds: c.ticketIds })),
    linkableTasks: tasks.map((t) => ({ taskId: t.taskId, customId: t.customId, url: t.url })),
  };
}

// --- threads -----------------------------------------------------------------

export function getThread(scopeKey: string): { threadId: number | null; messages: ChatMessage[] } {
  if (!parseScopeKey(scopeKey)) throw new ChatError("scope ไม่ถูกต้อง");
  const db = getDb();
  const thread = db
    .select()
    .from(schema.chatThreads)
    .where(eq(schema.chatThreads.scopeKey, scopeKey))
    .orderBy(desc(schema.chatThreads.id))
    .get();
  if (!thread) return { threadId: null, messages: [] };
  const messages = db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.threadId, thread.id))
    .orderBy(asc(schema.chatMessages.id))
    .all();
  return { threadId: thread.id, messages };
}

function historyOf(messages: ChatMessage[]): ChatHistoryEntry[] {
  return messages
    .filter((m) => !m.error)
    .map((m) => ({
      role: m.role,
      text: m.text,
      outcome: m.role === "assistant" && m.proposal ? m.proposalStatus : null,
    }));
}

/** Post a request in the scope's thread (or a fresh one) and get the AI's proposal. */
export async function sendChatMessage(
  input: {
    scopeKey: string;
    text: string;
    attachments?: ChatAttachment[];
    newThread?: boolean;
  },
  provider: AiProvider = new ClaudeCliProvider(),
): Promise<{ threadId: number; messages: ChatMessage[] }> {
  const scope = parseScopeKey(input.scopeKey);
  if (!scope) throw new ChatError("scope ไม่ถูกต้อง");
  const text = input.text.trim();
  if (!text) throw new ChatError("พิมพ์สิ่งที่ต้องการให้แก้ก่อน");
  const db = getDb();

  const existing = input.newThread ? null : getThread(input.scopeKey);
  const threadId =
    existing?.threadId ??
    db.insert(schema.chatThreads).values({ scopeKey: input.scopeKey }).returning().get().id;
  const history = historyOf(existing?.messages ?? []);

  const attachments = input.attachments ?? [];
  db.insert(schema.chatMessages)
    .values({ threadId, role: "user", text, attachments: attachments.length ? attachments : null })
    .run();

  const ctx = loadScopeContext(scope);
  const taskTypeNames = db.select().from(schema.taskTypes).all().map((t) => t.name);
  if (taskTypeNames.length === 0) {
    throw new ChatError("ยังไม่มีประเภทงาน — sync ในหน้า Settings ก่อน");
  }
  const system = buildChatSystemPrompt(taskTypeNames);
  const baseMessage = buildChatUserMessage({
    scope,
    days: ctx.days,
    editableCardIds: ctx.editableCardIds,
    creatableDates: ctx.creatableDates,
    history,
    instruction: text,
    attachments,
  });
  const model = getSetting("ai_model")?.trim() || DEFAULT_AI_MODEL;

  let reply = "";
  let ops: ChatOp[] = [];
  let failure: string | null = null;
  let repair = "";
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await provider.generate(baseMessage + repair, {
        model,
        system,
        timeoutMs: CHAT_TIMEOUT_MS,
      });
      const parsed = parseChatReply(result.text);
      let issues: string[];
      if (!("ops" in parsed)) {
        issues = [parsed.error];
      } else {
        const checked = validateChatOps(parsed.ops, {
          cards: ctx.cards,
          editableCardIds: ctx.editableCardIds,
          creatableDates: ctx.creatableDates,
          targets: ctx.targets,
          allowedTaskTypes: taskTypeNames,
          knownCommitHashes: ctx.knownCommitHashes,
          knownTaskRefs: ctx.knownTaskRefs,
        });
        reply = parsed.reply;
        ops = checked.ops;
        issues = checked.issues;
      }
      if (issues.length === 0) {
        failure = null;
        break;
      }
      failure = issues.slice(0, 5).join(" · ");
      repair =
        `\n\n## Your previous answer was rejected — fix these and return the full corrected JSON\n` +
        issues.map((i) => `- ${i}`).join("\n");
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    provider.close?.();
  }

  if (failure) {
    db.insert(schema.chatMessages)
      .values({ threadId, role: "assistant", text: "แก้ตามที่ขอไม่สำเร็จ", error: failure.slice(0, 1000) })
      .run();
  } else {
    const touched = new Set(ops.flatMap((op) => (op.op === "create" ? [] : [op.cardId])));
    const proposal: ChatProposal | null =
      ops.length > 0
        ? { ops, before: [...touched].map((id) => ctx.cards.get(id)!).filter(Boolean) }
        : null;
    db.insert(schema.chatMessages)
      .values({
        threadId,
        role: "assistant",
        text: reply || (proposal ? "เสนอการแก้ตามด้านล่าง" : "ไม่มีอะไรต้องแก้"),
        proposal,
        proposalStatus: proposal ? "pending" : null,
      })
      .run();
  }
  return { threadId, messages: getThread(input.scopeKey).messages };
}

// --- proposals ---------------------------------------------------------------

function loadPendingProposal(messageId: number): ChatMessage & { proposal: ChatProposal } {
  const message = getDb()
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.id, messageId))
    .get();
  if (!message?.proposal) throw new ChatError("ไม่พบข้อเสนอนี้", 404);
  if (message.proposalStatus !== "pending") {
    throw new ChatError(
      message.proposalStatus === "applied" ? "ข้อเสนอนี้ใช้ไปแล้ว" : "ข้อเสนอนี้ถูกทิ้งไปแล้ว",
      409,
    );
  }
  return message as ChatMessage & { proposal: ChatProposal };
}

export function discardProposal(messageId: number): void {
  loadPendingProposal(messageId);
  getDb()
    .update(schema.chatMessages)
    .set({ proposalStatus: "discarded" })
    .where(eq(schema.chatMessages.id, messageId))
    .run();
}

export type ApplyResult = { applied: number; failed: string[] };

/**
 * Apply a pending proposal. Refuses when any card it touches changed after the
 * proposal was made. Cards already on workload are changed there as well:
 * a delete happens on workload first (and is skipped locally if that fails);
 * an edit is saved locally, then pushed, and marked failed if the push fails —
 * the same rules as editing by hand.
 */
export async function applyProposal(messageId: number): Promise<ApplyResult> {
  const message = loadPendingProposal(messageId);
  const db = getDb();
  const { ops, before } = message.proposal;

  const ids = before.map((b) => b.id);
  const current = ids.length
    ? db.select().from(schema.cards).where(inArray(schema.cards.id, ids)).all()
    : [];
  const currentById = new Map(current.map((c) => [c.id, c]));
  const stale = staleCards(
    before,
    new Map(current.map((c) => [c.id, { updatedAt: c.updatedAt ? c.updatedAt.getTime() : null }])),
  );
  if (stale.length > 0) {
    throw new ChatError(
      `card ${stale.map((id) => `#${id}`).join(", ")} ถูกแก้ไปหลังจาก AI เสนอ — ส่งคำขอใหม่อีกครั้ง`,
      409,
    );
  }

  // Link a card to its ClickUp task from the commits it cites, like generation does.
  const dates = [
    ...new Set([
      ...current.map((c) => c.tasksDate),
      ...ops.flatMap((o) => (o.op === "create" ? [o.date] : [])),
    ]),
  ].sort();
  const linkCtx = dates.length
    ? loadScopeContext({ kind: "range", from: dates[0], to: dates[dates.length - 1] })
    : null;
  const linkFor = (evidence: { commits: string[]; tasks: string[] }) =>
    linkCtx
      ? resolveClickupLink({
          card: { evidence },
          commits: linkCtx.commitTickets,
          tasks: linkCtx.linkableTasks,
        })
      : null;

  const result: ApplyResult = { applied: 0, failed: [] };
  const now = () => new Date();
  const snapshot = (card: Card) =>
    db.insert(schema.cardVersions)
      .values({ cardId: card.id, snapshot: card as unknown as Record<string, unknown>, reason: "chat" })
      .run();

  for (const op of ops) {
    if (op.op === "create") {
      const link = linkFor(op.evidence);
      db.insert(schema.cards)
        .values({
          tasksDate: op.date,
          durationSec: op.durationSec,
          topic: op.topic,
          noteHtml: op.noteHtml,
          taskType: op.taskType,
          clickupTask: link?.customId ?? link?.taskId ?? null,
          clickupUrl: link?.url ?? null,
          origin: op.evidence.commits.length > 0 ? "git" : "manual",
          confidence: 1,
          evidence: op.evidence,
          fingerprint: fingerprintCard(op.date, op.topic, op.taskType),
          internalNote: "เพิ่มจาก chat",
          createdAt: now(),
          updatedAt: now(),
        })
        .run();
      result.applied += 1;
      continue;
    }

    const card = currentById.get(op.cardId);
    if (!card) continue;

    if (op.op === "delete") {
      if (card.remoteTaskId) {
        const removed = await deleteCardRemote(card);
        if (!removed.ok) {
          result.failed.push(`ลบ "${card.topic}" บน workload ไม่สำเร็จ: ${removed.error}`);
          continue;
        }
      }
      db.delete(schema.cards).where(eq(schema.cards.id, card.id)).run();
      result.applied += 1;
      continue;
    }

    snapshot(card);
    const link = op.evidence ? linkFor(op.evidence) : undefined;
    const updated = db
      .update(schema.cards)
      .set({
        ...(op.topic !== undefined ? { topic: op.topic } : {}),
        ...(op.noteHtml !== undefined ? { noteHtml: op.noteHtml } : {}),
        ...(op.taskType !== undefined ? { taskType: op.taskType } : {}),
        ...(op.durationSec !== undefined ? { durationSec: op.durationSec } : {}),
        ...(op.evidence !== undefined
          ? {
              evidence: op.evidence,
              clickupTask: link?.customId ?? link?.taskId ?? card.clickupTask,
              clickupUrl: link?.url ?? card.clickupUrl,
            }
          : {}),
        updatedAt: now(),
      })
      .where(eq(schema.cards.id, card.id))
      .returning()
      .get();

    if (updated.remoteTaskId) {
      const pushed = await pushCardUpdate(updated);
      db.update(schema.cards)
        .set(
          pushed.ok
            ? { status: "submitted", error: null }
            : { status: "failed", error: `sync ไป workload ไม่สำเร็จ: ${pushed.error}` },
        )
        .where(eq(schema.cards.id, card.id))
        .run();
      if (!pushed.ok) {
        result.failed.push(`แก้ "${card.topic}" ในแอปแล้ว แต่ sync ไป workload ไม่สำเร็จ: ${pushed.error}`);
      }
    }
    result.applied += 1;
  }

  db.update(schema.chatMessages)
    .set({
      proposalStatus: "applied",
      applyNote: result.failed.length ? result.failed.join("\n").slice(0, 1000) : null,
    })
    .where(eq(schema.chatMessages.id, messageId))
    .run();
  return result;
}
