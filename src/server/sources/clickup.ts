// ClickUp REST API v2 client. Personal token (pk_…) in the Authorization
// header (no Bearer prefix). Rate limit ~100 req/min — callers keep request
// counts low (incremental sync + capped comment fetches).

const BASE = "https://api.clickup.com/api/v2";

export type ClickupApiTask = {
  id: string;
  custom_id: string | null;
  name: string;
  status?: { status: string; type: string };
  date_created?: string;
  date_updated?: string;
  date_closed?: string | null;
  due_date?: string | null;
  priority?: { priority: string } | null;
  assignees?: { id: number; username: string }[];
  tags?: { name: string }[];
  list?: { name: string };
  folder?: { name: string };
  space?: { id: string };
  url?: string;
  text_content?: string | null;
};

export type ClickupComment = {
  id: string;
  comment_text: string;
  user: { id: number; username: string };
  date: string; // epoch ms as string
};

class ClickupError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ClickupError";
  }
}

async function cuFetch<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: token } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ClickupError(res.status, `ClickUp ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function getAuthorizedUser(token: string): Promise<{ id: number; email: string }> {
  const body = await cuFetch<{ user: { id: number; email: string } }>(token, "/user");
  return body.user;
}

export async function getAuthorizedTeams(token: string): Promise<{ id: string; name: string }[]> {
  const body = await cuFetch<{ teams: { id: string; name: string }[] }>(token, "/team");
  return body.teams;
}

/** Tasks updated within [fromMs, toMs] assigned to userId — follows pagination. */
export async function getTasksUpdatedInRange(input: {
  token: string;
  teamId: string;
  userId: number;
  fromMs: number;
  toMs: number;
  maxPages?: number;
}): Promise<ClickupApiTask[]> {
  const out: ClickupApiTask[] = [];
  const maxPages = input.maxPages ?? 5;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      page: String(page),
      include_closed: "true",
      subtasks: "true",
      date_updated_gt: String(input.fromMs),
      date_updated_lt: String(input.toMs),
    });
    params.append("assignees[]", String(input.userId));
    const body = await cuFetch<{ tasks: ClickupApiTask[]; last_page?: boolean }>(
      input.token,
      `/team/${input.teamId}/task?${params}`,
    );
    out.push(...body.tasks);
    if (body.last_page !== false || body.tasks.length < 100) break;
  }
  return out;
}

/** Fetch a single task by custom id (e.g. DEV-6395). Returns null on 404. */
export async function getTaskByCustomId(input: {
  token: string;
  teamId: string;
  customId: string;
}): Promise<ClickupApiTask | null> {
  try {
    return await cuFetch<ClickupApiTask>(
      input.token,
      `/task/${encodeURIComponent(input.customId)}?custom_task_ids=true&team_id=${input.teamId}`,
    );
  } catch (error) {
    if (error instanceof ClickupError && (error.status === 404 || error.status === 401)) {
      return null;
    }
    throw error;
  }
}

export async function getTaskComments(token: string, taskId: string): Promise<ClickupComment[]> {
  const body = await cuFetch<{ comments: ClickupComment[] }>(token, `/task/${taskId}/comment`);
  return body.comments;
}

export function epochMsToDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}
