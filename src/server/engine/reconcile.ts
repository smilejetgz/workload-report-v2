// Reconcile the local card list against what really exists on workload.
// Pure function: decides the actions, the caller applies them to the DB.
//
// Rule: for a card that is already submitted, workload is the truth — someone
// may have edited or deleted the row on the website. A card with a pending
// local change (status draft/approved/failed) is NOT overwritten.

import { sanitizeNoteHtml } from "@/lib/sanitize";

export type LocalCardLike = {
  id: number;
  tasksDate: string;
  durationSec: number;
  noteHtml: string;
  taskType: string;
  website: string | null;
  clickupTask: string | null;
  status: string;
  remoteTaskId: string | null;
};

export type RemoteTaskLike = {
  id: number;
  tasks_date: string;
  duration: number | string;
  note: string;
  task_type: string;
  website: string | null;
  clickup_task: string | null;
};

export type RemoteFields = {
  durationSec: number;
  noteHtml: string;
  taskType: string;
  website: string | null;
  clickupTask: string | null;
};

export type ReconcileAction =
  | { kind: "link"; cardId: number; remoteTaskId: string }
  | { kind: "update-local"; cardId: number; remoteTaskId: string; fields: RemoteFields }
  | { kind: "import"; remote: RemoteTaskLike }
  | { kind: "orphan"; cardId: number };

const NOTE_MATCH_LEN = 80;

function plainNote(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NOTE_MATCH_LEN);
}

function remoteFields(remote: RemoteTaskLike): RemoteFields {
  return {
    durationSec: Number(remote.duration) || 0,
    // Sanitised here rather than at write time so the drift comparison below
    // is like-for-like — otherwise every sync would "fix" the same card again.
    noteHtml: sanitizeNoteHtml(remote.note),
    taskType: remote.task_type,
    website: remote.website ?? null,
    clickupTask: remote.clickup_task ?? null,
  };
}

function differs(card: LocalCardLike, fields: RemoteFields): boolean {
  return (
    card.durationSec !== fields.durationSec ||
    card.noteHtml !== fields.noteHtml ||
    card.taskType !== fields.taskType ||
    (card.website ?? null) !== fields.website ||
    (card.clickupTask ?? null) !== fields.clickupTask
  );
}

/** Fuzzy key for rows created before we knew their remote id. */
function fuzzyKey(date: string, durationSec: number, note: string): string {
  return `${date.slice(0, 10)}|${durationSec}|${plainNote(note)}`;
}

export function planReconcile(input: {
  localCards: LocalCardLike[];
  remoteTasks: RemoteTaskLike[];
}): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  const takenRemote = new Set<number>();
  const matched = new Map<number, RemoteTaskLike>(); // cardId → remote row

  const byRemoteId = new Map<string, LocalCardLike>();
  for (const card of input.localCards) {
    if (card.remoteTaskId) byRemoteId.set(card.remoteTaskId, card);
  }

  // 1. Exact match on the stored remote id.
  for (const remote of input.remoteTasks) {
    const card = byRemoteId.get(String(remote.id));
    if (!card) continue;
    matched.set(card.id, remote);
    takenRemote.add(remote.id);
  }

  // 2. Submitted cards without an id: match on date + duration + note text.
  const fuzzyPool = new Map<string, RemoteTaskLike[]>();
  for (const remote of input.remoteTasks) {
    if (takenRemote.has(remote.id)) continue;
    const key = fuzzyKey(remote.tasks_date, Number(remote.duration) || 0, remote.note);
    fuzzyPool.set(key, [...(fuzzyPool.get(key) ?? []), remote]);
  }
  for (const card of input.localCards) {
    if (matched.has(card.id) || card.status !== "submitted") continue;
    const candidates = fuzzyPool.get(fuzzyKey(card.tasksDate, card.durationSec, card.noteHtml));
    const remote = candidates?.find((r) => !takenRemote.has(r.id));
    if (!remote) continue;
    matched.set(card.id, remote);
    takenRemote.add(remote.id);
    actions.push({ kind: "link", cardId: card.id, remoteTaskId: String(remote.id) });
  }

  // 3. Matched pairs that drifted → take the remote values.
  for (const card of input.localCards) {
    const remote = matched.get(card.id);
    if (!remote || card.status !== "submitted") continue;
    const fields = remoteFields(remote);
    if (!differs(card, fields)) continue;
    actions.push({
      kind: "update-local",
      cardId: card.id,
      remoteTaskId: String(remote.id),
      fields,
    });
  }

  // 4. Rows on workload with no card here (entered on the website, or by v1).
  for (const remote of input.remoteTasks) {
    if (!takenRemote.has(remote.id)) actions.push({ kind: "import", remote });
  }

  // 5. Cards we believe we submitted, but workload no longer has them.
  for (const card of input.localCards) {
    if (card.status === "submitted" && !matched.has(card.id)) {
      actions.push({ kind: "orphan", cardId: card.id });
    }
  }

  return actions;
}

/** A 200 from update-task/delete-task carries a rows-affected count, and 0 is
 *  ambiguous: the row may be gone, or the values may simply be unchanged. Only
 *  a re-read of the day can tell the two apart. */
export function decideWriteOutcome(input: {
  affected: number;
  /** null = the verifying read failed, so we cannot tell. */
  rowStillOnRemote: boolean | null;
}): "ok" | "row-missing" | "unknown" {
  if (input.affected > 0) return "ok";
  if (input.rowStillOnRemote === true) return "ok"; // no-op write, row is there
  if (input.rowStillOnRemote === false) return "row-missing";
  return "unknown";
}
