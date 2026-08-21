// Two-way sync with the workload site for cards that already exist there:
// pushing our edits/deletes, and pulling the real list back.
//
// The workload row is the truth for anything already submitted — it can be
// edited or deleted on the website, and the app's list has to show that.

import { and, eq, gte, lte } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { Card } from "@/db/schema";
import { fingerprintCard } from "./pipeline";
import { getSetting } from "./settings";
import { decideWriteOutcome, planReconcile, type ReconcileAction } from "./engine/reconcile";
import { sanitizeNoteHtml } from "@/lib/sanitize";
import { stripHtml } from "./engine/evidence";
import {
  deleteTask,
  searchTasks,
  updateTask,
  type CreateTaskInput,
  type RemoteTask,
} from "./sources/workload";

export type RemoteOutcome =
  | { ok: true; affected: number }
  | { ok: false; authExpired: boolean; error: string; rowMissing?: boolean };

type Credentials = { jwt: string; taskBy: string; email: string };

function credentials(): Credentials | { missing: string } {
  const jwt = getSetting("jwt");
  const taskBy = getSetting("task_by");
  const email = getSetting("email");
  if (!jwt) return { missing: "jwt" };
  if (!taskBy) return { missing: "task_by" };
  if (!email) return { missing: "email" };
  return { jwt, taskBy, email };
}

function toTaskInput(card: Card, creds: Credentials): CreateTaskInput {
  return {
    tasks_date: card.tasksDate,
    duration: card.durationSec,
    note: card.noteHtml,
    task_by: creds.taskBy,
    task_type: card.taskType,
    email: creds.email,
    website: card.website,
    clickup_task: card.clickupTask,
  };
}

/** Push a local edit of an already-submitted card to workload. */
export async function pushCardUpdate(card: Card): Promise<RemoteOutcome> {
  if (!card.remoteTaskId) return { ok: true, affected: 0 }; // never uploaded
  const creds = credentials();
  if ("missing" in creds) {
    return { ok: false, authExpired: false, error: `ยังไม่ได้ตั้งค่า ${creds.missing}` };
  }
  const res = await updateTask({
    jwt: creds.jwt,
    id: card.remoteTaskId,
    task: toTaskInput(card, creds),
  });
  if (res.authExpired) return { ok: false, authExpired: true, error: "JWT หมดอายุ" };
  if (!res.ok) return { ok: false, authExpired: false, error: `update-task ตอบ ${res.status}` };
  // 0 rows affected is ambiguous (row gone vs. values already identical) —
  // read the day back before calling it a failure.
  const outcome = decideWriteOutcome({
    affected: res.data,
    rowStillOnRemote: res.data > 0 ? true : await rowExists(creds, card),
  });
  if (outcome === "row-missing") {
    return {
      ok: false,
      authExpired: false,
      rowMissing: true,
      error: `ไม่เจอแถว #${card.remoteTaskId} ใน workload (ถูกลบไปแล้ว?) — ส่งใหม่ได้`,
    };
  }
  if (outcome === "unknown") {
    return {
      ok: false,
      authExpired: false,
      error: `update-task ตอบ 0 แถว และเช็คซ้ำไม่ได้ — ยังไม่ยืนยันว่า workload อัปเดตแล้ว`,
    };
  }
  return { ok: true, affected: res.data };
}

/** Delete the row on workload. Local deletion only happens if this succeeds. */
export async function deleteCardRemote(card: Card): Promise<RemoteOutcome> {
  if (!card.remoteTaskId) return { ok: true, affected: 0 };
  const creds = credentials();
  if ("missing" in creds) {
    return { ok: false, authExpired: false, error: `ยังไม่ได้ตั้งค่า ${creds.missing}` };
  }
  const res = await deleteTask({ jwt: creds.jwt, id: card.remoteTaskId });
  if (res.authExpired) return { ok: false, authExpired: true, error: "JWT หมดอายุ" };
  if (!res.ok) return { ok: false, authExpired: false, error: `delete-task ตอบ ${res.status}` };

  // Deleting is destructive and the endpoint answers 200 even for a no-op, so
  // read the day back and make sure the row is really gone before we drop it
  // locally — otherwise an invisible row would stay on the real report.
  const stillThere = await rowExists(creds, card);
  if (stillThere === true) {
    return {
      ok: false,
      authExpired: false,
      error: `เรียก delete-task แล้วแต่แถว #${card.remoteTaskId} ยังอยู่ใน workload`,
    };
  }
  if (stillThere === false) return { ok: true, affected: Math.max(res.data, 1) };
  // Cannot verify → trust only a positive rows-affected count.
  if (res.data > 0) return { ok: true, affected: res.data };
  return {
    ok: false,
    authExpired: false,
    error: "delete-task ตอบ 0 แถว และเช็คซ้ำไม่ได้ — ยังไม่ลบในแอปเพื่อกันข้อมูลค้าง",
  };
}

/** Does the remote row still exist? null when the check itself failed. */
async function rowExists(creds: Credentials, card: Card): Promise<boolean | null> {
  const check = await searchTasks({
    jwt: creds.jwt,
    email: creds.email,
    startDate: card.tasksDate,
    endDate: card.tasksDate,
  });
  if (!check.ok) return null;
  return check.data.some((t) => String(t.id) === card.remoteTaskId);
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
  const creds = credentials();
  if ("missing" in creds) return creds;

  const res = await searchTasks({
    jwt: creds.jwt,
    email: creds.email,
    startDate: fromYMD,
    endDate: toYMD,
  });
  if (res.authExpired) return { error: "JWT หมดอายุ — วางใหม่ในหน้า Settings", authExpired: true };
  if (!res.ok) return { error: `workload API ตอบ ${res.status}`, authExpired: false };

  const db = getDb();
  const localCards = db
    .select()
    .from(schema.cards)
    .where(and(gte(schema.cards.tasksDate, fromYMD), lte(schema.cards.tasksDate, toYMD)))
    .all();

  const actions = planReconcile({
    localCards: localCards.map((c) => ({
      id: c.id,
      tasksDate: c.tasksDate,
      durationSec: c.durationSec,
      noteHtml: c.noteHtml,
      taskType: c.taskType,
      website: c.website,
      clickupTask: c.clickupTask,
      status: c.status,
      remoteTaskId: c.remoteTaskId,
    })),
    remoteTasks: res.data.map(toRemoteLike),
  });

  return applyActions(actions, localCards, res.data.length);
}

function toRemoteLike(task: RemoteTask) {
  return {
    id: task.id,
    tasks_date: task.tasks_date.slice(0, 10),
    duration: task.duration,
    note: task.note,
    task_type: task.task_type,
    website: task.website,
    clickup_task: task.clickup_task,
  };
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
      const durationSec = Number(remote.duration) || 0;
      const topic = stripHtml(remote.note).slice(0, 80) || "งานจาก workload";
      db.insert(schema.cards)
        .values({
          tasksDate: remote.tasks_date,
          durationSec,
          topic,
          noteHtml: sanitizeNoteHtml(remote.note),
          taskType: remote.task_type,
          website: remote.website,
          clickupTask: remote.clickup_task,
          origin: "manual",
          confidence: 1,
          evidence: { commits: [], tasks: [] },
          fingerprint: fingerprintCard(remote.tasks_date, `remote-${remote.id}`, remote.task_type),
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
