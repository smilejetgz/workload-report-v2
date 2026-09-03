// Deterministic AiProvider for tests and integration runs without a real model.

import type { AiProvider, AiResult } from "./provider";

type QueueItem = { kind: "text"; text: string } | { kind: "error"; error: Error };

export class FakeProvider implements AiProvider {
  public prompts: string[] = [];
  private queue: QueueItem[] = [];
  private fallback: ((prompt: string) => string) | null = null;

  enqueue(...responses: string[]): void {
    this.queue.push(...responses.map((text) => ({ kind: "text" as const, text })));
  }

  /** Queue a thrown error (e.g. ClaudeCliError) for the next call. */
  enqueueError(...errors: Error[]): void {
    this.queue.push(...errors.map((error) => ({ kind: "error" as const, error })));
  }

  respondWith(fn: (prompt: string) => string): void {
    this.fallback = fn;
  }

  async generate(prompt: string): Promise<AiResult> {
    this.prompts.push(prompt);
    const queued = this.queue.shift();
    if (queued?.kind === "error") throw queued.error;
    if (queued?.kind === "text") return { text: queued.text, durationMs: 1 };
    if (this.fallback) return { text: this.fallback(prompt), durationMs: 1 };
    throw new Error("FakeProvider: no response queued");
  }
}
