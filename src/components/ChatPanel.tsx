"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ChatAttachment, ChatCardSnapshot, ChatMessage, ChatOp } from "@/db/schema";
import { api, type ChatThreadData } from "@/lib/api";
import { formatHours, formatThaiDate } from "@/lib/format";
import { sanitizeNoteHtml } from "@/lib/sanitize";
import { Button, Chip, Spinner } from "./ui";

/** What a chat is about. The page keys the panel by `nonce`, so reopening starts from the new draft. */
export type ChatTarget = {
  scope: string;
  title: string;
  draft?: string;
  attachments?: ChatAttachment[];
  nonce: number;
};

export function ChatPanel({ target, onClose }: { target: ChatTarget; onClose: () => void }) {
  const queryClient = useQueryClient();
  const queryKey = ["chat", target.scope];
  const [text, setText] = useState(target.draft ?? "");
  const [attachments, setAttachments] = useState<ChatAttachment[]>(target.attachments ?? []);
  const [startFresh, setStartFresh] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const thread = useQuery({ queryKey, queryFn: () => api.chatThread(target.scope) });
  const messages = startFresh ? [] : (thread.data?.messages ?? []);

  const send = useMutation({
    mutationFn: () =>
      api.sendChat({
        scope: target.scope,
        text,
        attachments: attachments.length ? attachments : undefined,
        newThread: startFresh,
      }),
    onSuccess: (data: ChatThreadData) => {
      queryClient.setQueryData(queryKey, data);
      setText("");
      setAttachments([]);
      setStartFresh(false);
    },
  });

  const act = useMutation({
    mutationFn: (input: { messageId: number; action: "apply" | "discard" }) =>
      api.proposalAction(input.messageId, input.action),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ["cards"] });
    },
  });

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, send.isPending]);

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20 sm:hidden" onClick={onClose} aria-hidden />
      <aside
        className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-background shadow-xl sm:w-[460px]"
        aria-label="แชทแก้รายงาน"
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <div className="min-w-0">
            <p className="display text-[14px] font-semibold">แชทแก้รายงาน</p>
            <p className="truncate text-[12px] text-muted">{target.title}</p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            {messages.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setStartFresh(true)}>
                เริ่มใหม่
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="ปิด">
              ✕
            </Button>
          </div>
        </header>

        <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {thread.isLoading && (
            <p className="text-[13px] text-muted">
              <Spinner className="mr-2" /> กำลังโหลด
            </p>
          )}
          {!thread.isLoading && messages.length === 0 && !send.isPending && (
            <div className="space-y-1 text-[13px] text-muted">
              <p>บอกสิ่งที่อยากแก้ เช่น</p>
              <ul className="list-disc space-y-0.5 pl-5">
                <li>รวม 2 รายการแรกเป็นรายการเดียว</li>
                <li>เขียนรายการ deploy ให้คนที่ไม่ใช่ dev อ่านเข้าใจ</li>
                <li>เพิ่มประชุมทีม 1 ชม. ลดจากรายการที่ยาวที่สุด</li>
              </ul>
              <p className="pt-1">AI จะเสนอการแก้ให้ดูก่อน กด <b>ใช้</b> ถึงจะเปลี่ยนจริง</p>
            </div>
          )}
          {messages.map((m) => (
            <MessageView
              key={m.id}
              message={m}
              busy={act.isPending && act.variables?.messageId === m.id}
              onAction={(action) => act.mutate({ messageId: m.id, action })}
            />
          ))}
          {send.isPending && (
            <>
              <UserBubble text={text} attachments={attachments} />
              <p className="flex items-center gap-2 text-[13px] text-muted">
                <Spinner /> AI กำลังคิด — อาจใช้เวลาเป็นนาที
              </p>
            </>
          )}
          {send.isError && <p className="text-[12px] text-danger">{(send.error as Error).message}</p>}
          {act.isError && <p className="text-[12px] text-danger">{(act.error as Error).message}</p>}
        </div>

        <form
          className="space-y-2 border-t border-border px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() && !send.isPending) send.mutate();
          }}
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {attachments.map((a) => (
                <Chip key={attachmentKey(a)} className="bg-accent/10 text-accent">
                  {a.kind === "commit" ? a.hash.slice(0, 8) : (a.customId ?? a.taskId)}
                </Chip>
              ))}
              <button
                type="button"
                className="cursor-pointer text-[11px] text-muted underline"
                onClick={() => setAttachments([])}
              >
                เอาออก
              </button>
            </div>
          )}
          {startFresh && <p className="text-[11px] text-muted">ข้อความนี้จะเริ่มบทสนทนาใหม่</p>}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (text.trim() && !send.isPending) send.mutate();
              }
            }}
            rows={3}
            placeholder="อยากให้แก้อะไร"
            aria-label="ข้อความถึง AI"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] focus:border-accent focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted">⌘/Ctrl + Enter เพื่อส่ง</span>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              className="ml-auto"
              disabled={!text.trim() || send.isPending}
            >
              {send.isPending && <Spinner />} ส่ง
            </Button>
          </div>
        </form>
      </aside>
    </>
  );
}

function attachmentKey(a: ChatAttachment): string {
  return a.kind === "commit" ? `c:${a.hash}` : `t:${a.taskId}`;
}

