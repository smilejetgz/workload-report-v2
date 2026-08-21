// Per-day evidence pack: shapes DB rows into a compact structure for the
// prompt builder. Pure functions — all queries happen in the pipeline.
//
// Commits are the day's ground truth (they are the work that actually shipped);
// ClickUp is supplementary — it names the ticket and covers activity that left
// no commit behind. So ClickUp rows are selected and ordered relative to the
// ticket ids found in that day's commits, not on their own merit.

import type { ClickupEvent, ClickupTask, Commit } from "@/db/schema";
import type { RemoteTask } from "@/server/sources/workload";
import { htmlToText } from "@/lib/html-text";
import { BANGKOK_OFFSET_MS, timeOfDay, toBangkokYMD } from "@/server/time";

export type EvidenceCommit = {
  hash: string;
  project: string;
  hhmm: string;
  timeOfDay: "morning" | "afternoon" | "evening";
  subject: string;
  branch: string | null;
  tickets: string[];
  dirs: string[];
  files: string[];
  insertions: number;
  deletions: number;
  filesChanged: number;
};

export type EvidenceTask = {
  taskId: string;
  customId: string | null;
  name: string;
  status: string | null;
  listName: string | null;
  /** A ticket id of this task appears in one of the day's commits. */
  linkedToCommits: boolean;
};

/** Active tasks are context only — keep the list short when commits already
 *  say what happened, so unrelated tickets cannot pull the plan off course. */
const MAX_ACTIVE_TASKS_WITH_COMMITS = 6;
const MAX_ACTIVE_TASKS_NO_COMMITS = 10;
const MAX_COMMIT_FILES = 4;

export type EvidenceComment = { taskRef: string; taskName: string; hhmm: string; text: string };

export type EvidenceRemote = { taskType: string; durationSec: number; notePlain: string };

export type DayEvidence = {
  date: string;
  targetSec: number;
  commits: EvidenceCommit[];
  tasksClosed: EvidenceTask[];
  tasksActive: EvidenceTask[];
  comments: EvidenceComment[];
  existingRemote: EvidenceRemote[];
};

function updatedMs(tasks: ClickupTask[], taskId: string): number {
  return tasks.find((t) => t.taskId === taskId)?.dateUpdated?.getTime() ?? 0;
}

