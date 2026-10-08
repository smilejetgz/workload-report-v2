"use client";

import { useState } from "react";
import type { ChatAttachment } from "@/db/schema";
import type { CoverageReport } from "@/server/engine/coverage";
import { formatThaiDate } from "@/lib/format";
import { Button } from "./ui";

type Item = { key: string; date: string | null; attachment: ChatAttachment; ref: string; label: string };

function itemsOf(coverage: CoverageReport): { tasks: Item[]; commits: Item[] } {
  return {
    tasks: coverage.closedTasksWithoutCard.map((t) => ({
      key: `t:${t.taskId}`,
      date: t.closedDate,
      ref: t.customId ?? t.taskId,
      label: t.name,
      attachment: { kind: "task", taskId: t.taskId, customId: t.customId, name: t.name, date: t.closedDate },
    })),
    commits: coverage.unreferencedCommits.map((c) => ({
      key: `c:${c.hash}`,
      date: c.date,
      ref: c.project,
      label: c.message,
      attachment: { kind: "commit", hash: c.hash, date: c.date, project: c.project, message: c.message },
    })),
  };
}

/** Group items by date, oldest first; undated items last. */
function byDate(items: Item[]): [string, Item[]][] {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = item.date ?? "";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].sort(([a], [b]) => (a || "9999").localeCompare(b || "9999"));
}

/**
 * What the report may have missed. Silent when there is nothing to say.
 * Items can be picked and handed to the AI chat to work into the report.
 */
export function CoveragePanel({
  coverage,
  onFillWithAi,
}: {
  coverage: CoverageReport;
  onFillWithAi: (picked: { attachments: ChatAttachment[]; dates: (string | null)[] }) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { tasks, commits } = itemsOf(coverage);
  const all = [...tasks, ...commits];
  const issueCount = all.length + coverage.offDaysWithEvidence.length;
  if (issueCount === 0) return null;

  // Items that disappeared (now cited by a card) drop out of the selection.
  const selected = all.filter((item) => picked.has(item.key));
  const toggle = (keys: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });

  const section = (title: string, items: Item[], mono: boolean) =>
    items.length > 0 && (
      <section>
        <div className="flex items-center gap-2">
          <p className="font-medium">
            {title}
            <span className="ml-1 font-mono text-muted">{items.length}</span>
          </p>
          <button
            type="button"
            className="cursor-pointer text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-foreground"
            onClick={() => {
              const keys = items.map((i) => i.key);
              toggle(keys, !keys.every((k) => picked.has(k)));
            }}
          >
            {items.every((i) => picked.has(i.key)) ? "ไม่เลือกทั้งหมด" : "เลือกทั้งหมด"}
          </button>
        </div>
        <div className="mt-1 space-y-1.5">
          {byDate(items).map(([date, group]) => (
            <div key={date || "none"}>
              <p className="font-mono text-[11px] text-muted">
                {date ? formatThaiDate(date) : "ไม่ทราบวัน"}
              </p>
              <ul className="space-y-0.5 text-[12px] text-muted">
                {group.map((item) => (
                  <li key={item.key}>
                    <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 hover:bg-surface-2">
                      <input
                        type="checkbox"
                        checked={picked.has(item.key)}
                        onChange={(e) => toggle([item.key], e.target.checked)}
                        className="mt-0.5 accent-(--accent)"
                      />
                      <span
                        className={`shrink-0 font-mono ${mono ? "text-foreground" : "opacity-70"}`}
                      >
                        {item.ref}
                      </span>
                      <span className="min-w-0 break-words">{item.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    );

  return (
    <details className="rounded-xl border border-border bg-surface">
      <summary className="cursor-pointer px-3.5 py-2.5 text-[13px] font-medium">
        อาจตกหล่น <span className="font-mono text-muted">{issueCount}</span> จุด
      </summary>

      <div className="space-y-4 border-t border-border px-3.5 py-3 text-[13px]">
        {all.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted">
              เลือกรายการที่ควรอยู่ในรายงาน แล้วให้ AI เติมให้ · เลือกแล้ว {selected.length}
            </span>
            <Button
              size="sm"
              variant="primary"
              className="ml-auto"
              disabled={selected.length === 0}
              onClick={() =>
                onFillWithAi({
                  attachments: selected.map((s) => s.attachment),
                  dates: selected.map((s) => s.date),
                })
              }
            >
              ให้ AI เติมเข้ารายงาน
            </Button>
          </div>
        )}
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

        {section("task ที่ปิดแล้วแต่ไม่มีรายการอ้างถึง", tasks, true)}
        {section("commit ที่ยังไม่มีรายการอ้างถึง", commits, false)}

      </div>
    </details>
  );
}
