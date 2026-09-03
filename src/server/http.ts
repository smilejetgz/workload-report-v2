import { NextResponse } from "next/server";
import type { z } from "zod";

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ success: true, data, error: null }, { status });
}

export function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ success: false, data: null, error: message }, { status });
}

export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<{ data: z.infer<T> } | { error: NextResponse }> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return { error: fail("body ต้องเป็น JSON") };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return { error: fail(`ข้อมูลไม่ถูกต้อง: ${result.error.issues[0]?.message ?? "invalid"}`) };
  }
  return { data: result.data };
}

export function handle(fn: () => Promise<NextResponse> | NextResponse): Promise<NextResponse> {
  return Promise.resolve()
    .then(fn)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return fail(message, 500);
    });
}
