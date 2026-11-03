import type { AiUsage } from "./usage";

export type AiResult = {
  text: string;
  durationMs: number;
  /** null when the provider does not report it (fake provider, raw output). */
  usage?: AiUsage | null;
};

export type AiGenerateOptions = {
  model?: string | null;
  /**
   * Instructions shared by many calls. Sent as the system prompt, so a
   * provider that keeps a session open pays for it once and then reads it
   * from the prompt cache. Calls with the same system text share sessions.
   */
  system?: string | null;
  /** MCP/tool names the CLI session may call (default: none — pure text). */
  allowedTools?: string[];
  timeoutMs?: number;
};

export interface AiProvider {
  generate(prompt: string, opts?: AiGenerateOptions): Promise<AiResult>;
  /** Release long-lived resources (open CLI sessions). Safe to call more than once. */
  close?(): void;
}
