"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Card, TaskType } from "@/db/schema";
import type { ResolvedDayTarget } from "@/server/day-targets";
import { api } from "@/lib/api";
import { formatHours, formatThaiDate, KIND_LABELS, uploadBadge } from "@/lib/format";
import { Button, Input, Meter, Select, Spinner, type MeterSegment } from "./ui";
import { CardItem } from "./CardItem";

export function DaySection({
  day,
  cards,
  taskTypes,
  /** A run is in flight right now (any day of it). */
  runActive,
  /** This day's place in that run. "empty" = no evidence, left blank on purpose. */
  runStatus,
  onRegenerate,
}: {
  day: ResolvedDayTarget;
  cards: Card[];
  taskTypes: TaskType[];
  runActive: boolean;
  runStatus?: string;
  onRegenerate: (date: string) => void;
}) {
  const queryClient = useQueryClient();
  const [isEditingTarget, setIsEditingTarget] = useState(false);
  const [targetDraft, setTargetDraft] = useState({
    hours: formatHours(day.targetSec),
    kind: day.kind,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["cards"] });
  const saveTarget = useMutation({
    mutationFn: () =>
      api.setDayTarget({
        date: day.date,
        targetHours: Number(targetDraft.hours) || 0,
        kind: targetDraft.kind,
      }),
    onSuccess: () => {
      setIsEditingTarget(false);
      invalidate();
    },
  });
  const clearTarget = useMutation({
    mutationFn: () => api.clearDayTarget(day.date),
    onSuccess: () => {
      setIsEditingTarget(false);
      invalidate();
    },
  });

  // A queued day looked identical to an idle one, so the page seemed stuck on
  // everything the run had not reached yet.
  const isWriting = runActive && runStatus === "running";
  const isQueued = runActive && runStatus === "pending";
  const plannedSec = cards.reduce((sum, c) => sum + c.durationSec, 0);
  const segments: MeterSegment[] = cards.map((c) => ({
    sec: c.durationSec,
    tone: uploadBadge(c).state,
  }));
  const isOff = day.targetSec === 0;
  const shortSec = Math.max(0, day.targetSec - plannedSec);

  const targetEditor = isEditingTarget && (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 p-2">
      <Input
        type="number"
        step="0.5"
        min="0"
        max="24"
        value={targetDraft.hours}
        onChange={(e) => setTargetDraft({ ...targetDraft, hours: e.target.value })}
        className="w-16 text-right font-mono"
        aria-label="ชั่วโมงเป้าของวัน"
      />
      <Select
        value={targetDraft.kind}
        onChange={(e) =>
          setTargetDraft({ ...targetDraft, kind: e.target.value as typeof day.kind })
        }
        aria-label="ประเภทวัน"
      >
        {Object.entries(KIND_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      <Button size="sm" variant="primary" onClick={() => saveTarget.mutate()}>
        บันทึก
      </Button>
      {day.isOverride && (
        <Button size="sm" variant="ghost" onClick={() => clearTarget.mutate()}>
          ใช้ค่าเริ่มต้น
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => setIsEditingTarget(false)}>
        ปิด
      </Button>
    </div>
  );

  // Days off collapse to a single line so the workdays own the page.
  if (isOff && cards.length === 0) {
    return (
      <div className="group flex items-center gap-3 border-b border-border/60 px-2 py-1.5 text-[12px] text-muted">
        <span className="w-24 shrink-0 font-mono">{formatThaiDate(day.date)}</span>
        <span>{day.note ?? KIND_LABELS[day.kind]}</span>
        <button
          type="button"
          className="ml-auto cursor-pointer opacity-0 hover:underline focus-visible:opacity-100 group-hover:opacity-100"
          onClick={() => setIsEditingTarget((v) => !v)}
        >
          แก้เป้า
        </button>
        {targetEditor}
      </div>
    );
  }

  return (
    <section className="border-b border-border/60 py-3 last:border-b-0">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2">
        <h3 className="display w-24 shrink-0 text-[14px] font-semibold">
          {formatThaiDate(day.date)}
        </h3>

        <div className="order-3 w-full sm:order-none sm:w-auto sm:flex-1">
          <Meter segments={segments} targetSec={day.targetSec} height={6} />
        </div>

        <span className="font-mono text-[12px] tabular-nums text-muted">
          <span className={shortSec > 0 ? "text-warn" : "text-foreground"}>
            {formatHours(plannedSec)}
          </span>
          <span className="opacity-50">/{formatHours(day.targetSec)} ชม.</span>
        </span>

        {day.kind !== "workday" && (
          <span className="text-[11px] text-muted">{day.note ?? KIND_LABELS[day.kind]}</span>
        )}
        {isWriting && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-accent">
            <Spinner /> กำลังเขียน
          </span>
        )}
        {isQueued && <span className="text-[12px] text-muted">รอคิว</span>}

        <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 sm:opacity-60 sm:hover:opacity-100">
          <Button size="sm" variant="ghost" onClick={() => setIsEditingTarget((v) => !v)}>
            เป้า
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={runActive || cards.some((c) => c.status === "submitted")}
            onClick={() => onRegenerate(day.date)}
            title="ลบฉบับร่างของวันนี้แล้วสร้างใหม่"
          >
            สร้างใหม่
          </Button>
        </div>
      </header>

      {targetEditor}

      <div className="mt-1">
        {cards.map((card) => (
          <CardItem key={card.id} card={card} taskTypes={taskTypes} />
        ))}

        {isWriting && cards.length === 0 && (
          <div className="mx-2 my-1 space-y-1.5" aria-hidden>
            <div className="h-3 w-2/5 animate-pulse rounded bg-surface-2" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-surface-2" />
          </div>
        )}
        {cards.length === 0 && !runActive && runStatus === "empty" && (
          <div className="mx-2 rounded-md border border-dashed border-border px-3 py-2.5 text-[12px] text-muted">
            <p className="font-medium text-foreground">ไม่มีหลักฐานของวันนี้</p>
            <p className="mt-0.5">
              ไม่มี commit ไม่มี task ที่ปิด และไม่มี comment ที่คุณเขียน จึงเว้นว่างไว้
              ไม่เติมชั่วโมงให้
            </p>
            <p className="mt-1">
              ลาหรือประชุมทั้งวัน → กด <b>เป้า</b> แล้วตั้งเป็นวันลา · ทำงานจริงแต่ยังไม่ push →
              เพิ่มรายการเอง · เพิ่ง push แล้ว → กด <b>สร้างใหม่</b>
            </p>
          </div>
        )}
        {cards.length === 0 && !isWriting && runStatus !== "empty" && (
          <p className="px-2 py-1 text-[12px] text-muted">
            {isQueued ? "รอคิว" : "ยังไม่มีรายการ"}
          </p>
        )}
      </div>
    </section>
  );
}
