# Workload Report v2

เลือกช่วงวัน → กด **Generate** → กด **Submit** — จบ

AI (claude CLI) วิเคราะห์ git commits + ClickUp activity แล้วเขียน workload report ให้ครบทุกอย่าง:
เลือก task type เอง, จัดกลุ่มงานเอง, เขียนโน้ตภาษาไทย+ศัพท์เทคนิคอังกฤษ, และจัดชั่วโมงให้รวมเท่าเป้าที่ตั้ง (default 8h/วัน) เป๊ะเสมอ

## Stack

- **Next.js 16.3.1** (App Router, full-stack) + React 19 + Tailwind 4 + TanStack Query
- **Drizzle + better-sqlite3** (`data/app.db`) — ⚠️ Node เท่านั้น: ห้ามรันโค้ด DB ด้วย Bun runtime
  (better-sqlite3 crash ใต้ bun 1.2.x) — bun ใช้เป็น package manager, script รันผ่าน `tsx`
- **claude CLI** (`claude -p`) เป็น AI provider — ต้องมี `claude` บน PATH
- `.mcp.json` มี `next-devtools-mcp` สำหรับ debug ผ่าน Claude Code

## เริ่มใช้

```bash
bun install
bun run import:v1     # (ครั้งแรก) ดึง settings/projects/สำนวนเก่า จาก ../workload-report/data.db
bun run dev           # เปิด http://localhost:3000
```

หน้า **Settings**:

1. **JWT** (จำเป็นตอน Submit) — copy จาก `Authorization: Bearer …` ใน DevTools ของ workload site
   (หมดอายุแล้ววางใหม่ได้เลย แอปเตือนเอง; ระหว่างไม่มี JWT ใช้ปุ่ม **copy payload** ส่งเองได้)
2. **ClickUp** — ไม่ต้องตั้งค่า ใช้ MCP connector ที่ล็อกอินใน Claude อยู่แล้วโดยอัตโนมัติ
   (ใส่ personal token `pk_…` ได้ถ้าอยากให้ sync เร็วขึ้นผ่าน REST)
3. **Projects** — import จาก v1 ให้แล้ว; เพิ่มใหม่กดจากรายการ repo ที่สแกนเจอในเครื่อง
   (ดึง author email จาก git config ของ repo ให้เอง)

## การทำงาน

```
เลือกช่วงวัน (เสาร์-อาทิตย์/วันหยุดไทย = 0h อัตโนมัติ, แก้รายวันได้)
  → refresh evidence: git scan (incremental) + ClickUp sync + match ticket id
  → AI ต่อวัน (ขนาน ≤3, validate + repair ≤3 รอบ)
  → allocator (โค้ด ไม่ใช่ AI) บังคับชั่วโมงรวม = เป้าเป๊ะ; ขาด → เติม card "inferred"
  → รีวิว/แก้/gen ใหม่รายวัน → Submit ทั้งหมด (upsert กันซ้ำด้วย fingerprint + remote id)
```

- **Coverage panel** ท้ายหน้า: commit ที่ไม่ถูกอ้าง, task ปิดแล้วไม่มี card, วันหยุดที่มี commit
- ประวัติ AI ทุก call อยู่ในตาราง `ai_calls` (prompt + raw output) — replay/debug ได้
- Generate ค้าง (dev restart) → กด Generate ใหม่ได้เลย วันที่มี draft แล้วจะถูกข้าม
- claude CLI ล้มชั่วคราว (เช่นเพิ่ง `/login` แล้ว token หมุน) → retry อัตโนมัติพร้อม backoff
  3/10/30/60s; ถ้ายังพลาดจะมีปุ่ม **ลองใหม่เฉพาะวันที่พลาด** ในแถบแจ้งเตือน

## CLI

```bash
bun run generate -- --from 2026-08-01 --to 2026-08-20 --hours 8 [--submit]
```

## Dev

```bash
bun run test          # vitest — engine ทั้งหมดเป็น pure function + integration ด้วย FakeProvider
bun run lint
bun run db:generate   # หลังแก้ src/db/schema.ts
```

โครงสร้าง: `src/server/engine/*` (pure: allocator/validator/matcher/coverage/prompt/evidence),
`src/server/sources/*` (git/clickup/workload API), `src/server/pipeline.ts` (generate),
`src/app/api/*` (route handlers), `PLAN.md` (design + decisions)
