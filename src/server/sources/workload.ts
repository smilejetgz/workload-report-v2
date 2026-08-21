// Client for the company workload-service API (ported from v1).
// All calls take an explicit jwt; a 401/403 response is surfaced as
// { authExpired: true } so the UI can prompt for a fresh token.

const BASE_URL =
  process.env.WORKLOAD_API_BASE ?? "https://workload-api.ketspace.io/services/resource/workload";

export type CreateTaskInput = {
  tasks_date: string; // YYYY-MM-DD
  duration: number; // seconds
  note: string;
  task_by: string;
  task_type: string;
  email: string;
  website?: string | null;
  clickup_task?: string | null;
};

export type RemoteTaskType = { id: number; tasks_propose: string; color: string };

export type RemoteEmployee = {
  id: number;
  name: string;
  email: string;
  role?: string;
  status_active?: number | boolean | null;
};

export type RemoteTask = {
  id: number;
  tasks_date: string;
  duration: number | string;
  note: string;
  website: string | null;
  task_by: string;
  task_type: string;
  email: string | null;
  clickup_task: string | null;
};

export type WorkloadResult<T> = {
  ok: boolean;
  status: number;
  authExpired: boolean;
  data: T;
  body: unknown;
};

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
  return {
    ok: res.ok,
    status: res.status,
    authExpired: res.status === 401 || res.status === 403,
    data: pickData(body),
    body,
  };
}

const dataArray =
  <T>() =>
  (body: unknown): T[] =>
    ((body as { data?: T[] })?.data ?? []) as T[];

// update-task / delete-task answer HTTP 200 with { data: <rows affected> } even
// when the id matched nothing — so `ok` alone means "the request was accepted",
// never "the row changed". Callers must check this count.
export function affectedRows(body: unknown): number {
  const data = (body as { data?: unknown })?.data;
  return typeof data === "number" ? data : Number(data) || 0;
}

export function getTaskTypes(jwt: string): Promise<WorkloadResult<RemoteTaskType[]>> {
  return request("/tasks/get-tasktype", jwt, {}, dataArray<RemoteTaskType>());
}

/** Employee directory — the source of truth for task_by / email on upload. */
export function getEmployees(jwt: string): Promise<WorkloadResult<RemoteEmployee[]>> {
  return request("/tasks/get-employee", jwt, {}, dataArray<RemoteEmployee>());
}

export function searchTasks(input: {
  jwt: string;
  email: string;
  startDate: string;
  endDate: string;
  role?: string;
}): Promise<WorkloadResult<RemoteTask[]>> {
  return request(
    "/tasks/search-tasks",
    input.jwt,
    {
      method: "POST",
      body: JSON.stringify({
        start_date: input.startDate,
        end_date: input.endDate,
        email: input.email,
        role: input.role ?? "staff",
        name: null,
        title: null,
      }),
    },
    dataArray<RemoteTask>(),
  );
}

export function createTaskList(input: {
  jwt: string;
  tasks: CreateTaskInput[];
}): Promise<WorkloadResult<unknown>> {
  // Server expects { tasks: [...] }, not a bare array.
  return request(
    "/tasks/create-task-list",
    input.jwt,
    { method: "POST", body: JSON.stringify({ tasks: input.tasks }) },
    (body) => body,
  );
}

export function updateTask(input: {
  jwt: string;
  id: string;
  task: CreateTaskInput;
}): Promise<WorkloadResult<number>> {
  return request(
    `/tasks/update-task/${input.id}`,
    input.jwt,
    { method: "PUT", body: JSON.stringify(input.task) },
    affectedRows,
  );
}

// Verified against the live API (21 ส.ค. 2026): DELETE /tasks/delete-task/{id}
// exists (POST /tasks/delete-task and /tasks/task/{id} both 404).
export function deleteTask(input: { jwt: string; id: string }): Promise<WorkloadResult<number>> {
  return request(`/tasks/delete-task/${input.id}`, input.jwt, { method: "DELETE" }, affectedRows);
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
