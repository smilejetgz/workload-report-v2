import { and, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { filterMyCommits } from "@/server/authors";
import { resolveDayTargets } from "@/server/day-targets";
import { buildCoverage } from "@/server/engine/coverage";
import { fail, handle, ok, parseBody } from "@/server/http";
import { selectClearableCards } from "@/server/submit";
import { getDefaultDailySec } from "@/server/settings";
import { isValidYMD, toBangkokYMD } from "@/server/time";

export function GET(request: Request) {
  return handle(() => {
    const url = new URL(request.url);
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if (!isValidYMD(from) || !isValidYMD(to) || from > to) return fail("from/to ไม่ถูกต้อง");

    const db = getDb();
    const cards = db
      .select()
      .from(schema.cards)
      .where(and(gte(schema.cards.tasksDate, from), lte(schema.cards.tasksDate, to)))
      .all();

    const overrides = db.select().from(schema.dayTargets).all();
    const days = resolveDayTargets(from, to, getDefaultDailySec(), overrides);

    const fromDate = new Date(`${from}T00:00:00+07:00`);
    const toDate = new Date(`${to}T23:59:59+07:00`);
    const commits = filterMyCommits(
      db
        .select()
        .from(schema.commits)
        .where(and(gte(schema.commits.authorDate, fromDate), lte(schema.commits.authorDate, toDate)))
        .all(),
    );
    const projects = db.select().from(schema.projects).all();
    const projectName = new Map(projects.map((p) => [p.id, p.name]));

    const closedTasks = db
      .select()
      .from(schema.clickupTasks)
      .all()
      .filter((t) => {
        if (!t.dateClosed) return false;
        const ymd = toBangkokYMD(t.dateClosed);
        return ymd >= from && ymd <= to;
      });

    const coverage = buildCoverage({
      days: days.map((d) => ({ date: d.date, targetSec: d.targetSec })),
      cards: cards.map((c) => ({
        tasksDate: c.tasksDate,
        durationSec: c.durationSec,
        status: c.status,
        evidence: c.evidence,
      })),
      commits: commits.map((c) => ({
        hash: c.hash,
        date: toBangkokYMD(c.authorDate),
        message: c.message.split("\n")[0].slice(0, 100),
        project: projectName.get(c.projectId) ?? "",
      })),
      closedTasks: closedTasks.map((t) => ({
        taskId: t.taskId,
        customId: t.customId,
        name: t.name,
        closedDate: t.dateClosed ? toBangkokYMD(t.dateClosed) : null,
      })),
    });

    return ok({ cards, days, coverage });
  });
}


const deleteSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Clear the cards in a range that were never uploaded. Rows that exist on
 *  workload are left alone — those are removed one by one, which deletes the
 *  remote row with them. */
export function DELETE(request: Request) {
  return handle(async () => {
    const parsed = await parseBody(request, deleteSchema);
    if ("error" in parsed) return parsed.error;
    const { from, to } = parsed.data;
    if (from > to) return fail("from/to ไม่ถูกต้อง");

    const clearable = selectClearableCards(from, to);
    if (clearable.length === 0) return ok({ deleted: 0 });

    getDb()
      .delete(schema.cards)
      .where(
        inArray(
          schema.cards.id,
          clearable.map((c) => c.id),
        ),
      )
      .run();
    return ok({ deleted: clearable.length });
  });
}
