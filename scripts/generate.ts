// CLI generate (Node via tsx — never bun runtime; better-sqlite3 crashes there).
// Usage: npx tsx scripts/generate.ts --from 2026-08-01 --to 2026-08-20 [--hours 8] [--submit]

import { getDb, schema } from "../src/db/client";
import { executeRun } from "../src/server/pipeline";
import { validateRangeParams } from "../src/server/runs";
import { ClaudeCliProvider } from "../src/server/ai/cli";
import { selectSubmittableCards, submitCards } from "../src/server/submit";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const from = arg("from");
const to = arg("to");
const hours = arg("hours");
const shouldSubmit = process.argv.includes("--submit");

if (!from || !to) {
  console.error("ใช้: npx tsx scripts/generate.ts --from YYYY-MM-DD --to YYYY-MM-DD [--hours 8] [--submit]");
  process.exit(1);
}

const params = {
  fromYMD: from,
  toYMD: to,
  hoursPerDay: hours ? Number(hours) : null,
};
const invalid = validateRangeParams(params);
if (invalid) {
  console.error(invalid);
  process.exit(1);
}

const db = getDb();
const run = db
  .insert(schema.runs)
  .values({ fromDate: from, toDate: to, params, status: "pending", heartbeatAt: new Date() })
  .returning()
  .get();

console.log(`run #${run.id}: generate ${from} → ${to} …`);
const ticker = setInterval(() => {
  const current = db.select().from(schema.runs).all().find((r) => r.id === run.id);
  const p = current?.progress;
  if (p) process.stdout.write(`\r  ${p.completed}/${p.total} วัน (กำลังทำ: ${p.currentDates.join(", ") || "-"})   `);
}, 1000);

await executeRun(run.id, params, new ClaudeCliProvider());
clearInterval(ticker);

const finished = db.select().from(schema.runs).all().find((r) => r.id === run.id)!;
console.log(`\nสถานะ: ${finished.status}${finished.error ? ` — ${finished.error}` : ""}`);

const cards = db.select().from(schema.cards).all().filter((c) => c.tasksDate >= from && c.tasksDate <= to);
for (const date of [...new Set(cards.map((c) => c.tasksDate))].sort()) {
  const dayCards = cards.filter((c) => c.tasksDate === date);
  const total = dayCards.reduce((s, c) => s + c.durationSec, 0) / 3600;
  console.log(`  ${date}: ${dayCards.length} cards / ${total}h`);
  for (const c of dayCards) {
    console.log(`    - [${c.taskType}] ${(c.durationSec / 3600).toFixed(2)}h ${c.topic} (${c.origin}${c.status !== "draft" ? `, ${c.status}` : ""})`);
  }
}

if (shouldSubmit) {
  console.log("\nกำลัง submit …");
  const submittable = selectSubmittableCards(from, to);
  const result = await submitCards(submittable);
  if ("missing" in result) console.error(`ตั้งค่า ${result.missing} ก่อน`);
  else if (result.authExpired) console.error("JWT หมดอายุ");
  else console.log(`ส่งใหม่ ${result.submitted}, อัปเดต ${result.updated}, พลาด ${result.failed}`);
}
