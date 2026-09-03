// One-off repair: card topics stored before stripHtml decoded HTML entities.
// Topic is derived data (the note's opening line), so recomputing it is safe.
// Run: npx tsx scripts/fix-topics.ts
import { eq } from "drizzle-orm";
import { getDb, schema } from "../src/db/client";
import { stripHtml } from "../src/server/engine/evidence";

const db = getDb();
const broken = db
  .select()
  .from(schema.cards)
  .all()
  .filter((card) => card.topic.includes("&#"));

for (const card of broken) {
  const topic = stripHtml(card.noteHtml).slice(0, 80) || card.topic;
  db.update(schema.cards).set({ topic }).where(eq(schema.cards.id, card.id)).run();
  console.log(`${card.id} → ${topic.slice(0, 56)}`);
}
console.log(`ซ่อมแล้ว ${broken.length} รายการ`);
