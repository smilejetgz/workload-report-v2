"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  countUploadStates,
  formatHours,
  uploadBadge,
  formatThaiDate,
  prevMonthRange,
  startOfMonthYMD,
  startOfWeekYMD,
  todayYMD,
} from "@/lib/format";
import { ThemeToggle } from "./ThemeToggle";
import { Button, Input, Label, Meter, Spinner, type MeterSegment } from "./ui";
import { DaySection } from "./DaySection";
import { CoveragePanel } from "./CoveragePanel";
import { CalendarPanel } from "./CalendarPanel";
import { GenerateProgress } from "./GenerateProgress";

type Preset = { label: string; range: () => { from: string; to: string } };

/**
 * Run errors are one joined string of per-day failures. Collapse repeated
 * causes so the banner shows "3 วันพลาด: <reason>" instead of a wall of text.
 */
function summarizeRunError(error: string | null, failedDates: string[]): string {
  if (!error) return "generate ล้มเหลว";
  const causes = [
    ...new Set(
      error
        .split(" | ")
        .map((part) => part.replace(/^\d{4}-\d{2}-\d{2}:\s*/, "").trim())
        .filter(Boolean),
    ),
  ];
  const head = failedDates.length > 0 ? `${failedDates.length} วันยังไม่สำเร็จ — ` : "";
  return `${head}${causes.slice(0, 2).join(" · ").slice(0, 300)}`;
}

const PRESETS: Preset[] = [
  { label: "วันนี้", range: () => ({ from: todayYMD(), to: todayYMD() }) },
  { label: "สัปดาห์นี้", range: () => ({ from: startOfWeekYMD(), to: todayYMD() }) },
  { label: "เดือนนี้", range: () => ({ from: startOfMonthYMD(), to: todayYMD() }) },
  { label: "เดือนก่อน", range: prevMonthRange },
];

