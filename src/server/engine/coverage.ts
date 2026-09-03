// Coverage report: what evidence is still unreferenced, which days are short.
// Pure function.

export type CoverageDayInput = { date: string; targetSec: number };
export type CoverageCardInput = {
  tasksDate: string;
  durationSec: number;
  status: string;
  evidence: { commits: string[]; tasks: string[] };
};
export type CoverageCommitInput = { hash: string; date: string; message: string; project: string };
export type CoverageTaskInput = { taskId: string; customId: string | null; name: string; closedDate: string | null };

export type DayCoverage = {
  date: string;
  targetSec: number;
  plannedSec: number;
  status: "ok" | "under" | "over" | "empty" | "off";
};

export type CoverageReport = {
  days: DayCoverage[];
  unreferencedCommits: CoverageCommitInput[];
  closedTasksWithoutCard: CoverageTaskInput[];
  offDaysWithEvidence: string[]; // weekend/holiday dates that still have commits
  totalTargetSec: number;
  totalPlannedSec: number;
};

export function buildCoverage(input: {
  days: CoverageDayInput[];
  cards: CoverageCardInput[];
  commits: CoverageCommitInput[];
  closedTasks: CoverageTaskInput[];
}): CoverageReport {
  const plannedByDate = new Map<string, number>();
  const referencedCommits = new Set<string>();
  const referencedTasks = new Set<string>();

  for (const card of input.cards) {
    plannedByDate.set(card.tasksDate, (plannedByDate.get(card.tasksDate) ?? 0) + card.durationSec);
    for (const c of card.evidence.commits) referencedCommits.add(c.toLowerCase());
    for (const t of card.evidence.tasks) referencedTasks.add(t.toLowerCase());
  }

  const days: DayCoverage[] = input.days.map((day) => {
    const planned = plannedByDate.get(day.date) ?? 0;
    let status: DayCoverage["status"];
    if (day.targetSec === 0) status = "off";
    else if (planned === 0) status = "empty";
    else if (planned < day.targetSec) status = "under";
    else if (planned > day.targetSec) status = "over";
    else status = "ok";
    return { date: day.date, targetSec: day.targetSec, plannedSec: planned, status };
  });

  const isReferenced = (hash: string) => {
    const h = hash.toLowerCase();
    for (const ref of referencedCommits) {
      if (h.startsWith(ref) || ref.startsWith(h)) return true;
    }
    return false;
  };

  const unreferencedCommits = input.commits.filter((c) => !isReferenced(c.hash));

  const closedTasksWithoutCard = input.closedTasks.filter((t) => {
    const refs = [t.taskId.toLowerCase(), t.customId?.toLowerCase()].filter(Boolean) as string[];
    return !refs.some((r) => referencedTasks.has(r));
  });

  const commitDates = new Set(input.commits.map((c) => c.date));
  const offDaysWithEvidence = days
    .filter((d) => d.targetSec === 0 && commitDates.has(d.date))
    .map((d) => d.date);

  return {
    days,
    unreferencedCommits,
    closedTasksWithoutCard,
    offDaysWithEvidence,
    totalTargetSec: days.reduce((s, d) => s + d.targetSec, 0),
    totalPlannedSec: days.reduce((s, d) => s + d.plannedSec, 0),
  };
}
