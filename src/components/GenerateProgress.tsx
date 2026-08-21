"use client";

import { useEffect, useRef, useState } from "react";
import type { Run } from "@/db/schema";
import { formatThaiDate } from "@/lib/format";
import { Button, Spinner } from "./ui";

const DAY_STATUS: Record<string, { label: string; className: string; mark: string }> = {
  pending: { label: "รอคิว", className: "text-muted", mark: "○" },
  running: { label: "กำลังเขียน", className: "text-accent font-medium", mark: "◍" },
  done: { label: "เสร็จ", className: "text-ok", mark: "●" },
  skipped: { label: "มีอยู่แล้ว", className: "text-muted", mark: "–" },
  empty: { label: "ไม่มีหลักฐาน", className: "text-warn", mark: "○" },
  failed: { label: "ไม่สำเร็จ", className: "text-danger", mark: "✕" },
};

/**
 * A live window on the run: which day the model is writing right now, which are
 * already in, and which came back empty. It floats rather than blocks, because
 * cards land day by day and watching them arrive is the point.
 */
const LEVEL_STYLE: Record<string, string> = {
  info: "text-muted",
  warn: "text-warn",
  error: "text-danger",
};

export function GenerateProgress({
  run,
  isRunning,
  onCancel,
}: {
  /** null while the run is being created — there is nothing to read yet. */
  run: Run | null;
  isRunning: boolean;
  onCancel: () => void;
}) {
  const [isOpen, setIsOpen] = useState(true);
  const [tab, setTab] = useState<"log" | "days">("log");
  const logEnd = useRef<HTMLDivElement>(null);
  const progress = run?.progress ?? null;
  const lines = progress?.log ?? [];

  // Follow the newest line the way a terminal does.
  useEffect(() => {
    if (isOpen && tab === "log") logEnd.current?.scrollIntoView({ block: "nearest" });
  }, [lines.length, isOpen, tab]);

  const isSyncing = !progress || progress.phase === "sync";
  const days = Object.entries(progress?.dayStatus ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const pct = progress?.total ? (progress.completed / progress.total) * 100 : 0;

  return (
    <aside
      className="fixed bottom-16 right-4 z-30 w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
      aria-live="polite"
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        {isRunning ? (
          <Spinner className="text-accent" />
        ) : (
          <span
            className={`size-2 rounded-full ${run?.status === "failed" ? "bg-danger" : "bg-ok"}`}
          />
        )}
        <span className="text-[13px] font-medium">
          {!isRunning
            ? run?.status === "failed"
              ? "รอบที่แล้วไม่สำเร็จ"
              : "รอบที่แล้วเสร็จแล้ว"
            : isSyncing
              ? "กำลังอ่านหลักฐาน"
              : "AI กำลังเขียนรายงาน"}
        </span>
        {progress && progress.total > 0 && (
          <span className="font-mono text-[12px] tabular-nums text-muted">
            {progress.completed}/{progress.total}
          </span>
        )}
        <button
          type="button"
          className="ml-auto cursor-pointer px-1 text-[12px] text-muted hover:text-foreground"
          onClick={() => setIsOpen((v) => !v)}
          aria-expanded={isOpen}
        >
          {isOpen ? "ย่อ" : "ขยาย"}
        </button>
      </header>

      <div className="h-0.5 w-full bg-surface-2">
        <div
          className="h-full bg-accent transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>

      {isOpen && (
        <>
          <div className="flex gap-1 border-b border-border px-2 py-1.5 text-[12px]">
            {(["log", "days"] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`cursor-pointer rounded px-2 py-0.5 ${
                  tab === t ? "bg-surface-2 font-medium" : "text-muted hover:text-foreground"
                }`}
                onClick={() => setTab(t)}
              >
                {t === "log" ? `ทุกขั้นตอน (${lines.length})` : `รายวัน (${days.length})`}
              </button>
            ))}
          </div>

          {tab === "log" ? (
            <div className="max-h-64 overflow-y-auto px-2.5 py-2 text-[12px] leading-relaxed">
              {lines.length === 0 && (
                <p className="text-muted">{isRunning ? "กำลังเริ่ม" : "ยังไม่มีบันทึก"}</p>
              )}
              {lines.map((line, i) => (
                <p key={i} className={`flex gap-1.5 ${LEVEL_STYLE[line.level] ?? ""}`}>
                  <span className="shrink-0 font-mono opacity-50">
                    {line.at.slice(11, 19)}
                  </span>
                  <span className="min-w-0 break-words">{line.text}</span>
                </p>
              ))}
              <div ref={logEnd} />
            </div>
          ) : (
            <ul className="max-h-64 overflow-y-auto px-1.5 py-1.5 text-[12px]">
              {days.map(([date, status]) => {
                const meta = DAY_STATUS[status] ?? DAY_STATUS.pending;
                return (
                  <li
                    key={date}
                    className={`flex items-center gap-2 rounded px-1.5 py-1 ${
                      status === "running" ? "bg-accent-soft" : ""
                    }`}
                  >
                    <span className={`w-3 text-center ${meta.className}`} aria-hidden>
                      {meta.mark}
                    </span>
                    <span className="font-mono">{formatThaiDate(date)}</span>
                    <span className={`ml-auto ${meta.className}`}>{meta.label}</span>
                  </li>
                );
              })}
            </ul>
          )}

          <footer className="flex items-center gap-2 border-t border-border px-3 py-2">
            <p className="text-[11px] text-muted">
              {isRunning ? "การ์ดจะขึ้นทีละวันที่เขียนเสร็จ" : "ดูย้อนหลังได้จนกว่าจะสร้างรอบใหม่"}
            </p>
            {isRunning && (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={onCancel}>
                ยกเลิก
              </Button>
            )}
          </footer>
        </>
      )}
    </aside>
  );
}
