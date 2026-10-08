// Client for the company workload v2 API (workloads.ketspace.io/api).
// All calls take an explicit jwt — the access token the workload web app
// keeps in localStorage["workload.access_token"]. Identity comes from that
// token alone: the server never reads who the work belongs to from the body.
//
// Only a 401 means the token is dead. A 403 here is a real refusal (e.g. a
// task type the user's position may not log), so it is reported as an error.

const BASE_URL = (process.env.WORKLOAD_API_BASE ?? "https://workloads.ketspace.io/api").replace(
  /\/+$/,
  "",
);

export type RemoteTaskType = {
  id: number;
  name: string;
  color: string | null;
  isActive: boolean;
  sortOrder: number | null;
  /** Positions that may log this type. A held position listed nowhere may log any type. */
  positionIds: number[];
};

export type RemoteProject = {
  id: number;
  name: string;
  websiteUrl: string | null;
  isActive: boolean;
};

export type RemoteMe = {
  id: number;
  name: string;
  email: string;
  role: string;
  positions: { positionId: number; name: string; isPrimary: boolean }[];
};

/** One row of GET /tasks, reduced to what this app reads. */
export type RemoteTask = {
  id: number;
  workDate: string; // YYYY-MM-DD
  /** The caller's own hours on this task — other assignees are not ours. */
  durationSec: number;
  title: string;
  /** agendaNote — the rich-text HTML body; empty when only a title was entered. */
  noteHtml: string;
  taskTypeId: number;
  projectId: number | null;
  clickupTaskId: string | null;
  /** The row's id on the old (v1) workload, kept by the data migration. */
  legacyId: number | null;
};

/** POST /tasks/batch item — no taskId creates, a taskId edits that row. */
export type BatchItem = {
  taskId?: number;
  taskTypeId: number;
  projectId?: number | null;
  durationSec: number;
  title?: string;
  note?: string;
  clickupTaskId?: string | null;
};

export type BatchLog = { workDate: string; items?: BatchItem[]; remove?: number[] };

export type BatchResult = {
  created: number[];
  updated: number[];
  removed: number[];
  dayTotalSec: number;
};

export type WorkloadResult<T> = {
  ok: boolean;
  status: number;
  authExpired: boolean;
  data: T;
  /** Server's error message (Thai), when it gave one. */
  message: string | null;
  /** For batch errors: which item (0-based) the server rejected. */
  index: number | null;
  body: unknown;
};

function errorDetail(body: unknown): { message: string | null; index: number | null } {
  if (!body || typeof body !== "object") return { message: null, index: null };
  const { message, index } = body as { message?: unknown; index?: unknown };
  const text = Array.isArray(message)
    ? message.map(String).join(", ")
    : typeof message === "string"
      ? message
      : null;
  return { message: text, index: typeof index === "number" ? index : null };
}

