import { spawnSync } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { fail, handle, ok, parseBody } from "@/server/http";
import { isGitRepo } from "@/server/sources/git";

export function GET() {
  return handle(() => {
    const projects = getDb().select().from(schema.projects).all();
    return ok({ projects });
  });
}

const postSchema = z.object({
  path: z.string().min(1),
  name: z.string().optional(),
  authorEmailFilter: z.string().nullish(),
  defaultTaskType: z.string().nullish(),
  defaultWebsite: z.string().nullish(),
});

/** Repo-level git user.email (falls back to global) — used to scan only own commits. */
function repoAuthorEmail(repoPath: string): string | null {
  const result = spawnSync("git", ["-C", repoPath, "config", "user.email"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const email = result.status === 0 ? result.stdout.trim() : "";
  return email || null;
}

export function POST(request: Request) {
  return handle(async () => {
    const parsed = await parseBody(request, postSchema);
    if ("error" in parsed) return parsed.error;
    const input = parsed.data;
    const abs = path.resolve(input.path);
    if (!isGitRepo(abs)) return fail(`ไม่ใช่ git repo: ${abs}`);
    const project = getDb()
      .insert(schema.projects)
      .values({
        path: abs,
        name: input.name?.trim() || path.basename(abs),
        authorEmailFilter: input.authorEmailFilter ?? repoAuthorEmail(abs),
        defaultTaskType: input.defaultTaskType ?? null,
        defaultWebsite: input.defaultWebsite ?? null,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (!project) return fail("มี project นี้อยู่แล้ว");
    return ok({ project }, 201);
  });
}
