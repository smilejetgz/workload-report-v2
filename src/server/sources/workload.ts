// Client for the company workload site (workloads.ketspace.io) — the REST API
// its own calendar page uses, reverse-engineered from the site's bundle and
// verified against the live service on 2 Oct 2026.
//
// Auth is the site's web session token (localStorage["workload.access_token"],
// a JWT that lives 8 hours). Every call takes it explicitly; a 401/403 is
// surfaced as { authExpired: true } so the UI can ask for a fresh one.
//
// Identity is implied by the token: the server stores the row under the
// token's user, so no name/email travels with a task any more.

const BASE_URL = process.env.WORKLOAD_API_BASE ?? "https://workloads.ketspace.io/api";

/** my-day calls for a date range run this many at a time. */
const RANGE_CONCURRENCY = 4;

export type RemoteMe = {
  id: number;
  email: string;
  name: string;
  role: string;
  positionIds: number[];
};

export type RemoteTaskType = {
  id: number;
  name: string;
  color: string | null;
  isActive: boolean;
  isFallback: boolean;
  formKind: string | null;
  positionIds: number[];
};

export type RemoteProject = {
  id: number;
  name: string;
  kind: string;
  websiteUrl: string | null;
  isActive: boolean;
};

/**
 * One row on the site, normalised from either shape the API uses: a my-day
 * item (`taskId`, `durationSec`, `taskTypeName`) or a /tasks list item (`id`,
 * `assignees[].durationSec`, `legacyId`, `workDate`).
 */
export type RemoteTask = {
  id: number;
  userId: number | null;
  workDate: string; // YYYY-MM-DD
  title: string;
  taskTypeId: number | null;
  taskTypeName: string | null;
  projectId: number | null;
  projectName: string | null;
  durationSec: number;
  /** `agendaNote` on the wire. HTML for rows this app wrote (and the migrated
   *  ones); plain text when typed into the site's own note box. */
  note: string;
  clickupTaskId: string | null;
  clickupUrl: string | null;
  /** The row's id on the old workload system, kept by the migration. */
  legacyId: number | null;
};

/** One row of POST /tasks/batch: `id` present = update that row, absent = create. */
export type BatchItem = {
  id?: number;
  taskTypeId: number;
  projectId: number | null;
  durationSec: number;
  title: string;
  note: string;
  clickupTaskId: string | null;
};

export type BatchDayInput = {
  workDate: string;
  items: BatchItem[];
  /** Row ids to delete in the same call. */
  remove?: number[];
};

export type WorkloadResult<T> = {
  ok: boolean;
  status: number;
  authExpired: boolean;
  data: T;
  body: unknown;
  /** The server's own message on an error body (NestJS `{ message }`), if any. */
  message: string | null;
};

