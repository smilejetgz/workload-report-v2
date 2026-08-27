// Typed client for the app's API. All endpoints share the { success, data, error } envelope.

import type {
  Card,
  Project,
  Run,
  TaskType,
} from "@/db/schema";
import type { CoverageReport } from "@/server/engine/coverage";
import type { ResolvedDayTarget } from "@/server/day-targets";
import type { IdentityCheck } from "@/server/engine/identity";
import type { GitAuthorOption } from "@/app/api/git-authors/route";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const body = (await res.json().catch(() => null)) as {
    success: boolean;
    data: T;
    error: string | null;
  } | null;
  if (!body || !body.success) {
    throw new ApiError(body?.error ?? `HTTP ${res.status}`, res.status);
  }
  return body.data;
}

export type SettingsData = {
  settings: Record<string, string | null>;
  gitAuthors: string[];
  identity: IdentityCheck;
  jwtExpiresAt: string | null;
  jwtExpired: boolean | null;
};

export type GitAuthorsData = {
  authors: GitAuthorOption[];
  selected: string[];
  since: string;
  warnings: string[];
};

export type EmployeesData = {
  employees: { id: number; name: string; email: string; role?: string }[];
  identity: IdentityCheck;
};

export type CardsData = { cards: Card[]; days: ResolvedDayTarget[]; coverage: CoverageReport };

export const api = {
  settings: () => call<SettingsData>("/api/settings"),
  saveSettings: (values: Record<string, string>) =>
    call<{ saved: string[] }>("/api/settings", { method: "PUT", body: JSON.stringify({ values }) }),

  projects: () => call<{ projects: Project[] }>("/api/projects"),
  discoverProjects: (root?: string) =>
    call<{
      root: string;
      repos: { name: string; path: string; alreadyAdded: boolean; lastActivityAt: string | null }[];
    }>(`/api/projects/discover${root ? `?root=${encodeURIComponent(root)}` : ""}`),
  addProject: (path: string) =>
    call<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify({ path }) }),
  updateProject: (id: number, patch: Partial<Pick<Project, "enabled" | "name">>) =>
    call<{ project: Project }>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteProject: (id: number) =>
    call<{ deleted: number }>(`/api/projects/${id}`, { method: "DELETE" }),

  gitAuthors: (days?: number) =>
    call<GitAuthorsData>(`/api/git-authors${days ? `?days=${days}` : ""}`),
  /** Looking in ClickUp is optional: it is the slow half of gathering evidence. */
  setClickupEnabled: (enabled: boolean) =>
    call<{ saved: string[] }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ values: { clickup_enabled: enabled ? "1" : "0" } }),
    }),
  /** Persisted as a JSON array so one setting holds the whole selection. */
  saveGitAuthors: (authors: string[]) =>
    call<{ saved: string[] }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ values: { git_authors: JSON.stringify(authors) } }),
    }),
  employees: () => call<EmployeesData>("/api/employees"),

  taskTypes: () => call<{ taskTypes: TaskType[] }>("/api/task-types"),
  syncTaskTypes: () => call<{ synced: number }>("/api/task-types", { method: "POST" }),

  cards: (from: string, to: string) => call<CardsData>(`/api/cards?from=${from}&to=${to}`),
  updateCard: (
    id: number,
    patch: Partial<{
      topic: string;
      noteHtml: string;
      taskType: string;
      durationHours: number;
      clickupTask: string | null;
      status: "draft" | "approved";
    }>,
  ) =>
    call<{ card: Card; remoteUpdated?: boolean }>(`/api/cards/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  /** Deletes on workload first when the card was already submitted. */
  deleteCard: (id: number, localOnly = false) =>
    call<{ deleted: number; remoteDeleted: boolean }>(
      `/api/cards/${id}${localOnly ? "?localOnly=1" : ""}`,
      { method: "DELETE" },
    ),
  /** Delete the cards in a range that never reached workload. */
  clearUnsubmitted: (from: string, to: string) =>
    call<{ deleted: number }>("/api/cards", {
      method: "DELETE",
      body: JSON.stringify({ from, to }),
    }),
  /** Make the local list match the rows that really exist on workload. */
  reconcile: (from: string, to: string) =>
    call<{
      linked: number;
      updatedFromRemote: number;
      imported: number;
      orphaned: number;
      remoteCount: number;
    }>("/api/reconcile", { method: "POST", body: JSON.stringify({ from, to }) }),

  generate: (input: {
    from: string;
    to: string;
    hoursPerDay?: number | null;
    regenerateDates?: string[];
  }) => call<{ runId: number }>("/api/generate", { method: "POST", body: JSON.stringify(input) }),
  run: (id: number) => call<{ run: Run }>(`/api/runs/${id}`),
  latestRun: () => call<{ run: Run | null }>("/api/runs/latest"),
  runAction: (id: number, action: "cancel" | "resume") =>
    call<{ runId: number }>(`/api/runs/${id}`, { method: "POST", body: JSON.stringify({ action }) }),

  submit: (from: string, to: string, ids?: number[]) =>
    call<{
      submitted: number;
      updated: number;
      failed: number;
      errors: string[];
      warnings: string[];
    }>("/api/submit", {
      method: "POST",
      body: JSON.stringify({ from, to, ids }),
    }),
  submitPayload: (from: string, to: string) =>
    call<{ payload: { tasks: unknown[] }; count: number }>(`/api/submit?from=${from}&to=${to}`),

  /** One day (date) or a span (from+to) — leave is usually several days. */
  setDayTarget: (input: {
    date?: string;
    from?: string;
    to?: string;
    targetHours: number;
    kind: "workday" | "half" | "weekend" | "holiday" | "leave";
    note?: string | null;
    includeNonWorkdays?: boolean;
  }) => call<{ dates: string[] }>("/api/day-targets", { method: "PUT", body: JSON.stringify(input) }),
  clearDayTarget: (input: string | { from: string; to: string }) =>
    call<{ dates: string[] }>("/api/day-targets", {
      method: "DELETE",
      body: JSON.stringify(typeof input === "string" ? { date: input } : input),
    }),

  /** Preview (apply=false) or write the company holiday calendar. */
  importHolidays: (input: { text: string; year: string; apply: boolean }) =>
    call<{
      holidays: { date: string; name: string }[];
      revertToWorkday: string[];
      skipped: string[];
      applied: boolean;
    }>("/api/holidays", { method: "POST", body: JSON.stringify(input) }),
};
