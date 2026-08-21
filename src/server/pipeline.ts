// Generate pipeline: evidence → AI per day → validate/repair → allocate → cards.

import { createHash } from "node:crypto";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { RunProgress } from "@/db/schema";
import { filterMyCommits } from "./authors";
import { resolveDayTargets, type ResolvedDayTarget } from "./day-targets";
import { getDefaultDailySec, getSetting } from "./settings";
import { refreshEvidence } from "./sync";
import { getTaskTypes, searchTasks, type RemoteTask } from "./sources/workload";
import { resolveClickupLink } from "./engine/clickup-link";
import { buildDayEvidence, hasDayEvidence, type DayEvidence } from "./engine/evidence";
import { buildDayPrompt } from "./engine/prompt";
import { parseDayPlan, validateDayPlan, type DayPlan } from "./engine/validator";
import { allocate, MAX_CARD_SEC, STEP_SEC } from "./engine/allocator";
import type { AiProvider } from "./ai/provider";
import { isTransientAiError } from "./ai/cli";
import { sumUsage, type AiUsage } from "./ai/usage";
import { appendLog, type RunLogger } from "./run-log";

const MAX_ATTEMPTS = 3;
const MAX_TRANSIENT_RETRIES = 4;
const TRANSIENT_BACKOFF_MS = [3_000, 10_000, 30_000, 60_000];
const DAY_CONCURRENCY = 3;

export type GenerateParams = {
  fromYMD: string;
  toYMD: string;
  hoursPerDay?: number | null;
  regenerateDates?: string[] | null; // force re-plan these dates (drops their drafts)
};

/** 12345 → "12.3k" so a log line stays readable. */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function fingerprintCard(date: string, topic: string, taskType: string): string {
  return createHash("sha1").update(`${date}|${topic.trim()}|${taskType}`).digest("hex");
}