export function HomePage() {
  const queryClient = useQueryClient();
  const [range, setRange] = useState(() => PRESETS[2].range()); // เดือนนี้
  const [hours, setHours] = useState("");
  const [manualRunId, setManualRunId] = useState<number | null>(null);
  const [dismissedRunId, setDismissedRunId] = useState<number | null>(null);
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [showLastRunLog, setShowLastRunLog] = useState(false);
  // How many rows workload really had at the last sync — shown next to ours.
  const [lastRemoteCount, setLastRemoteCount] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const taskTypesQuery = useQuery({ queryKey: ["taskTypes"], queryFn: api.taskTypes });
  const cardsQuery = useQuery({
    queryKey: ["cards", range.from, range.to],
    queryFn: () => api.cards(range.from, range.to),
  });

  // Polled rather than fetched once: a run can start in another tab or from the
  // CLI, and the window has to notice. Without this the panel showed up only
  // when the run happened to begin in this tab.
  const latestRunQuery = useQuery({
    queryKey: ["latestRun"],
    queryFn: api.latestRun,
    refetchInterval: 2000,
    // A generate takes minutes and people switch windows while it works.
    // Without this the poll pauses whenever the tab loses focus, which is what
    // made the progress window look like it updated only sometimes.
    refetchIntervalInBackground: true,
  });
  const latestRun = latestRunQuery.data?.run ?? null;
  const latestIsActive =
    latestRun !== null && (latestRun.status === "running" || latestRun.status === "pending");
  // A live run always wins; otherwise keep showing the most recent one so its
  // log stays readable after it finishes.
  const activeRunId = latestIsActive ? latestRun.id : (manualRunId ?? latestRun?.id ?? null);

  const runQuery = useQuery({
    queryKey: ["run", activeRunId],
    queryFn: () => api.run(activeRunId!),
    enabled: activeRunId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status === "running" || status === "pending" ? 1000 : false;
    },
    refetchIntervalInBackground: true,
  });
  const run = runQuery.data?.run ?? null;
  const isGenerating = run?.status === "running" || run?.status === "pending";

  // While generating, keep the timeline fresh so cards appear day by day.
  useEffect(() => {
    if (!isGenerating) return;
    const t = setInterval(
      () => queryClient.invalidateQueries({ queryKey: ["cards"] }),
      2000,
    );
    return () => clearInterval(t);
  }, [isGenerating, queryClient]);
  const refreshedForRun = useRef<number | null>(null);
  useEffect(() => {
    if (run && !isGenerating && refreshedForRun.current !== run.id) {
      refreshedForRun.current = run.id;
      queryClient.invalidateQueries({ queryKey: ["cards"] });
    }
  }, [run, isGenerating, queryClient]);

  // Run outcome is shown as derived state (dismissable), never set in an effect.
  const failedDates =
    run && !isGenerating
      ? Object.entries(run.progress?.dayStatus ?? {})
          .filter(([, status]) => status === "failed")
          .map(([date]) => date)
          .sort()
      : [];
  const emptyDates =
    run && !isGenerating
      ? Object.entries(run.progress?.dayStatus ?? {})
          .filter(([, status]) => status === "empty")
          .map(([date]) => date)
          .sort()
      : [];
  const runNotice =
    run && !isGenerating && run.id !== dismissedRunId && (run.status === "failed" || run.error)
      ? {
          kind: "error" as const,
          text: summarizeRunError(run.error, failedDates),
        }
      : run && !isGenerating && run.id !== dismissedRunId && emptyDates.length > 0
        ? {
            // Silence here would read as "generate missed those days".
            kind: "ok" as const,
            text:
              `เว้นว่าง ${emptyDates.length} วันที่ไม่มีหลักฐาน (ไม่มี commit / task ปิด / comment): ` +
              `${emptyDates.map(formatThaiDate).join(", ")} — ตั้งเป็นวันลา หรือเพิ่ม card เองได้`,
          }
        : null;
  const displayNotice = notice ?? runNotice;

  const generate = useMutation({
    mutationFn: (regenerateDates?: string[]) =>
      api.generate({
        from: range.from,
        to: range.to,
        hoursPerDay: hours ? Number(hours) : null,
        regenerateDates,
      }),
    onSuccess: ({ runId }) => {
      setNotice(null);
      setManualRunId(runId);
    },
    onError: (error) => setNotice({ kind: "error", text: (error as Error).message }),
  });

  const submit = useMutation({
    mutationFn: () => api.submit(range.from, range.to),
    onSuccess: (result) => {
      setConfirmingSubmit(false);
      queryClient.invalidateQueries({ queryKey: ["cards"] });
      const text =
        `ส่งสำเร็จ ${result.submitted + result.updated} ใบ${result.failed ? `, พลาด ${result.failed}` : ""}` +
        (result.warnings.length > 0 ? ` · ⚠️ ${result.warnings.join(" · ")}` : "");
      setNotice({ kind: result.failed ? "error" : "ok", text });
      // Re-read workload so the list shows exactly what landed there.
      reconcile.mutate();
    },
    onError: (error) => {
      setConfirmingSubmit(false);
      setNotice({ kind: "error", text: (error as Error).message });
    },
  });

  // "list ต้องตรงกับตัวจริง": pull the real workload rows and align the list.
  const reconcile = useMutation({
    mutationFn: () => api.reconcile(range.from, range.to),
    onSuccess: (r) => {
      setLastRemoteCount(r.remoteCount);
      queryClient.invalidateQueries({ queryKey: ["cards"] });
      const parts = [
        `workload มี ${r.remoteCount} ใบในช่วงนี้`,
        r.imported ? `ดึงเข้ามา ${r.imported}` : "",
        r.updatedFromRemote ? `อัปเดตตามของจริง ${r.updatedFromRemote}` : "",
        r.linked ? `ผูก id ${r.linked}` : "",
        r.orphaned ? `หายจาก workload ${r.orphaned} (กลับเป็น draft)` : "",
      ].filter(Boolean);
      setNotice({ kind: "ok", text: parts.join(" · ") });
    },
    onError: (error) => setNotice({ kind: "error", text: (error as Error).message }),
  });

  const clearUnsubmitted = useMutation({
    mutationFn: () => api.clearUnsubmitted(range.from, range.to),
    onSuccess: ({ deleted }) => {
      setConfirmingClear(false);
      queryClient.invalidateQueries({ queryKey: ["cards"] });
      setNotice({
        kind: "ok",
        text: deleted > 0 ? `ล้าง ${deleted} รายการที่ยังไม่ได้อัพแล้ว` : "ไม่มีรายการให้ล้าง",
      });
    },
    onError: (error) => {
      setConfirmingClear(false);
      setNotice({ kind: "error", text: (error as Error).message });
    },
  });

  const clickupEnabled = settingsQuery.data?.settings.clickup_enabled !== "0";
  const toggleClickup = useMutation({
    mutationFn: (enabled: boolean) => api.setClickupEnabled(enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
    onError: (error) => setNotice({ kind: "error", text: (error as Error).message }),
  });

  const copyPayload = useMutation({
    mutationFn: async () => {
      const { payload, count } = await api.submitPayload(range.from, range.to);
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      return count;
    },
    onSuccess: (count) => setNotice({ kind: "ok", text: `copy payload ${count} ใบแล้ว — วางใน curl/DevTools ได้เลย` }),
    onError: (error) => setNotice({ kind: "error", text: (error as Error).message }),
  });

  // From the click until the server answers and the first run poll lands there
  // is a gap — a second or two, longer when the route still has to compile —
  // during which nothing on screen moved. These treat that gap as part of the
  // run so the button, the window and every day row react immediately.
  const isStarting = generate.isPending;
  const runActive = isGenerating || isStarting;
  const runPhase = isStarting ? ("sync" as const) : run?.progress?.phase;
  const dayRunStatus = (date: string) =>
    isStarting ? "pending" : run?.progress?.dayStatus[date];

  const data = cardsQuery.data;
  const cardsByDate = new Map<string, NonNullable<typeof data>["cards"]>();
  for (const card of data?.cards ?? []) {
    cardsByDate.set(card.tasksDate, [...(cardsByDate.get(card.tasksDate) ?? []), card]);
  }
  const submittable = (data?.cards ?? []).filter((c) => c.status !== "submitted");
  const uploadCounts = countUploadStates(data?.cards ?? []);
  const clearable = (data?.cards ?? []).filter((c) => c.status !== "submitted" && !c.remoteTaskId);
  const jwtProblem =
    settingsQuery.data &&
    (!settingsQuery.data.settings.jwt || settingsQuery.data.jwtExpired === true);

  const totalTargetSec = data?.coverage.totalTargetSec ?? 0;
  const totalPlannedSec = data?.coverage.totalPlannedSec ?? 0;
  const summarySegments: MeterSegment[] = (data?.cards ?? [])
    .slice()
    .sort((a, b) => a.tasksDate.localeCompare(b.tasksDate))
    .map((c) => ({ sec: c.durationSec, tone: uploadBadge(c).state }));
  const shortDays = (data?.coverage.days ?? []).filter(
    (d) => d.targetSec > 0 && d.plannedSec < d.targetSec,
  ).length;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-32">
      <header className="sticky top-0 z-20 -mx-4 mb-4 flex items-center gap-3 border-b border-border bg-background/85 px-4 py-2.5 backdrop-blur">
        <h1 className="display text-[15px] font-bold">รายงานงาน</h1>
        <span className="font-mono text-[11px] text-muted">workload</span>
        <div className="ml-auto flex items-center gap-3">
          <ThemeToggle />
          <Link
            href="/settings"
            className="text-[13px] text-muted transition-colors hover:text-foreground"
          >
            ตั้งค่า
          </Link>
        </div>
      </header>

      {jwtProblem && (
        <div className="mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[13px]">
          <b>ยังส่งขึ้น workload ไม่ได้</b> — โทเคน
          {settingsQuery.data?.settings.jwt ? "หมดอายุแล้ว" : "ยังไม่ได้ตั้งค่า"} สร้างรายงานได้ตามปกติ ·{" "}
          <Link href="/settings" className="underline">
            วางโทเคนใหม่
          </Link>
        </div>
      )}

      {/* ── 1. ช่วงวันที่ ───────────────────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-3.5">
        <Label className="mb-2">ช่วงวันที่</Label>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((preset) => {
              const r = preset.range();
              const isActive = r.from === range.from && r.to === range.to;
              return (
                <Button
                  key={preset.label}
                  size="sm"
                  variant={isActive ? "primary" : "outline"}
                  onClick={() => setRange(r)}
                >
                  {preset.label}
                </Button>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
              className="font-mono"
              aria-label="จากวันที่"
            />
            <span className="text-muted">–</span>
            <Input
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
              className="font-mono"
              aria-label="ถึงวันที่"
            />
          </div>
          <label className="flex items-center gap-1.5 text-[13px] text-muted">
            <Input
              type="number"
              step="0.5"
              min="1"
              max="24"
              placeholder={settingsQuery.data?.settings.default_daily_hours ?? "8"}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="w-14 text-right font-mono"
            />
            ชม./วัน
          </label>
          <label
            className="flex cursor-pointer items-center gap-1.5 text-[13px] text-muted"
            title="ปิดแล้วจะเขียนจาก commit อย่างเดียว เร็วขึ้นมากเพราะไม่ต้องรอดึง ClickUp"
          >
            <input
              type="checkbox"
              checked={clickupEnabled}
              disabled={runActive || toggleClickup.isPending}
              onChange={(e) => toggleClickup.mutate(e.target.checked)}
              className="accent-(--accent)"
            />
            ค้นใน ClickUp
          </label>
          <Button
            variant="primary"
            size="lg"
            className="ml-auto"
            disabled={runActive}
            onClick={() => generate.mutate(undefined)}
          >
            {runActive && <Spinner />} สร้างรายงาน
          </Button>
        </div>
      </section>

      {/* ── ตัวชี้วัดรวมของช่วง ─────────────────────────────────────── */}
      {data && totalTargetSec > 0 && (
        <section className="mt-4 px-1">
          <div className="flex items-end gap-2">
            <span className="display text-[34px] font-bold leading-none tabular-nums">
              {formatHours(totalPlannedSec)}
            </span>
            <span className="mb-0.5 font-mono text-[13px] text-muted">
              / {formatHours(totalTargetSec)} ชม.
            </span>
            <div className="mb-1 ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-ok" /> อัพแล้ว {uploadCounts.uploaded}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-accent" /> ยังไม่อัพ {uploadCounts.pending}
              </span>
              {uploadCounts.failed > 0 && (
                <span className="inline-flex items-center gap-1.5 text-danger">
                  <span className="size-2 rounded-full bg-danger" /> อัพไม่สำเร็จ{" "}
                  {uploadCounts.failed}
                </span>
              )}
            </div>
          </div>
          <Meter
            segments={summarySegments}
            targetSec={totalTargetSec}
            height={12}
            className="mt-2"
          />
          <p className="mt-1.5 text-[12px] text-muted">
            {shortDays > 0 ? `${shortDays} วันยังไม่ครบชั่วโมง` : "ทุกวันครบชั่วโมงแล้ว"}
            {lastRemoteCount !== null && ` · บน workload มี ${lastRemoteCount} รายการ`}
          </p>
        </section>
      )}

      {displayNotice && (
        <div
          className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] ${
            displayNotice.kind === "ok"
              ? "border-border bg-surface"
              : "border-danger/40 bg-danger/10"
          }`}
        >
          <p className="min-w-0 flex-1">{displayNotice.text}</p>
          {failedDates.length > 0 && !notice && (
            <Button
              size="sm"
              variant="primary"
              disabled={generate.isPending}
              onClick={() => generate.mutate(failedDates)}
            >
              ลองใหม่ {failedDates.length} วัน
            </Button>
          )}
          <button
            type="button"
            aria-label="ปิดข้อความ"
            className="cursor-pointer px-1 text-muted"
            onClick={() => (notice ? setNotice(null) : run && setDismissedRunId(run.id))}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── 2. รายวัน ──────────────────────────────────────────────── */}
      <div className="mt-4 rounded-xl border border-border bg-surface px-1.5 py-1">
        {cardsQuery.isLoading && (
          <p className="py-10 text-center text-[13px] text-muted">
            <Spinner className="mr-2" /> กำลังโหลด
          </p>
        )}
        {data?.days.map((day) => (
          <DaySection
            key={day.date}
            day={day}
            cards={cardsByDate.get(day.date) ?? []}
            taskTypes={taskTypesQuery.data?.taskTypes ?? []}
            runActive={runActive}
            runPhase={runPhase}
            runStatus={dayRunStatus(day.date)}
            onRegenerate={(date) => generate.mutate([date])}
          />
        ))}
        {data && data.days.length === 0 && (
          <p className="py-10 text-center text-[13px] text-muted">ไม่มีวันในช่วงนี้</p>
        )}
      </div>

      {/* ── เครื่องมือรอง ───────────────────────────────────────────── */}
      {data && (
        <div className="mt-4 space-y-2">
          <CoveragePanel coverage={data.coverage} />
          <details className="rounded-xl border border-border bg-surface">
            <summary className="cursor-pointer px-3.5 py-2.5 text-[13px] font-medium">
              วันหยุดและวันลา
            </summary>
            <div className="border-t border-border">
              <CalendarPanel defaultDate={range.to} />
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-2 px-1 text-[12px] text-muted">
            <button
              type="button"
              className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-foreground disabled:opacity-40"
              disabled={reconcile.isPending}
              onClick={() => reconcile.mutate()}
            >
              {reconcile.isPending && <Spinner className="mr-1" />}
              เทียบกับ workload
            </button>
            <span className="opacity-40">·</span>
            <button
              type="button"
              className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-foreground"
              onClick={() => copyPayload.mutate()}
            >
              คัดลอก payload
            </button>
            {run?.progress?.log && run.progress.log.length > 0 && !isGenerating && (
              <>
                <span className="opacity-40">·</span>
                <button
                  type="button"
                  className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-foreground"
                  onClick={() => setShowLastRunLog((v) => !v)}
                >
                  {showLastRunLog ? "ซ่อนบันทึกรอบล่าสุด" : "บันทึกรอบล่าสุด"}
                </button>
              </>
            )}
            {clearable.length > 0 && (
              <>
                <span className="opacity-40">·</span>
                {confirmingClear ? (
                  <span className="inline-flex items-center gap-2">
                    <span>ลบ {clearable.length} รายการนี้ทิ้ง?</span>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={clearUnsubmitted.isPending}
                      onClick={() => clearUnsubmitted.mutate()}
                    >
                      {clearUnsubmitted.isPending && <Spinner />} ยืนยันล้าง
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmingClear(false)}>
                      ยกเลิก
                    </Button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="cursor-pointer text-danger underline decoration-dotted underline-offset-2"
                    title="ลบเฉพาะรายการที่ยังไม่ได้ส่งขึ้น workload — ของที่ส่งไปแล้วไม่ถูกแตะ"
                    onClick={() => setConfirmingClear(true)}
                  >
                    ล้างรายการที่ยังไม่ได้อัพ ({clearable.length})
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {(runActive || (run && showLastRunLog)) && (
        <GenerateProgress
          run={isStarting ? null : run}
          isRunning={runActive}
          onCancel={() => activeRunId && api.runAction(activeRunId, "cancel")}
        />
      )}

      {/* ── 3. ส่งขึ้น workload ─────────────────────────────────────── */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 text-[13px]">
            {submittable.length > 0 ? (
              <>
                <b className="font-mono tabular-nums">{submittable.length}</b> รายการรอส่ง
                <span className="text-muted"> · {formatHours(
                  submittable.reduce((s, c) => s + c.durationSec, 0),
                )} ชม.</span>
              </>
            ) : (
              <span className="text-muted">ส่งครบแล้ว</span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {confirmingSubmit ? (
              <>
                <Button onClick={() => setConfirmingSubmit(false)}>ยกเลิก</Button>
                <Button
                  variant="primary"
                  size="lg"
                  disabled={submit.isPending}
                  onClick={() => submit.mutate()}
                >
                  {submit.isPending && <Spinner />} ยืนยันส่ง {submittable.length} รายการ
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                size="lg"
                disabled={submittable.length === 0 || isGenerating || Boolean(jwtProblem)}
                onClick={() => setConfirmingSubmit(true)}
              >
                ส่งขึ้น workload
              </Button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
