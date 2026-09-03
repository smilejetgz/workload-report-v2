// Git evidence source. Single-pass `git log --numstat --source` per range —
// no per-commit subprocess (v1 did N+1 `git show` calls; too slow at 1,200+ commits).

import { existsSync } from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";

export type ScannedCommit = {
  hash: string;
  authorDate: Date;
  authorEmail: string;
  authorName: string;
  message: string;
  branch: string | null;
  ticketIds: string[];
  filesSummary: { topDirs: string[]; topFiles: string[] };
  insertions: number;
  deletions: number;
  filesChanged: number;
};

const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

// Jira-style keys (DEV-6395, ISSUE-7709) + raw ClickUp refs (CU-abc123, #86czb2y7w).
// The prefix is letters only: allowing a digit turned "V8-7-5" into a ticket.
const TICKET_RE = /\b[A-Z]{2,10}-\d{1,6}\b/g;
const CLICKUP_REF_RE = /\b(CU-[a-z0-9]+)\b|(?:^|\s)(#[a-z0-9]{6,9})\b/gi;

// Standards and algorithms written the same way a ticket key is. Commit bodies
// are full of them, and each one became a ClickUp lookup that could not match.
const NOT_A_TICKET = new Set([
  "ISO", "SHA", "MD", "RFC", "UTF", "AES", "RSA", "TLS", "SSL", "HTTP", "HTTPS",
  "ES", "CVE", "GMT", "UTC", "IPV", "WCAG", "SRGB", "RGB", "RGBA", "HSL", "UTM",
  "EC", "PBKDF", "HMAC", "JWT", "OAUTH", "SQL", "UUID", "BASE",
]);

/** CSS colours are #RGB / #RRGGBB / #RRGGBBAA — never a ClickUp task id. */
function isHexColor(ref: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(ref);
}

export function extractTicketIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(TICKET_RE)) {
    const key = m[0].toUpperCase();
    if (!NOT_A_TICKET.has(key.split("-")[0])) ids.add(key);
  }
  for (const m of text.matchAll(CLICKUP_REF_RE)) {
    const ref = m[1] ?? m[2];
    if (ref && !isHexColor(ref)) ids.add(ref);
  }
  return [...ids];
}

export function isGitRepo(repoPath: string): boolean {
  return existsSync(repoPath) && existsSync(path.join(repoPath, ".git"));
}

// ---------------------------------------------------------------------------
// Authors: only OUR commits belong in the workload report. A repo's log is
// shared with the whole team, so every scan is filtered to the selected
// identities (emails or names) — anything else is somebody else's work.
// ---------------------------------------------------------------------------

export type GitAuthor = {
  email: string;
  name: string;
  commits: number;
  lastCommitAt: string | null;
};

/** Accepts a JSON array (settings) or a comma/newline list (per-project field). */
export function parseAuthorFilters(value: string | null | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter(Boolean);
      }
    } catch {
      // fall through to the plain-text split
    }
  }
  return trimmed
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Empty filter list = keep everything (no identity chosen yet). */
export function isMyCommit(
  commit: { authorEmail: string; authorName: string },
  filters: string[],
): boolean {
  if (filters.length === 0) return true;
  const email = commit.authorEmail.toLowerCase();
  const name = commit.authorName.toLowerCase();
  return filters.some((f) => {
    const needle = f.trim().toLowerCase();
    return needle.length > 0 && (needle === email || needle === name);
  });
}

/** Aggregate `git log` author lines (email, name, ISO date) into distinct authors. */
export function parseAuthorLog(raw: string): GitAuthor[] {
  type Acc = { email: string; names: Map<string, number>; commits: number; last: string | null };
  const byEmail = new Map<string, Acc>();

  for (const line of raw.split("\n")) {
    const [email, name, iso] = line.split(FIELD_SEP);
    if (!email?.trim() || !name?.trim()) continue;
    const key = email.trim().toLowerCase();
    const acc =
      byEmail.get(key) ?? { email: key, names: new Map<string, number>(), commits: 0, last: null };
    acc.commits += 1;
    acc.names.set(name.trim(), (acc.names.get(name.trim()) ?? 0) + 1);
    if (iso && (!acc.last || iso > acc.last)) acc.last = iso;
    byEmail.set(key, acc);
  }

  return [...byEmail.values()]
    .map((acc) => ({
      email: acc.email,
      name: [...acc.names.entries()].sort((a, b) => b[1] - a[1])[0][0],
      commits: acc.commits,
      lastCommitAt: acc.last,
    }))
    .sort((a, b) => b.commits - a.commits || a.email.localeCompare(b.email));
}

