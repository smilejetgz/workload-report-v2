// Evidence refresh: git incremental scan + ClickUp sync + deterministic matching.

import { and, eq, gte, lte } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { authorFiltersByProject, getSelectedAuthors } from "./authors";
import { getSetting, isClickupEnabled, setSetting } from "./settings";
import { isGitRepo, scanCommits } from "./sources/git";
import {
  epochMsToDate,
  getAuthorizedTeams,
  getAuthorizedUser,
  getTaskByCustomId,
  getTaskComments,
  getTasksUpdatedInRange,
  type ClickupApiTask,
} from "./sources/clickup";
import { fetchClickupViaMcp } from "./sources/clickup-mcp";
import { matchCommitsToTasks } from "./engine/matcher";
import type { RunLogger } from "./run-log";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLICKUP_RANGE_PAD_DAYS = 7;
const MAX_CUSTOM_ID_FETCHES = 20;
const MAX_COMMENT_FETCHES = 25;
// The MCP path pays a CLI round-trip per id, but commit tickets are the whole
// point of the ClickUp lookup — keep the same budget as REST.
const MAX_MCP_TICKET_FETCHES = 20;

export type SyncSummary = {
  commitsScanned: number;
  clickupTasksSynced: number;
  clickupEventsSynced: number;
  linksMatched: number;
  clickupSource: "rest" | "mcp" | "none";
  warnings: string[];
};

export async function refreshEvidence(
  fromYMD: string,
  toYMD: string,
  onLog: RunLogger = () => {},
): Promise<SyncSummary> {
  const db = getDb();
  const warnings: string[] = [];
  // Every warning is also a log line: a silent skip here is what makes a day
  // look like "no work happened" when really the repo was never read.
  const warn = (text: string) => {
    warnings.push(text);
    onLog("warn", text);
  };

  // --- 1. Git ---------------------------------------------------------------
  let commitsScanned = 0;
  // A repo with nothing this range is the normal case, not a problem — one
  // closing line beats a column of warnings nobody reads.
  let quietProjects = 0;
  const enabledProjects = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.enabled, true))
    .all();
  const filtersByProject = authorFiltersByProject();
  const selectedAuthors = getSelectedAuthors();
  if (selectedAuthors.length === 0 && enabledProjects.some((p) => !p.authorEmailFilter)) {
    warn("ยังไม่ได้เลือก git user ของเรา — commit ของทุกคนในทีมจะถูกดึงเข้ามา");
  }
  onLog(
    "info",
    `อ่าน git ${enabledProjects.length} โปรเจกต์ · นับเป็นงานของ ${
      selectedAuthors.length > 0 ? selectedAuthors.join(", ") : "ทุกคน"
    }`,
  );

  for (const project of enabledProjects) {
    if (!isGitRepo(project.path)) {
      warn(`ไม่ใช่ git repo: ${project.path}`);
      continue;
    }
    try {
      const scanned = await scanCommits({
        repoPath: project.path,
        sinceYMD: fromYMD,
        untilYMD: toYMD,
        authorFilters: filtersByProject.get(project.id) ?? [],
      });
      for (const c of scanned) {
        db.insert(schema.commits)
          .values({
            projectId: project.id,
            hash: c.hash,
            authorDate: c.authorDate,
            authorEmail: c.authorEmail,
            authorName: c.authorName,
            message: c.message,
            branch: c.branch,
            ticketIds: c.ticketIds,
            filesSummary: c.filesSummary,
            insertions: c.insertions,
            deletions: c.deletions,
            filesChanged: c.filesChanged,
          })
          .onConflictDoUpdate({
            target: [schema.commits.projectId, schema.commits.hash],
            set: {
              branch: c.branch,
              ticketIds: c.ticketIds,
              filesSummary: c.filesSummary,
              insertions: c.insertions,
              deletions: c.deletions,
              filesChanged: c.filesChanged,
            },
          })
          .run();
      }
      commitsScanned += scanned.length;
      if (scanned.length > 0) onLog("info", `git ${project.name}: ${scanned.length} commit`);
      else quietProjects += 1;
      db.update(schema.projects)
        .set({ lastScannedAt: new Date() })
        .where(eq(schema.projects.id, project.id))
        .run();
    } catch (error) {
      warn(`สแกน ${project.name} ล้มเหลว: ${errMessage(error)}`);
    }
  }
  onLog(
    "info",
    `git รวม ${commitsScanned} commit` +
      (quietProjects > 0 ? ` · อีก ${quietProjects} โปรเจกต์ไม่มี commit ในช่วงนี้` : ""),
  );

  // --- 2. ClickUp -----------------------------------------------------------
  // With a personal token → direct REST (fast). Without one → a headless
  // claude session pulls the same data through the ClickUp MCP connector.
  let clickupTasksSynced = 0;
  let clickupEventsSynced = 0;
  let clickupSource: SyncSummary["clickupSource"] = "none";
  const token = getSetting("clickup_token");

  if (!isClickupEnabled()) {
    onLog("info", "ข้าม ClickUp (ปิดไว้) — เขียนรายงานจาก commit อย่างเดียว");
  } else if (token) {
    onLog("info", "ดึง ClickUp ผ่าน personal token");
    try {
      const { teamId, userId } = await resolveClickupIdentity(token);
      const fromMs = Date.parse(`${fromYMD}T00:00:00+07:00`) - CLICKUP_RANGE_PAD_DAYS * DAY_MS;
      const toMs = Date.parse(`${toYMD}T23:59:59+07:00`) + CLICKUP_RANGE_PAD_DAYS * DAY_MS;

      const tasks = await getTasksUpdatedInRange({ token, teamId, userId, fromMs, toMs });

      // Tasks referenced by commit ticket ids but not assigned/updated in range.
      const knownCustomIds = new Set(
        tasks.map((t) => t.custom_id?.toUpperCase()).filter(Boolean) as string[],
      );
      const referencedIds = collectTicketIds(db, fromYMD, toYMD).filter(
        (id) => /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(id) && !knownCustomIds.has(id),
      );
      for (const customId of referencedIds.slice(0, MAX_CUSTOM_ID_FETCHES)) {
        const task = await getTaskByCustomId({ token, teamId, customId });
        if (task) tasks.push(task);
      }

      for (const task of tasks) upsertClickupTask(db, task);
      clickupTasksSynced = tasks.length;

      clickupEventsSynced += deriveTaskEvents(db, tasks);
      clickupEventsSynced += await syncComments(db, token, userId, tasks, fromMs, toMs, {
        priorityCustomIds: collectTicketIds(db, fromYMD, toYMD),
      });
      clickupSource = "rest";
      onLog("info", `ClickUp: ${clickupTasksSynced} task, ${clickupEventsSynced} เหตุการณ์`);
    } catch (error) {
      warn(`ClickUp เชื่อมต่อไม่ได้: ${errMessage(error)} — สร้างรายงานต่อจาก commit อย่างเดียว`);
    }
  } else {
    onLog("info", "ดึง ClickUp ผ่าน Claude MCP connector (ไม่มี token) อาจใช้เวลาสักครู่");
    const mcp = await syncClickupViaMcp(db, fromYMD, toYMD, onLog);
    clickupTasksSynced = mcp.tasks;
    clickupEventsSynced = mcp.events;
    if (mcp.warning) {
      warn(`${mcp.warning} — สร้างรายงานต่อจาก commit อย่างเดียว`);
    } else {
      clickupSource = "mcp";
      onLog("info", `ClickUp: ${clickupTasksSynced} task, ${clickupEventsSynced} เหตุการณ์`);
    }
  }

  // --- 3. Match -------------------------------------------------------------
  const rangeCommits = db
    .select()
    .from(schema.commits)
    .where(
      and(
        gte(schema.commits.authorDate, new Date(`${fromYMD}T00:00:00+07:00`)),
        lte(schema.commits.authorDate, new Date(`${toYMD}T23:59:59+07:00`)),
      ),
    )
    .all();
  const allTasks = db.select().from(schema.clickupTasks).all();
  const links = matchCommitsToTasks(
    rangeCommits.map((c) => ({ hash: c.hash, projectId: c.projectId, ticketIds: c.ticketIds })),
    allTasks.map((t) => ({ taskId: t.taskId, customId: t.customId })),
  );
  for (const link of links) {
    db.insert(schema.commitTaskLinks).values(link).onConflictDoNothing().run();
  }
  onLog("info", `จับคู่ commit กับ task ได้ ${links.length} คู่`);

  return {
    commitsScanned,
    clickupTasksSynced,
    clickupEventsSynced,
    linksMatched: links.length,
    clickupSource,
    warnings,
  };
}

