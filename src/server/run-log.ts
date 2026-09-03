// The running commentary of a generate run: which repo is being scanned, why
// ClickUp could not be reached, which day the model is on, what the validator
// rejected. It is stored on the run so the window can show it live and it can
// still be read afterwards.

import type { RunLogEntry } from "@/db/schema";

/** Enough to cover a month-long run without letting the row grow unbounded. */
export const MAX_RUN_LOG = 300;

export type RunLogger = (level: RunLogEntry["level"], text: string) => void;

/** Appends immutably and keeps the newest entries when the cap is reached. */
export function appendLog(
  log: RunLogEntry[],
  entry: RunLogEntry,
  max: number = MAX_RUN_LOG,
): RunLogEntry[] {
  const next = [...log, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}
