import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ClaudeCliError, ClaudeCliProvider, sessionArgs } from "@/server/ai/cli";

// A stand-in `claude` on PATH: speaks the stream-json protocol, answers each
// user line with a result line, and reports cost as a running total — the
// way the real CLI does. It echoes its pid and argv so tests can see which
// process answered and how it was started.
const FAKE = `#!/usr/bin/env node
const readline = require("node:readline");
let turns = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const prompt = msg.message.content;
  turns += 1;
  if (prompt === "fail") {
    process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "rate limited" }) + "\\n");
    return;
  }
  const delay = prompt === "slow" ? 300 : 0;
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [] } }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "result",
      is_error: false,
      result: JSON.stringify({ pid: process.pid, turns, prompt, argv: process.argv.slice(2) }),
      usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 9000 * (turns - 1), cache_creation_input_tokens: 100 },
      modelUsage: { "claude-sonnet-5-5[1m]": { outputTokens: 10 * turns } },
      total_cost_usd: 0.01 * turns,
    }) + "\\n");
  }, delay);
});
`;

let dir = "";
const originalPath = process.env.PATH;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  fs.writeFileSync(path.join(dir, "claude"), FAKE, { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

const reply = (text: string) =>
  JSON.parse(text) as { pid: number; turns: number; prompt: string; argv: string[] };

describe("ClaudeCliProvider — one long-lived session, cache-friendly", () => {
  test("consecutive days go to the same process, so the cached prefix is reused", async () => {
    const provider = new ClaudeCliProvider();
    try {
      const a = reply((await provider.generate("day 1", { system: "RULES" })).text);
      const b = reply((await provider.generate("day 2", { system: "RULES" })).text);
      expect(b.pid).toBe(a.pid);
      expect(b.turns).toBe(2);
    } finally {
      provider.close();
    }
  });

  test("per-turn cost is the difference of the CLI's running total", async () => {
    const provider = new ClaudeCliProvider();
    try {
      const first = await provider.generate("day 1", { system: "RULES" });
      const second = await provider.generate("day 2", { system: "RULES" });
      expect(first.usage?.costUsd).toBeCloseTo(0.01);
      expect(second.usage?.costUsd).toBeCloseTo(0.01);
      expect(second.usage?.cacheReadTokens).toBe(9000);
      expect(second.usage?.model).toBe("claude-sonnet-5-5[1m]");
    } finally {
      provider.close();
    }
  });

  test("starts sessions with the system prompt, the default model and a stripped tool set", async () => {
    const provider = new ClaudeCliProvider();
    try {
      const { argv } = reply((await provider.generate("day 1", { system: "RULES" })).text);
      expect(argv).toEqual(expect.arrayContaining(["--allow-dangerously-skip-permissions"]));
      expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe("RULES");
      expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-5-5[1m]");
      expect(argv[argv.indexOf("--input-format") + 1]).toBe("stream-json");
      expect(argv[argv.indexOf("--tools") + 1]).toBe("");
      expect(argv).toContain("--strict-mcp-config");
    } finally {
      provider.close();
    }
  });

  test("concurrent calls each get their own session", async () => {
    const provider = new ClaudeCliProvider();
    try {
      const [a, b] = await Promise.all([
        provider.generate("slow", { system: "RULES" }),
        provider.generate("slow", { system: "RULES" }),
      ]);
      expect(reply(a.text).pid).not.toBe(reply(b.text).pid);
    } finally {
      provider.close();
    }
  });

  test("a different system prompt never shares a session", async () => {
    const provider = new ClaudeCliProvider();
    try {
      const a = reply((await provider.generate("x", { system: "RULES A" })).text);
      const b = reply((await provider.generate("x", { system: "RULES B" })).text);
      expect(b.pid).not.toBe(a.pid);
    } finally {
      provider.close();
    }
  });

  test("an error turn is a ClaudeCliError and the next call starts a fresh session", async () => {
    const provider = new ClaudeCliProvider();
    try {
      const first = reply((await provider.generate("ok", { system: "RULES" })).text);
      await expect(provider.generate("fail", { system: "RULES" })).rejects.toBeInstanceOf(ClaudeCliError);
      const after = reply((await provider.generate("ok", { system: "RULES" })).text);
      expect(after.pid).not.toBe(first.pid);
      expect(after.turns).toBe(1);
    } finally {
      provider.close();
    }
  });

  test("a turn that runs too long times out as a ClaudeCliError", async () => {
    const provider = new ClaudeCliProvider();
    try {
      await expect(
        provider.generate("slow", { system: "RULES", timeoutMs: 50 }),
      ).rejects.toMatchObject({ kind: "timeout" });
    } finally {
      provider.close();
    }
  });

  test("a session is retired after enough days, bounding the history it re-reads", async () => {
    const provider = new ClaudeCliProvider();
    try {
      const pids = new Set<number>();
      for (let i = 0; i < 9; i++) {
        pids.add(reply((await provider.generate(`day ${i}`, { system: "RULES" })).text).pid);
      }
      expect(pids.size).toBe(2);
    } finally {
      provider.close();
    }
  });
});

describe("sessionArgs", () => {
  test("tool-using sessions keep MCP and list their tools", () => {
    const args = sessionArgs({ model: "m", system: null, allowedTools: ["mcp__x__y"] });
    expect(args).toContain("--allowedTools");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--append-system-prompt");
  });
});
