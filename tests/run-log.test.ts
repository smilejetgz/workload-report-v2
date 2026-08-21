import { describe, expect, test } from "vitest";
import type { RunLogEntry } from "@/db/schema";
import { appendLog, MAX_RUN_LOG } from "@/server/run-log";

const entry = (text: string): RunLogEntry => ({
  at: "2026-08-21T10:00:00.000Z",
  level: "info",
  text,
});

describe("appendLog", () => {
  test("adds to the end without touching the original array", () => {
    const first = [entry("a")];
    const second = appendLog(first, entry("b"));
    expect(second.map((e) => e.text)).toEqual(["a", "b"]);
    expect(first).toHaveLength(1);
  });

  test("keeps the newest entries once the cap is reached", () => {
    const full = Array.from({ length: 5 }, (_, i) => entry(`line ${i}`));
    const capped = appendLog(full, entry("newest"), 5);
    expect(capped).toHaveLength(5);
    expect(capped[0].text).toBe("line 1");
    expect(capped.at(-1)?.text).toBe("newest");
  });

  test("a long run cannot grow the row without bound", () => {
    let log: RunLogEntry[] = [entry("start")];
    for (let i = 0; i < MAX_RUN_LOG + 50; i++) log = appendLog(log, entry(`line ${i}`));
    expect(log).toHaveLength(MAX_RUN_LOG);
    expect(log.some((e) => e.text === "start")).toBe(false);
  });
});
