"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { formatThaiDate, KIND_LABELS } from "@/lib/format";
import { Button, Input, Label, Select, Spinner } from "./ui";

const ZOHO_URL = "https://people.zoho.com/ketshopweb/zp#leavetracker/holiday";

type Kind = "leave" | "holiday" | "half" | "workday";

const KIND_HOURS: Record<Kind, number> = { leave: 0, holiday: 0, half: 4, workday: 8 };

/** Secondary tool: mark leave / holidays over a span, and import the company
 *  calendar from Zoho People instead of trusting the bundled Thai list. */
export function CalendarPanel({ defaultDate }: { defaultDate: string }) {
  const queryClient = useQueryClient();
  const [range, setRange] = useState({ from: defaultDate, to: defaultDate });
  const [kind, setKind] = useState<Kind>("leave");
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [year, setYear] = useState(defaultDate.slice(0, 4));

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["cards"] });

  const apply = useMutation({
    mutationFn: () =>
      api.setDayTarget({
        from: range.from,
        to: range.to,
        targetHours: KIND_HOURS[kind],
        kind,
        note: note.trim() || null,
      }),
    onSuccess: (r) => {
      setNotice(`ตั้ง ${KIND_LABELS[kind]} ${r.dates.length} วันแล้ว`);
      setNote("");
      invalidate();
    },
    onError: (e) => setNotice((e as Error).message),
  });

  const clear = useMutation({
    mutationFn: () => api.clearDayTarget({ from: range.from, to: range.to }),
    onSuccess: (r) => {
      setNotice(`คืนค่า default ${r.dates.length} วัน`);
      invalidate();
    },
    onError: (e) => setNotice((e as Error).message),
  });

  const preview = useMutation({
    mutationFn: (applyIt: boolean) => api.importHolidays({ text: paste, year, apply: applyIt }),
    onSuccess: (r) => {
      const revert = r.revertToWorkday.length
        ? ` · คืนเป็นวันทำงาน ${r.revertToWorkday.length} วัน (${r.revertToWorkday.map(formatThaiDate).join(", ")})`
        : "";
      setNotice(
        `${r.applied ? "นำเข้าแล้ว" : "พรีวิว"}: วันหยุด ${r.holidays.length} วัน${revert}` +
          (r.skipped.length ? ` · ข้ามนอกปี ${r.skipped.length}` : ""),
      );
      if (r.applied) invalidate();
    },
    onError: (e) => setNotice((e as Error).message),
  });

  return (
    <section className="space-y-4 p-3.5">
      {notice && <p className="rounded-md bg-surface-2 px-3 py-2 text-[12px]">{notice}</p>}

      <div className="space-y-2">
        <Label>ตั้งเป็นช่วง</Label>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted">
            ตั้งแต่
            <Input
              type="date"
              value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
              className="ml-1 font-mono"
            />
          </label>
          <label className="text-xs text-muted">
            ถึง
            <Input
              type="date"
              value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
              className="ml-1 font-mono"
            />
          </label>
          <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)} aria-label="ประเภทวัน">
            <option value="leave">วันลา (0 ชม.)</option>
            <option value="holiday">วันหยุด (0 ชม.)</option>
            <option value="half">ครึ่งวัน (4 ชม.)</option>
            <option value="workday">วันทำงาน (คืนเป็น 8 ชม.)</option>
          </Select>
          <Input
            placeholder="โน้ต เช่น ลาพักร้อน"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="min-w-40 flex-1"
          />
          <Button variant="primary" disabled={apply.isPending} onClick={() => apply.mutate()}>
            {apply.isPending && <Spinner />} ตั้งค่า
          </Button>
          <Button variant="ghost" disabled={clear.isPending} onClick={() => clear.mutate()}>
            ล้าง
          </Button>
        </div>
        <p className="text-[12px] text-muted">เสาร์-อาทิตย์และวันหยุดในช่วงถูกข้ามให้อัตโนมัติ</p>
      </div>

      <div className="space-y-2 border-t border-border pt-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <Label>นำเข้าวันหยุดบริษัท</Label>
          <a
            href={ZOHO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] text-accent underline decoration-dotted underline-offset-2"
          >
            เปิด Zoho People ↗
          </a>
          <Input
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="w-20 font-mono"
            aria-label="ปีที่นำเข้า"
          />
        </div>
        <p className="text-[12px] text-muted">
          ที่ Zoho เปิด ตัวติดตามการลา → วันหยุด → เลือกช่วงทั้งปี แล้วคัดลอกตารางมาวางที่นี่
          วันที่บริษัทไม่ได้หยุดจะถูกคืนเป็นวันทำงานให้ด้วย
        </p>
        <textarea
          rows={4}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={"วางตารางจาก Zoho ที่นี่ หรือพิมพ์เอง:\n2026-01-02 วันหยุดปีใหม่"}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs focus:border-accent focus:outline-none"
        />
        <div className="flex gap-2">
          <Button
            disabled={!paste.trim() || preview.isPending}
            onClick={() => preview.mutate(false)}
          >
            {preview.isPending && <Spinner />} พรีวิว
          </Button>
          <Button
            variant="primary"
            disabled={!paste.trim() || preview.isPending}
            onClick={() => preview.mutate(true)}
          >
            นำเข้าเลย
          </Button>
        </div>
      </div>
    </section>
  );
}
