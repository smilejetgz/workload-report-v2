// AiProvider backed by the local Claude Code CLI (`claude -p`).

import { spawn } from "node:child_process";
import os from "node:os";
import type { AiGenerateOptions, AiProvider, AiResult } from "./provider";
import { parseUsage } from "./usage";

const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * The CLI itself failed (spawn / non-zero exit / timeout / error envelope) —
 * as opposed to the model returning unusable content. These are usually
 * transient (credentials rotating on re-login, rate limit, machine asleep)
 * and are worth retrying with backoff rather than sending a repair prompt.
 */
export class ClaudeCliError extends Error {
  constructor(
    message: string,
    public readonly kind: "spawn" | "exit" | "timeout" | "envelope",
  ) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

export function isTransientAiError(error: unknown): error is ClaudeCliError {
  return error instanceof ClaudeCliError;
}

/** Pull a human-readable line out of the CLI's JSON error envelope. */
function describeCliFailure(output: string): string {
  const trimmed = output.trim();
  try {
    const parsed = JSON.parse(trimmed) as { result?: unknown; error?: unknown; subtype?: unknown };
    for (const field of [parsed.result, parsed.error, parsed.subtype]) {
      if (typeof field === "string" && field.trim()) return field.trim().slice(0, 300);
    }
    return "claude CLI ตอบ error โดยไม่มีข้อความอธิบาย (อาจเป็น auth/limit ชั่วคราว)";
  } catch {
    return trimmed.slice(0, 300) || "ไม่มี output";
  }
}

export class ClaudeCliProvider implements AiProvider {
  async generate(prompt: string, opts?: AiGenerateOptions): Promise<AiResult> {
    const started = Date.now();
    const args = ["-p", "--output-format", "json"];
    if (opts?.model) args.push("--model", opts.model);
    if (opts?.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));

    const stdout = await runClaude(args, prompt, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const durationMs = Date.now() - started;

    // --output-format json wraps the reply: { result: "...", is_error, ... }
    type Envelope = { result?: unknown; is_error?: boolean };
    let wrapper: Envelope | null = null;
    try {
      wrapper = JSON.parse(stdout) as Envelope;
    } catch {
      // Not JSON — fall through and hand the raw text to the caller.
    }
    if (wrapper?.is_error) {
      throw new ClaudeCliError(describeCliFailure(stdout), "envelope");
    }
    const usage = parseUsage(wrapper);
    if (typeof wrapper?.result === "string") {
      return { text: wrapper.result, durationMs, usage };
    }
    return { text: stdout, durationMs, usage };
  }

  /**
   * Run a session and return the FULL NDJSON transcript (assistant turns,
   * tool calls, tool results). Callers parse tool_result payloads themselves —
   * the model never has to re-emit data it fetched.
   */
  generateTranscript(prompt: string, opts?: AiGenerateOptions): Promise<string> {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (opts?.model) args.push("--model", opts.model);
    if (opts?.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
    return runClaude(args, prompt, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }
}

function runClaude(args: string[], stdin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // cwd = tmpdir so the CLI doesn't pick up any project's CLAUDE.md context.
    // User-scope MCP connectors (claude.ai) still load from ~/.claude.json.
    const child = spawn("claude", args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ClaudeCliError(`claude CLI timeout หลัง ${timeoutMs / 1000}s`, "timeout"));
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ClaudeCliError(`spawn claude ล้มเหลว: ${e.message}`, "spawn"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new ClaudeCliError(describeCliFailure(err || out), "exit"));
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}