function serverMessage(body: unknown): string | null {
  const message = (body as { message?: unknown })?.message;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map(String).join("; ");
  return null;
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
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${jwt}`,
      ...init.headers,
    },
  });
  const body: unknown = await res.json().catch(() => ({}));
  return {
    ok: res.ok,
    status: res.status,
    authExpired: res.status === 401 || res.status === 403,
    data: pickData(body),
    body,
    message: res.ok ? null : serverMessage(body),
  };
}

// ---------------------------------------------------------------------------
// Normalisers — exported so the shapes can be pinned by tests without a server.
// ---------------------------------------------------------------------------

const asNumber = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asNumberArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.map(asNumber).filter((n): n is number => n !== null) : [];
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function toRemoteMe(raw: unknown): RemoteMe | null {
  const r = asRecord(raw);
  const id = r ? asNumber(r.id) : null;
  if (!r || id === null) return null;
  const positions = Array.isArray(r.positions) ? r.positions : [];
  return {
    id,
    email: asString(r.email) ?? "",
    name: asString(r.name) ?? "",
    role: asString(r.role) ?? "",
    positionIds: positions
      .map((p) => asNumber(asRecord(p)?.positionId))
      .filter((n): n is number => n !== null),
  };
}

export function toRemoteTaskType(raw: unknown): RemoteTaskType | null {
  const r = asRecord(raw);
  const id = r ? asNumber(r.id) : null;
  const name = r ? asString(r.name) : null;
  if (!r || id === null || !name) return null;
  return {
    id,
    name,
    color: asString(r.color),
    isActive: r.isActive === undefined ? true : Boolean(r.isActive),
    isFallback: Boolean(r.isFallback),
    formKind: asString(r.formKind),
    positionIds: asNumberArray(r.positionIds),
  };
}

export function toRemoteProject(raw: unknown): RemoteProject | null {
  const r = asRecord(raw);
  const id = r ? asNumber(r.id) : null;
  const name = r ? asString(r.name) : null;
  if (!r || id === null || !name) return null;
  return {
    id,
    name,
    kind: asString(r.kind) ?? "website",
    websiteUrl: asString(r.websiteUrl),
    isActive: r.isActive === undefined ? true : Boolean(r.isActive),
  };
}

export function toRemoteTask(raw: unknown, fallbackDate = ""): RemoteTask | null {
  const r = asRecord(raw);
  const id = r ? (asNumber(r.id) ?? asNumber(r.taskId)) : null;
  if (!r || id === null) return null;
  // A soft-deleted row in the list is not on the calendar any more.
  if (r.deletedAt) return null;
  const workDate = (asString(r.workDate) ?? fallbackDate).slice(0, 10);
  const assignees = (Array.isArray(r.assignees) ? r.assignees : []).map(asRecord);
  // my-day carries the seconds directly; the list keeps them per assignee.
  const durationSec =
    asNumber(r.durationSec) ??
    (assignees.length > 0
      ? assignees.reduce((sum, a) => sum + (asNumber(a?.durationSec) ?? 0), 0)
      : Math.round((asNumber(r.hours) ?? 0) * 3600));
  return {
    id,
    userId: asNumber(r.userId) ?? asNumber(r.loggedBy) ?? asNumber(assignees[0]?.userId),
    workDate,
    title: asString(r.title) ?? "",
    taskTypeId: asNumber(r.taskTypeId),
    taskTypeName: asString(r.taskTypeName) ?? asString(asRecord(r.taskType)?.name),
    projectId: asNumber(r.projectId),
    projectName: asString(r.projectName) ?? asString(asRecord(r.project)?.name),
    durationSec,
    note: asString(r.agendaNote) ?? asString(r.note) ?? "",
    clickupTaskId: asString(r.clickupTaskId),
    clickupUrl: asString(r.clickupUrl),
    legacyId: asNumber(r.legacyId),
  };
}

const list =
  <T>(convert: (raw: unknown) => T | null) =>
  (body: unknown): T[] => {
    const rows = Array.isArray(body) ? body : ((body as { items?: unknown })?.items ?? []);
    return (Array.isArray(rows) ? rows : []).map(convert).filter((x): x is T => x !== null);
  };

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** Who the token belongs to — this is who every uploaded row lands under. */
export function getMe(jwt: string): Promise<WorkloadResult<RemoteMe | null>> {
  return request("/auth/me", jwt, {}, toRemoteMe);
}

export function getTaskTypes(jwt: string): Promise<WorkloadResult<RemoteTaskType[]>> {
  return request("/task-types", jwt, {}, list(toRemoteTaskType));
}

export function getProjects(jwt: string): Promise<WorkloadResult<RemoteProject[]>> {
  return request("/projects", jwt, {}, list(toRemoteProject));
}

/** The token owner's rows for one day. */
export function getMyDay(jwt: string, date: string): Promise<WorkloadResult<RemoteTask[]>> {
  return request(`/tasks/my-day?date=${encodeURIComponent(date)}`, jwt, {}, (body) =>
    list((raw) => toRemoteTask(raw, date))(body),
  );
}

export function listDates(fromYMD: string, toYMD: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${fromYMD}T00:00:00Z`);
  const end = new Date(`${toYMD}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return dates;
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** Largest page the list endpoint allows (its `maxLimit`). */
const LIST_PAGE = 500;

/**
 * The token owner's rows for a date range from GET /tasks (staff only ever see
 * their own rows there). Paginated, and the only read that carries `legacyId`
 * — the bridge from rows uploaded to the old system.
 */
export async function getMyRange(
  jwt: string,
  fromYMD: string,
  toYMD: string,
): Promise<WorkloadResult<RemoteTask[]>> {
  const rows: RemoteTask[] = [];
  let offset = 0;
  for (;;) {
    const query = new URLSearchParams({
      from: fromYMD,
      to: toYMD,
      limit: String(LIST_PAGE),
      offset: String(offset),
    });
    const page = await request(`/tasks?${query}`, jwt, {}, (body) => ({
      items: list(toRemoteTask)(body),
      total: asNumber((body as { total?: unknown })?.total) ?? 0,
      count: Array.isArray((body as { items?: unknown })?.items)
        ? ((body as { items: unknown[] }).items.length)
        : 0,
    }));
    if (!page.ok) return { ...page, data: [] };
    rows.push(...page.data.items);
    offset += page.data.count;
    if (page.data.count === 0 || offset >= page.data.total) break;
  }
  return { ok: true, status: 200, authExpired: false, data: rows, body: null, message: null };
}

/**
 * Day-by-day read through my-day — the shape the site's own calendar uses,
 * kept for callers that need a specific day re-read after a write.
 */
export async function getMyDays(
  jwt: string,
  fromYMD: string,
  toYMD: string,
): Promise<WorkloadResult<RemoteTask[]>> {
  const dates = listDates(fromYMD, toYMD);
  const rows: RemoteTask[] = [];
  for (let i = 0; i < dates.length; i += RANGE_CONCURRENCY) {
    const chunk = dates.slice(i, i + RANGE_CONCURRENCY);
    const results = await Promise.all(chunk.map((d) => getMyDay(jwt, d)));
    const failed = results.find((r) => !r.ok);
    if (failed) return { ...failed, data: [] };
    for (const r of results) rows.push(...r.data);
  }
  return { ok: true, status: 200, authExpired: false, data: rows, body: null, message: null };
}

/**
 * Upsert one day in a single call — the same request the site's calendar
 * sends. Rows with `id` are updated, rows without are created, `remove`
 * deletes. The response body is not relied on: callers read the day back
 * with getMyDay to learn ids and confirm what landed.
 */
export function batchDay(jwt: string, input: BatchDayInput): Promise<WorkloadResult<unknown>> {
  const payload: Record<string, unknown> = { workDate: input.workDate, items: input.items };
  if (input.remove && input.remove.length > 0) payload.remove = input.remove;
  return request("/tasks/batch", jwt, { method: "POST", body: JSON.stringify(payload) }, (b) => b);
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
