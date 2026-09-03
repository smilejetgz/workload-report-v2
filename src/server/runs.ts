// In-process run orchestration. Runs execute inside the Next.js server process;
// state lives in SQLite so the UI (and a resume) survives dev-server reloads.

import { desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { Run } from "@/db/schema";
import { dateRange, isValidYMD } from "./time";
import { executeRun, type GenerateParams } from "./pipeline";
import type { AiProvider } from "./ai/provider";
import { ClaudeCliProvider } from "./ai/cli";

const MAX_RANGE_DAYS = 62;
const STALE_HEARTBEAT_MS = 3 * 60 * 1000;

const globalForRuns = globalThis as unknown as { __activeRunIds?: Set<number> };
function activeRuns(): Set<number> {
  globalForRuns.__activeRunIds ??= new Set();
  return globalForRuns.__activeRunIds;
}

export function validateRangeParams(params: GenerateParams): string | null {
  if (!isValidYMD(params.fromYMD) || !isValidYMD(params.toYMD)) return "รูปแบบวันที่ไม่ถูกต้อง";
  if (params.fromYMD > params.toYMD) return "วันเริ่มต้องไม่เกินวันจบ";
  if (dateRange(params.fromYMD, params.toYMD).length > MAX_RANGE_DAYS) {
    return `ช่วงยาวเกิน ${MAX_RANGE_DAYS} วัน`;
  }
  if (params.hoursPerDay != null && (params.hoursPerDay <= 0 || params.hoursPerDay > 24)) {
    return "ชั่วโมง/วันต้องอยู่ระหว่าง 0-24";
  }
  return null;
}

export function startRun(params: GenerateParams, provider?: AiProvider): { runId: number } {
  const db = getDb();

  // One live run at a time — reuse if something is genuinely still working.
  const running = db
    .select()
    .from(schema.runs)
    .where(inArray(schema.runs.status, ["pending", "running"]))
    .all();
  for (const run of running) {
    const fresh =
      run.heartbeatAt && Date.now() - run.heartbeatAt.getTime() < STALE_HEARTBEAT_MS;
    if (fresh && activeRuns().has(run.id)) {
      throw new Error(`มี run #${run.id} กำลังทำงานอยู่`);
    }
    // Stale (dev reload killed it) — mark failed so a new run can start.
    db.update(schema.runs)
      .set({ status: "failed", error: "run ค้าง (process ถูก restart)", finishedAt: new Date() })
      .where(eq(schema.runs.id, run.id))
      .run();
  }

  const inserted = db
    .insert(schema.runs)
    .values({
      fromDate: params.fromYMD,
      toDate: params.toYMD,
      params: params as unknown as Record<string, unknown>,
      status: "pending",
      heartbeatAt: new Date(),
    })
    .returning({ id: schema.runs.id })
    .get();

  launch(inserted.id, params, provider ?? new ClaudeCliProvider());
  return { runId: inserted.id };
}

export function resumeRun(runId: number, provider?: AiProvider): void {
  const db = getDb();
  const run = db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
  if (!run) throw new Error(`ไม่พบ run #${runId}`);
  if (activeRuns().has(runId)) throw new Error(`run #${runId} กำลังทำงานอยู่แล้ว`);
  const params = run.params as unknown as GenerateParams;
  db.update(schema.runs)
    .set({ status: "pending", error: null, finishedAt: null, heartbeatAt: new Date() })
    .where(eq(schema.runs.id, runId))
    .run();
  // Days that already have draft cards are skipped inside the pipeline.
  launch(runId, { ...params, regenerateDates: null }, provider ?? new ClaudeCliProvider());
}

export function cancelRun(runId: number): void {
  getDb()
    .update(schema.runs)
    .set({ status: "cancelled" })
    .where(eq(schema.runs.id, runId))
    .run();
}

export function getRun(runId: number): Run | null {
  return getDb().select().from(schema.runs).where(eq(schema.runs.id, runId)).get() ?? null;
}

export function getLatestRun(): Run | null {
  return (
    getDb().select().from(schema.runs).orderBy(desc(schema.runs.id)).limit(1).get() ?? null
  );
}

function launch(runId: number, params: GenerateParams, provider: AiProvider): void {
  activeRuns().add(runId);
  void executeRun(runId, params, provider)
    .catch(() => {
      // executeRun records its own failure state; never let it take the process down.
    })
    .finally(() => {
      activeRuns().delete(runId);
    });
}
