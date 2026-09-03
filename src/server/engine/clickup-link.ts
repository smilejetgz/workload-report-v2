// Attach the related ClickUp task (id + url) to a card, deterministically.
//
// One rule: a commit the card cites carries a ticket id → that task's link goes
// on the card. Nothing else qualifies. The model's own guess and loose task
// mentions are ignored on purpose — a ClickUp url sitting next to hours that no
// commit backs reads as evidence the work is real.

export type LinkableTask = { taskId: string; customId: string | null; url: string | null };
export type LinkableCommit = { hash: string; ticketIds: string[] };

export type ClickupLink = { taskId: string; customId: string | null; url: string };

type CardLike = { evidence: { commits: string[]; tasks: string[] } };

const norm = (value: string) => value.trim().toUpperCase();

function indexTasks(tasks: LinkableTask[]): Map<string, LinkableTask> {
  const index = new Map<string, LinkableTask>();
  for (const task of tasks) {
    if (task.customId) index.set(norm(task.customId), task);
    index.set(norm(task.taskId), task);
  }
  return index;
}

/** Ticket ids from the cited commits, most-cited first. */
function ticketIdsFromCitedCommits(card: CardLike, commits: LinkableCommit[]): string[] {
  const cited = card.evidence.commits.map((h) => h.toLowerCase());
  const isCited = (hash: string) => {
    const h = hash.toLowerCase();
    return cited.some((ref) => h.startsWith(ref) || ref.startsWith(h));
  };

  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const commit of commits) {
    if (!isCited(commit.hash)) continue;
    for (const raw of commit.ticketIds) {
      const id = norm(raw);
      if (!counts.has(id)) order.push(id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return order.sort(
    (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || order.indexOf(a) - order.indexOf(b),
  );
}

export function resolveClickupLink(input: {
  card: CardLike;
  commits: LinkableCommit[];
  tasks: LinkableTask[];
}): ClickupLink | null {
  const index = indexTasks(input.tasks);
  for (const id of ticketIdsFromCitedCommits(input.card, input.commits)) {
    // DEV-6395 → custom id; CU-abc / #abc1234 → the raw task id.
    const task = index.get(id) ?? index.get(id.replace(/^(CU-|#)/, ""));
    if (!task?.url) continue; // not synced, or synced without a url
    return { taskId: task.taskId, customId: task.customId, url: task.url };
  }
  return null;
}