export async function executeRun(
  runId: number,
  params: GenerateParams,
  provider: AiProvider,
): Promise<void> {
  const db = getDb();
  const setRun = (values: Partial<typeof schema.runs.$inferInsert>) =>
    db.update(schema.runs).set(values).where(eq(schema.runs.id, runId)).run();

  // The progress object is created up front so the sync phase can narrate
  // itself: "ClickUp เชื่อมไม่ได้" has to reach the screen while it happens,
  // not after the run is over.
  const progress: RunProgress = {
    total: 0,
    completed: 0,
    currentDates: [],
    dayStatus: {},
    phase: "sync",
    log: [],
  };
  const log: RunLogger = (level, text) => {
    progress.log = appendLog(progress.log ?? [], { at: new Date().toISOString(), level, text });
    setRun({ progress, heartbeatAt: new Date() });
  };
  const usages: (AiUsage | null)[] = [];

  try {
    setRun({ status: "running", heartbeatAt: new Date(), progress });

    // Regenerating means "redo exactly these days". Everything below — the
    // evidence refresh, the remote preflight, the day queue — narrows to them,
    // so pressing สร้างใหม่ on one day cannot plan the rest of the range.
    const regenerate = new Set(params.regenerateDates ?? []);
    const requested = [...regenerate].sort();
    const fromYMD = requested[0] ?? params.fromYMD;
    const toYMD = requested[requested.length - 1] ?? params.toYMD;

    log(
      "info",
      requested.length > 0
        ? `สร้างใหม่เฉพาะ ${requested.length} วัน: ${requested.join(", ")}`
        : `ช่วง ${params.fromYMD} ถึง ${params.toYMD}`,
    );

    const defaultSec = params.hoursPerDay ? params.hoursPerDay * 3600 : getDefaultDailySec();
    const overrides = db.select().from(schema.dayTargets).all();
    const targets = resolveDayTargets(fromYMD, toYMD, defaultSec, overrides);
    const workDays = targets.filter(
      (t) => t.targetSec > 0 && (regenerate.size === 0 || regenerate.has(t.date)),
    );
    // Published before the sync: reading evidence takes a while (a ClickUp pull
    // can run for minutes) and the day rows have to say "รอคิว" meanwhile.
    progress.total = workDays.length;
    progress.dayStatus = Object.fromEntries(workDays.map((d) => [d.date, "pending" as const]));
    log("info", `วันทำงานในช่วงนี้ ${workDays.length} วัน`);

    // --- Evidence + remote preflight (sequential, shared by all days) -------
    const sync = await refreshEvidence(fromYMD, toYMD, log);
    const { remoteTasks, remoteWarning } = await fetchRemoteTasks(fromYMD, toYMD);
    if (remoteWarning) log("warn", remoteWarning);
    else log("info", `เช็คของที่อยู่บน workload แล้ว ${remoteTasks.length} รายการ`);
    const taskTypeNames = await ensureTaskTypes();
    log("info", `ประเภทงานที่เลือกได้ ${taskTypeNames.length} แบบ`);

    for (const date of regenerate) {
      db.delete(schema.cards)
        .where(
          and(
            eq(schema.cards.tasksDate, date),
            inArray(schema.cards.status, ["draft", "approved"]),
          ),
        )
        .run();
    }

    progress.phase = "generate";
    log("info", `เริ่มเขียนรายงาน ${workDays.length} วัน (ทำพร้อมกันครั้งละ ${DAY_CONCURRENCY})`);

    const shared = await loadSharedContext(fromYMD, toYMD);
    log(
      "info",
      `หลักฐานในช่วงนี้: ${shared.commits.length} commit ของเรา · ${shared.tasks.length} task ใน ClickUp` +
        (shared.aiModel ? ` · โมเดล ${shared.aiModel}` : " · โมเดลค่าเริ่มต้นของ CLI"),
    );
    const queue = [...workDays];
    const failures: string[] = [...sync.warnings];
    if (remoteWarning) failures.push(remoteWarning);

    const worker = async () => {
      for (;;) {
        const day = queue.shift();
        if (!day) return;
        const current = db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
        if (current?.status === "cancelled") return;

        progress.currentDates.push(day.date);
        progress.dayStatus[day.date] = "running";
        setRun({ progress, heartbeatAt: new Date() });
        try {
          const outcome = await generateDay({
            runId,
            day,
            remoteTasks,
            taskTypeNames,
            shared,
            provider,
            log,
            usages,
          });
          progress.dayStatus[day.date] = outcome;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          progress.dayStatus[day.date] = "failed";
          failures.push(`${day.date}: ${message}`);
          log("error", `${day.date}: ${message}`);
        }
        progress.completed += 1;
        progress.currentDates = progress.currentDates.filter((d) => d !== day.date);
        setRun({ progress, heartbeatAt: new Date() });
      }
    };
    await Promise.all(Array.from({ length: DAY_CONCURRENCY }, worker));

    const final = db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
    if (final?.status === "cancelled") {
      setRun({ finishedAt: new Date() });
      return;
    }
    const failedDays = Object.values(progress.dayStatus).filter((s) => s === "failed").length;
    const total = sumUsage(usages);
    log(
      "info",
      total.calls > 0
        ? `รวม ${total.calls} ครั้ง · ${total.model ?? "ไม่ทราบโมเดล"} · ` +
            `เข้า ${fmtTokens(total.inputTokens)} ออก ${fmtTokens(total.outputTokens)} ` +
            `แคช ${fmtTokens(total.cacheReadTokens + total.cacheCreationTokens)} ` +
            `= ${fmtTokens(total.totalTokens)} token` +
            (total.costUsd > 0 ? ` · $${total.costUsd.toFixed(4)}` : "")
        : "ไม่ได้เรียก AI ในรอบนี้",
    );
    setRun({
      status: failedDays === progress.total && progress.total > 0 ? "failed" : "done",
      error: failures.length ? failures.join(" | ").slice(0, 1000) : null,
      finishedAt: new Date(),
      progress,
    });
  } catch (error) {
    setRun({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date(),
    });
  }
}

// ---------------------------------------------------------------------------

type SharedContext = {
  commits: (typeof schema.commits.$inferSelect)[];
  projectNames: Map<number, string>;
  tasks: (typeof schema.clickupTasks.$inferSelect)[];
  events: (typeof schema.clickupEvents.$inferSelect)[];
  styleExamples: (typeof schema.styleExamples.$inferSelect)[];
  rulesMd: string | null;
  aiModel: string | null;
};

async function loadSharedContext(fromYMD: string, toYMD: string): Promise<SharedContext> {
  const db = getDb();
  const from = new Date(`${fromYMD}T00:00:00+07:00`);
  const to = new Date(`${toYMD}T23:59:59+07:00`);
  // Rows scanned before the author selection (or by a teammate) are dropped
  // here too — the report must only contain our own work.
  const commits = filterMyCommits(
    db
      .select()
      .from(schema.commits)
      .where(and(gte(schema.commits.authorDate, from), lte(schema.commits.authorDate, to)))
      .all(),
  );
  const projects = db.select().from(schema.projects).all();
  return {
    commits,
    projectNames: new Map(projects.map((p) => [p.id, p.name])),
    tasks: db.select().from(schema.clickupTasks).all(),
    events: db
      .select()
      .from(schema.clickupEvents)
      .where(and(gte(schema.clickupEvents.at, from), lte(schema.clickupEvents.at, to)))
      .all(),
    styleExamples: db.select().from(schema.styleExamples).all().slice(-20).reverse(),
    rulesMd: getSetting("rules_md"),
    aiModel: getSetting("ai_model"),
  };
}

