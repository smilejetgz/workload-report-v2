import { handle, ok } from "@/server/http";
import { getLatestRun } from "@/server/runs";

export function GET() {
  return handle(() => ok({ run: getLatestRun() }));
}
