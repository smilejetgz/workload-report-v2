// AI output validation + normalization. Pure functions.

import { z } from "zod";

export const dayPlanCardSchema = z.object({
  topic: z.string().min(2).max(200),
  task_type: z.string().min(1),
  website: z.string().nullish(),
  clickup_task: z.string().nullish(),
  note_html: z.string().min(5),
  hours: z.number().min(0.25).max(10),
  time_of_day: z.enum(["morning", "afternoon", "evening"]).nullish(),
  origin: z.enum(["git", "clickup", "inferred"]).default("git"),
  evidence: z
    .object({
      commits: z.array(z.string()).default([]),
      tasks: z.array(z.string()).default([]),
    })
    .default({ commits: [], tasks: [] }),
  confidence: z.number().min(0).max(1).default(0.5),
});

export const dayPlanSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cards: z.array(dayPlanCardSchema).max(8),
  reviewer_notes: z.string().nullish(),
});

export type DayPlan = z.infer<typeof dayPlanSchema>;
export type DayPlanCard = z.infer<typeof dayPlanCardSchema>;

/** Extract the first JSON object from raw AI text (handles code fences / prose). */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function parseDayPlan(raw: string): { plan: DayPlan | null; error: string | null } {
  const json = extractJson(raw);
  if (json === null) return { plan: null, error: "ไม่พบ JSON ใน output" };
  const result = dayPlanSchema.safeParse(json);
  if (!result.success) {
    return { plan: null, error: z.prettifyError(result.error).slice(0, 500) };
  }
  return { plan: result.data, error: null };
}

import { sanitizeNoteHtml } from "@/lib/sanitize";
export { sanitizeNoteHtml };

export type ValidationContext = {
  date: string;
  allowedTaskTypes: string[];
  knownCommitHashes: string[]; // full hashes
  knownTaskRefs: string[]; // task ids + custom ids
  /** Commits made on this day — every one must end up on a card, because
   *  commits are the work that actually happened. Omit to skip the check. */
  dayCommitHashes?: string[];
};

const MAX_LISTED_UNCOVERED = 6;

function hashesOverlap(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

export type ValidatedPlan = {
  plan: DayPlan;
  issues: string[];
  /** True when something was wrong enough that a repair round should be tried. */
  needsRepair: boolean;
};

export function validateDayPlan(plan: DayPlan, ctx: ValidationContext): ValidatedPlan {
  const issues: string[] = [];
  let needsRepair = false;

  const typeByLower = new Map(ctx.allowedTaskTypes.map((t) => [t.toLowerCase(), t]));
  const hashSet = ctx.knownCommitHashes;
  const taskRefSet = new Set(ctx.knownTaskRefs.map((t) => t.toLowerCase()));

  if (plan.date !== ctx.date) {
    issues.push(`date ${plan.date} ไม่ตรงกับ ${ctx.date} — แก้ให้แล้ว`);
  }

  const cards = plan.cards.map((card) => {
    const canonicalType = typeByLower.get(card.task_type.toLowerCase());
    if (!canonicalType) {
      issues.push(`task_type "${card.task_type}" ไม่อยู่ใน list`);
      needsRepair = true;
    }

    const commits = card.evidence.commits.filter((ref) => {
      const found = hashSet.some((h) => h.startsWith(ref.toLowerCase()) || ref.startsWith(h));
      if (!found) issues.push(`commit "${ref.slice(0, 10)}" ไม่มีจริง — ตัดออก`);
      return found;
    });
    const tasks = card.evidence.tasks.filter((ref) => {
      const found = taskRefSet.has(ref.toLowerCase());
      if (!found) issues.push(`task "${ref}" ไม่มีจริง — ตัดออก`);
      return found;
    });

    return {
      ...card,
      task_type: canonicalType ?? card.task_type,
      note_html: sanitizeNoteHtml(card.note_html),
      evidence: { commits, tasks },
    };
  });

  if (cards.length > 5) {
    issues.push(`มี ${cards.length} cards (เกิน 5) — ควรรวมให้เหลือ ≤5`);
    needsRepair = true;
  }

  // Commit coverage: commits are the real work, so none may be silently dropped.
  const dayCommits = ctx.dayCommitHashes ?? [];
  if (dayCommits.length > 0) {
    const referenced = cards.flatMap((c) => c.evidence.commits);
    const uncovered = dayCommits.filter((h) => !referenced.some((ref) => hashesOverlap(h, ref)));
    if (uncovered.length > 0) {
      const listed = uncovered.slice(0, MAX_LISTED_UNCOVERED).map((h) => h.slice(0, 8));
      const more = uncovered.length > listed.length ? ` (+${uncovered.length - listed.length})` : "";
      issues.push(
        `commit ที่ยังไม่มี card อ้างถึง: ${listed.join(", ")}${more} — ` +
          `ต้องครอบคลุมทุก commit ของวันนี้ (รวมเข้า card เดิมได้)`,
      );
      needsRepair = true;
    }
    if (!cards.some((c) => c.origin === "git" && c.evidence.commits.length > 0)) {
      issues.push(
        `วันนี้มี ${dayCommits.length} commit แต่ไม่มี card origin "git" ที่อ้าง commit — ` +
          `commit คืองานจริง ต้องเป็นฐานของ card`,
      );
      needsRepair = true;
    }
  }

  return {
    plan: { ...plan, date: ctx.date, cards },
    issues,
    needsRepair,
  };
}