function bangkokHHMM(d: Date): string {
  return new Date(d.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(11, 16);
}

/** @see htmlToText — kept as the server-side name used across the engine. */
export const stripHtml = htmlToText;

export function buildDayEvidence(input: {
  date: string;
  targetSec: number;
  commits: Commit[];
  projectNames: Map<number, string>;
  tasks: ClickupTask[];
  events: ClickupEvent[];
  remoteTasks: RemoteTask[];
}): DayEvidence {
  const { date } = input;
  const taskById = new Map(input.tasks.map((t) => [t.taskId, t]));

  const commits = input.commits
    .filter((c) => toBangkokYMD(c.authorDate) === date)
    .sort((a, b) => a.authorDate.getTime() - b.authorDate.getTime())
    .map((c) => ({
      hash: c.hash,
      project: input.projectNames.get(c.projectId) ?? `project-${c.projectId}`,
      hhmm: bangkokHHMM(c.authorDate),
      timeOfDay: timeOfDay(c.authorDate),
      subject: c.message.split("\n")[0].slice(0, 120),
      branch: c.branch,
      tickets: c.ticketIds,
      dirs: c.filesSummary?.topDirs ?? [],
      files: (c.filesSummary?.topFiles ?? []).slice(0, MAX_COMMIT_FILES),
      insertions: c.insertions,
      deletions: c.deletions,
      filesChanged: c.filesChanged,
    }));

  // Ticket ids the day's commits point at — the only bridge from real work to
  // ClickUp, so they decide which tasks are worth showing and in what order.
  const commitTickets = new Set(commits.flatMap((c) => c.tickets.map((t) => t.toUpperCase())));
  const isLinked = (t: ClickupTask): boolean =>
    (t.customId != null && commitTickets.has(t.customId.toUpperCase())) ||
    commitTickets.has(t.taskId.toUpperCase()) ||
    commitTickets.has(`CU-${t.taskId}`.toUpperCase()) ||
    commitTickets.has(`#${t.taskId}`.toUpperCase());

  const toEvidenceTask = (t: ClickupTask): EvidenceTask => ({
    taskId: t.taskId,
    customId: t.customId,
    name: t.name,
    status: t.status,
    listName: t.listName,
    linkedToCommits: isLinked(t),
  });

  const tasksClosed = input.tasks
    .filter((t) => t.dateClosed && toBangkokYMD(t.dateClosed) === date)
    .map(toEvidenceTask)
    .sort((a, b) => Number(b.linkedToCommits) - Number(a.linkedToCommits));

  const closedIds = new Set(tasksClosed.map((t) => t.taskId));
  const doneStatusRe = /closed|done|complete|cancel/i;
  const activeLimit =
    commits.length > 0 ? MAX_ACTIVE_TASKS_WITH_COMMITS : MAX_ACTIVE_TASKS_NO_COMMITS;
  const tasksActive = input.tasks
    .filter(
      (t) =>
        !closedIds.has(t.taskId) &&
        t.statusType !== "done" &&
        t.statusType !== "closed" &&
        !t.dateClosed &&
        !doneStatusRe.test(t.status ?? ""),
    )
    .map(toEvidenceTask)
    .sort(
      (a, b) =>
        Number(b.linkedToCommits) - Number(a.linkedToCommits) ||
        (updatedMs(input.tasks, b.taskId) - updatedMs(input.tasks, a.taskId)),
    )
    .slice(0, activeLimit);

  const comments = input.events
    .filter((e) => e.kind === "comment" && toBangkokYMD(e.at) === date)
    .map((e) => {
      const task = taskById.get(e.taskId);
      return {
        taskRef: task?.customId ?? e.taskId,
        taskName: task?.name ?? e.taskId,
        hhmm: bangkokHHMM(e.at),
        text: (e.text ?? "").slice(0, 200),
      };
    });

  const existingRemote = input.remoteTasks
    .filter((t) => t.tasks_date.slice(0, 10) === date)
    .map((t) => ({
      taskType: t.task_type,
      durationSec: Number(t.duration) || 0,
      notePlain: stripHtml(t.note).slice(0, 200),
    }));

  return { date, targetSec: input.targetSec, commits, tasksClosed, tasksActive, comments, existingRemote };
}

/** Compact plain-text rendering for the prompt. */
export function formatEvidenceText(ev: DayEvidence): string {
  const lines: string[] = [];

  if (ev.commits.length > 0) {
    lines.push(
      `### PRIMARY EVIDENCE — git commits (${ev.commits.length}) — this is the work that really happened`,
    );
    for (const c of ev.commits) {
      const tickets = c.tickets.length ? ` [${c.tickets.join(", ")}]` : "";
      const branch = c.branch ? ` (branch: ${c.branch})` : "";
      const files = c.files.length ? `, files: ${c.files.join(", ")}` : "";
      lines.push(
        `- ${c.hhmm} [${c.project}]${tickets} ${c.subject}${branch} ` +
          `(+${c.insertions}/-${c.deletions}, ${c.filesChanged} files, dirs: ${c.dirs.join(", ") || "-"}${files}) hash=${c.hash.slice(0, 8)}`,
      );
    }
  } else {
    lines.push(
      "### PRIMARY EVIDENCE — git commits: no commits this day. " +
        "Nothing shipped from a repo, so build the day from the ClickUp activity below instead.",
    );
  }

  const linkMark = (t: EvidenceTask) => (t.linkedToCommits ? " ← linked to today's commits" : "");

  if (ev.tasksClosed.length > 0) {
    lines.push(`### SUPPLEMENTARY — ClickUp tasks closed this day`);
    for (const t of ev.tasksClosed) {
      lines.push(
        `- ${t.customId ?? t.taskId} "${t.name}" (list: ${t.listName ?? "-"})${linkMark(t)}`,
      );
    }
  }

  if (ev.comments.length > 0) {
    lines.push(`### SUPPLEMENTARY — ClickUp comments I wrote this day`);
    for (const c of ev.comments) {
      lines.push(`- ${c.hhmm} on ${c.taskRef} "${c.taskName}": ${c.text}`);
    }
  }

  if (ev.tasksActive.length > 0) {
    lines.push(
      `### SUPPLEMENTARY — ClickUp tasks in progress (naming / context / filler candidates only)`,
    );
    for (const t of ev.tasksActive) {
      lines.push(
        `- ${t.customId ?? t.taskId} "${t.name}" (status: ${t.status ?? "-"})${linkMark(t)}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Did anything verifiable happen on this day?
 *
 * Commits, a task closed, or a comment we wrote all prove work took place.
 * Open tasks do NOT — a ticket can sit "in progress" for months — so a day
 * whose only "evidence" is the backlog counts as empty, and the pipeline
 * leaves it alone rather than inventing hours for it.
 */
export function hasDayEvidence(ev: DayEvidence): boolean {
  return ev.commits.length > 0 || ev.tasksClosed.length > 0 || ev.comments.length > 0;
}
