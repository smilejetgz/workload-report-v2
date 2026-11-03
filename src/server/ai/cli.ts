// AiProvider backed by the local Claude Code CLI (`claude -p`).
//
// Token economy: one long-lived CLI process per concurrent worker, fed one
// day at a time over stream-json. The instructions travel once as the system
// prompt (--append-system-prompt), and every later day reads them — and the
// conversation so far — from the prompt cache instead of paying for them again.
// The session is stripped to what a pure-text job needs: no built-in tools,
// no MCP servers, no skills, and the per-machine sections of the default
// system prompt moved out so the cached prefix stays byte-identical.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import type { AiGenerateOptions, AiProvider, AiResult } from "./provider";
import { DEFAULT_AI_MODEL } from "@/lib/ai-defaults";
import { parseUsage } from "./usage";

export { DEFAULT_AI_MODEL };

const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * A session's history is re-read (from cache) on every turn, so it is retired
 * after this many days — enough to amortise the system prompt, before the
 * history costs more than it saves.
 */
const MAX_TURNS_PER_SESSION = 8;

/** Flags every invocation shares. */
const BASE_ARGS = ["-p", "--allow-dangerously-skip-permissions"];

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

/** Arguments for a stream-json generation session. */
export function sessionArgs(opts: {
  model: string;
  system: string | null;
  allowedTools?: string[];
}): string[] {
  const args = [
    ...BASE_ARGS,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    opts.model,
    "--no-session-persistence",
    "--disable-slash-commands",
    "--exclude-dynamic-system-prompt-sections",
  ];
  if (opts.allowedTools?.length) {
    // Tool-using sessions keep their MCP servers; only the listed tools may run.
    args.push("--allowedTools", opts.allowedTools.join(","));
  } else {
    // Pure text: tool and MCP definitions would only add tokens to every turn.
    args.push("--tools", "", "--strict-mcp-config");
  }
  if (opts.system) args.push("--append-system-prompt", opts.system);
  return args;
}

/** The `result` line the CLI prints at the end of each turn. */
type ResultEnvelope = {
  type: "result";
  is_error?: boolean;
  result?: unknown;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  /** Running total for the whole session, not this turn. */
  total_cost_usd?: number;
};

type Pending = {
  resolve: (envelope: ResultEnvelope) => void;
  reject: (error: ClaudeCliError) => void;
  timer: NodeJS.Timeout;
};

/** One `claude -p --input-format stream-json` process, answering one turn at a time. */
class CliSession {
  readonly key: string;
  turns = 0;
  busy = false;
  closed = false;
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private stderr = "";
  private pending: Pending | null = null;
  private costSoFar = 0;

  constructor(key: string, args: string[]) {
    this.key = key;
    // cwd = tmpdir so the CLI doesn't pick up any project's CLAUDE.md context.
    this.child = spawn("claude", args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk.toString()));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    this.child.on("error", (e) =>
      this.fail(new ClaudeCliError(`spawn claude ล้มเหลว: ${e.message}`, "spawn")),
    );
    this.child.on("close", () =>
      this.fail(new ClaudeCliError(describeCliFailure(this.stderr || "claude CLI ปิดตัวกลางคัน"), "exit")),
    );
    // A closed stdin (e.g. the process already died) must not crash the app.
    this.child.stdin.on("error", () => {});
  }

  /** Send one user message and wait for that turn's result line. */
  async send(prompt: string, timeoutMs: number): Promise<AiResult> {
    if (this.closed) throw new ClaudeCliError("claude CLI session ปิดไปแล้ว", "exit");
    const started = Date.now();
    this.busy = true;
    try {
      const envelope = await new Promise<ResultEnvelope>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.fail(new ClaudeCliError(`claude CLI timeout หลัง ${timeoutMs / 1000}s`, "timeout"));
        }, timeoutMs);
        this.pending = { resolve, reject, timer };
        const message = { type: "user", message: { role: "user", content: prompt } };
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
      });
      this.turns += 1;
      const durationMs = Date.now() - started;
      if (envelope.is_error) {
        // The session's state is unknown after an error turn — start fresh next time.
        this.close();
        throw new ClaudeCliError(describeCliFailure(JSON.stringify(envelope)), "envelope");
      }
      // Cost is reported as a running total; this turn's share is the difference.
      const total = typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : 0;
      const turnCost = Math.max(0, total - this.costSoFar);
      this.costSoFar = total;
      const usage = parseUsage({ ...envelope, total_cost_usd: turnCost });
      const text = typeof envelope.result === "string" ? envelope.result : "";
      return { text, durationMs, usage };
    } finally {
      this.busy = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    // stdin EOF ends the CLI on its own; make sure a stuck one does not linger.
    setTimeout(() => this.child.kill("SIGKILL"), 5000).unref();
  }

  private onStdout(text: string): void {
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: { type?: unknown };
      try {
        message = JSON.parse(line) as { type?: unknown };
      } catch {
        continue; // not a protocol line
      }
      if (message.type === "result" && this.pending) {
        const { resolve, timer } = this.pending;
        clearTimeout(timer);
        this.pending = null;
        resolve(message as ResultEnvelope);
      }
    }
  }

  private fail(error: ClaudeCliError): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    if (!this.closed) {
      this.closed = true;
      this.child.kill("SIGKILL");
    }
  }
}

export class ClaudeCliProvider implements AiProvider {
  private sessions: CliSession[] = [];

  async generate(prompt: string, opts?: AiGenerateOptions): Promise<AiResult> {
    const model = opts?.model || DEFAULT_AI_MODEL;
    const system = opts?.system ?? null;
    const key = JSON.stringify([model, system, opts?.allowedTools ?? []]);
    this.sessions = this.sessions.filter((s) => !s.closed);
    const session =
      this.sessions.find((s) => s.key === key && !s.busy) ??
      this.spawnSession(key, sessionArgs({ model, system, allowedTools: opts?.allowedTools }));
    // Claim it before the first await, so a concurrent call opens its own.
    session.busy = true;
    try {
      return await session.send(prompt, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    } finally {
      if (session.turns >= MAX_TURNS_PER_SESSION) session.close();
    }
  }

  close(): void {
    for (const session of this.sessions) session.close();
    this.sessions = [];
  }

  /**
   * Run a session and return the FULL NDJSON transcript (assistant turns,
   * tool calls, tool results). Callers parse tool_result payloads themselves —
   * the model never has to re-emit data it fetched.
   */
  generateTranscript(prompt: string, opts?: AiGenerateOptions): Promise<string> {
    const args = [...BASE_ARGS, "--output-format", "stream-json", "--verbose"];
    if (opts?.model) args.push("--model", opts.model);
    if (opts?.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
    return runClaude(args, prompt, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  private spawnSession(key: string, args: string[]): CliSession {
    const session = new CliSession(key, args);
    this.sessions.push(session);
    return session;
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