async function request<T>(
  path: string,
  jwt: string,
  init: RequestInit,
  pickData: (body: unknown) => T,
): Promise<WorkloadResult<T>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${jwt}`,
      ...init.headers,
    },
  });
  const body: unknown = await res.json().catch(() => ({}));
  const detail = res.ok ? { message: null, index: null } : errorDetail(body);
  return {
    ok: res.ok,
    status: res.status,
    authExpired: res.status === 401,
    data: pickData(res.ok ? body : null),
    ...detail,
    body,
  };
}

/** "workload ตอบ 409: เกินเพดาน 24 ชม./คน/วัน …" — for logs and card errors. */
export function describeFailure(label: string, res: WorkloadResult<unknown>): string {
  return `${label} ตอบ ${res.status}${res.message ? `: ${res.message}` : ""}`;
}

const asArray = (body: unknown): Record<string, unknown>[] =>
  Array.isArray(body) ? (body as Record<string, unknown>[]) : [];

const num = (v: unknown): number => Number(v) || 0;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function getMe(jwt: string): Promise<WorkloadResult<RemoteMe | null>> {
  return request("/auth/me", jwt, {}, (body) => {
    if (!body || typeof body !== "object") return null;
    const row = body as Record<string, unknown>;
    return {
      id: num(row.id),
      name: str(row.name) ?? "",
      email: str(row.email) ?? "",
      role: str(row.role) ?? "",
      positions: asArray(row.positions).map((p) => ({
        positionId: num(p.positionId),
        name: str(p.name) ?? "",
        isPrimary: Boolean(p.isPrimary),
      })),
    };
  });
}

export function getTaskTypes(jwt: string): Promise<WorkloadResult<RemoteTaskType[]>> {
  return request("/task-types", jwt, {}, (body) =>
    asArray(body).map((t) => ({
      id: num(t.id),
      name: str(t.name) ?? "",
      color: str(t.color),
      isActive: t.isActive !== false && t.isActive !== 0,
      sortOrder: t.sortOrder == null ? null : num(t.sortOrder),
      positionIds: Array.isArray(t.positionIds) ? t.positionIds.map(num) : [],
    })),
  );
}

/**
 * Task types this person may log — the same rule the server enforces on write
 * (and the MCP list_task_types tool): no position, or a position no type is
 * linked to, may log every type; otherwise only types linked to a held position.
 */
export function allowedTaskTypes(
  types: RemoteTaskType[],
  heldPositionIds: number[],
): RemoteTaskType[] {
  const active = types.filter((t) => t.isActive);
  const linked = new Set(types.flatMap((t) => t.positionIds));
  const allowAll = heldPositionIds.length === 0 || heldPositionIds.some((id) => !linked.has(id));
  const held = new Set(heldPositionIds);
  return active
    .filter((t) => allowAll || t.positionIds.some((id) => held.has(id)))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
}

export function getProjects(jwt: string): Promise<WorkloadResult<RemoteProject[]>> {
  return request("/projects", jwt, {}, (body) =>
    asArray(body).map((p) => ({
      id: num(p.id),
      name: str(p.name) ?? "",
      websiteUrl: str(p.websiteUrl),
      isActive: p.isActive !== false && p.isActive !== 0,
    })),
  );
}

function toRemoteTask(row: Record<string, unknown>, userId: number): RemoteTask {
  const mine = asArray(row.assignees).find((a) => num(a.userId) === userId);
  return {
    id: num(row.id),
    workDate: String(row.workDate ?? "").slice(0, 10),
    durationSec: num(mine?.durationSec),
    title: str(row.title) ?? "",
    noteHtml: str(row.agendaNote) ?? "",
    taskTypeId: num(row.taskTypeId),
    projectId: row.projectId == null ? null : num(row.projectId),
    clickupTaskId: str(row.clickupTaskId),
    legacyId: row.legacyId == null ? null : num(row.legacyId),
  };
}

const PAGE_LIMIT = 500; // the server's maximum

/** Every task the user is an assignee on in [from, to], following pages. */
export async function listMyTasks(input: {
  jwt: string;
  userId: number;
  from: string;
  to: string;
}): Promise<WorkloadResult<RemoteTask[]>> {
  const all: RemoteTask[] = [];
  for (let offset = 0; ; offset += PAGE_LIMIT) {
    const query = new URLSearchParams({
      from: input.from,
      to: input.to,
      user_ids: String(input.userId),
      limit: String(PAGE_LIMIT),
      offset: String(offset),
    });
    const res = await request(`/tasks?${query}`, input.jwt, {}, (body) => {
      const page = (body ?? {}) as { items?: unknown; total?: unknown };
      return { items: asArray(page.items), total: num(page.total) };
    });
    if (!res.ok) return { ...res, data: all };
    all.push(...res.data.items.map((row) => toRemoteTask(row, input.userId)));
    if (res.data.items.length === 0 || offset + PAGE_LIMIT >= res.data.total) {
      return { ...res, data: all };
    }
  }
}

/** Add, edit and remove one person-day in one all-or-nothing request. */
export function batchLog(input: {
  jwt: string;
  log: BatchLog;
}): Promise<WorkloadResult<BatchResult>> {
  return request(
    "/tasks/batch",
    input.jwt,
    { method: "POST", body: JSON.stringify(input.log) },
    (body) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const ids = (v: unknown) => (Array.isArray(v) ? v.map(num) : []);
      return {
        created: ids(b.created),
        updated: ids(b.updated),
        removed: ids(b.removed),
        dayTotalSec: num(b.dayTotalSec),
      };
    },
  );
}

/** Soft-deletes the task. 404 = not visible to us (already gone, or never ours). */
export function deleteTask(input: { jwt: string; id: number }): Promise<WorkloadResult<boolean>> {
  return request(`/tasks/${input.id}`, input.jwt, { method: "DELETE" }, (body) =>
    Boolean((body as { deleted?: unknown } | null)?.deleted),
  );
}

/** Decode JWT payload without verifying (we only inspect tokens the user pastes). */
export function decodeJwt(jwt: string): Record<string, unknown> | null {
  try {
    const [, payload] = jwt.split(".");
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function jwtExpiry(jwt: string): Date | null {
  const payload = decodeJwt(jwt);
  const exp = payload?.exp;
  return typeof exp === "number" ? new Date(exp * 1000) : null;
}

/** Who the token belongs to — the server writes every row under this user. */
export type JwtIdentity = { userId: number; email: string; name: string; role: string };

export function jwtIdentity(jwt: string): JwtIdentity | null {
  const payload = decodeJwt(jwt);
  const userId = Number(payload?.sub);
  if (!payload || !Number.isInteger(userId) || userId <= 0) return null;
  return {
    userId,
    email: typeof payload.email === "string" ? payload.email : "",
    name: typeof payload.name === "string" ? payload.name : "",
    role: typeof payload.role === "string" ? payload.role : "",
  };
}

// --- remote ids --------------------------------------------------------------
// Cards submitted to the old workload carry that system's row id, stored as
// "v1:<id>" since the switch. They are never sent as a v2 task id — a v1 id
// can equal an unrelated v2 row of ours. Reconcile re-links them through the
// legacyId the data migration kept on each v2 row.

const LEGACY_PREFIX = "v1:";

export function isLegacyRemoteId(remoteTaskId: string | null): boolean {
  return Boolean(remoteTaskId?.startsWith(LEGACY_PREFIX));
}

export function legacyRemoteId(legacyId: number): string {
  return `${LEGACY_PREFIX}${legacyId}`;
}

/** The v2 task id behind a card's remote id, or null when it has none / is a v1 id. */
export function v2TaskId(remoteTaskId: string | null): number | null {
  if (!remoteTaskId || !/^\d+$/.test(remoteTaskId)) return null;
  return Number(remoteTaskId);
}

// --- field mapping -----------------------------------------------------------

/** ClickUp id/URL the server accepts (db/src/clickup.ts) — anything else 400s the whole day. */
export function clickupTaskIdForUpload(value: string | null): string | null {
  const text = value?.trim() ?? "";
  if (!text) return null;
  const fromUrl = text.match(/app\.clickup\.com\/t\/(?:\d+\/)?([A-Za-z0-9_-]+)/);
  const id = fromUrl ? fromUrl[1] : text;
  return /^(?=.*[A-Za-z0-9])[A-Za-z0-9_-]{1,50}$/.test(id) ? id : null;
}

const TITLE_MAX = 255; // tasks.title is varchar(255)

export function titleForUpload(topic: string): string | undefined {
  const text = topic.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, TITLE_MAX) : undefined;
}

function hostOf(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
}

/**
 * The project a card's free-text website/project field names: an exact
 * (case-insensitive) project name, or the same host as a project's website.
 * null when nothing matches — the task is then logged without a project.
 */
export function matchProject(
  website: string | null,
  projects: RemoteProject[],
): RemoteProject | null {
  const text = website?.trim().toLowerCase() ?? "";
  if (!text) return null;
  const active = projects.filter((p) => p.isActive);
  const byName = active.find((p) => p.name.trim().toLowerCase() === text);
  if (byName) return byName;
  const host = hostOf(text);
  if (!host) return null;
  return active.find((p) => p.websiteUrl && hostOf(p.websiteUrl) === host) ?? null;
}
