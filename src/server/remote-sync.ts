// Two-way sync with the workload site for cards that already exist there:
// pushing our edits/deletes, and pulling the real list back.
//
// The workload row is the truth for anything already submitted — it can be
// edited or deleted on the website, and the app's list has to show that.

import { and, eq, gte, lte } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { Card } from "@/db/schema";
import { fingerprintCard } from "./pipeline";
import { planReconcile, type ReconcileAction, type RemoteTaskLike } from "./engine/reconcile";
import { sanitizeNoteHtml } from "@/lib/sanitize";
import { stripHtml } from "./engine/evidence";
import {
  batchLog,
  deleteTask,
  describeFailure,
  isLegacyRemoteId,
  listMyTasks,
  v2TaskId,
} from "./sources/workload";
import { cardToBatchItem, loadLookups, workloadAccount, type Lookups } from "./workload-account";

export type RemoteOutcome =
  | { ok: true; affected: number }
  | { ok: false; authExpired: boolean; error: string; rowMissing?: boolean };

const NOT_LINKED =
  "ยังไม่ได้จับคู่กับแถวใน workload v2 (ส่งไว้ตั้งแต่ระบบเก่า) — กด 'ดึงจาก workload' ก่อน";

/** Push a local edit of an already-submitted card to workload. */
export async function pushCardUpdate(card: Card): Promise<RemoteOutcome> {
  if (!card.remoteTaskId) return { ok: true, affected: 0 }; // never uploaded
  const taskId = v2TaskId(card.remoteTaskId);
  if (taskId === null) return { ok: false, authExpired: false, error: NOT_LINKED };
  const account = workloadAccount();
  if ("missing" in account) {
    return { ok: false, authExpired: false, error: `ยังไม่ได้ตั้งค่า ${account.missing}` };
  }
  const loaded = await loadLookups(account.jwt);
  if (!loaded.ok) return { ok: false, authExpired: loaded.authExpired, error: loaded.error };
  const built = cardToBatchItem(card, loaded.lookups, taskId);
  if ("error" in built) return { ok: false, authExpired: false, error: built.error };

  const res = await batchLog({
    jwt: account.jwt,
    log: { workDate: card.tasksDate, items: [built.item] },
  });
  if (res.authExpired) return { ok: false, authExpired: true, error: "JWT หมดอายุ" };
  if (res.status === 404) {
    return {
      ok: false,
      authExpired: false,
      rowMissing: true,
      error: `ไม่เจอแถว #${taskId} ใน workload (ถูกลบไปแล้ว?) — ส่งใหม่ได้`,
    };
  }
  if (!res.ok) return { ok: false, authExpired: false, error: describeFailure("tasks/batch", res) };
  return { ok: true, affected: res.data.updated.length };
}

/** Delete the row on workload. Local deletion only happens if this succeeds. */
export async function deleteCardRemote(card: Card): Promise<RemoteOutcome> {
  if (!card.remoteTaskId) return { ok: true, affected: 0 };
  // A v1 id says nothing about which v2 row to delete — never guess here.
  if (isLegacyRemoteId(card.remoteTaskId)) {
    return { ok: false, authExpired: false, error: NOT_LINKED };
  }
  const taskId = v2TaskId(card.remoteTaskId);
  if (taskId === null) {
    return { ok: false, authExpired: false, error: `remote id "${card.remoteTaskId}" ไม่ถูกต้อง` };
  }
  const account = workloadAccount();
  if ("missing" in account) {
    return { ok: false, authExpired: false, error: `ยังไม่ได้ตั้งค่า ${account.missing}` };
  }
  const res = await deleteTask({ jwt: account.jwt, id: taskId });
  if (res.authExpired) return { ok: false, authExpired: true, error: "JWT หมดอายุ" };
  // 404: the row is already gone (or was never ours to see) — nothing is left behind.
  if (res.status === 404) return { ok: true, affected: 0 };
  if (!res.ok) return { ok: false, authExpired: false, error: describeFailure("delete task", res) };
  return { ok: true, affected: 1 };
}

export type RemoteRange =
  | { ok: true; tasks: RemoteTaskLike[]; lookups: Lookups }
  | { ok: false; authExpired: boolean; error: string };

/** The user's real workload rows for a range, with type/project names resolved. */
export async function fetchRemoteRange(
  jwt: string,
  userId: number,
  fromYMD: string,
  toYMD: string,
): Promise<RemoteRange> {
  const [tasks, loaded] = await Promise.all([
    listMyTasks({ jwt, userId, from: fromYMD, to: toYMD }),
    loadLookups(jwt),
  ]);
  if (tasks.authExpired) return { ok: false, authExpired: true, error: "JWT หมดอายุ" };
  if (!tasks.ok) return { ok: false, authExpired: false, error: describeFailure("tasks", tasks) };
  if (!loaded.ok) return loaded;

  const typeName = new Map(loaded.lookups.taskTypes.map((t) => [t.id, t.name]));
  const projectName = new Map(loaded.lookups.projects.map((p) => [p.id, p.name]));
  return {
    ok: true,
    lookups: loaded.lookups,
    tasks: tasks.data.map((task) => ({
      id: task.id,
      legacyId: task.legacyId,
      workDate: task.workDate,
      durationSec: task.durationSec,
      title: task.title,
      noteHtml: task.noteHtml,
      taskType: typeName.get(task.taskTypeId) ?? `#${task.taskTypeId}`,
      website: task.projectId === null ? null : (projectName.get(task.projectId) ?? null),
      clickupTask: task.clickupTaskId,
    })),
  };
}

