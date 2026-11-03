// Reconcile the local card list against what really exists on workload.
// Pure function: decides the actions, the caller applies them to the DB.
//
// Rule: for a card that is already submitted, workload is the truth — someone
// may have edited or deleted the row on the website. A card with a pending
// local change (status draft/approved/failed) is NOT overwritten.
//
// Rows uploaded to the old system were migrated to the new site with their old
// id kept as `legacyId`, so a card still holding the old id is matched through
// it and moved onto the new id.

import { htmlToPlainNote, plainTextToNoteHtml } from "@/lib/html-text";
import { sanitizeNoteHtml } from "@/lib/sanitize";
import { normalizeHost } from "./project-match";

export type LocalCardLike = {
  id: number;
  tasksDate: string;
  durationSec: number;
  topic: string;
  noteHtml: string;
  taskType: string;
  website: string | null;
  clickupTask: string | null;
  status: string;
  remoteTaskId: string | null;
};

/** A row from the site with ids already resolved to the names the app stores. */
export type RemoteTaskLike = {
  id: number;
  legacyId: number | null;
  workDate: string;
  title: string;
  /** As stored on the site: HTML for rows this app wrote, plain text otherwise. */
  note: string;
  taskType: string;
  durationSec: number;
  /** The project's host or name, null when the row has no project. */
  website: string | null;
  clickupTask: string | null;
};

export type RemoteFields = {
  durationSec: number;
  topic: string;
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

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
/** The note's words with markup, bullets and spaces removed — the migration
 *  flattened notes this way, and a plain-text copy differs only in those. */
const words = (s: string) =>
  htmlToPlainNote(s)
    .split("\n")
    .map((line) => line.replace(/^[-•*]\s+/, ""))
    .join("")
    .replace(/\s+/g, "")
    .toLowerCase();
const looksLikeHtml = (s: string) => /<[a-z][^>]*>/i.test(s);

/** The HTML to store for a remote note — sanitised, never raw. */
export function noteHtmlFromRemote(note: string): string {
  return looksLikeHtml(note) ? sanitizeNoteHtml(note) : plainTextToNoteHtml(note);
}

/** A title this short could be a real headline; only longer ones count as echoes. */
const ECHO_MIN_CHARS = 20;

/** The migration set the title to the note's own text (squeezed, and cut off
 *  at the column's limit), so a title that is how the note begins is not a
 *  title anyone chose. */
function titleEchoesNote(remote: RemoteTaskLike): boolean {
  const title = words(remote.title);
  const note = words(remote.note);
  if (note.length === 0 || title.length === 0) return false;
  return title === note || (title.length >= ECHO_MIN_CHARS && note.startsWith(title));
}

/** A readable topic for a row entered on the site (or migrated). */
export function topicForImport(remote: RemoteTaskLike): string {
  if (titleEchoesNote(remote)) {
    const firstLine = htmlToPlainNote(remote.note).split("\n")[0]?.replace(/^- /, "");
    if (firstLine) return firstLine.slice(0, 200);
  }
  return squash(remote.title) || "งานจาก workload";
}

function notesAgree(card: LocalCardLike, remote: RemoteTaskLike): boolean {
  return (
    sanitizeNoteHtml(card.noteHtml) === sanitizeNoteHtml(remote.note) ||
    words(card.noteHtml) === words(remote.note)
  );
}

function topicsAgree(card: LocalCardLike, remote: RemoteTaskLike): boolean {
  return squash(card.topic) === squash(remote.title) || titleEchoesNote(remote);
}

function remoteFields(remote: RemoteTaskLike, card: LocalCardLike): RemoteFields {
  return {
    durationSec: remote.durationSec,
    topic: topicsAgree(card, remote) ? card.topic : squash(remote.title),
    // Same words → keep the card's own markup; a sync must not churn a note
    // whose only difference is how the site stored it.
    noteHtml: notesAgree(card, remote) ? card.noteHtml : noteHtmlFromRemote(remote.note),
    taskType: remote.taskType,
    website: remote.website,
    clickupTask: remote.clickupTask ?? null,
  };
}

function differs(card: LocalCardLike, remote: RemoteTaskLike): boolean {
  return (
    card.durationSec !== remote.durationSec ||
    card.taskType !== remote.taskType ||
    normalizeHost(card.website) !== normalizeHost(remote.website) ||
    (card.clickupTask ?? null) !== (remote.clickupTask ?? null) ||
    !topicsAgree(card, remote) ||
    !notesAgree(card, remote)
  );
}

/** Fuzzy key for rows created before we knew their remote id. */
function fuzzyKey(date: string, durationSec: number, title: string): string {
  return `${date.slice(0, 10)}|${durationSec}|${squash(title).toLowerCase()}`;
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

  // 1. Exact match on the stored remote id — the new id, or the old one the
  //    migration kept as legacyId (then the card moves onto the new id).
  for (const remote of input.remoteTasks) {
    const card = byRemoteId.get(String(remote.id));
    if (card) {
      matched.set(card.id, remote);
      takenRemote.add(remote.id);
      continue;
    }
    const legacy = remote.legacyId !== null ? byRemoteId.get(String(remote.legacyId)) : undefined;
    if (legacy && !matched.has(legacy.id)) {
      matched.set(legacy.id, remote);
      takenRemote.add(remote.id);
      actions.push({ kind: "link", cardId: legacy.id, remoteTaskId: String(remote.id) });
    }
  }

  // 2. Submitted cards without a usable id: match on date + duration + title.
  const fuzzyPool = new Map<string, RemoteTaskLike[]>();
  for (const remote of input.remoteTasks) {
    if (takenRemote.has(remote.id)) continue;
    const key = fuzzyKey(remote.workDate, remote.durationSec, remote.title);
    fuzzyPool.set(key, [...(fuzzyPool.get(key) ?? []), remote]);
  }
  for (const card of input.localCards) {
    if (matched.has(card.id) || card.status !== "submitted") continue;
    const candidates = fuzzyPool.get(fuzzyKey(card.tasksDate, card.durationSec, card.topic));
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
    if (!differs(card, remote)) continue;
    actions.push({
      kind: "update-local",
      cardId: card.id,
      remoteTaskId: String(remote.id),
      fields: remoteFields(remote, card),
    });
  }

  // 4. Rows on workload with no card here (entered on the website).
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