/** Distinct authors in a repo, for the "which git user is me?" picker. */
export async function listAuthors(opts: {
  repoPath: string;
  sinceYMD?: string | null;
}): Promise<GitAuthor[]> {
  const git = simpleGit(opts.repoPath);
  const args = [
    "log",
    "--all",
    "--no-merges",
    `--pretty=format:%ae${FIELD_SEP}%an${FIELD_SEP}%aI`,
  ];
  if (opts.sinceYMD) args.push(`--since=${opts.sinceYMD}`);
  return parseAuthorLog(await git.raw(args));
}

function summariseFiles(files: string[]): { topDirs: string[]; topFiles: string[] } {
  const dirCount = new Map<string, number>();
  for (const f of files) {
    const dir = f.split("/").slice(0, 2).join("/");
    dirCount.set(dir, (dirCount.get(dir) ?? 0) + 1);
  }
  const topDirs = [...dirCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([d]) => d);
  return { topDirs, topFiles: files.slice(0, 8) };
}

export async function scanCommits(opts: {
  repoPath: string;
  sinceYMD: string; // inclusive, local dates
  untilYMD: string; // inclusive
  /** Selected identities (emails and/or names). Empty = everyone. */
  authorFilters?: string[];
}): Promise<ScannedCommit[]> {
  const git = simpleGit(opts.repoPath);
  const untilExclusive = new Date(`${opts.untilYMD}T00:00:00Z`);
  untilExclusive.setUTCDate(untilExclusive.getUTCDate() + 2); // buffer for tz skew

  const args = [
    "log",
    "--all",
    "--source",
    "--no-merges",
    "--numstat",
    `--since=${opts.sinceYMD}`,
    `--until=${untilExclusive.toISOString().slice(0, 10)}`,
    `--pretty=format:${RECORD_SEP}%H${FIELD_SEP}%aI${FIELD_SEP}%ae${FIELD_SEP}%an${FIELD_SEP}%S${FIELD_SEP}%B${FIELD_SEP}`,
  ];
  // git ORs repeated --author, which narrows the log cheaply; the exact
  // email/name check below is what actually guarantees "only my commits".
  const authorFilters = (opts.authorFilters ?? []).filter((a) => a.trim().length > 0);
  for (const author of authorFilters) args.push(`--author=${author}`);

  const raw = await git.raw(args);
  const results: ScannedCommit[] = [];
  const seen = new Set<string>(); // --all --source may repeat a commit per ref

  for (const record of raw.split(RECORD_SEP)) {
    if (!record.trim()) continue;
    const [hash, dateIso, email, name, source, message, numstatBlock] = record.split(FIELD_SEP);
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);

    let insertions = 0;
    let deletions = 0;
    const files: string[] = [];
    for (const line of (numstatBlock ?? "").split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      if (m[1] !== "-") insertions += parseInt(m[1], 10);
      if (m[2] !== "-") deletions += parseInt(m[2], 10);
      files.push(m[3]);
    }

    const authorEmail = email ?? "";
    const authorName = name ?? "";
    if (!isMyCommit({ authorEmail, authorName }, authorFilters)) continue;

    const branch = source?.replace(/^refs\/(remotes\/[^/]+|heads|tags)\//, "") || null;
    results.push({
      hash,
      authorDate: new Date(dateIso),
      authorEmail,
      authorName,
      message: (message ?? "").trim(),
      branch,
      ticketIds: extractTicketIds(`${message ?? ""} ${branch ?? ""}`),
      filesSummary: summariseFiles(files),
      insertions,
      deletions,
      filesChanged: files.length,
    });
  }
  return results;
}