async function fetchRemoteTasks(
  fromYMD: string,
  toYMD: string,
): Promise<{ remoteTasks: RemoteTask[]; remoteWarning: string | null }> {
  const jwt = getSetting("jwt");
  const email = getSetting("email");
  if (!jwt || !email) {
    return { remoteTasks: [], remoteWarning: "ไม่มี JWT/email — ข้ามการเช็คงานที่ส่งไปแล้ว" };
  }
  const res = await searchTasks({ jwt, email, startDate: fromYMD, endDate: toYMD });
  if (res.authExpired) return { remoteTasks: [], remoteWarning: "JWT หมดอายุ — เช็คซ้ำไม่ได้" };
  if (!res.ok) return { remoteTasks: [], remoteWarning: `workload API ตอบ ${res.status}` };
  return { remoteTasks: res.data, remoteWarning: null };
}

async function ensureTaskTypes(): Promise<string[]> {
  const db = getDb();
  const jwt = getSetting("jwt");
  if (jwt) {
    const res = await getTaskTypes(jwt);
    if (res.ok) {
      for (const t of res.data) {
        db.insert(schema.taskTypes)
          .values({ id: t.id, name: t.tasks_propose, color: t.color, syncedAt: new Date() })
          .onConflictDoUpdate({
            target: schema.taskTypes.id,
            set: { name: t.tasks_propose, color: t.color, syncedAt: new Date() },
          })
          .run();
      }
    }
  }
  const names = db
    .select()
    .from(schema.taskTypes)
    .all()
    .map((t) => t.name);
  if (names.length === 0) {
    throw new Error("ไม่มี task types — ใส่ workload JWT ใน Settings แล้ว sync ก่อน");
  }
  return names;
}

