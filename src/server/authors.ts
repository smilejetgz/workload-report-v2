// Which git identities count as "me". Selection lives in settings
// (git_authors, JSON array) with an optional per-project override
// (projects.author_email_filter). Commits by anyone else never enter a report.

import { getDb, schema } from "@/db/client";
import { getSetting } from "./settings";
import { isMyCommit, parseAuthorFilters } from "./sources/git";

export function getSelectedAuthors(): string[] {
  return parseAuthorFilters(getSetting("git_authors"));
}

/** Per-project filters: project override when set, otherwise the global list. */
export function authorFiltersByProject(): Map<number, string[]> {
  const global = getSelectedAuthors();
  const projects = getDb().select().from(schema.projects).all();
  return new Map(
    projects.map((p) => {
      const own = parseAuthorFilters(p.authorEmailFilter);
      return [p.id, own.length > 0 ? own : global];
    }),
  );
}

/** Drop rows written by other people — old scans may predate the selection. */
export function filterMyCommits<
  T extends { projectId: number; authorEmail: string; authorName: string },
>(commits: T[], filtersByProject = authorFiltersByProject()): T[] {
  const global = getSelectedAuthors();
  return commits.filter((c) => isMyCommit(c, filtersByProject.get(c.projectId) ?? global));
}