async function syncClickupViaMcp(
  db: ReturnType<typeof getDb>,
  fromYMD: string,
  toYMD: string,
  onLog: RunLogger = () => {},
): Promise<{ tasks: number; events: number; warning: string | null }> {
  // Ticket ids seen in commits but not yet in the cache → fetched directly.
  const knownCustomIds = new Set(
    db
      .select({ customId: schema.clickupTasks.customId })
      .from(schema.clickupTasks)
      .all()
      .map((r) => r.customId?.toUpperCase())
      .filter(Boolean) as string[],
  );
  const ticketIds = collectTicketIds(db, fromYMD, toYMD)
    .filter((id) => /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(id) && !knownCustomIds.has(id))
    .slice(0, MAX_MCP_TICKET_FETCHES);

  if (ticketIds.length > 0) {
    onLog("info", `ตาม ticket จาก commit อีก ${ticketIds.length} ใบ: ${ticketIds.join(", ")}`);
  }
  const { payload, error } = await fetchClickupViaMcp(fromYMD, toYMD, ticketIds);
  if (!payload) {
    return { tasks: 0, events: 0, warning: `ClickUp MCP sync ล้มเหลว: ${error}` };
  }
  if (payload.userId) setSetting("clickup_user_id", String(payload.userId));
  const userId = payload.userId ?? Number(getSetting("clickup_user_id") ?? 0);

  for (const task of payload.tasks) upsertClickupTask(db, task);
  let events = deriveTaskEvents(db, payload.tasks);

  for (const { taskId, comment } of payload.comments) {
    if (userId && comment.user.id !== userId) continue;
    const at = epochMsToDate(comment.date);
    if (!at) continue;
    db.insert(schema.clickupEvents)
      .values({
        taskId,
        kind: "comment",
        at,
        actorId: comment.user.id ? String(comment.user.id) : null,
        text: comment.comment_text.slice(0, 500),
      })
      .onConflictDoNothing()
      .run();
    events++;
  }
  return { tasks: payload.tasks.length, events, warning: null };
}

