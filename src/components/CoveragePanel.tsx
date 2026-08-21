"use client";

import type { CoverageReport } from "@/server/engine/coverage";
import { formatThaiDate } from "@/lib/format";

/** What the report may have missed. Silent when there is nothing to say. */
export function CoveragePanel({ coverage }: { coverage: CoverageReport }) {
  const issueCount =
    coverage.unreferencedCommits.length +
    coverage.closedTasksWithoutCard.length +
    coverage.offDaysWithEvidence.length;
  if (issueCount === 0) return null;

  return (
    <details className="rounded-xl border border-border bg-surface">
      <summary className="cursor-pointer px-3.5 py-2.5 text-[13px] font-medium">
        อาจตกหล่น <span className="font-mono text-muted">{issueCount}</span> จุด
      </summary>

      <div className="space-y-4 border-t border-border px-3.5 py-3 text-[13px]">
        {coverage.offDaysWithEvidence.length > 0 && (
          <section>
            <p className="font-medium">วันหยุดที่มี commit</p>
            <p className="mt-0.5 text-[12px] text-muted">
              ถ้าวันนั้นทำงานจริง กด <b>เป้า</b> ที่วันนั้นเพื่อเปิดเป็นวันทำงาน
            </p>
            <p className="mt-1 font-mono text-[12px]">
              {coverage.offDaysWithEvidence.map(formatThaiDate).join("  ")}
            </p>
          </section>
        )}

        {coverage.closedTasksWithoutCard.length > 0 && (
          <section>
            <p className="font-medium">
              task ที่ปิดแล้วแต่ไม่มีรายการอ้างถึง
              <span className="ml-1 font-mono text-muted">
                {coverage.closedTasksWithoutCard.length}
              </span>
            </p>
            <ul className="mt-1 space-y-0.5 text-[12px] text-muted">
              {coverage.closedTasksWithoutCard.slice(0, 10).map((t) => (
                <li key={t.taskId} className="flex gap-2">
                  <span className="shrink-0 font-mono text-foreground">
                    {t.customId ?? t.taskId}
                  </span>
                  <span className="truncate">{t.name}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {coverage.unreferencedCommits.length > 0 && (
          <section>
            <p className="font-medium">
              commit ที่ยังไม่มีรายการอ้างถึง
              <span className="ml-1 font-mono text-muted">
                {coverage.unreferencedCommits.length}
              </span>
            </p>
            <ul className="mt-1 space-y-0.5 text-[12px] text-muted">
              {coverage.unreferencedCommits.slice(0, 15).map((c) => (
                <li key={c.hash} className="flex gap-2">
                  <span className="shrink-0 font-mono">{c.date.slice(5)}</span>
                  <span className="shrink-0 font-mono opacity-70">{c.project}</span>
                  <span className="truncate">{c.message}</span>
                </li>
              ))}
              {coverage.unreferencedCommits.length > 15 && (
                <li className="opacity-70">
                  และอีก {coverage.unreferencedCommits.length - 15} รายการ
                </li>
              )}
            </ul>
          </section>
        )}
      </div>
    </details>
  );
}
