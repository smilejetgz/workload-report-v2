// Submit cards to the workload site, one day per request: POST /tasks/batch
// updates the rows we already know (by id) and creates the rest, then the day
// is read back so every card learns its remote id and the result is confirmed
// by what the site actually holds, not by the response code.

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { Card, TaskType, WorkloadProject } from "@/db/schema";
import { htmlToText } from "@/lib/html-text";
import { sanitizeNoteHtml } from "@/lib/sanitize";
import { getSelectedAuthors } from "./authors";
import { matchDayRows, type DayMatchCard } from "./engine/day-match";
import { checkIdentity } from "./engine/identity";
import { resolveProjectId } from "./engine/project-match";
import { cachedAccount } from "./me";
import { getSetting } from "./settings";
import { batchDay, getMyDay, type BatchItem } from "./sources/workload";
import { listTaskTypes, listWorkloadProjects, taskTypeIdByName } from "./workload-ref";

export type SubmitResult = {
  submitted: number;
  updated: number;
  failed: number;
  authExpired: boolean;
  errors: string[];
  /** Identity mismatches (git user vs token owner) — not fatal. */
  warnings: string[];
};

/** The site requires a title; a card's topic is that title. */
const TITLE_MAX = 200;

export type CardRefs = { taskTypes: TaskType[]; projects: WorkloadProject[] };

export function loadCardRefs(): CardRefs {
  return { taskTypes: listTaskTypes(), projects: listWorkloadProjects() };
}

export function cardTitle(card: Pick<Card, "topic" | "noteHtml">): string {
  const topic = card.topic.replace(/\s+/g, " ").trim();
  const title = topic || htmlToText(card.noteHtml).slice(0, 80) || "งาน";
  return title.slice(0, TITLE_MAX);
}

/**
 * The row the site stores for a card. Returns an error string instead when the
 * card names a task type the site does not have — uploading it would fail
 * server-side for the whole day, so it is kept out of the batch.
 */
export function toBatchItem(card: Card, refs: CardRefs): BatchItem | { error: string } {
  const taskTypeId = taskTypeIdByName(refs.taskTypes, card.taskType);
  if (taskTypeId === null) {
    return { error: `ไม่รู้จักประเภทงาน "${card.taskType}" บน workload — กดดึงประเภทงานใหม่ในหน้า Settings` };
  }
  return {
    ...(card.remoteTaskId ? { id: Number(card.remoteTaskId) } : {}),
    taskTypeId,
    projectId: resolveProjectId(card.website, refs.projects),
    durationSec: card.durationSec,
    title: cardTitle(card),
    // The site stores the note as HTML (its own calendar builds HTML notes,
    // and the migration kept ours) — send the card's markup, sanitised.
    note: sanitizeNoteHtml(card.noteHtml),
    clickupTaskId: card.clickupTask?.trim() || null,
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

export type DayPayload = { workDate: string; items: BatchItem[] };

/** The exact bodies a submit would POST, for manual submission when the token is dead. */
export function buildPayload(cards: Card[]): { days: DayPayload[]; skipped: string[] } {
  const refs = loadCardRefs();
  const byDate = new Map<string, BatchItem[]>();
  const skipped: string[] = [];
  for (const card of [...cards].sort((a, b) => a.tasksDate.localeCompare(b.tasksDate))) {
    const item = toBatchItem(card, refs);
    if ("error" in item) {
      skipped.push(`${card.tasksDate} "${card.topic}": ${item.error}`);
      continue;
    }
    byDate.set(card.tasksDate, [...(byDate.get(card.tasksDate) ?? []), item]);
  }
  return {
    days: [...byDate.entries()].map(([workDate, items]) => ({ workDate, items })),
    skipped,
  };
}

export async function submitCards(cards: Card[]): Promise<SubmitResult | { missing: string }> {
  const jwt = getSetting("jwt");
  if (!jwt) return { missing: "jwt" };
  const db = getDb();
  const refs = loadCardRefs();
  const result: SubmitResult = {
    submitted: 0,
    updated: 0,
    failed: 0,
    authExpired: false,
    errors: [],
    // Rows land under the token's owner; if that is not the person whose
    // commits were used, the report lands under the wrong name.
    warnings: checkIdentity({ account: cachedAccount(), gitAuthors: getSelectedAuthors() }).warnings,
  };
  if (cards.length === 0) return result;
  if (refs.taskTypes.length === 0) {
    return { ...result, failed: cards.length, errors: ["ยังไม่มีประเภทงาน — กดดึงประเภทงานใหม่ในหน้า Settings"] };
  }

  const now = () => new Date();
  const markSubmitted = (card: Card, remoteTaskId: string | null) => {
    db.update(schema.cards)
      .set({
        status: "submitted",
        submittedAt: now(),
        error: null,
        updatedAt: now(),
        ...(remoteTaskId ? { remoteTaskId } : {}),
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
  };
  const markFailed = (card: Card, message: string) => {
    db.update(schema.cards)
      .set({ status: "failed", error: message.slice(0, 500), updatedAt: now() })
      .where(eq(schema.cards.id, card.id))
      .run();
    result.failed += 1;
    result.errors.push(`${card.tasksDate} "${card.topic}": ${message.slice(0, 200)}`);
  };

  const byDate = new Map<string, Card[]>();
  for (const card of cards) byDate.set(card.tasksDate, [...(byDate.get(card.tasksDate) ?? []), card]);

  for (const [workDate, dayCards] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sendable: DayMatchCard[] = [];
    for (const card of dayCards) {
      const item = toBatchItem(card, refs);
      if ("error" in item) markFailed(card, item.error);
      else sendable.push({ cardId: card.id, remoteTaskId: card.remoteTaskId, item });
    }
    if (sendable.length === 0) continue;

    const res = await batchDay(jwt, { workDate, items: sendable.map((s) => s.item) });
    if (res.authExpired) {
      result.authExpired = true;
      return result;
    }
    const cardById = new Map(dayCards.map((c) => [c.id, c]));
    if (!res.ok) {
      const why = res.message ? `${res.status}: ${res.message}` : String(res.status);
      for (const s of sendable) markFailed(cardById.get(s.cardId)!, `workload ตอบ ${why}`);
      continue;
    }

    // Accepted. Read the day back: that is where ids come from, and the only
    // proof that the rows are really there.
    const day = await getMyDay(jwt, workDate);
    const matched = day.ok ? matchDayRows(sendable, day.data) : new Map();
    for (const s of sendable) {
      const card = cardById.get(s.cardId)!;
      const row = matched.get(s.cardId);
      if (!day.ok) {
        // The write went through; only the confirming read failed. Keep the
        // card submitted and let the next reconcile pick the id up.
        markSubmitted(card, null);
      } else if (!row && s.remoteTaskId) {
        // We asked to update a row the site no longer has. Drop the stale id
        // so the next submit creates it instead of failing forever.
        db.update(schema.cards)
          .set({ remoteTaskId: null, updatedAt: now() })
          .where(eq(schema.cards.id, card.id))
          .run();
        markFailed(card, `ไม่เจอแถว #${s.remoteTaskId} ใน workload แล้ว — กดส่งอีกครั้งเพื่อสร้างใหม่`);
        continue;
      } else {
        markSubmitted(card, row ? String(row.id) : null);
      }
      if (s.remoteTaskId) result.updated += 1;
      else result.submitted += 1;
    }
  }
  return result;
}
