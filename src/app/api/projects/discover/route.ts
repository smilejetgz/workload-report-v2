import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, schema } from "@/db/client";
import { fail, handle, ok } from "@/server/http";
import { isGitRepo } from "@/server/sources/git";

export type DiscoveredRepo = {
  name: string;
  path: string;
  alreadyAdded: boolean;
  lastActivityAt: string | null;
};

function defaultRoot(existingPaths: string[]): string {
  // Most common parent dir of projects already added, else ~/code, else home.
  const counts = new Map<string, number>();
  for (const p of existingPaths) {
    const parent = path.dirname(p);
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best && fs.existsSync(best)) return best;
  const codeDir = path.join(os.homedir(), "code");
  return fs.existsSync(codeDir) ? codeDir : os.homedir();
}

function lastActivity(repoPath: string): string | null {
  try {
    return fs.statSync(path.join(repoPath, ".git", "HEAD")).mtime.toISOString();
  } catch {
    return null;
  }
}

export function GET(request: Request) {
  return handle(() => {
    const existing = getDb().select().from(schema.projects).all();
    const existingPaths = new Set(existing.map((p) => p.path));

    const url = new URL(request.url);
    const rootParam = url.searchParams.get("root");
    const root = path.resolve(rootParam?.trim() || defaultRoot([...existingPaths]));
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return fail(`ไม่พบโฟลเดอร์ ${root}`);
    }

    const repos: DiscoveredRepo[] = [];
    if (isGitRepo(root)) {
      repos.push({
        name: path.basename(root),
        path: root,
        alreadyAdded: existingPaths.has(root),
        lastActivityAt: lastActivity(root),
      });
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const repoPath = path.join(root, entry.name);
      if (!isGitRepo(repoPath)) continue;
      repos.push({
        name: entry.name,
        path: repoPath,
        alreadyAdded: existingPaths.has(repoPath),
        lastActivityAt: lastActivity(repoPath),
      });
    }

    repos.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
    return ok({ root, repos });
  });
}