function UserBubble({ text, attachments }: { text: string; attachments?: ChatAttachment[] | null }) {
  return (
    <div className="ml-8 rounded-lg bg-accent/10 px-3 py-2 text-[13px]">
      <p className="whitespace-pre-wrap">{text}</p>
      {attachments && attachments.length > 0 && (
        <p className="mt-1 text-[11px] text-muted">
          แนบ {attachments.length} รายการจาก “อาจตกหล่น”
        </p>
      )}
    </div>
  );
}

function MessageView({
  message,
  busy,
  onAction,
}: {
  message: ChatMessage;
  busy: boolean;
  onAction: (action: "apply" | "discard") => void;
}) {
  if (message.role === "user") {
    return <UserBubble text={message.text} attachments={message.attachments} />;
  }
  return (
    <div className="mr-4 space-y-2 text-[13px]">
      <p className="whitespace-pre-wrap">{message.text}</p>
      {message.error && <p className="text-[12px] text-danger">{message.error}</p>}
      {message.proposal && (
        <ProposalView
          ops={message.proposal.ops}
          before={message.proposal.before}
          status={message.proposalStatus}
          applyNote={message.applyNote}
          busy={busy}
          onAction={onAction}
        />
      )}
    </div>
  );
}

function ProposalView({
  ops,
  before,
  status,
  applyNote,
  busy,
  onAction,
}: {
  ops: ChatOp[];
  before: ChatCardSnapshot[];
  status: ChatMessage["proposalStatus"];
  applyNote: string | null;
  busy: boolean;
  onAction: (action: "apply" | "discard") => void;
}) {
  const byId = new Map(before.map((c) => [c.id, c]));
  const touchesWorkload = ops.some((op) => op.op !== "create" && byId.get(op.cardId)?.remoteTaskId);

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface p-2.5">
      {ops.map((op, i) => (
        <OpView key={i} op={op} card={op.op === "create" ? undefined : byId.get(op.cardId)} />
      ))}

      {status === "pending" ? (
        <div className="space-y-1.5 pt-1">
          {touchesWorkload && (
            <p className="text-[11px] text-warn">
              มีรายการที่อยู่บน workload แล้ว — กดใช้จะแก้/ลบบน workload ด้วย
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onAction("apply")}>
              {busy && <Spinner />} ใช้
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction("discard")}>
              ทิ้ง
            </Button>
          </div>
        </div>
      ) : (
        <p className="pt-1 text-[11px] text-muted">
          {status === "applied" ? "✓ ใช้แล้ว" : "ทิ้งแล้ว"}
        </p>
      )}
      {applyNote && <p className="whitespace-pre-wrap text-[11px] text-danger">{applyNote}</p>}
    </div>
  );
}

function Change({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <p className="text-[12px]">
      <span className="text-muted">{label}</span> <span className="line-through opacity-60">{from}</span>{" "}
      → <span className="font-medium">{to}</span>
    </p>
  );
}

function OpView({ op, card }: { op: ChatOp; card?: ChatCardSnapshot }) {
  const onWorkload = card?.remoteTaskId ? (
    <Chip className="bg-warn/15 text-warn">บน workload</Chip>
  ) : null;

  if (op.op === "create") {
    return (
      <div className="space-y-1 border-l-2 border-ok pl-2">
        <p className="text-[12px] font-medium text-ok">
          + เพิ่ม · {formatThaiDate(op.date)} · {formatHours(op.durationSec)} ชม. · {op.taskType}
        </p>
        <p className="font-medium">{op.topic}</p>
        <div
          className="note-html text-[12px] text-muted"
          dangerouslySetInnerHTML={{ __html: sanitizeNoteHtml(op.noteHtml) }}
        />
      </div>
    );
  }
  if (!card) return null;

  if (op.op === "delete") {
    return (
      <div className="space-y-1 border-l-2 border-danger pl-2">
        <p className="flex items-center gap-1.5 text-[12px] font-medium text-danger">
          − ลบ · {formatThaiDate(card.tasksDate)} · {formatHours(card.durationSec)} ชม. {onWorkload}
        </p>
        <p className="line-through opacity-70">{card.topic}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1 border-l-2 border-accent pl-2">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-accent">
        ✎ แก้ · {formatThaiDate(card.tasksDate)} {onWorkload}
      </p>
      <p className="font-medium">{op.topic ?? card.topic}</p>
      {op.durationSec !== undefined && op.durationSec !== card.durationSec && (
        <Change label="ชั่วโมง" from={formatHours(card.durationSec)} to={formatHours(op.durationSec)} />
      )}
      {op.taskType !== undefined && op.taskType !== card.taskType && (
        <Change label="ประเภท" from={card.taskType} to={op.taskType} />
      )}
      {op.topic !== undefined && op.topic !== card.topic && (
        <Change label="หัวข้อ" from={card.topic} to={op.topic} />
      )}
      {op.noteHtml !== undefined && op.noteHtml !== card.noteHtml && (
        <>
          <div
            className="note-html text-[12px]"
            dangerouslySetInnerHTML={{ __html: sanitizeNoteHtml(op.noteHtml) }}
          />
          <details className="text-[12px] text-muted">
            <summary className="cursor-pointer">ของเดิม</summary>
            <div
              className="note-html line-through opacity-70"
              dangerouslySetInnerHTML={{ __html: sanitizeNoteHtml(card.noteHtml) }}
            />
          </details>
        </>
      )}
      {op.evidence && (
        <p className="text-[11px] text-muted">
          หลักฐาน: {[...op.evidence.commits.map((h) => h.slice(0, 8)), ...op.evidence.tasks].join(", ") || "-"}
        </p>
      )}
    </div>
  );
}
