import { getDb, schema } from "@/db/client";
import { getSelectedAuthors } from "@/server/authors";
import { handle, ok } from "@/server/http";
import { isGitRepo, listAuthors, type GitAuthor } from "@/server/sources/git";

const DEFAULT_LOOKBACK_DAYS = 365;

export type GitAuthorOption = GitAuthor & {
  projects: string[];
  selected: boolean;
};

function sinceYMD(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** GET ?days=365 → every author seen in the enabled repos, with our selection. */
export function GET(request: Request) {
  return handle(async () => {
    const url = new URL(request.url);
    const days = Number(url.searchParams.get("days") ?? DEFAULT_LOOKBACK_DAYS);
    const since = sinceYMD(Number.isFinite(days) && days > 0 ? days : DEFAULT_LOOKBACK_DAYS);

    const selected = new Set(getSelectedAuthors().map((a) => a.toLowerCase()));
    const projects = getDb().select().from(schema.projects).all();
    const merged = new Map<string, GitAuthorOption>();
    const warnings: string[] = [];

    for (const project of projects) {
      if (!project.enabled || !isGitRepo(project.path)) continue;
      let authors: GitAuthor[] = [];
      try {
        authors = await listAuthors({ repoPath: project.path, sinceYMD: since });
      } catch (error) {
        warnings.push(
          `อ่าน author ของ ${project.name} ไม่ได้: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      for (const author of authors) {
        const existing = merged.get(author.email);
        if (existing) {
          existing.commits += author.commits;
          existing.projects.push(project.name);
          if (author.lastCommitAt && (existing.lastCommitAt ?? "") < author.lastCommitAt) {
            existing.lastCommitAt = author.lastCommitAt;
          }
          continue;
        }
        merged.set(author.email, {
          ...author,
          projects: [project.name],
          selected:
            selected.has(author.email.toLowerCase()) || selected.has(author.name.toLowerCase()),
        });
      }
    }

    const authors = [...merged.values()].sort((a, b) => b.commits - a.commits);
    return ok({ authors, selected: getSelectedAuthors(), since, warnings });
  });
}
