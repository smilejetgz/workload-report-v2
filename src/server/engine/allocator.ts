// Hour allocator: forces the sum of card durations to exactly match the day
// target. Deterministic pure function — the AI proposes, code disposes.

export const STEP_SEC = 15 * 60; // 15-minute grid
export const MIN_CARD_SEC = 30 * 60; // 0.5h
export const MAX_CARD_SEC = 4 * 60 * 60; // 4h
export const MAX_CARDS_PER_DAY = 5;

export type AllocInput = {
  id: string;
  proposedSec: number;
  origin: "git" | "clickup" | "inferred" | "manual";
  confidence: number;
};

export type Allocation = { id: string; sec: number };

export type AllocResult = {
  allocations: Allocation[];
  /** Seconds still missing after stretching every card to its max. */
  shortfallSec: number;
};

// Cards we prefer to stretch/shrink first: inferred filler before real work.
function adjustPriority(card: AllocInput): number {
  const originRank = { inferred: 0, manual: 3, clickup: 2, git: 2 }[card.origin] ?? 1;
  return originRank * 10 + card.confidence * 9;
}

function roundToStep(sec: number): number {
  return Math.round(sec / STEP_SEC) * STEP_SEC;
}

function clamp(sec: number): number {
  return Math.min(MAX_CARD_SEC, Math.max(MIN_CARD_SEC, roundToStep(sec)));
}

export function allocate(cards: AllocInput[], targetSec: number): AllocResult {
  if (targetSec <= 0 || cards.length === 0) {
    return { allocations: [], shortfallSec: Math.max(0, targetSec) };
  }

  const work = cards.map((c) => ({ ...c, sec: clamp(c.proposedSec) }));
  const sorted = [...work].sort(
    (a, b) => adjustPriority(a) - adjustPriority(b) || a.id.localeCompare(b.id),
  );

  let diff = targetSec - work.reduce((sum, c) => sum + c.sec, 0);

  // Grow: round-robin over adjustable cards (inferred/low-confidence first).
  let guard = 10_000;
  while (diff > 0 && guard-- > 0) {
    const candidate = sorted.find((c) => c.sec + STEP_SEC <= MAX_CARD_SEC);
    if (!candidate) break;
    candidate.sec += STEP_SEC;
    diff -= STEP_SEC;
    sorted.push(sorted.splice(sorted.indexOf(candidate), 1)[0]); // rotate
  }

  // Shrink: same priority order, down to MIN_CARD_SEC.
  while (diff < 0 && guard-- > 0) {
    const candidate = sorted.find((c) => c.sec - STEP_SEC >= MIN_CARD_SEC);
    if (candidate) {
      candidate.sec -= STEP_SEC;
      diff += STEP_SEC;
      sorted.push(sorted.splice(sorted.indexOf(candidate), 1)[0]);
      continue;
    }
    // Everything at minimum but still over target → drop the weakest card.
    if (sorted.length > 1) {
      const dropped = sorted.shift()!;
      diff += dropped.sec;
      dropped.sec = 0;
      continue;
    }
    // Single card and target below MIN — final fallback: exact target.
    sorted[0].sec = Math.max(STEP_SEC, roundToStep(targetSec));
    diff = 0;
  }

  const allocations = work.filter((c) => c.sec > 0).map((c) => ({ id: c.id, sec: c.sec }));
  return { allocations, shortfallSec: Math.max(0, diff) };
}
