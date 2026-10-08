// Submit cards to workload v2. One POST /tasks/batch per day: cards with a
// known remote id are edits, the rest are created, and the server answers
// with the new ids in item order — so nothing has to be guessed back.
//
// A batch is all-or-nothing on the server: one bad item means none of that
// day was written, so every card of that day is marked failed together.

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { Card } from "@/db/schema";
import { getSelectedAuthors } from "./authors";
import { checkIdentity } from "./engine/identity";
import {
  batchLog,
  describeFailure,
  isLegacyRemoteId,
  v2TaskId,
  type BatchItem,
  type BatchLog,
} from "./sources/workload";
import {
  cardToBatchItem,
  loadLookups,
  workloadAccount,
  type Lookups,
} from "./workload-account";

export type SubmitResult = {
  submitted: number;
  updated: number;
  failed: number;
  authExpired: boolean;
  errors: string[];
  /** Identity mismatches (git user vs the workload account) — not fatal. */
  warnings: string[];
};

/** The server refuses more than this many items in one batch. */
const BATCH_MAX_ITEMS = 50;

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

function groupByDate(cards: Card[]): Map<string, Card[]> {
  const byDate = new Map<string, Card[]>();
  for (const card of [...cards].sort((a, b) => a.tasksDate.localeCompare(b.tasksDate))) {
    byDate.set(card.tasksDate, [...(byDate.get(card.tasksDate) ?? []), card]);
  }
  return byDate;
}

/**
 * Request bodies for manual submission (copy-paste fallback when the JWT is
 * dead): one POST /tasks/batch body per day. Works offline, so task type ids
 * come from the last synced list and no project is attached.
 */
export function buildPayload(cards: Card[]): { days: BatchLog[]; skipped: string[] } {
  const taskTypes = getDb()
    .select()
    .from(schema.taskTypes)
    .all()
    .map((t) => ({ ...t, isActive: true, sortOrder: null, positionIds: [] }));
  const lookups: Lookups = { taskTypes, projects: [] };
  const days: BatchLog[] = [];
  const skipped: string[] = [];
  for (const [workDate, dayCards] of groupByDate(cards)) {
    const items: BatchItem[] = [];
    for (const card of dayCards) {
      const built = cardToBatchItem(card, lookups, v2TaskId(card.remoteTaskId) ?? undefined);
      if ("error" in built) skipped.push(`${workDate} "${card.topic}": ${built.error}`);
      else items.push(built.item);
    }
    if (items.length > 0) days.push({ workDate, items });
  }
  return { days, skipped };
}

export async function submitCards(cards: Card[]): Promise<SubmitResult | { missing: string }> {
  const account = workloadAccount();
  if ("missing" in account) return account;
  const db = getDb();
  const result: SubmitResult = {
    submitted: 0,
    updated: 0,
    failed: 0,
    authExpired: false,
    errors: [],
    // Rows land under the token's owner; if that is not the person whose
    // commits were used, the report lands under the wrong name.
    warnings: checkIdentity({
      workloadEmail: account.identity.email,
      workloadName: account.identity.name,
      gitAuthors: getSelectedAuthors(),
    }).warnings,
  };
  if (cards.length === 0) return result;

  const loaded = await loadLookups(account.jwt);
  if (!loaded.ok) {
    if (loaded.authExpired) return { ...result, authExpired: true };
    for (const card of cards) markFailed(card, loaded.error);
    return result;
  }

  // remoteTaskId null = written, but the id is unknown; reconcile links it later.
  function markSubmitted(card: Card, remoteTaskId: number | null) {
    db.update(schema.cards)
      .set({
        status: "submitted",
        remoteTaskId: remoteTaskId === null ? null : String(remoteTaskId),
        submittedAt: new Date(),
        error: null,
        updatedAt: new Date(),
      })
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
  }
  function markFailed(card: Card, message: string) {
    db.update(schema.cards)
      .set({ status: "failed", error: message.slice(0, 500), updatedAt: new Date() })
      .where(eq(schema.cards.id, card.id))
      .run();
    result.failed += 1;
    result.errors.push(`${card.tasksDate} "${card.topic}": ${message.slice(0, 200)}`);
  }

  for (const [workDate, dayCards] of groupByDate(cards)) {
    const ready: { card: Card; item: BatchItem; taskId: number | null }[] = [];
    for (const card of dayCards) {
      if (isLegacyRemoteId(card.remoteTaskId)) {
        markFailed(
          card,
          "ยังไม่ได้จับคู่กับแถวใน workload v2 (ส่งไว้ตั้งแต่ระบบเก่า) — กด 'ดึงจาก workload' ก่อน",
        );
        continue;
      }
      const taskId = v2TaskId(card.remoteTaskId);
      const built = cardToBatchItem(card, loaded.lookups, taskId ?? undefined);
      if ("error" in built) markFailed(card, built.error);
      else ready.push({ card, item: built.item, taskId });
    }

    for (let start = 0; start < ready.length; start += BATCH_MAX_ITEMS) {
      const chunk = ready.slice(start, start + BATCH_MAX_ITEMS);
      const res = await batchLog({
        jwt: account.jwt,
        log: { workDate, items: chunk.map((c) => c.item) },
      });
      if (res.authExpired) {
        result.authExpired = true;
        return result;
      }
      if (!res.ok) {
        const culprit = res.index !== null ? chunk[res.index] : undefined;
        // An edit whose row is gone: drop the stale id so the next submit creates it again.
        if (res.status === 404 && culprit?.taskId != null) {
          db.update(schema.cards)
            .set({ remoteTaskId: null, updatedAt: new Date() })
            .where(eq(schema.cards.id, culprit.card.id))
            .run();
        }
        const reason = describeFailure("tasks/batch", res);
        for (const entry of chunk) {
          markFailed(
            entry.card,
            entry === culprit
              ? res.status === 404 && entry.taskId != null
                ? `ไม่เจอแถว #${entry.taskId} ใน workload — กด Submit อีกครั้งเพื่อสร้างใหม่`
                : reason
              : culprit
                ? `ทั้งวันยังไม่ถูกบันทึก เพราะ "${culprit.card.topic}" ผิด: ${reason}`
                : reason,
          );
        }
        continue;
      }

      // created[] follows the order of the items that had no taskId.
      let createdIndex = 0;
      for (const entry of chunk) {
        if (entry.taskId !== null) {
          markSubmitted(entry.card, entry.taskId);
          result.updated += 1;
          continue;
        }
        // The row was written either way; never mark it failed, or a resubmit duplicates it.
        markSubmitted(entry.card, res.data.created[createdIndex++] ?? null);
        result.submitted += 1;
      }
    }
  }
  return result;
}
