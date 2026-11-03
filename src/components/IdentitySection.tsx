"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button, Chip, Label, Spinner } from "./ui";

/** Identity: which git users are me, and which workload account the report
 *  lands under (the JWT's owner). The two must be the same person — commits
 *  are the evidence, the workload account is where it is written. */
export function IdentitySection() {
  const queryClient = useQueryClient();
  const authorsQuery = useQuery({ queryKey: ["gitAuthors"], queryFn: () => api.gitAuthors(), retry: 0 });
  const meQuery = useQuery({ queryKey: ["workloadMe"], queryFn: api.me, retry: 0 });

  const selected = authorsQuery.data?.selected ?? [];
  const isSelected = (author: { email: string; name: string }) =>
    selected.some((s) => s.toLowerCase() === author.email.toLowerCase() || s.toLowerCase() === author.name.toLowerCase());

  const saveAuthors = useMutation({
    mutationFn: (next: string[]) => api.saveGitAuthors(next),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gitAuthors"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["workloadMe"] });
    },
  });

  const toggle = (authorEmail: string, on: boolean) => {
    const without = selected.filter((s) => s.toLowerCase() !== authorEmail.toLowerCase());
    saveAuthors.mutate(on ? [...without, authorEmail] : without);
  };

  const identity = meQuery.data?.identity;
  // A shared repo has dozens of contributors; ours belong at the top, and the
  // rest stays reachable behind a scroll rather than filling the page.
  const authors = [...(authorsQuery.data?.authors ?? [])].sort(
    (a, b) => Number(isSelected(b)) - Number(isSelected(a)) || b.commits - a.commits,
  );

  return (
    <section className="space-y-3 rounded-xl border border-border bg-surface p-3.5">
      <div className="flex items-center gap-2">
        <Label>ตัวตน — git และ workload ต้องเป็นคนเดียวกัน</Label>
        {saveAuthors.isPending && <Spinner />}
      </div>
      <p className="text-[13px] text-muted">
        เลือก git user ได้หลายชื่อ ระบบจะนับเฉพาะ commit ของชื่อที่เลือก
        และต้องเป็นคนเดียวกับชื่อที่ใช้ส่งรายงาน
      </p>

      {identity && identity.warnings.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-warn/40 bg-warn/10 text-warn px-3 py-2 text-xs">
          {identity.warnings.map((w) => (
            <li key={w}>⚠️ {w}</li>
          ))}
        </ul>
      )}

      <div className="space-y-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium">git user ที่นับเป็นงานของเรา</span>
          <span className="text-[12px] text-muted">
            เลือกแล้ว {selected.length} จาก {authors.length}
          </span>
        </div>
        {authorsQuery.isFetching && <p className="text-[12px] text-muted">กำลังอ่าน git log</p>}
        {authorsQuery.isError && (
          <p className="text-[12px] text-danger">{(authorsQuery.error as Error).message}</p>
        )}
        {!authorsQuery.isFetching && authors.length === 0 && (
          <p className="text-[12px] text-muted">ยังไม่พบ author เพิ่มโปรเจกต์ด้านล่างก่อน</p>
        )}
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-1">
        {authors.map((author) => (
          <label
            key={author.email}
            className="flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-[13px] hover:bg-surface-2"
          >
            <input
              type="checkbox"
              checked={isSelected(author)}
              onChange={(e) => toggle(author.email, e.target.checked)}
              className="accent-(--accent)"
            />
            <span className="font-medium">{author.name}</span>
            <span className="font-mono text-xs text-muted">{author.email}</span>
            <Chip className="ml-auto bg-surface-2 font-mono text-muted">{author.commits}</Chip>
            <span
              className="max-w-40 truncate rounded bg-surface-2 px-1.5 text-[11px] leading-[17px] text-muted"
              title={author.projects.join(", ")}
            >
              {author.projects.join(", ")}
            </span>
          </label>
        ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">บัญชี workload ที่ส่งรายงาน</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["workloadMe"] })}
            disabled={meQuery.isFetching}
          >
            {meQuery.isFetching && <Spinner />} ตรวจอีกครั้ง
          </Button>
        </div>
        {meQuery.isError ? (
          <p className="text-[12px] text-muted">{(meQuery.error as Error).message}</p>
        ) : (
          meQuery.data && (
            <p className="text-[13px]">
              <b>{meQuery.data.me.name}</b>{" "}
              <span className="font-mono text-xs text-muted">{meQuery.data.me.email}</span>
              {meQuery.data.me.positions.length > 0 && (
                <span className="text-[12px] text-muted">
                  {" "}
                  · {meQuery.data.me.positions.map((p) => p.name).join(", ")}
                </span>
              )}
            </p>
          )
        )}
        <p className="text-[12px] text-muted">
          มาจากโทเคนด้านบน — อยากส่งในนามคนอื่นต้องใช้โทเคนของคนนั้น
        </p>
      </div>
    </section>
  );
}
