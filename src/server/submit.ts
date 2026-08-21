// Submit cards to the workload API. Idempotent-ish: cards with a known
// remote_task_id are updated, the rest are created in one batch, then remote
// ids are recovered by re-fetching the range and matching.

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { Card } from "@/db/schema";
import { getSelectedAuthors } from "./authors";
import { stripHtml } from "./engine/evidence";
import { checkIdentity } from "./engine/identity";
import { getSetting } from "./settings";
import {
  createTaskList,
  searchTasks,
  updateTask,
  type CreateTaskInput,
  type RemoteTask,
} from "./sources/workload";

export type SubmitResult = {
  submitted: number;
  updated: number;
  failed: number;
  authExpired: boolean;
  errors: string[];
  /** Identity mismatches (git user vs workload task_by/email) — not fatal. */
  warnings: string[];
};

type Credentials = { jwt: string; taskBy: string; email: string };

function requireCredentials(): Credentials | { missing: string } {
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

export function selectSubmittableCards(fromYMD: string, toYMD: string, ids?: number[]): Card[] {
  const db = getDb();
  const base = and(
    gte(schema.cards.tasksDate, fromYMD),
    lte(schema.cards.tasksDate, toYMD),
    inArray(schema.cards.status, ["draft", "approved", "failed"]),
  );
  const where = ids && ids.length > 0 ? and(base, inArray(schema.cards.id, ids)) : base;
  return db.select().from(schema.cards).where(where).all();
}

/**
 * Cards that exist only in this app, so clearing them costs nothing remotely.
 *
 * A card holding a remote id may have a row on workload — deleting it here
 * would orphan that row with nothing left pointing at it — so those are kept
 * and must be removed one by one, which deletes on workload too.
 */
export function isClearableCard(card: { status: string; remoteTaskId: string | null }): boolean {
  return card.status !== "submitted" && !card.remoteTaskId;
}

export function selectClearableCards(fromYMD: string, toYMD: string): Card[] {
  return getDb()
    .select()
    .from(schema.cards)
    .where(and(gte(schema.cards.tasksDate, fromYMD), lte(schema.cards.tasksDate, toYMD)))
    .all()
    .filter(isClearableCard);
}

/** Payload for manual submission (copy-paste fallback when JWT is dead). */
export function buildPayload(cards: Card[]): { tasks: CreateTaskInput[] } | { missing: string } {
  const creds = requireCredentials();
  if ("missing" in creds && creds.missing === "jwt") {
    // Payload export works without jwt — only task_by/email are required.
    const taskBy = getSetting("task_by");
    const email = getSetting("email");
    if (!taskBy) return { missing: "task_by" };
    if (!email) return { missing: "email" };
    return { tasks: cards.map((c) => toTaskInput(c, { jwt: "", taskBy, email })) };
  }
  if ("missing" in creds) return creds;
  return { tasks: cards.map((c) => toTaskInput(c, creds)) };
}

export async function submitCards(cards: Card[]): Promise<SubmitResult | { missing: string }> {
  const creds = requireCredentials();
  if ("missing" in creds) return creds;
  const db = getDb();
  const result: SubmitResult = {
    submitted: 0,
    updated: 0,
    failed: 0,
    authExpired: false,
    errors: [],
    // The upload carries task_by/email; if that is not the person whose
    // commits were used, the report lands under the wrong name.
    warnings: checkIdentity({
      workloadEmail: creds.email,
      taskBy: creds.taskBy,
      gitAuthors: getSelectedAuthors(),
      employees: null,
    }).warnings,
  };
  if (cards.length === 0) return result;

  const markSubmitted = (card: Card) => {
    db.update(schema.cards)
      .set({ status: "submitted", submittedAt: new Date(), error: null, updatedAt: new Date() })
      .where(eq(schema.cards.id, card.id))
      .run();
    db.insert(schema.styleExamples)
      .values({
        tasksDate: card.tasksDate,
        taskType: card.taskType,
        durationSec: card.durationSec,
        noteHtml: card.noteHtml,
        source: "v2",
      })
      .run();
  };
  const markFailed = (card: Card, message: string) => {
    db.update(schema.cards)
      .set({ status: "failed", error: message.slice(0, 500), updatedAt: new Date() })
      .where(eq(schema.cards.id, card.id))
      .run();
    result.failed += 1;
    result.errors.push(`${card.tasksDate} "${card.topic}": ${message.slice(0, 200)}`);
  };

  // 1. Updates for cards that already exist remotely.
  const toUpdate = cards.filter((c) => c.remoteTaskId);
  for (const card of toUpdate) {
    const res = await updateTask({
      jwt: creds.jwt,
      id: card.remoteTaskId!,
      task: toTaskInput(card, creds),
    });
    if (res.authExpired) {
      result.authExpired = true;
      return result;
    }
    if (res.ok && res.data > 0) {
      markSubmitted(card);
      result.updated += 1;
    } else if (res.ok) {
      // 200 with 0 rows affected: the row we remembered is gone from workload.
      // Drop the stale id so the next submit creates it again.
      db.update(schema.cards)
        .set({ remoteTaskId: null, updatedAt: new Date() })
        .where(eq(schema.cards.id, card.id))
        .run();
      markFailed(card, `ไม่เจอแถว #${card.remoteTaskId} ใน workload — กด Submit อีกครั้งเพื่อสร้างใหม่`);
    } else {
      markFailed(card, `update ตอบ ${res.status}`);
    }
  }

  // 2. Batch-create the rest.
  const toCreate = cards.filter((c) => !c.remoteTaskId);
  if (toCreate.length > 0) {
    const res = await createTaskList({
      jwt: creds.jwt,
      tasks: toCreate.map((c) => toTaskInput(c, creds)),
    });
    if (res.authExpired) {
      result.authExpired = true;
      return result;
    }
    if (res.ok) {
      for (const card of toCreate) {
        markSubmitted(card);
        result.submitted += 1;
      }
      await recoverRemoteIds(toCreate, creds);
    } else {
      for (const card of toCreate) markFailed(card, `create ตอบ ${res.status}`);
    }
  }
  return result;
}

/** Re-fetch the range and store remote ids so future submits become updates. */
async function recoverRemoteIds(cards: Card[], creds: Credentials): Promise<void> {
  if (cards.length === 0) return;
  const db = getDb();
  const dates = cards.map((c) => c.tasksDate).sort();
  const res = await searchTasks({
    jwt: creds.jwt,
    email: creds.email,
    startDate: dates[0],
    endDate: dates[dates.length - 1],
  });
  if (!res.ok) return;

  const remoteByKey = new Map<string, RemoteTask>();
  for (const task of res.data) {
    const key = `${task.tasks_date.slice(0, 10)}|${Number(task.duration)}|${stripHtml(task.note).slice(0, 80)}`;
    remoteByKey.set(key, task);
  }
  for (const card of cards) {
    const key = `${card.tasksDate}|${card.durationSec}|${stripHtml(card.noteHtml).slice(0, 80)}`;
    const remote = remoteByKey.get(key);
    if (remote) {
      db.update(schema.cards)
        .set({ remoteTaskId: String(remote.id) })
        .where(eq(schema.cards.id, card.id))
        .run();
    }
  }
}
