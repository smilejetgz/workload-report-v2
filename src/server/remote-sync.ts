// Two-way sync with the workload site for cards that already exist there:
// pushing our edits/deletes, and pulling the real list back.
//
// The workload row is the truth for anything already submitted — it can be
// edited or deleted on the website, and the app's list has to show that.
//
// Every write goes through POST /tasks/batch (the call the site's own calendar
// makes) and is confirmed by reading the day back with GET /tasks/my-day: the
// response code says the request was accepted, the re-read says what is there.

import { and, eq, gte, lte } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { Card } from "@/db/schema";
import { fingerprintCard } from "./pipeline";
import { getSetting } from "./settings";
import {
  noteHtmlFromRemote,
  planReconcile,
  topicForImport,
  type ReconcileAction,
  type RemoteTaskLike,
} from "./engine/reconcile";
import { websiteForProject } from "./engine/project-match";
import { loadCardRefs, toBatchItem, type CardRefs } from "./submit";
import { batchDay, getMyDay, getMyRange, type RemoteTask } from "./sources/workload";
import { taskTypeNameById } from "./workload-ref";

export type RemoteOutcome =
  | { ok: true; affected: number }
  | { ok: false; authExpired: boolean; error: string; rowMissing?: boolean };

const AUTH_EXPIRED: RemoteOutcome = { ok: false, authExpired: true, error: "JWT หมดอายุ" };

function describe(status: number, message: string | null): string {
  return message ? `${status}: ${message}` : String(status);
}

/** Push a local edit of an already-submitted card to workload. */
export async function pushCardUpdate(card: Card): Promise<RemoteOutcome> {
  if (!card.remoteTaskId) return { ok: true, affected: 0 }; // never uploaded
  const jwt = getSetting("jwt");
  if (!jwt) return { ok: false, authExpired: false, error: "ยังไม่ได้ตั้งค่า jwt" };
  const item = toBatchItem(card, loadCardRefs());
  if ("error" in item) return { ok: false, authExpired: false, error: item.error };

  const res = await batchDay(jwt, { workDate: card.tasksDate, items: [item] });
  if (res.authExpired) return AUTH_EXPIRED;
  if (!res.ok) {
    return { ok: false, authExpired: false, error: `workload ตอบ ${describe(res.status, res.message)}` };
  }
  // Confirm: the row must still be there. An update of a row that was deleted
  // on the website is the one case the batch call cannot tell us about.
  const after = await rowAfter(jwt, card);
  if (after === null) {
    return {
      ok: false,
      authExpired: false,
      error: "ส่งแล้วแต่อ่านกลับไม่ได้ — ยังไม่ยืนยันว่า workload อัปเดตแล้ว",
    };
  }
  if (!after) {
    return {
      ok: false,
      authExpired: false,
      rowMissing: true,
      error: `ไม่เจอแถว #${card.remoteTaskId} ใน workload (ถูกลบไปแล้ว?) — ส่งใหม่ได้`,
    };
  }
  return { ok: true, affected: 1 };
}

/** Delete the row on workload. Local deletion only happens if this succeeds. */
export async function deleteCardRemote(card: Card): Promise<RemoteOutcome> {
  if (!card.remoteTaskId) return { ok: true, affected: 0 };
  const jwt = getSetting("jwt");
  if (!jwt) return { ok: false, authExpired: false, error: "ยังไม่ได้ตั้งค่า jwt" };

  const res = await batchDay(jwt, {
    workDate: card.tasksDate,
    items: [],
    remove: [Number(card.remoteTaskId)],
  });
  if (res.authExpired) return AUTH_EXPIRED;
  if (!res.ok) {
    return { ok: false, authExpired: false, error: `workload ตอบ ${describe(res.status, res.message)}` };
  }

  // Deleting is destructive: read the day back and make sure the row is really
  // gone before we drop it locally — otherwise an invisible row would stay on
  // the real report.
  const after = await rowAfter(jwt, card);
  if (after === true) {
    return {
      ok: false,
      authExpired: false,
      error: `สั่งลบแล้วแต่แถว #${card.remoteTaskId} ยังอยู่ใน workload`,
    };
  }
  if (after === false) return { ok: true, affected: 1 };
  return {
    ok: false,
    authExpired: false,
    error: "สั่งลบแล้วแต่อ่านกลับไม่ได้ — ยังไม่ลบในแอปเพื่อกันข้อมูลค้าง",
  };
}

/** Does the remote row exist after the write? null when the check itself failed. */
async function rowAfter(jwt: string, card: Card): Promise<boolean | null> {
  const check = await getMyDay(jwt, card.tasksDate);
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
  const jwt = getSetting("jwt");
  if (!jwt) return { missing: "jwt" };

  const res = await getMyRange(jwt, fromYMD, toYMD);
  if (res.authExpired) return { error: "JWT หมดอายุ — วางใหม่ในหน้า Settings", authExpired: true };
  if (!res.ok) return { error: `workload API ตอบ ${describe(res.status, res.message)}`, authExpired: false };

  const db = getDb();
  const refs = loadCardRefs();
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
      topic: c.topic,
      noteHtml: c.noteHtml,
      taskType: c.taskType,
      website: c.website,
      clickupTask: c.clickupTask,
      status: c.status,
      remoteTaskId: c.remoteTaskId,
    })),
    remoteTasks: res.data.map((t) => toRemoteLike(t, refs)),
  });

  return applyActions(actions, localCards, res.data.length);
}

/** Resolve the site's ids to the names the app stores on a card. */
export function toRemoteLike(task: RemoteTask, refs: CardRefs): RemoteTaskLike {
  return {
    id: task.id,
    legacyId: task.legacyId,
    workDate: task.workDate,
    title: task.title,
    note: task.note,
    taskType:
      task.taskTypeName ??
      taskTypeNameById(refs.taskTypes, task.taskTypeId) ??
      `#${task.taskTypeId ?? "?"}`,
    durationSec: task.durationSec,
    website: websiteForProject(task.projectId, refs.projects) ?? task.projectName ?? null,
    clickupTask: task.clickupTaskId,
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
          topic: action.fields.topic,
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
      db.insert(schema.cards)
        .values({
          tasksDate: remote.workDate,
          durationSec: remote.durationSec,
          topic: topicForImport(remote),
          noteHtml: noteHtmlFromRemote(remote.note),
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