async function resolveClickupIdentity(
  token: string,
): Promise<{ teamId: string; userId: number }> {
  let teamId = getSetting("clickup_team_id");
  let userId = Number(getSetting("clickup_user_id") ?? "");
  if (!teamId) {
    const teams = await getAuthorizedTeams(token);
    if (teams.length === 0) throw new Error("token นี้ไม่เห็น workspace ไหนเลย");
    teamId = teams[0].id;
    setSetting("clickup_team_id", teamId);
  }
  if (!Number.isFinite(userId) || userId <= 0) {
    const user = await getAuthorizedUser(token);
    userId = user.id;
    setSetting("clickup_user_id", String(userId));
  }
  return { teamId, userId };
}

function collectTicketIds(
  db: ReturnType<typeof getDb>,
  fromYMD: string,
  toYMD: string,
): string[] {
  const rows = db
    .select({ ticketIds: schema.commits.ticketIds })
    .from(schema.commits)
    .where(
      and(
        gte(schema.commits.authorDate, new Date(`${fromYMD}T00:00:00+07:00`)),
        lte(schema.commits.authorDate, new Date(`${toYMD}T23:59:59+07:00`)),
      ),
    )
    .all();
  return [...new Set(rows.flatMap((r) => r.ticketIds))];
}

function upsertClickupTask(db: ReturnType<typeof getDb>, task: ClickupApiTask): void {
  const values = {
    taskId: task.id,
    customId: task.custom_id ?? null,
    name: task.name,
    status: task.status?.status ?? null,
    statusType: task.status?.type ?? null,
    listName: task.list?.name ?? null,
    folderName: task.folder?.name ?? null,
    spaceName: task.space?.id ?? null,
    tags: (task.tags ?? []).map((t) => t.name),
    assignees: (task.assignees ?? []).map((a) => a.id),
    url: task.url ?? null,
    dateCreated: epochMsToDate(task.date_created),
    dateUpdated: epochMsToDate(task.date_updated),
    dateClosed: epochMsToDate(task.date_closed),
    dueDate: epochMsToDate(task.due_date),
    priority: task.priority?.priority ?? null,
    description: task.text_content?.slice(0, 2000) ?? null,
    syncedAt: new Date(),
  };
  db.insert(schema.clickupTasks)
    .values(values)
    .onConflictDoUpdate({ target: schema.clickupTasks.taskId, set: values })
    .run();
}

function deriveTaskEvents(db: ReturnType<typeof getDb>, tasks: ClickupApiTask[]): number {
  let count = 0;
  for (const task of tasks) {
    const closed = epochMsToDate(task.date_closed);
    if (closed) {
      db.insert(schema.clickupEvents)
        .values({ taskId: task.id, kind: "closed", at: closed, actorId: null, text: task.name })
        .onConflictDoNothing()
        .run();
      count++;
    }
  }
  return count;
}

async function syncComments(
  db: ReturnType<typeof getDb>,
  token: string,
  userId: number,
  tasks: ClickupApiTask[],
  fromMs: number,
  toMs: number,
  opts: { priorityCustomIds?: string[] } = {},
): Promise<number> {
  let count = 0;
  // Tasks our commits point at come first — the comment budget should be spent
  // on the work we can prove happened, not on whatever was touched last.
  const priority = new Set((opts.priorityCustomIds ?? []).map((id) => id.toUpperCase()));
  const isPriority = (t: ClickupApiTask) =>
    Boolean(t.custom_id && priority.has(t.custom_id.toUpperCase()));
  const recentTasks = tasks
    .filter((t) => {
      const updated = epochMsToDate(t.date_updated)?.getTime() ?? 0;
      return isPriority(t) || (updated >= fromMs && updated <= toMs);
    })
    .sort((a, b) => Number(isPriority(b)) - Number(isPriority(a)))
    .slice(0, MAX_COMMENT_FETCHES);

  for (const task of recentTasks) {
    try {
      const comments = await getTaskComments(token, task.id);
      for (const comment of comments) {
        const at = epochMsToDate(comment.date);
        if (!at || comment.user.id !== userId) continue;
        if (at.getTime() < fromMs || at.getTime() > toMs) continue;
        db.insert(schema.clickupEvents)
          .values({
            taskId: task.id,
            kind: "comment",
            at,
            actorId: String(comment.user.id),
            text: comment.comment_text.slice(0, 500),
          })
          .onConflictDoNothing()
          .run();
        count++;
      }
    } catch {
      // Comments are enrichment — one failing task must not break the sync.
    }
  }
  return count;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
