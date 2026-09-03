// One-off repair: ticket ids extracted before the pattern rejected CSS colours
// (#FFFFFF), acronyms (ISO-8601, SHA-256) and versions (V8-7). They are derived
// from the stored message and branch, so recomputing them is safe.
// Run: npx tsx scripts/fix-ticket-ids.ts
import { eq } from "drizzle-orm";
import { getDb, schema } from "../src/db/client";
import { extractTicketIds } from "../src/server/sources/git";

const db = getDb();
let repaired = 0;
const dropped = new Set<string>();

for (const commit of db.select().from(schema.commits).all()) {
  const fresh = extractTicketIds(`${commit.message} ${commit.branch ?? ""}`);
  const before = commit.ticketIds;
  if (fresh.length === before.length && fresh.every((id, i) => id === before[i])) continue;

  for (const id of before) if (!fresh.includes(id)) dropped.add(id);
  db.update(schema.commits)
    .set({ ticketIds: fresh })
    .where(eq(schema.commits.id, commit.id))
    .run();
  repaired += 1;
}

console.log(`ซ่อม ${repaired} commit`);
if (dropped.size > 0) console.log(`เอาออก: ${[...dropped].sort().join(", ")}`);
