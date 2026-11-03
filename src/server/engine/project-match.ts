// Host normalisation shared by the project lookup (sources/workload.matchProject)
// and the reverse mapping for rows pulled back from the site. The site keeps one
// project per customer website, keyed by its bare host ("pet-vet-store.com"),
// plus a couple of internal projects matched by name ("Ketshopweb", "KetBill").
// Pure functions.

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
