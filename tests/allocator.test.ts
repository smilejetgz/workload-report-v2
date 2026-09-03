import { describe, expect, test } from "vitest";
import {
  allocate,
  MAX_CARD_SEC,
  MIN_CARD_SEC,
  STEP_SEC,
  type AllocInput,
} from "@/server/engine/allocator";

const H = 3600;

function card(id: string, hours: number, origin: AllocInput["origin"] = "git", confidence = 0.8) {
  return { id, proposedSec: hours * H, origin, confidence };
}

function total(result: ReturnType<typeof allocate>): number {
  return result.allocations.reduce((s, a) => s + a.sec, 0);
}

describe("allocate", () => {
  test("keeps proposal when it already sums to target", () => {
    const result = allocate([card("a", 3), card("b", 5 - 3)], 5 * H);
    expect(total(result)).toBe(5 * H);
    expect(result.shortfallSec).toBe(0);
  });

  test("grows cards to reach an 8h target exactly", () => {
    const result = allocate([card("a", 2), card("b", 3)], 8 * H);
    expect(total(result)).toBe(8 * H);
    expect(result.shortfallSec).toBe(0);
  });

  test("shrinks cards when proposal exceeds target", () => {
    const result = allocate([card("a", 4), card("b", 4), card("c", 4)], 8 * H);
    expect(total(result)).toBe(8 * H);
  });

  test("prefers growing inferred cards before git cards", () => {
    const result = allocate(
      [card("real", 2, "git", 0.9), card("filler", 1, "inferred", 0.3)],
      8 * H,
    );
    const filler = result.allocations.find((a) => a.id === "filler")!;
    const real = result.allocations.find((a) => a.id === "real")!;
    expect(total(result)).toBe(8 * H);
    expect(filler.sec).toBeGreaterThanOrEqual(real.sec);
  });

  test("reports shortfall when every card is maxed out", () => {
    const result = allocate([card("a", 1), card("b", 1)], 12 * H);
    expect(total(result)).toBe(2 * MAX_CARD_SEC);
    expect(result.shortfallSec).toBe(12 * H - 2 * MAX_CARD_SEC);
  });

  test("drops weakest card when everything at minimum still overshoots", () => {
    const cards = [
      card("a", 0.5, "git", 0.9),
      card("b", 0.5, "git", 0.8),
      card("c", 0.5, "inferred", 0.2),
    ];
    const result = allocate(cards, 1 * H);
    expect(total(result)).toBe(1 * H);
    expect(result.allocations.length).toBe(2);
    expect(result.allocations.map((a) => a.id)).not.toContain("c");
  });

  test("single card below minimum falls back to exact target", () => {
    const result = allocate([card("a", 2)], 0.25 * H);
    expect(total(result)).toBe(0.25 * H);
  });

  test("zero target yields no allocations", () => {
    const result = allocate([card("a", 2)], 0);
    expect(result.allocations).toEqual([]);
  });

  test("no cards yields full shortfall", () => {
    const result = allocate([], 8 * H);
    expect(result.shortfallSec).toBe(8 * H);
  });

  test("all allocations stay on the 15-minute grid within bounds", () => {
    const result = allocate(
      [card("a", 1.4), card("b", 2.3, "clickup"), card("c", 0.6, "inferred", 0.1)],
      7.5 * H,
    );
    expect(total(result)).toBe(7.5 * H);
    for (const a of result.allocations) {
      expect(a.sec % STEP_SEC).toBe(0);
      expect(a.sec).toBeGreaterThanOrEqual(MIN_CARD_SEC);
      expect(a.sec).toBeLessThanOrEqual(MAX_CARD_SEC);
    }
  });

  test("is deterministic", () => {
    const cards = [card("a", 1), card("b", 2, "inferred", 0.4), card("c", 3, "clickup")];
    expect(allocate(cards, 8 * H)).toEqual(allocate(cards, 8 * H));
  });
});
