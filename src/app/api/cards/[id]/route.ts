import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { sanitizeNoteHtml } from "@/server/engine/validator";
import { fail, handle, ok, parseBody } from "@/server/http";
import { deleteCardRemote, pushCardUpdate } from "@/server/remote-sync";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  topic: z.string().min(1).optional(),
  noteHtml: z.string().optional(),
  taskType: z.string().optional(),
  website: z.string().nullable().optional(),
  clickupTask: z.string().nullable().optional(),
  durationHours: z.number().min(0.25).max(12).optional(),
  status: z.enum(["draft", "approved"]).optional(),
});

export function PATCH(request: Request, ctx: Ctx) {
  return handle(async () => {
    const { id } = await ctx.params;
    const parsed = await parseBody(request, patchSchema);
    if ("error" in parsed) return parsed.error;

    const db = getDb();
    const existing = db.select().from(schema.cards).where(eq(schema.cards.id, Number(id))).get();
    if (!existing) return fail("ไม่พบ card", 404);
    if (existing.status === "submitted" && parsed.data.status) {
      return fail("card ที่ submit แล้วแก้ status ไม่ได้ (แก้เนื้อหาแล้ว submit ซ้ำได้)");
    }

    // Snapshot before edit — undo support.
    db.insert(schema.cardVersions)
      .values({
        cardId: existing.id,
        snapshot: existing as unknown as Record<string, unknown>,
        reason: "edit",
      })
      .run();

    const patch = parsed.data;
    const card = db
      .update(schema.cards)
      .set({
        ...(patch.topic !== undefined ? { topic: patch.topic } : {}),
        ...(patch.noteHtml !== undefined ? { noteHtml: sanitizeNoteHtml(patch.noteHtml) } : {}),
        ...(patch.taskType !== undefined ? { taskType: patch.taskType } : {}),
        ...(patch.website !== undefined ? { website: patch.website } : {}),
        ...(patch.clickupTask !== undefined ? { clickupTask: patch.clickupTask } : {}),
        ...(patch.durationHours !== undefined
          ? { durationSec: Math.round(patch.durationHours * 3600) }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        origin: "manual" as const,
        updatedAt: new Date(),
      })
      .where(eq(schema.cards.id, existing.id))
      .returning()
      .get();

    // Already on workload → the edit has to land there too, or the list lies.
    if (card.remoteTaskId) {
      const pushed = await pushCardUpdate(card);
      if (!pushed.ok) {
        // Keep the local edit but mark it unsynced, so the list never claims
        // workload has something it does not.
        db.update(schema.cards)
          .set({ status: "failed", error: `sync ไป workload ไม่สำเร็จ: ${pushed.error}` })
          .where(eq(schema.cards.id, card.id))
          .run();
        return fail(
          `แก้ในแอปแล้ว แต่ sync ไป workload ไม่สำเร็จ: ${pushed.error}` +
            (pushed.authExpired ? " — วาง JWT ใหม่แล้วกดแก้อีกครั้ง" : ""),
          pushed.authExpired ? 401 : 502,
        );
      }
      const synced = db
        .update(schema.cards)
        .set({ status: "submitted", error: null, updatedAt: new Date() })
        .where(eq(schema.cards.id, card.id))
        .returning()
        .get();
      return ok({ card: synced, remoteUpdated: true });
    }
    return ok({ card });
  });
}

export function DELETE(request: Request, ctx: Ctx) {
  return handle(async () => {
    const { id } = await ctx.params;
    const db = getDb();
    const existing = db.select().from(schema.cards).where(eq(schema.cards.id, Number(id))).get();
    if (!existing) return fail("ไม่พบ card", 404);

    // Submitted cards are deleted on workload FIRST — deleting only locally
    // would leave an invisible row behind on the real report.
    let remoteDeleted = false;
    if (existing.remoteTaskId) {
      const removed = await deleteCardRemote(existing);
      if (!removed.ok) {
        const localOnly = new URL(request.url).searchParams.get("localOnly") === "1";
        if (!localOnly) {
          return fail(
            `ลบใน workload ไม่สำเร็จ: ${removed.error} — ยังไม่ลบในแอปเพื่อกันข้อมูลหลุด` +
              (removed.authExpired ? " (วาง JWT ใหม่)" : ""),
            removed.authExpired ? 401 : 502,
          );
        }
      } else {
        remoteDeleted = true;
      }
    }
    db.delete(schema.cards).where(eq(schema.cards.id, existing.id)).run();
    return ok({ deleted: existing.id, remoteDeleted });
  });
}
