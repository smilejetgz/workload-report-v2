// After a day is upserted with POST /tasks/batch, the rows are read back with
// GET /tasks/my-day and paired with the cards that were sent, so each card
// learns its remote id. Pure function.
//
// Updates are paired by id. Creates are paired by what we sent (title +
// duration + type), which is how the site itself shows a row — two identical
// rows on one day are rare, and when they do occur they are interchangeable.

import type { BatchItem, RemoteTask } from "@/server/sources/workload";

export type DayMatchCard = {
  cardId: number;
  remoteTaskId: string | null;
  item: BatchItem;
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function itemKey(item: { title: string; durationSec: number; taskTypeId: number | null }): string {
  return `${norm(item.title)}|${item.durationSec}|${item.taskTypeId ?? ""}`;
}

export function matchDayRows(cards: DayMatchCard[], rows: RemoteTask[]): Map<number, RemoteTask> {
  const matched = new Map<number, RemoteTask>();
  const taken = new Set<number>();
  const byId = new Map(rows.map((r) => [String(r.id), r]));

  // 1. Rows we already knew — pair by id.
  for (const card of cards) {
    if (!card.remoteTaskId) continue;
    const row = byId.get(card.remoteTaskId);
    if (!row || taken.has(row.id)) continue;
    matched.set(card.cardId, row);
    taken.add(row.id);
  }

  // 2. Freshly created rows — pair by what we sent.
  const pool = new Map<string, RemoteTask[]>();
  for (const row of rows) {
    if (taken.has(row.id)) continue;
    const key = itemKey(row);
    pool.set(key, [...(pool.get(key) ?? []), row]);
  }
  for (const card of cards) {
    if (matched.has(card.cardId)) continue;
    const row = pool.get(itemKey(card.item))?.find((r) => !taken.has(r.id));
    if (!row) continue;
    matched.set(card.cardId, row);
    taken.add(row.id);
  }

  // 3. Title may have been trimmed or normalised server-side: fall back to
  //    duration + type when that leaves exactly one candidate.
  for (const card of cards) {
    if (matched.has(card.cardId)) continue;
    const candidates = rows.filter(
      (r) =>
        !taken.has(r.id) &&
        r.durationSec === card.item.durationSec &&
        r.taskTypeId === card.item.taskTypeId,
    );
    if (candidates.length !== 1) continue;
    matched.set(card.cardId, candidates[0]);
    taken.add(candidates[0].id);
  }

  return matched;
}
