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

1. **โทเคน workload** (จำเป็นตอน Submit/เทียบ) — เปิด https://workloads.ketspace.io → DevTools →
   Application → Local Storage → คัดลอกค่า `workload.access_token` มาวาง
   (โทเคนเว็บอยู่ได้ 8 ชั่วโมง หมดแล้ววางใหม่ แอปเตือนเอง; วางแล้วแอปเช็ค `/auth/me` ว่าเป็นใคร
   ทุกรายการจะขึ้นในชื่อเจ้าของโทเคน ไม่ต้องตั้งชื่อ/อีเมลเอง; ระหว่างไม่มีโทเคนใช้ปุ่ม **copy payload** ส่งเองได้)
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
  → รีวิว/แก้/gen ใหม่รายวัน → Submit ทั้งหมด (POST /tasks/batch ทีละวัน: มี id = แก้, ไม่มี = สร้าง
    แล้วอ่าน my-day กลับมาเก็บ id จริง)
```

## workload API (workloads.ketspace.io)

- base `https://workloads.ketspace.io/api` (override ด้วย `WORKLOAD_API_BASE`), `Authorization: Bearer <โทเคนเว็บ>`
- อ้างอิง: `GET /task-types` (เฉพาะที่ตำแหน่งเราลงได้ตาม `positionIds`), `GET /projects` (เว็บลูกค้าจับคู่ด้วยโดเมน
  จากช่อง website ของการ์ด + internal อย่าง Ketshopweb/KetBill จับคู่ด้วยชื่อ), `GET /auth/me`
- อ่าน: `GET /tasks?from&to&limit&offset` (staff เห็นแค่ของตัวเอง, มี `legacyId` = id บนระบบเก่า),
  `GET /tasks/my-day?date` (ใช้อ่านกลับหลังเขียน; แถวใช้ `taskId`)
- เขียน: `POST /tasks/batch { workDate, items:[{ id?, taskTypeId, projectId, durationSec, title, note, clickupTaskId }], remove?:[id] }`
  — `title` = topic ของการ์ด, `note` = HTML ของการ์ด (เว็บเก็บโน้ตเป็น HTML)
- การ์ดที่เคยส่งขึ้นระบบเก่า (Jul–Aug 2026) ถูกย้ายมาแล้ว ปุ่ม **เทียบกับ workload** จับคู่ผ่าน `legacyId`
  แล้วเปลี่ยน remote id เป็นของใหม่ให้เอง

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
