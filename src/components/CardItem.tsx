"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Card, TaskType } from "@/db/schema";
import { api } from "@/lib/api";
import { formatHours, uploadBadge } from "@/lib/format";
import { htmlToText } from "@/lib/html-text";
import { sanitizeNoteHtml } from "@/lib/sanitize";
import { Button, Chip, Input, Select } from "./ui";

const UPLOAD_DOT: Record<string, string> = {
  uploaded: "bg-ok",
  pending: "bg-tick",
  failed: "bg-danger",
};

export function CardItem({ card, taskTypes }: { card: Card; taskTypes: TaskType[] }) {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState({
    topic: card.topic,
    taskType: card.taskType,
    hours: formatHours(card.durationSec),
    noteHtml: card.noteHtml,
    clickupTask: card.clickupTask ?? "",
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["cards"] });
  const update = useMutation({
    mutationFn: () =>
      api.updateCard(card.id, {
        topic: draft.topic,
        taskType: draft.taskType,
        durationHours: Number(draft.hours) || card.durationSec / 3600,
        noteHtml: draft.noteHtml,
        clickupTask: draft.clickupTask || null,
      }),
    onSuccess: () => {
      setIsEditing(false);
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteCard(card.id),
    onSuccess: () => {
      setConfirmingDelete(false);
      invalidate();
    },
  });

  const isOnRemote = Boolean(card.remoteTaskId);
  const syncError = (update.error ?? remove.error) as Error | null;
  const badge = uploadBadge(card);
  const typeColor = taskTypes.find((t) => t.name === card.taskType)?.color;
  // Rows imported from workload use the note's opening line as their topic;
  // printing both says the same thing twice.
  const notePlain = htmlToText(card.noteHtml);
  const topicRepeatsNote =
    card.topic.length > 0 && notePlain.startsWith(card.topic.replace(/…$/, "").trim());

  if (isEditing) {
    return (
      <div className="space-y-2 rounded-lg border border-accent bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={draft.topic}
            onChange={(e) => setDraft({ ...draft, topic: e.target.value })}
            className="min-w-44 flex-1"
            placeholder="หัวข้องาน"
            aria-label="หัวข้องาน"
          />
          <Select
            value={draft.taskType}
            onChange={(e) => setDraft({ ...draft, taskType: e.target.value })}
            aria-label="ประเภทงาน"
          >
            {taskTypes.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </Select>
          <Input
            value={draft.hours}
            onChange={(e) => setDraft({ ...draft, hours: e.target.value })}
            className="w-16 text-right font-mono"
            type="number"
            step="0.25"
            min="0.25"
            aria-label="ชั่วโมง"
          />
          <Input
            value={draft.clickupTask}
            onChange={(e) => setDraft({ ...draft, clickupTask: e.target.value })}
            className="w-28 font-mono"
            placeholder="DEV-0000"
            aria-label="ClickUp task"
          />
        </div>
        <textarea
          value={draft.noteHtml}
          onChange={(e) => setDraft({ ...draft, noteHtml: e.target.value })}
          rows={5}
          aria-label="รายละเอียด (HTML)"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs focus:border-accent focus:outline-none"
        />
        <div
          className="note-html rounded-md bg-surface-2 px-3 py-2 text-[13px]"
          dangerouslySetInnerHTML={{ __html: sanitizeNoteHtml(draft.noteHtml) }}
        />
        <div className="flex items-center gap-2">
          {update.isError && (
            <p className="text-xs text-danger">{(update.error as Error).message}</p>
          )}
          <Button
            className="ml-auto"
            onClick={() => {
              setDraft({
                topic: card.topic,
                taskType: card.taskType,
                hours: formatHours(card.durationSec),
                noteHtml: card.noteHtml,
                clickupTask: card.clickupTask ?? "",
              });
              setIsEditing(false);
            }}
          >
            ยกเลิก
          </Button>
          <Button variant="primary" disabled={update.isPending} onClick={() => update.mutate()}>
            {isOnRemote ? "บันทึกและอัปเดตบน workload" : "บันทึก"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group grid grid-cols-[3.25rem_1fr] gap-x-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2">
      {/* Hours get their own right-aligned column so a day reads as a column of
          figures that visibly adds up to its target. */}
      <div className="flex items-baseline justify-end gap-1 pt-px">
        <span className="display text-[15px] font-semibold tabular-nums">
          {formatHours(card.durationSec)}
        </span>
        <span className="text-[10px] text-muted">ชม.</span>
      </div>

      <div className="relative min-w-0">
        {/* Row actions float over the top-right corner so a card with no
            separate headline does not carry an empty band above its text. */}
        <div className="absolute -top-0.5 right-0 flex items-center gap-1 rounded bg-surface-2 pl-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {confirmingDelete ? (
            <>
              <Button
                size="sm"
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {isOnRemote ? "ลบทั้งบน workload" : "ยืนยันลบ"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                ยกเลิก
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => setIsEditing(true)}>
                แก้ไข
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(true)}>
                ลบ
              </Button>
            </>
          )}
        </div>

        {topicRepeatsNote ? (
          <span className="sr-only">{card.topic}</span>
        ) : (
          <p className="pr-24 font-medium leading-snug break-words">{card.topic}</p>
        )}

        <div
          className="note-html break-words text-[13px] leading-relaxed text-muted"
          dangerouslySetInnerHTML={{ __html: sanitizeNoteHtml(card.noteHtml) }}
        />

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1" title={card.error ?? badge.label}>
            <span className={`size-1.5 rounded-full ${UPLOAD_DOT[badge.state]}`} />
            {badge.label}
          </span>
          <span className="inline-flex items-center gap-1" title={`ประเภทงาน: ${card.taskType}`}>
            <span
              className="size-1.5 rounded-full"
              style={{ background: typeColor ?? "var(--tick)" }}
            />
            {card.taskType}
          </span>
          {card.clickupTask &&
            (card.clickupUrl ? (
              <a
                href={card.clickupUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-accent underline decoration-dotted underline-offset-2"
              >
                {card.clickupTask}
              </a>
            ) : (
              <span className="font-mono">{card.clickupTask}</span>
            ))}
          {/* Only the exception is labelled: filler invented to reach the
              target, which a reviewer should look at before submitting. */}
          {card.origin === "inferred" && (
            <Chip className="bg-warn/15 text-warn" title="เติมให้ครบชั่วโมง ไม่มี commit รองรับ">
              เติมให้
            </Chip>
          )}
          {isOnRemote && <span className="font-mono opacity-60">#{card.remoteTaskId}</span>}
        </div>

        {syncError && <p className="mt-1 text-[11px] text-danger">{syncError.message}</p>}
        {!syncError && card.status === "failed" && card.error && (
          <p className="mt-1 text-[11px] text-danger">{card.error}</p>
        )}
        {card.internalNote && !isOnRemote && (
          <p className="mt-1 text-[11px] text-muted/80" title="โน้ตภายใน ไม่ถูกส่งขึ้น workload">
            {card.internalNote}
          </p>
        )}
      </div>
    </div>
  );
}
