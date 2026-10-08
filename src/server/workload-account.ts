// Who we write to workload as, and the lookups a card needs before it can
// become a v2 task (task type id, project id). Shared by submit, the two-way
// sync and the generate pipeline.

import { getDb, schema } from "@/db/client";
import type { Card } from "@/db/schema";
import { getSetting } from "./settings";
import {
  allowedTaskTypes,
  clickupTaskIdForUpload,
  describeFailure,
  getMe,
  getProjects,
  getTaskTypes,
  jwtIdentity,
  matchProject,
  titleForUpload,
  type BatchItem,
  type JwtIdentity,
  type RemoteProject,
  type RemoteTaskType,
} from "./sources/workload";

export type Account = { jwt: string; identity: JwtIdentity };

/** The configured JWT and the user it belongs to — every write lands under that user. */
export function workloadAccount(): Account | { missing: string } {
  const jwt = getSetting("jwt");
  if (!jwt) return { missing: "jwt" };
  const identity = jwtIdentity(jwt);
  // A token without a numeric `sub` is not a workload v2 token (e.g. a leftover v1 one).
  if (!identity) return { missing: "jwt (ไม่ใช่โทเคนของ workload v2)" };
  return { jwt, identity };
}

export type Lookups = { taskTypes: RemoteTaskType[]; projects: RemoteProject[] };

export type LookupResult =
  | { ok: true; lookups: Lookups }
  | { ok: false; authExpired: boolean; error: string };

/** Every task type (active or not, to read history) and every project. */
export async function loadLookups(jwt: string): Promise<LookupResult> {
  const [types, projects] = await Promise.all([getTaskTypes(jwt), getProjects(jwt)]);
  for (const res of [types, projects]) {
    if (res.authExpired) return { ok: false, authExpired: true, error: "JWT หมดอายุ" };
  }
  if (!types.ok) return { ok: false, authExpired: false, error: describeFailure("task-types", types) };
  // Projects are optional on a task; a failed list only costs the project link.
  return { ok: true, lookups: { taskTypes: types.data, projects: projects.ok ? projects.data : [] } };
}

/** Name → id, preferring an active type when an old one shares the name. */
export function taskTypeIdByName(name: string, types: RemoteTaskType[]): number | null {
  const key = name.trim().toLowerCase();
  const same = types.filter((t) => t.name.trim().toLowerCase() === key);
  return (same.find((t) => t.isActive) ?? same[0])?.id ?? null;
}

/**
 * A card as a POST /tasks/batch item. On an edit (taskId given) a project
 * that cannot be resolved is left out, so the row keeps the project it has.
 */
export function cardToBatchItem(
  card: Card,
  lookups: Lookups,
  taskId?: number,
): { item: BatchItem } | { error: string } {
  const taskTypeId = taskTypeIdByName(card.taskType, lookups.taskTypes);
  if (taskTypeId === null) {
    return { error: `ประเภทงาน "${card.taskType}" ไม่มีใน workload — เลือกประเภทใหม่แล้วส่งอีกครั้ง` };
  }
  const project = matchProject(card.website, lookups.projects);
  const item: BatchItem = {
    ...(taskId !== undefined ? { taskId } : {}),
    taskTypeId,
    ...(project ? { projectId: project.id } : {}),
    durationSec: card.durationSec,
    note: card.noteHtml,
  };
  const title = titleForUpload(card.topic);
  if (title) item.title = title;
  const clickup = clickupTaskIdForUpload(card.clickupTask);
  if (clickup) item.clickupTaskId = clickup;
  return { item };
}

/**
 * Refresh the local list of task types the AI may pick: only the active types
 * this user's positions may log, so a generated card never names a type the
 * server would refuse with 403.
 */
export async function syncAllowedTaskTypes(
  jwt: string,
): Promise<{ ok: true; count: number } | { ok: false; authExpired: boolean; error: string }> {
  const [me, types] = await Promise.all([getMe(jwt), getTaskTypes(jwt)]);
  for (const res of [me, types]) {
    if (res.authExpired) return { ok: false, authExpired: true, error: "JWT หมดอายุ" };
  }
  if (!types.ok) return { ok: false, authExpired: false, error: describeFailure("task-types", types) };
  if (!me.ok || !me.data) return { ok: false, authExpired: false, error: describeFailure("auth/me", me) };

  const allowed = allowedTaskTypes(
    types.data,
    me.data.positions.map((p) => p.positionId),
  );
  const db = getDb();
  const now = new Date();
  // Replace, not upsert: ids from the old workload, or types since closed,
  // must not stay pickable.
  db.transaction((tx) => {
    tx.delete(schema.taskTypes).run();
    for (const t of allowed) {
      tx.insert(schema.taskTypes).values({ id: t.id, name: t.name, color: t.color, syncedAt: now }).run();
    }
  });
  return { ok: true, count: allowed.length };
}
