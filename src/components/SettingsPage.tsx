"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { IdentitySection } from "./IdentitySection";
import { ThemeToggle } from "./ThemeToggle";
import { Button, Input, Label, Spinner } from "./ui";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-muted">{hint}</span>}
    </label>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [newProjectPath, setNewProjectPath] = useState("");
  const [scanRoot, setScanRoot] = useState<string | null>(null); // null = server default
  const [notice, setNotice] = useState<string | null>(null);

  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const taskTypesQuery = useQuery({ queryKey: ["taskTypes"], queryFn: api.taskTypes });
  const discoverQuery = useQuery({
    queryKey: ["discover", scanRoot],
    queryFn: () => api.discoverProjects(scanRoot ?? undefined),
    retry: 0,
  });

  const save = useMutation({
    mutationFn: () => api.saveSettings(draft),
    onSuccess: (r) => {
      setDraft({});
      setNotice(`บันทึกแล้ว: ${r.saved.join(", ")}`);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e) => setNotice((e as Error).message),
  });

  const syncTypes = useMutation({
    mutationFn: api.syncTaskTypes,
    onSuccess: (r) => {
      setNotice(`sync task types แล้ว ${r.synced} แบบ`);
      queryClient.invalidateQueries({ queryKey: ["taskTypes"] });
    },
    onError: (e) => setNotice((e as Error).message),
  });

  const invalidateProjects = () => {
    queryClient.invalidateQueries({ queryKey: ["projects"] });
    queryClient.invalidateQueries({ queryKey: ["discover"] });
  };
  const addProject = useMutation({
    mutationFn: (projectPath: string) => api.addProject(projectPath),
    onSuccess: () => {
      setNewProjectPath("");
      invalidateProjects();
    },
    onError: (e) => setNotice((e as Error).message),
  });
  const addAll = useMutation({
    mutationFn: async (paths: string[]) => {
      for (const p of paths) await api.addProject(p);
      return paths.length;
    },
    onSuccess: (count) => {
      setNotice(`เพิ่ม ${count} projects แล้ว`);
      invalidateProjects();
    },
    onError: (e) => {
      setNotice((e as Error).message);
      invalidateProjects();
    },
  });
  const toggleProject = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api.updateProject(id, { enabled }),
    onSuccess: invalidateProjects,
  });
  const removeProject = useMutation({
    mutationFn: (id: number) => api.deleteProject(id),
    onSuccess: invalidateProjects,
  });

  const current = settingsQuery.data?.settings ?? {};
  const value = (key: string) => draft[key] ?? current[key] ?? "";
  const set = (key: string, v: string) => setDraft((d) => ({ ...d, [key]: v }));
  const isDirty = Object.keys(draft).length > 0;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-24">
      <header className="sticky top-0 z-20 -mx-4 mb-4 flex items-center gap-3 border-b border-border bg-background/85 px-4 py-2.5 backdrop-blur">
        <h1 className="display text-[15px] font-bold">ตั้งค่า</h1>
        <div className="ml-auto flex items-center gap-3">
          <ThemeToggle />
          <Link
            href="/"
            className="text-[13px] text-muted transition-colors hover:text-foreground"
          >
            กลับหน้ารายงาน
          </Link>
        </div>
      </header>

      {notice && (
        <div className="mb-3 rounded-lg border border-border bg-surface px-3 py-2 text-[13px]">
          {notice}
          <button type="button" className="float-right cursor-pointer text-muted" onClick={() => setNotice(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="space-y-5">
        <section className="space-y-3 rounded-xl border border-border bg-surface p-3.5">
          <Label>บัญชีสำหรับส่งรายงาน</Label>
          <Field
            label="โทเคน (JWT)"
            hint={
              settingsQuery.data?.jwtExpiresAt
                ? `หมดอายุ ${new Date(settingsQuery.data.jwtExpiresAt).toLocaleString("th-TH")}${settingsQuery.data.jwtExpired ? " — หมดแล้ว วางใหม่" : ""}`
                : "เปิด workload.ketspace.io แล้วคัดลอกค่าจาก localStorage.token → access_token"
            }
          >
            <textarea
              rows={2}
              placeholder={current.jwt ?? "วาง JWT ที่นี่"}
              value={draft.jwt ?? ""}
              onChange={(e) => set("jwt", e.target.value)}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs focus:border-accent focus:outline-none"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="ชื่อที่แสดง">
              <Input value={value("task_by")} onChange={(e) => set("task_by", e.target.value)} className="w-full" />
            </Field>
            <Field label="อีเมล">
              <Input value={value("email")} onChange={(e) => set("email", e.target.value)} className="w-full" />
            </Field>
          </div>
          <p className="text-[12px] text-muted">
            ชื่อและอีเมลนี้ถูกส่งไปกับทุกรายการ เลือกจากรายชื่อพนักงานด้านล่างให้ตรงกับ git user ที่เลือกไว้
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => syncTypes.mutate()} disabled={syncTypes.isPending}>
              {syncTypes.isPending && <Spinner />} ดึงประเภทงานใหม่
            </Button>
            <span className="text-[12px] text-muted">
              มี {taskTypesQuery.data?.taskTypes.length ?? 0} ประเภท
            </span>
          </div>
        </section>

        <IdentitySection
          taskBy={value("task_by")}
          email={value("email")}
          onPickEmployee={(employee) =>
            setDraft((d) => ({ ...d, task_by: employee.name, email: employee.email }))
          }
        />

        <section className="space-y-3 rounded-xl border border-border bg-surface p-3.5">
          <Label>ClickUp</Label>
          <p className="text-[13px] text-muted">
            ไม่ต้องตั้งค่าก็ใช้ได้ ระบบดึงผ่าน Claude MCP connector ที่ล็อกอินอยู่แล้ว
            ใส่โทเคนด้านล่างถ้าต้องการให้ดึงเร็วขึ้น
          </p>
          <Field
            label="Personal token (ไม่บังคับ)"
            hint="ClickUp → Settings → Apps → Generate"
          >
            <Input
              type="password"
              placeholder={current.clickup_token ?? "pk_…"}
              value={draft.clickup_token ?? ""}
              onChange={(e) => set("clickup_token", e.target.value)}
              className="w-full font-mono"
            />
          </Field>
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-surface p-3.5">
          <Label>การสร้างรายงาน</Label>
          <div className="grid grid-cols-2 gap-3">
            <Field label="โมเดล" hint="เว้นว่างเพื่อใช้ค่าเริ่มต้น">
              <Input
                placeholder="เช่น sonnet"
                value={value("ai_model")}
                onChange={(e) => set("ai_model", e.target.value)}
                className="w-full font-mono"
              />
            </Field>
            <Field label="ชั่วโมงต่อวัน">
              <Input
                type="number"
                step="0.5"
                min="1"
                max="24"
                placeholder="8"
                value={value("default_daily_hours")}
                onChange={(e) => set("default_daily_hours", e.target.value)}
                className="w-full font-mono"
              />
            </Field>
          </div>
          <Field label="กฎเพิ่มเติมในการเขียน" hint="แนบไปกับทุกคำสั่ง เช่น เน้นเขียนเชิงผลลัพธ์ หรือศัพท์เฉพาะของทีม">
            <textarea
              rows={4}
              value={value("rules_md")}
              onChange={(e) => set("rules_md", e.target.value)}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] focus:border-accent focus:outline-none"
            />
          </Field>
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-surface p-3.5">
          <Label>โปรเจกต์ ({projectsQuery.data?.projects.length ?? 0})</Label>
          <div className="space-y-1.5">
            {projectsQuery.data?.projects.map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-[13px]">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) => toggleProject.mutate({ id: p.id, enabled: e.target.checked })}
                  className="accent-(--accent)"
                  aria-label={`เปิดใช้ ${p.name}`}
                />
                <span className={p.enabled ? "" : "text-muted line-through"}>{p.name}</span>
                <span
                  className="max-w-72 truncate rounded bg-surface-2 px-1.5 font-mono text-[11px] leading-[17px] text-muted"
                  title={p.path}
                >
                  {p.path}
                </span>
                <button
                  type="button"
                  className="ml-auto cursor-pointer text-xs text-danger opacity-60 hover:opacity-100"
                  onClick={() => removeProject.mutate(p.id)}
                >
                  ลบ
                </button>
              </div>
            ))}
          </div>
          <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium">พบในเครื่อง</span>
              <Input
                value={scanRoot ?? discoverQuery.data?.root ?? ""}
                onChange={(e) => setScanRoot(e.target.value)}
                className="flex-1 min-w-52 font-mono text-xs"
                aria-label="โฟลเดอร์ที่สแกน"
              />
              <Button
                size="sm"
                onClick={() => queryClient.invalidateQueries({ queryKey: ["discover"] })}
                disabled={discoverQuery.isFetching}
              >
                {discoverQuery.isFetching && <Spinner />} ค้นหา
              </Button>
            </div>
            {discoverQuery.isError && (
              <p className="text-xs text-danger">{(discoverQuery.error as Error).message}</p>
            )}
            {(() => {
              const found = (discoverQuery.data?.repos ?? []).filter((r) => !r.alreadyAdded);
              if (discoverQuery.data && found.length === 0) {
                return <p className="text-[12px] text-muted">เพิ่มครบทุก repo ในโฟลเดอร์นี้แล้ว</p>;
              }
              return (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {found.map((repo) => (
                      <Button
                        key={repo.path}
                        size="sm"
                        title={repo.path}
                        disabled={addProject.isPending || addAll.isPending}
                        onClick={() => addProject.mutate(repo.path)}
                      >
                        {repo.name}
                      </Button>
                    ))}
                  </div>
                  {found.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={addAll.isPending}
                      onClick={() => addAll.mutate(found.map((r) => r.path))}
                    >
                      {addAll.isPending && <Spinner />} เพิ่มทั้งหมด {found.length} รายการ
                    </Button>
                  )}
                </>
              );
            })()}
            <details>
              <summary className="cursor-pointer text-[12px] text-muted">หรือพิมพ์ path เอง</summary>
              <div className="mt-2 flex gap-2">
                <Input
                  placeholder="/path/to/git/repo"
                  value={newProjectPath}
                  onChange={(e) => setNewProjectPath(e.target.value)}
                  className="flex-1 font-mono"
                />
                <Button
                  onClick={() => addProject.mutate(newProjectPath)}
                  disabled={!newProjectPath || addProject.isPending}
                >
                  เพิ่ม
                </Button>
              </div>
            </details>
          </div>
        </section>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-2.5">
          <span className="text-[13px] text-muted">
            {isDirty ? "มีการแก้ไขที่ยังไม่ได้บันทึก" : "บันทึกไว้ทั้งหมดแล้ว"}
          </span>
          <Button
            variant="primary"
            size="lg"
            className="ml-auto"
            disabled={!isDirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending && <Spinner />} บันทึก
          </Button>
        </div>
      </div>
    </main>
  );
}
