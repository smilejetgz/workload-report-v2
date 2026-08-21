import { describe, expect, test } from "vitest";
import { parseUsage, sumUsage } from "@/server/ai/usage";

// Shape taken from a real `claude -p --output-format json` envelope.
const ENVELOPE = {
  result: "ok",
  total_cost_usd: 0.0653196,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 31480,
    cache_read_input_tokens: 18046,
    output_tokens: 109,
  },
  modelUsage: {
    "claude-haiku-4-5-20251001": {
      inputTokens: 10,
      outputTokens: 109,
      cacheReadInputTokens: 18046,
      cacheCreationInputTokens: 31480,
      costUSD: 0.0653196,
    },
  },
};

describe("parseUsage", () => {
  test("reads tokens, model and cost from the CLI envelope", () => {
    expect(parseUsage(ENVELOPE)).toEqual({
      model: "claude-haiku-4-5-20251001",
      inputTokens: 10,
      outputTokens: 109,
      cacheReadTokens: 18046,
      cacheCreationTokens: 31480,
      costUsd: 0.0653196,
    });
  });

  test("falls back to modelUsage when the flat usage block is missing", () => {
    const usage = parseUsage({ modelUsage: ENVELOPE.modelUsage });
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBe(109);
  });

  test("names the model that did the most work when several are listed", () => {
    const usage = parseUsage({
      modelUsage: {
        "claude-haiku-4-5": { outputTokens: 10, inputTokens: 1 },
        "claude-sonnet-5": { outputTokens: 900, inputTokens: 5 },
      },
    });
    expect(usage?.model).toBe("claude-sonnet-5");
  });

  test("an envelope without usage yields null rather than zeroes", () => {
    expect(parseUsage({ result: "ok" })).toBeNull();
    expect(parseUsage("not an object")).toBeNull();
  });
});

describe("sumUsage", () => {
  test("adds up every call of a run", () => {
    const total = sumUsage([
      { inputTokens: 10, outputTokens: 100, cacheReadTokens: 5, cacheCreationTokens: 1, costUsd: 0.1, model: "a" },
      { inputTokens: 20, outputTokens: 200, cacheReadTokens: 7, cacheCreationTokens: 2, costUsd: 0.2, model: "a" },
    ]);
    expect(total).toMatchObject({
      inputTokens: 30,
      outputTokens: 300,
      cacheReadTokens: 12,
      cacheCreationTokens: 3,
      calls: 2,
    });
    expect(total.costUsd).toBeCloseTo(0.3, 6);
  });

  test("counts total tokens across every kind", () => {
    const total = sumUsage([
      { inputTokens: 10, outputTokens: 100, cacheReadTokens: 5, cacheCreationTokens: 1, costUsd: 0, model: "a" },
    ]);
    expect(total.totalTokens).toBe(116);
  });

  test("no calls sums to zero, not NaN", () => {
    expect(sumUsage([])).toMatchObject({ calls: 0, totalTokens: 0, costUsd: 0 });
  });

  test("ignores calls that reported no usage", () => {
    const total = sumUsage([
      null,
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, model: "a" },
    ]);
    expect(total.calls).toBe(1);
  });
});
