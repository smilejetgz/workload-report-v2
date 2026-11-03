// Resolve a card's `website` (a URL or a name the AI/user typed) to a workload
// project id. The site keeps one project per customer website, keyed by its
// bare host ("pet-vet-store.com"), plus a couple of internal projects matched
// by name ("Ketshopweb", "KetBill"). Pure function.

export type ProjectLike = {
  id: number;
  name: string;
  websiteUrl: string | null;
  isActive?: boolean;
};

/** "https://www.Shop.com/path" → "shop.com"; names pass through lower-cased. */
export function normalizeHost(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/^www\./, "")
    .trim();
}

export function resolveProjectId(
  website: string | null | undefined,
  projects: ProjectLike[],
): number | null {
  const host = normalizeHost(website);
  if (!host) return null;
  // Active projects first, so a retired duplicate never wins over the live one.
  const ordered = [...projects].sort(
    (a, b) => Number(b.isActive ?? true) - Number(a.isActive ?? true),
  );
  const byHost = ordered.find((p) => normalizeHost(p.websiteUrl) === host);
  if (byHost) return byHost.id;
  const byName = ordered.find((p) => normalizeHost(p.name) === host);
  return byName?.id ?? null;
}

/** The other direction, for rows pulled back from the site. */
export function websiteForProject(
  projectId: number | null | undefined,
  projects: ProjectLike[],
): string | null {
  if (projectId == null) return null;
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;
  return project.websiteUrl?.trim() || project.name;
}
