// One-shot import from workload-report v1 (../workload-report/data.db):
// projects + submitted cards → style corpus. (The v1 JWT is not copied: the
// app now writes to workload v2, which issues its own token.)
// Run: npx tsx scripts/import-v1.ts [path-to-v1-data.db]

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getDb, schema } from "../src/db/client";
import { eq } from "drizzle-orm";
import { sanitizeNoteHtml } from "@/lib/sanitize";

const v1DbPath = process.argv[2] ?? path.resolve(process.cwd(), "../workload-report/data.db");
if (!fs.existsSync(v1DbPath)) {
  console.error(`ไม่พบ v1 db ที่ ${v1DbPath}`);
  process.exit(1);
}

const v1 = new Database(v1DbPath, { readonly: true });
const db = getDb();

// --- projects ---------------------------------------------------------------
const v1Projects = v1
  .prepare(
    "select path, name, default_task_type, default_website, author_email_filter, enabled from projects",
  )
  .all() as {
  path: string;
  name: string;
  default_task_type: string | null;
  default_website: string | null;
  author_email_filter: string | null;
  enabled: number;
}[];
let projectsCopied = 0;
for (const p of v1Projects) {
  db.insert(schema.projects)
    .values({
      path: p.path,
      name: p.name,
      defaultTaskType: p.default_task_type,
      defaultWebsite: p.default_website,
      authorEmailFilter: p.author_email_filter,
      enabled: Boolean(p.enabled),
    })
    .onConflictDoNothing()
    .run();
  projectsCopied++;
}

// --- style corpus from submitted cards --------------------------------------
const v1Cards = v1
  .prepare(
    "select tasks_date, duration_sec, note, task_type from cards where status = 'submitted' and length(note) > 20 order by tasks_date desc limit 50",
  )
  .all() as { tasks_date: string; duration_sec: number; note: string; task_type: string }[];

db.delete(schema.styleExamples).where(eq(schema.styleExamples.source, "v1")).run();
for (const c of v1Cards) {
  db.insert(schema.styleExamples)
    .values({
      tasksDate: c.tasks_date,
      taskType: c.task_type,
      durationSec: c.duration_sec,
      // v1 notes are pre-sanitiser data and end up in AI prompts and the UI.
      noteHtml: sanitizeNoteHtml(c.note),
      source: "v1",
    })
    .run();
}

console.log(
  `import เสร็จ: projects ${projectsCopied}, style examples ${v1Cards.length}`,
);
