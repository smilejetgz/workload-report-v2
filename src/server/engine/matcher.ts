// Deterministic commit↔ClickUp-task matching by ticket id. Pure function.
// Fuzzy/semantic linking is intentionally NOT done here — the AI links loose
// evidence during generation and the validator checks referenced ids exist.

export type MatchableCommit = {
  hash: string;
  projectId: number;
  ticketIds: string[];
};

export type MatchableTask = {
  taskId: string;
  customId: string | null;
};

export type MatchedLink = {
  commitHash: string;
  projectId: number;
  taskId: string;
  source: "id_match";
  confidence: number;
};

export function matchCommitsToTasks(
  commits: MatchableCommit[],
  tasks: MatchableTask[],
): MatchedLink[] {
  const byCustomId = new Map<string, string>();
  const byTaskId = new Map<string, string>();
  for (const t of tasks) {
    if (t.customId) byCustomId.set(t.customId.toUpperCase(), t.taskId);
    byTaskId.set(t.taskId.toLowerCase(), t.taskId);
  }

  const links: MatchedLink[] = [];
  const seen = new Set<string>();
  for (const commit of commits) {
    for (const raw of commit.ticketIds) {
      const ticket = raw.toUpperCase();
      // DEV-6395 → custom id; CU-abc / #abc1234 → raw task id.
      const taskId =
        byCustomId.get(ticket) ??
        byTaskId.get(raw.replace(/^(CU-|#)/i, "").toLowerCase()) ??
        null;
      if (!taskId) continue;
      const key = `${commit.hash}|${commit.projectId}|${taskId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        commitHash: commit.hash,
        projectId: commit.projectId,
        taskId,
        source: "id_match",
        confidence: 1,
      });
    }
  }
  return links;
}
