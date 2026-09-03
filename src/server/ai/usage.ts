// Token accounting for the generate run.
//
// `claude -p --output-format json` reports usage two ways: a flat `usage`
// block, and a `modelUsage` map keyed by the model that actually ran. The map
// is the only place the model name appears, so both are read.

export type AiUsage = {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
};

export type UsageTotal = AiUsage & { calls: number; totalTokens: number };

type ModelUsageEntry = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
};

const num = (value: unknown): number => (typeof value === "number" && isFinite(value) ? value : 0);

export function parseUsage(envelope: unknown): AiUsage | null {
  if (!envelope || typeof envelope !== "object") return null;
  const env = envelope as {
    usage?: Record<string, unknown>;
    modelUsage?: Record<string, ModelUsageEntry>;
    total_cost_usd?: unknown;
  };

  const models = Object.entries(env.modelUsage ?? {});
  // Several models can appear when the CLI delegates; credit the one that
  // produced the most output.
  const [model, byModel] =
    models.sort((a, b) => num(b[1]?.outputTokens) - num(a[1]?.outputTokens))[0] ?? [];

  const flat = env.usage;
  if (!flat && !byModel) return null;

  return {
    model: model ?? null,
    inputTokens: flat ? num(flat.input_tokens) : num(byModel?.inputTokens),
    outputTokens: flat ? num(flat.output_tokens) : num(byModel?.outputTokens),
    cacheReadTokens: flat
      ? num(flat.cache_read_input_tokens)
      : num(byModel?.cacheReadInputTokens),
    cacheCreationTokens: flat
      ? num(flat.cache_creation_input_tokens)
      : num(byModel?.cacheCreationInputTokens),
    costUsd: num(env.total_cost_usd) || num(byModel?.costUSD),
  };
}

export function sumUsage(entries: (AiUsage | null | undefined)[]): UsageTotal {
  const used = entries.filter((e): e is AiUsage => Boolean(e));
  const total = used.reduce(
    (acc, e) => ({
      inputTokens: acc.inputTokens + e.inputTokens,
      outputTokens: acc.outputTokens + e.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + e.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + e.cacheCreationTokens,
      costUsd: acc.costUsd + e.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
  );
  return {
    ...total,
    model: used.at(-1)?.model ?? null,
    calls: used.length,
    totalTokens:
      total.inputTokens + total.outputTokens + total.cacheReadTokens + total.cacheCreationTokens,
  };
}