async function generateDay(input: {
  runId: number;
  day: ResolvedDayTarget;
  remoteTasks: RemoteTask[];
  taskTypeNames: string[];
  shared: SharedContext;
  provider: AiProvider;
  log: RunLogger;
  usages: (AiUsage | null)[];
}): Promise<"done" | "skipped" | "empty"> {
  const db = getDb();
  const { day, shared, log } = input;

  // Existing cards: skip day entirely if it already has drafts (resume-safe),
  // and count submitted/remote time against the target.
  const existing = db
    .select()
    .from(schema.cards)
    .where(eq(schema.cards.tasksDate, day.date))
    .all();
  if (existing.some((c) => c.status === "draft" || c.status === "approved")) {
    log("info", `${day.date}: มีรายการอยู่แล้ว ข้ามไป`);
    return "skipped";
  }

  const remoteSec = input.remoteTasks
    .filter((t) => t.tasks_date.slice(0, 10) === day.date)
    .reduce((s, t) => s + (Number(t.duration) || 0), 0);
  const submittedSec = existing
    .filter((c) => c.status === "submitted")
    .reduce((s, c) => s + c.durationSec, 0);
  const remaining = day.targetSec - Math.max(remoteSec, submittedSec);
  if (remaining < STEP_SEC) {
    log("info", `${day.date}: ครบชั่วโมงจากของที่ส่งไปแล้ว ข้ามไป`);
    return "skipped";
  }

  const evidence = buildDayEvidence({
    date: day.date,
    targetSec: remaining,
    commits: shared.commits,
    projectNames: shared.projectNames,
    tasks: shared.tasks,
    events: shared.events,
    remoteTasks: input.remoteTasks,
  });

  // No commits, no closed task, no comment → nothing verifiable happened.
  // Leave the day empty: coverage will flag the missing hours, and the user
  // adds a card or marks it as leave. Filling it from the backlog would put
  // work that never happened into a company report.
  if (!hasDayEvidence(evidence)) {
    log("warn", `${day.date}: ไม่มี commit ไม่มี task ที่ปิด ไม่มี comment — เว้นว่างไว้`);
    return "empty";
  }

  log(
    "info",
    `${day.date}: หลักฐาน ${evidence.commits.length} commit · ` +
      `${evidence.tasksClosed.length} task ที่ปิด · ${evidence.comments.length} comment · ` +
      `ต้องลง ${remaining / 3600} ชม.`,
  );

  const plan = await generateValidPlan(input, evidence);

  // Force hours to the target with code, never the model.
  const allocInput = plan.cards.map((card, i) => ({
    id: String(i),
    proposedSec: Math.round(card.hours * 3600),
    origin: card.origin,
    confidence: card.confidence,
  }));
  const { allocations, shortfallSec } = allocate(allocInput, remaining);
  log(
    "info",
    `${day.date}: AI เสนอ ${plan.cards.length} รายการ · จัดชั่วโมงแล้ว ${allocations.length} รายการ` +
      (shortfallSec > 0 ? ` · เติมอีก ${shortfallSec / 3600} ชม.` : ""),
  );
  const secByIndex = new Map(allocations.map((a) => [Number(a.id), a.sec]));

  const now = new Date();
  for (const [i, card] of plan.cards.entries()) {
    const sec = secByIndex.get(i);
    if (!sec) continue; // dropped by allocator

    // Commit → ticket id → the ClickUp task we actually synced. A card whose
    // commits carry no ticket id keeps no ClickUp reference at all: the
    // model's guess is not evidence, so it is dropped rather than uploaded.
    const link = resolveClickupLink({
      card: { evidence: card.evidence },
      commits: evidence.commits.map((c) => ({ hash: c.hash, ticketIds: c.tickets })),
      tasks: shared.tasks.map((t) => ({ taskId: t.taskId, customId: t.customId, url: t.url })),
    });

    db.insert(schema.cards)
      .values({
        runId: input.runId,
        tasksDate: day.date,
        durationSec: sec,
        topic: card.topic,
        noteHtml: card.note_html,
        taskType: card.task_type,
        website: card.website ?? null,
        clickupTask: link?.customId ?? link?.taskId ?? null,
        clickupUrl: link?.url ?? null,
        origin: card.origin,
        confidence: card.confidence,
        evidence: card.evidence,
        timeOfDay: card.time_of_day ?? null,
        fingerprint: fingerprintCard(day.date, card.topic, card.task_type),
        // reviewer_notes is day-level context — keep it on the first card only.
        internalNote: i === 0 ? (plan.reviewer_notes ?? "") : "",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  // Still short after stretching everything → deterministic filler cards.
  let filler = shortfallSec;
  while (filler >= STEP_SEC) {
    const sec = Math.min(filler, MAX_CARD_SEC);
    const topic = "Review / testing / งาน engineering อื่น ๆ";
    db.insert(schema.cards)
      .values({
        runId: input.runId,
        tasksDate: day.date,
        durationSec: sec,
        topic,
        noteHtml:
          "<p><b>Review / testing</b></p><ul><li>ตรวจสอบและทดสอบงานที่กำลังพัฒนา</li><li>ติดตามงานค้างและแก้ปัญหาย่อย</li></ul>",
        taskType: input.taskTypeNames[0],
        origin: "inferred",
        confidence: 0.2,
        evidence: { commits: [], tasks: [] },
        fingerprint: fingerprintCard(day.date, `${topic}-${filler}`, input.taskTypeNames[0]),
        internalNote: "เติมอัตโนมัติให้ครบเป้าชั่วโมง",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    filler -= sec;
  }
  return "done";
}

async function generateValidPlan(
  input: {
    runId: number;
    day: ResolvedDayTarget;
    taskTypeNames: string[];
    shared: SharedContext;
    provider: AiProvider;
    log: RunLogger;
    usages: (AiUsage | null)[];
  },
  evidence: DayEvidence,
): Promise<DayPlan> {
  const { log } = input;
  const db = getDb();
  const knownCommitHashes = evidence.commits.map((c) => c.hash.toLowerCase());
  const knownTaskRefs = [
    ...evidence.tasksClosed,
    ...evidence.tasksActive,
    ...input.shared.tasks.map((t) => ({ taskId: t.taskId, customId: t.customId })),
  ].flatMap((t) => [t.taskId, ...(t.customId ? [t.customId] : [])]);

  let repairNote: string | null = null;
  let lastError = "unknown";
  let transientRetries = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS + MAX_TRANSIENT_RETRIES; attempt++) {
    const prompt = buildDayPrompt({
      evidence,
      taskTypeNames: input.taskTypeNames,
      rulesMd: input.shared.rulesMd,
      styleExamples: input.shared.styleExamples,
      repairNote,
    });

    let raw = "";
    let durationMs = 0;
    let usage: AiUsage | null = null;
    let callError: string | null = null;
    let isTransient = false;
    log("info", `${input.day.date}: เรียก AI ครั้งที่ ${attempt} (prompt ${fmtTokens(prompt.length)} ตัวอักษร)`);
    try {
      const result = await input.provider.generate(prompt, { model: input.shared.aiModel });
      raw = result.text;
      durationMs = result.durationMs;
      usage = result.usage ?? null;
      if (usage) {
        input.usages.push(usage);
        log(
          "info",
          `${input.day.date}: ${usage.model ?? "โมเดลค่าเริ่มต้น"} · ` +
            `เข้า ${fmtTokens(usage.inputTokens)} ออก ${fmtTokens(usage.outputTokens)} ` +
            `แคช ${fmtTokens(usage.cacheReadTokens + usage.cacheCreationTokens)} · ` +
            `${(durationMs / 1000).toFixed(1)} วิ` +
            (usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(4)}` : ""),
        );
      }
    } catch (error) {
      callError = error instanceof Error ? error.message : String(error);
      isTransient = isTransientAiError(error);
    }

    const parsed = callError ? { plan: null, error: callError } : parseDayPlan(raw);
    const validated = parsed.plan
      ? validateDayPlan(parsed.plan, {
          date: input.day.date,
          allowedTaskTypes: input.taskTypeNames,
          knownCommitHashes,
          knownTaskRefs,
          // Commits are the work that happened, so none may be left off a card.
          dayCommitHashes: knownCommitHashes,
        })
      : null;

    db.insert(schema.aiCalls)
      .values({
        runId: input.runId,
        date: input.day.date,
        attempt,
        prompt,
        rawOutput: raw || null,
        durationMs,
        model: usage?.model ?? input.shared.aiModel ?? null,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cacheReadTokens: usage?.cacheReadTokens ?? null,
        cacheCreationTokens: usage?.cacheCreationTokens ?? null,
        costUsd: usage?.costUsd ?? null,
        status: callError ? "error" : validated && !validated.needsRepair ? "ok" : "invalid",
        error: callError ?? parsed.error ?? validated?.issues.join("; ")?.slice(0, 500) ?? null,
      })
      .run();

    if (validated && !validated.needsRepair && validated.plan.cards.length > 0) {
      if (validated.issues.length > 0) {
        log("warn", `${input.day.date}: แก้ให้อัตโนมัติ — ${validated.issues.slice(0, 2).join(" · ")}`);
      }
      return validated.plan;
    }
    if (validated && validated.plan.cards.length > 0 && attempt >= MAX_ATTEMPTS) {
      // Out of repair attempts — salvage cards whose task_type is valid.
      const allowed = new Set(input.taskTypeNames.map((t) => t.toLowerCase()));
      const salvage = validated.plan.cards.filter((c) => allowed.has(c.task_type.toLowerCase()));
      if (salvage.length > 0) return { ...validated.plan, cards: salvage };
    }

    lastError = callError ?? parsed.error ?? validated?.issues.join("; ") ?? "invalid";
    log(
      isTransient ? "warn" : "warn",
      `${input.day.date}: ${isTransient ? "เรียก CLI ไม่สำเร็จ" : "ผลลัพธ์ไม่ผ่านการตรวจ"} — ${lastError.slice(0, 160)}`,
    );

    if (isTransient) {
      // The CLI never reached the model (auth rotating, rate limit, timeout).
      // Waiting is the fix — a repair note would be nonsense, and burning the
      // repair budget on it is what made a brief outage kill the whole day.
      transientRetries++;
      if (transientRetries <= MAX_TRANSIENT_RETRIES) {
        const waitMs = TRANSIENT_BACKOFF_MS[Math.min(transientRetries - 1, TRANSIENT_BACKOFF_MS.length - 1)];
        log("warn", `${input.day.date}: รออีก ${waitMs / 1000} วินาทีแล้วลองใหม่`);
      }
      if (transientRetries > MAX_TRANSIENT_RETRIES) {
        throw new Error(`เรียก claude CLI ไม่สำเร็จ ${transientRetries} ครั้ง: ${lastError.slice(0, 200)}`);
      }
      attempt--; // a failed call is not a modelling attempt
      await sleep(TRANSIENT_BACKOFF_MS[Math.min(transientRetries - 1, TRANSIENT_BACKOFF_MS.length - 1)]);
      continue;
    }

    repairNote = `Attempt ${attempt} was rejected: ${lastError.slice(0, 400)}. Return corrected JSON.`;
  }
  throw new Error(`AI ตอบไม่ผ่าน validator หลัง ${MAX_ATTEMPTS} ครั้ง: ${lastError.slice(0, 200)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
