import { and, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { filterMyCommits } from "@/server/authors";
import { resolveDayTargets } from "@/server/day-targets";
import { buildDayEvidence } from "@/server/engine/evidence";
import { buildDayPrompt } from "@/server/engine/prompt";
import { fail, handle, ok, parseBody } from "@/server/http";
import { getDefaultDailySec, getSetting } from "@/server/settings";
import { refreshEvidence } from "@/server/sync";

const postSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hoursPerDay: z.number().min(0.5).max(24).nullish(),
  refresh: z.boolean().default(false),
});

/** Prompt preview: build the exact prompt for one day without calling the AI. */
export function POST(request: Request) {
  return handle(async () => {
    const parsed = await parseBody(request, postSchema);
    if ("error" in parsed) return parsed.error;
    const { date, hoursPerDay, refresh } = parsed.data;

    if (refresh) await refreshEvidence(date, date);

    const db = getDb();
    const overrides = db.select().from(schema.dayTargets).all();
    const defaultSec = hoursPerDay ? hoursPerDay * 3600 : getDefaultDailySec();
    const [target] = resolveDayTargets(date, date, defaultSec, overrides);

    const from = new Date(`${date}T00:00:00+07:00`);
    const to = new Date(`${date}T23:59:59+07:00`);
    const commits = filterMyCommits(
      db
        .select()
        .from(schema.commits)
        .where(and(gte(schema.commits.authorDate, from), lte(schema.commits.authorDate, to)))
        .all(),
    );
    const projects = db.select().from(schema.projects).all();
    const taskTypes = db.select().from(schema.taskTypes).all();
    if (taskTypes.length === 0) return fail("ยังไม่มี task types — sync ก่อน");

    const evidence = buildDayEvidence({
      date,
      targetSec: target.targetSec || defaultSec,
      commits,
      projectNames: new Map(projects.map((p) => [p.id, p.name])),
      tasks: db.select().from(schema.clickupTasks).all(),
      events: db
        .select()
        .from(schema.clickupEvents)
        .where(and(gte(schema.clickupEvents.at, from), lte(schema.clickupEvents.at, to)))
        .all(),
      remoteTasks: [],
    });

    const prompt = buildDayPrompt({
      evidence,
      taskTypeNames: taskTypes.map((t) => t.name),
      rulesMd: getSetting("rules_md"),
      styleExamples: db.select().from(schema.styleExamples).all().slice(-3),
    });
    return ok({ prompt, evidence });
  });
}