export type ReconcileSummary = {
  linked: number;
  updatedFromRemote: number;
  imported: number;
  orphaned: number;
  remoteCount: number;
};

/** Pull the real workload rows for a range and make the local list match. */
export async function reconcileRange(
  fromYMD: string,
  toYMD: string,
): Promise<ReconcileSummary | { missing: string } | { error: string; authExpired: boolean }> {
  const account = workloadAccount();
  if ("missing" in account) return account;

  const remote = await fetchRemoteRange(account.jwt, account.identity.userId, fromYMD, toYMD);
  if (!remote.ok) {
    return remote.authExpired
      ? { error: "JWT หมดอายุ — วางใหม่ในหน้า Settings", authExpired: true }
      : { error: `workload API: ${remote.error}`, authExpired: false };
  }

  const db = getDb();
  const localCards = db
    .select()
    .from(schema.cards)
    .where(and(gte(schema.cards.tasksDate, fromYMD), lte(schema.cards.tasksDate, toYMD)))
    .all();

  const actions = planReconcile({ localCards, remoteTasks: remote.tasks });
  return applyActions(actions, localCards, remote.tasks.length);
}

function applyActions(
  actions: ReconcileAction[],
  localCards: Card[],
  remoteCount: number,
): ReconcileSummary {
  const db = getDb();
  const byId = new Map(localCards.map((c) => [c.id, c]));
  const summary: ReconcileSummary = {
    linked: 0,
    updatedFromRemote: 0,
    imported: 0,
    orphaned: 0,
    remoteCount,
  };
  const now = new Date();

  for (const action of actions) {
    if (action.kind === "link") {
      db.update(schema.cards)
        .set({ remoteTaskId: action.remoteTaskId, updatedAt: now })
        .where(eq(schema.cards.id, action.cardId))
        .run();
      summary.linked += 1;
      continue;
    }
    if (action.kind === "update-local") {
      const existing = byId.get(action.cardId);
      if (existing) snapshot(existing, "reconcile");
      db.update(schema.cards)
        .set({
          durationSec: action.fields.durationSec,
          ...(action.fields.topic ? { topic: action.fields.topic } : {}),
          noteHtml: action.fields.noteHtml,
          taskType: action.fields.taskType,
          website: action.fields.website,
          clickupTask: action.fields.clickupTask,
          remoteTaskId: action.remoteTaskId,
          error: null,
          updatedAt: now,
        })
        .where(eq(schema.cards.id, action.cardId))
        .run();
      summary.updatedFromRemote += 1;
      continue;
    }
    if (action.kind === "import") {
      const remote = action.remote;
      const topic =
        remote.title.trim() || stripHtml(remote.noteHtml).slice(0, 80) || "งานจาก workload";
      db.insert(schema.cards)
        .values({
          tasksDate: remote.workDate,
          durationSec: remote.durationSec,
          topic,
          noteHtml: sanitizeNoteHtml(remote.noteHtml),
          taskType: remote.taskType,
          website: remote.website,
          clickupTask: remote.clickupTask,
          origin: "manual",
          confidence: 1,
          evidence: { commits: [], tasks: [] },
          fingerprint: fingerprintCard(remote.workDate, `remote-${remote.id}`, remote.taskType),
          status: "submitted",
          remoteTaskId: String(remote.id),
          internalNote: "ดึงมาจาก workload (ไม่ได้สร้างในแอปนี้)",
          submittedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      summary.imported += 1;
      continue;
    }
    // orphan: we think it was submitted, workload no longer has it.
    const existing = byId.get(action.cardId);
    if (existing) snapshot(existing, "reconcile-orphan");
    db.update(schema.cards)
      .set({
        status: "draft",
        remoteTaskId: null,
        error: "ไม่เจอใน workload แล้ว (ถูกลบที่ปลายทาง?) — ส่งใหม่ได้",
        updatedAt: now,
      })
      .where(eq(schema.cards.id, action.cardId))
      .run();
    summary.orphaned += 1;
  }
  return summary;
}

function snapshot(card: Card, reason: string): void {
  getDb()
    .insert(schema.cardVersions)
    .values({ cardId: card.id, snapshot: card as unknown as Record<string, unknown>, reason })
    .run();
}
