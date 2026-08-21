const THAI_DAYS = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const THAI_MONTHS = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

export function formatThaiDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${THAI_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${THAI_MONTHS[d.getUTCMonth()]}`;
}

export function formatHours(sec: number): string {
  const hours = sec / 3600;
  return Number.isInteger(hours) ? `${hours}` : hours.toFixed(2).replace(/\.?0+$/, "");
}

export function todayYMD(): string {
  const now = new Date();
  return new Date(now.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

export function startOfMonthYMD(): string {
  return `${todayYMD().slice(0, 8)}01`;
}

export function startOfWeekYMD(): string {
  const today = todayYMD();
  const d = new Date(`${today}T00:00:00Z`);
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // Monday-based
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}

export function prevMonthRange(): { from: string; to: string } {
  const today = todayYMD();
  const d = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
  d.setUTCDate(0); // last day of previous month
  const to = d.toISOString().slice(0, 10);
  return { from: `${to.slice(0, 8)}01`, to };
}

export const KIND_LABELS: Record<string, string> = {
  workday: "วันทำงาน",
  half: "ครึ่งวัน",
  weekend: "เสาร์-อาทิตย์",
  holiday: "วันหยุด",
  leave: "วันลา",
};

export const ORIGIN_STYLES: Record<string, { label: string; className: string }> = {
  git: { label: "git", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  clickup: { label: "clickup", className: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  inferred: { label: "เติมให้", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  manual: { label: "แก้เอง", className: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
};

// ---------------------------------------------------------------------------
// Upload state: the one thing you must be able to read off a row at a glance —
// is this on workload or not? Derived from the card's status plus whether we
// hold the id of the real remote row.
// ---------------------------------------------------------------------------

export type UploadState = "uploaded" | "pending" | "failed";

export type UploadBadge = { state: UploadState; label: string; className: string };

const UPLOAD_BADGES: Record<UploadState, Omit<UploadBadge, "state">> = {
  uploaded: { label: "อัพแล้ว", className: "bg-ok/15 text-ok" },
  pending: { label: "ยังไม่อัพ", className: "bg-surface-2 text-muted" },
  failed: { label: "อัพไม่สำเร็จ", className: "bg-danger/15 text-danger" },
};

export function uploadBadge(card: {
  status: string;
  remoteTaskId?: string | null;
}): UploadBadge {
  if (card.status === "failed") return { state: "failed", ...UPLOAD_BADGES.failed };
  if (card.status === "submitted") {
    // Submitted but with no remote id: the row is up there, we just could not
    // match it back — say so instead of pretending it is fully linked.
    const label = card.remoteTaskId ? UPLOAD_BADGES.uploaded.label : "อัพแล้ว (ยังไม่ผูก id)";
    return { state: "uploaded", ...UPLOAD_BADGES.uploaded, label };
  }
  return { state: "pending", ...UPLOAD_BADGES.pending };
}

export function countUploadStates(cards: { status: string; remoteTaskId?: string | null }[]): {
  uploaded: number;
  pending: number;
  failed: number;
} {
  const counts = { uploaded: 0, pending: 0, failed: 0 };
  for (const card of cards) counts[uploadBadge(card).state] += 1;
  return counts;
}
