import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Config / sources
// ---------------------------------------------------------------------------

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  path: text("path").notNull().unique(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  authorEmailFilter: text("author_email_filter"),
  defaultTaskType: text("default_task_type"),
  defaultWebsite: text("default_website"),
  lastScannedAt: integer("last_scanned_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Key-value settings: jwt, task_by, email, clickup_token, clickup_team_id,
// clickup_user_id, ai_model, default_daily_hours, rules_md
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Synced from workload API /tasks/get-tasktype. AI may only pick from this list.
export const taskTypes = sqliteTable("task_types", {
  id: integer("id").primaryKey(), // remote id
  name: text("name").notNull(),
  color: text("color"),
  syncedAt: integer("synced_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export type DayKind = "workday" | "half" | "weekend" | "holiday" | "leave";

// Per-day hour targets. Rows only exist for overrides; defaults are computed
// (Mon-Fri = default_daily_hours, Sat/Sun + Thai holidays = 0).
export const dayTargets = sqliteTable("day_targets", {
  date: text("date").primaryKey(), // YYYY-MM-DD (Asia/Bangkok)
  targetSec: integer("target_sec").notNull(),
  kind: text("kind").$type<DayKind>().notNull().default("workday"),
  note: text("note"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const commits = sqliteTable(
  "commits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    hash: text("hash").notNull(),
    authorDate: integer("author_date", { mode: "timestamp" }).notNull(),
    authorEmail: text("author_email").notNull(),
    authorName: text("author_name").notNull(),
    message: text("message").notNull(),
    branch: text("branch"),
    ticketIds: text("ticket_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    filesSummary: text("files_summary", { mode: "json" })
      .$type<{ topDirs: string[]; topFiles: string[] }>(),
    insertions: integer("insertions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    filesChanged: integer("files_changed").notNull().default(0),
  },
  (t) => [
    uniqueIndex("commits_project_hash").on(t.projectId, t.hash),
    index("commits_author_date").on(t.authorDate),
  ],
);

export const clickupTasks = sqliteTable("clickup_tasks", {
  taskId: text("task_id").primaryKey(),
  customId: text("custom_id"), // e.g. DEV-6395
  name: text("name").notNull(),
  status: text("status"),
  statusType: text("status_type"), // open | custom | done | closed
  listName: text("list_name"),
  folderName: text("folder_name"),
  spaceName: text("space_name"),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
  assignees: text("assignees", { mode: "json" }).$type<number[]>().notNull().default([]),
  url: text("url"),
  dateCreated: integer("date_created", { mode: "timestamp" }),
  dateUpdated: integer("date_updated", { mode: "timestamp" }),
  dateClosed: integer("date_closed", { mode: "timestamp" }),
  dueDate: integer("due_date", { mode: "timestamp" }),
  priority: text("priority"),
  description: text("description"),
  syncedAt: integer("synced_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const clickupEvents = sqliteTable(
  "clickup_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id").notNull(),
    kind: text("kind").$type<"comment" | "closed" | "updated">().notNull(),
    at: integer("at", { mode: "timestamp" }).notNull(),
    actorId: text("actor_id"),
    text: text("text"),
  },
  (t) => [
    uniqueIndex("clickup_events_task_kind_at").on(t.taskId, t.kind, t.at),
    index("clickup_events_at").on(t.at),
  ],
);

// Deterministic commit↔task links only (ticket id in message/branch, or manual).
// Fuzzy linking is delegated to the AI at generation time and validated after.
export const commitTaskLinks = sqliteTable(
  "commit_task_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    commitHash: text("commit_hash").notNull(),
    projectId: integer("project_id").notNull(),
    taskId: text("task_id").notNull(),
    source: text("source").$type<"id_match" | "manual">().notNull(),
    confidence: real("confidence").notNull().default(1),
  },
  (t) => [uniqueIndex("commit_task_links_unique").on(t.commitHash, t.projectId, t.taskId)],
);

// Few-shot style corpus: imported from v1 submitted cards + accumulated from v2.
export const styleExamples = sqliteTable("style_examples", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tasksDate: text("tasks_date").notNull(),
  taskType: text("task_type").notNull(),
  durationSec: integer("duration_sec").notNull(),
  noteHtml: text("note_html").notNull(),
  source: text("source").$type<"v1" | "v2">().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ---------------------------------------------------------------------------
// Planning / audit
// ---------------------------------------------------------------------------

export type RunStatus = "pending" | "running" | "done" | "failed" | "cancelled";

/** One line of what the run is doing, shown live while it works. */
export type RunLogEntry = { at: string; level: "info" | "warn" | "error"; text: string };

export type RunProgress = {
  total: number;
  completed: number;
  currentDates: string[];
  /** "empty" = no evidence that day, so nothing was invented for it. */
  dayStatus: Record<string, "pending" | "running" | "done" | "failed" | "skipped" | "empty">;
  /** "sync" while evidence is being gathered (git + ClickUp), then "generate". */
  phase?: "sync" | "generate";
  /** Newest last; capped so the row cannot grow without bound. */
  log?: RunLogEntry[];
};

export const runs = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fromDate: text("from_date").notNull(),
  toDate: text("to_date").notNull(),
  params: text("params", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  status: text("status").$type<RunStatus>().notNull().default("pending"),
  progress: text("progress", { mode: "json" }).$type<RunProgress>(),
  error: text("error"),
  heartbeatAt: integer("heartbeat_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
});

// One row per AI invocation (per day, per attempt) — audit + replay.
export const aiCalls = sqliteTable(
  "ai_calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    attempt: integer("attempt").notNull().default(1),
    prompt: text("prompt").notNull(),
    rawOutput: text("raw_output"),
    durationMs: integer("duration_ms"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
    costUsd: real("cost_usd"),
    status: text("status").$type<"ok" | "invalid" | "error">().notNull(),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (t) => [index("ai_calls_run").on(t.runId)],
);

export type CardOrigin = "git" | "clickup" | "inferred" | "manual";
export type CardStatus = "draft" | "approved" | "submitted" | "failed";
export type CardEvidence = { commits: string[]; tasks: string[] };

export const cards = sqliteTable(
  "cards",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id").references(() => runs.id, { onDelete: "set null" }),
    tasksDate: text("tasks_date").notNull(), // YYYY-MM-DD
    durationSec: integer("duration_sec").notNull(),
    topic: text("topic").notNull().default(""),
    noteHtml: text("note_html").notNull().default(""),
    taskType: text("task_type").notNull(),
    website: text("website"),
    clickupTask: text("clickup_task"),
    // Resolved from the commits' ticket ids — null when no synced task matches.
    clickupUrl: text("clickup_url"),
    origin: text("origin").$type<CardOrigin>().notNull().default("git"),
    confidence: real("confidence").notNull().default(0.5),
    evidence: text("evidence", { mode: "json" })
      .$type<CardEvidence>()
      .notNull()
      .default({ commits: [], tasks: [] }),
    timeOfDay: text("time_of_day").$type<"morning" | "afternoon" | "evening" | null>(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").$type<CardStatus>().notNull().default("draft"),
    remoteTaskId: text("remote_task_id"),
    error: text("error"),
    internalNote: text("internal_note").notNull().default(""),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    submittedAt: integer("submitted_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (t) => [index("cards_date").on(t.tasksDate), index("cards_fingerprint").on(t.fingerprint)],
);

export const cardVersions = sqliteTable(
  "card_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    cardId: integer("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    snapshot: text("snapshot", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    reason: text("reason"),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (t) => [index("card_versions_card").on(t.cardId)],
);

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------

export type Project = typeof projects.$inferSelect;
export type Commit = typeof commits.$inferSelect;
export type ClickupTask = typeof clickupTasks.$inferSelect;
export type ClickupEvent = typeof clickupEvents.$inferSelect;
export type CommitTaskLink = typeof commitTaskLinks.$inferSelect;
export type StyleExample = typeof styleExamples.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type TaskType = typeof taskTypes.$inferSelect;
export type DayTarget = typeof dayTargets.$inferSelect;
