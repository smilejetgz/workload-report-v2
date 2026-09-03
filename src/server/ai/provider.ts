import type { AiUsage } from "./usage";

export type AiResult = {
  text: string;
  durationMs: number;
  /** null when the provider does not report it (fake provider, raw output). */
  usage?: AiUsage | null;
};

export type AiGenerateOptions = {
  model?: string | null;
  /** MCP/tool names the CLI session may call (default: none — pure text). */
  allowedTools?: string[];
  timeoutMs?: number;
};

export interface AiProvider {
  generate(prompt: string, opts?: AiGenerateOptions): Promise<AiResult>;
}
