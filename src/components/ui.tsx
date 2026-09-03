"use client";

import { clsx } from "clsx";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "outline";
  size?: "sm" | "md" | "lg";
};

export function Button({ variant = "outline", size = "md", className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={clsx(
        "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium",
        "transition-[background-color,border-color,color,box-shadow] duration-150",
        "disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" && "h-7 px-2.5 text-xs",
        size === "md" && "h-8 px-3 text-[13px]",
        size === "lg" && "display h-10 px-5 text-[15px] font-semibold",
        variant === "primary" && "bg-accent text-white hover:brightness-110",
        variant === "outline" && "border border-border bg-surface hover:border-muted/50",
        variant === "ghost" && "text-muted hover:bg-surface-2 hover:text-foreground",
        variant === "danger" && "text-danger hover:bg-danger/10",
        className,
      )}
      {...rest}
    />
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={clsx(
        "h-8 rounded-md border border-border bg-surface px-2.5 text-[13px]",
        "focus:border-accent focus:outline-none",
        className,
      )}
      {...rest}
    />
  );
}

export function Select({
  className,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={clsx(
        "h-8 cursor-pointer rounded-md border border-border bg-surface px-2 text-[13px]",
        "focus:border-accent focus:outline-none",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Chip({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center rounded px-1.5 py-px text-[11px] leading-[17px]",
        className ?? "bg-surface-2 text-muted",
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        "inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
      aria-label="กำลังโหลด"
    />
  );
}

/** Small caps engraved caption above a control or panel. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx("label-eng block", className)}>{children}</span>;
}

// ── Meter ────────────────────────────────────────────────────────────────
// The one visual idea of the interface, used at two sizes: a track ruled at
// every hour, filled segment by segment. Reading it answers both questions the
// report has to answer — does the day add up, and what is already uploaded.

export type MeterTone = "uploaded" | "pending" | "failed";

export type MeterSegment = { sec: number; tone: MeterTone };

const SEGMENT_COLOR: Record<MeterTone, string> = {
  uploaded: "bg-ok",
  pending: "bg-accent",
  failed: "bg-danger",
};

export function Meter({
  segments,
  targetSec,
  height = 8,
  className,
}: {
  segments: MeterSegment[];
  targetSec: number;
  height?: number;
  className?: string;
}) {
  const plannedSec = segments.reduce((sum, s) => sum + s.sec, 0);
  // An over-filled day is measured against itself so nothing is clipped away
  // silently; the overflow shows as a warn-toned tail.
  const scaleSec = Math.max(targetSec, plannedSec, 1);
  const hours = Math.max(1, Math.round(scaleSec / 3600));
  // A month-long range would draw a hatch if every hour got a tick, so past a
  // day's worth the ruler switches to one mark per working day.
  const tickHours = hours <= 12 ? 1 : 8;
  const pct = (sec: number) => `${(sec / scaleSec) * 100}%`;
  const isOver = plannedSec > targetSec && targetSec > 0;

  return (
    <div
      className={clsx("meter", className)}
      style={{ height, ["--tick-step" as string]: `${(tickHours / hours) * 100}%` }}
      role="img"
      aria-label={`ลงแล้ว ${plannedSec / 3600} จาก ${targetSec / 3600} ชั่วโมง`}
    >
      <div className="meter-ticks" aria-hidden />
      <div className="meter-fill">
        {segments.map((segment, i) => (
          <div
            key={i}
            className={clsx("meter-seg", SEGMENT_COLOR[segment.tone])}
            style={{ width: pct(segment.sec) }}
          />
        ))}
      </div>
      {/* Past the target the gauge gets a red-line rather than a longer bar —
          the excess stays visible instead of being scaled away. */}
      {isOver && (
        <span
          className="absolute inset-y-0 w-0.5 bg-warn"
          style={{ left: pct(targetSec) }}
          aria-hidden
        />
      )}
    </div>
  );
}
