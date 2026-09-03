import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { fail, handle, ok, parseBody } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  authorEmailFilter: z.string().nullable().optional(),
  defaultTaskType: z.string().nullable().optional(),
  defaultWebsite: z.string().nullable().optional(),
});

export function PATCH(request: Request, ctx: Ctx) {
  return handle(async () => {
    const { id } = await ctx.params;
    const parsed = await parseBody(request, patchSchema);
    if ("error" in parsed) return parsed.error;
    const project = getDb()
      .update(schema.projects)
      .set(parsed.data)
      .where(eq(schema.projects.id, Number(id)))
      .returning()
      .get();
    if (!project) return fail("ไม่พบ project", 404);
    return ok({ project });
  });
}

export function DELETE(_request: Request, ctx: Ctx) {
  return handle(async () => {
    const { id } = await ctx.params;
    getDb().delete(schema.projects).where(eq(schema.projects.id, Number(id))).run();
    return ok({ deleted: Number(id) });
  });
}
