// Reference data from the workload site, mirrored into local tables so the AI
// and the uploader can resolve names ↔ ids without a round trip per card.
//
// Sync replaces the whole table: the site's ids are the truth, and a type that
// disappeared there must not keep matching here.

import { getDb, schema } from "@/db/client";
import type { TaskType, WorkloadProject } from "@/db/schema";
import { getProjects, getTaskTypes, type WorkloadResult } from "./sources/workload";
import { getSetting } from "./settings";

export async function syncTaskTypes(jwt: string): Promise<WorkloadResult<TaskType[]>> {
  const res = await getTaskTypes(jwt);
  if (!res.ok) return { ...res, data: [] };
  const db = getDb();
  const now = new Date();
  const rows: TaskType[] = res.data.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    isActive: t.isActive,
    isFallback: t.isFallback,
    formKind: t.formKind,
    positionIds: t.positionIds,
    syncedAt: now,
  }));
  db.transaction((tx) => {
    tx.delete(schema.taskTypes).run();
    for (const row of rows) tx.insert(schema.taskTypes).values(row).run();
  });
  return { ...res, data: rows };
}

export async function syncProjects(jwt: string): Promise<WorkloadResult<WorkloadProject[]>> {
  const res = await getProjects(jwt);
  if (!res.ok) return { ...res, data: [] };
  const db = getDb();
  const now = new Date();
  const rows: WorkloadProject[] = res.data.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    websiteUrl: p.websiteUrl,
    isActive: p.isActive,
    syncedAt: now,
  }));
  db.transaction((tx) => {
    tx.delete(schema.workloadProjects).run();
    for (const row of rows) tx.insert(schema.workloadProjects).values(row).run();
  });
  return { ...res, data: rows };
}

export function listTaskTypes(): TaskType[] {
  return getDb().select().from(schema.taskTypes).all();
}

export function listWorkloadProjects(): WorkloadProject[] {
  return getDb().select().from(schema.workloadProjects).all();
}

/** The user's workload position ids, cached from GET /auth/me. */
export function myPositionIds(): number[] {
  try {
    const parsed: unknown = JSON.parse(getSetting("workload_position_ids") ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

/**
 * Task types the token's owner may log: active, and either open to every
 * position or listing one of theirs. With no position known, every active
 * type is allowed.
 */
export function allowedTaskTypes(types: TaskType[], positionIds: number[]): TaskType[] {
  const active = types.filter((t) => t.isActive);
  if (positionIds.length === 0) return active;
  const allowed = active.filter(
    (t) => t.positionIds.length === 0 || t.positionIds.some((p) => positionIds.includes(p)),
  );
  return allowed.length > 0 ? allowed : active;
}

/** The type the site itself falls back to ("Others"), else the first allowed. */
export function fallbackTaskType(types: TaskType[]): TaskType | null {
  return types.find((t) => t.isFallback) ?? types[0] ?? null;
}

/** Case-insensitive name → id, the way the validator already matches names. */
export function taskTypeIdByName(types: TaskType[], name: string): number | null {
  const wanted = name.trim().toLowerCase();
  return types.find((t) => t.name.trim().toLowerCase() === wanted)?.id ?? null;
}

export function taskTypeNameById(types: TaskType[], id: number | null): string | null {
  if (id === null) return null;
  return types.find((t) => t.id === id)?.name ?? null;
}
