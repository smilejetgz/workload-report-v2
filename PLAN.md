# workload-report-v2 — Implementation Plan (rev 2 — Next.js edition)

> เป้าหมาย: **เลือกช่วงวัน → กด Generate → กด Submit — จบใน 2-3 คลิก**
> AI คิดทุกอย่างให้ (task type, จัดกลุ่มงาน, ข้อความ, ชั่วโมงครบเป้า) — ของ advanced ซ่อนไว้เป็น secondary

## Decisions (locked)
| หัวข้อ | เลือก |
|---|---|
| Stack | **Next.js 16.3.1 full-stack** (App Router), React 19, Tailwind 4, TanStack Query |
| DB | Drizzle + better-sqlite3 (SQLite ที่ `data/app.db`) |
| Runtime | **Node เท่านั้น** — better-sqlite3 crash ใต้ Bun runtime (NAPI fatal, ยืนยันแล้วกับ bun 1.2.10) → CLI script รันด้วย `tsx`; bun ใช้เป็น package manager เท่านั้น |
| workload auth | JWT ของ workload เอง (`localStorage.token.access_token` บนเว็บ, ~792 chars) — **ไม่ใช่** Zoho `access_token` จาก URL `#authen` (ตัวนั้น API ตอบ 401/403) |
| ClickUp | **ปิดได้จากหน้าแรก** (ติ๊ก "ค้นใน ClickUp") — ปิดแล้วเขียนจาก commit อย่างเดียว เร็วขึ้นมาก · **ไม่ต้องตั้งค่า** — ดึงผ่าน claude.ai ClickUp MCP connector (headless `claude -p` + `--output-format stream-json`, อ่าน tool_result จาก transcript ตรง ๆ ไม่ให้โมเดล copy ข้อมูล) · ใส่ personal token `pk_…` ได้ถ้าอยากใช้ REST ที่เร็วกว่า |
| AI | `claude -p` CLI (stdin + `--output-format json`) ผ่าน provider interface + **FakeProvider สำหรับ test** |
| เวลาไม่พอเป้า | เติมอัตโนมัติ + badge `inferred` — **เฉพาะวันที่มีหลักฐาน**; วันที่ไม่มีหลักฐานเลย = เว้นว่าง ไม่แต่ง |
| ภาษา | ไทยเป็นฐาน + ศัพท์เทคนิคอังกฤษ (ยกกฎ prompt v1), ไม่ใส่ commit hash |
| MCP | `.mcp.json` ใส่ `next-devtools-mcp@latest` |
| **ลำดับหลักฐาน** | **commit มาก่อนเสมอ** — commit = งานจริง; ClickUp เป็นของเสริม (ใช้ตั้งชื่อ/บริบท/เติมเวลา) และถูกดึงตาม ticket id ที่เจอใน commit |
| **git user** | เลือกได้หลายคน (`settings.git_authors`, override ต่อ project ได้) — เอาแค่ commit ของเรา ของคนอื่นในทีมถูกข้ามทั้งตอน scan และตอนอ่านจาก DB |
| **ตัวตนตอน upload** | `task_by` / `email` ที่ส่งเข้า `create-task-list` เลือกจาก `/tasks/get-employee` และต้องเป็นคนเดียวกับ git user ที่เลือก (เตือนถ้าไม่ตรง) |

## Design system (rev 3 — จัดใหม่ทั้งหมด 21 ส.ค. 2026)
**แนวคิด: เครื่องมือวัด** — โจทย์จริงของแอปคือ "ชั่วโมงต้องลงตัวพอดีเป้า และทุกบรรทัดต้องมี commit หนุน"
ดีไซน์เลยพูดภาษาเดียวคือการวัดและหลักฐาน
- **Signature: hour meter** — แถบวัดที่มีขีดบอกชั่วโมง แบ่งเป็นช่วงตามแต่ละ card และไล่สีตามสถานะอัพโหลด
  ใช้ 2 ขนาด: ใหญ่ = ทั้งช่วง, เล็ก = รายวัน · เกินเป้าขึ้นเส้นแดงตรงเป้า ไม่ยืดแถบให้ดูเหมือนพอดี
  · ช่วงยาวเกิน 12 ชม. ขีดเปลี่ยนเป็นต่อวันแทนต่อชั่วโมง (ไม่งั้นกลายเป็นลายพื้น)
- **สี blueprint**: กระดาษเย็น + หมึกน้ำเงินดำ + น้ำเงินเข้มหนึ่งสีสำหรับปุ่มหลัก · สีอื่นสงวนไว้บอกสถานะ
  เขียว=อัพแล้ว / น้ำเงิน=ยังไม่อัพ / แดง=ไม่สำเร็จ / ส้ม=ต้องดู · light + dark + ปุ่มสลับธีม (จำค่าไว้, ไม่มีไฟกระพริบ)
- **ตัวอักษร**: IBM Plex Sans Thai (เนื้อความ) + Bai Jamjuree (หัวข้อ/ตัวเลขชั่วโมง) + IBM Plex Mono (ตัวเลข/รหัส)
- **layout**: 3 ขั้นชัด — ช่วงวันที่ → ตัวเลขรวม+meter → รายวัน → แถบส่งล่างจอ · เครื่องมือรอง (coverage,
  วันหยุด/วันลา, เทียบ workload, copy payload) ยุบไว้ท้ายหน้า ไม่แย่งเส้นทางหลัก
- **card เป็นแถวสมุดบัญชี**: ชั่วโมงคอลัมน์ซ้ายชิดขวา อ่านไล่ลงมาแล้วบวกเป็นเป้าได้ · ป้ายสถานะเหลือจุดเดียว
  · ป้าย "เติมให้" ติดเฉพาะ card ที่ไม่มี commit หนุน (กรณียกเว้นเท่านั้น)

## UX principle (สำคัญสุด — โจทย์ใหม่จากผู้ใช้)
**หน้าเดียวจบ ใช้ง่ายที่สุด:**
1. เลือกช่วงวัน (preset: วันนี้ / สัปดาห์นี้ / เดือนนี้ / custom) — ชั่วโมง/วัน default **8** แก้ได้แต่ไม่บังคับ
2. กด **Generate** → progress ต่อวัน, card โผล่สดทีละวันที่เสร็จ
3. กด **Submit ทั้งหมด** (confirm ครั้งเดียว) → เสร็จ

- เสาร์-อาทิตย์ + วันหยุดไทย (bundled list, แก้ได้) = 0 ชม. อัตโนมัติ — ผู้ใช้ไม่ต้องตั้งอะไร
- แก้ card / regenerate รายวัน / coverage / ปฏิทินวันลา / settings = secondary, กดเข้าไปดูเองเท่านั้น
- Happy path ต้องไม่มี form บังคับกรอกเลยนอกจากช่วงวัน

## Facts ที่ยืนยันแล้ว
- ClickUp member: `Tirajet Chukleang` / user id `89097306`; MCP ระดับ session ใช้ได้ (space `Ket-Bill`)
- ClickUp time entries ส.ค. 2026 = 0 รายการ ⇒ AI ต้องประมาณเวลาเอง
- commit/branch มี ticket id จริง (`DEV-6395` ×46, `DEV-6771`, `ISSUE-7709`) ⇒ ผูก commit↔task แบบ deterministic ได้
  · **ตัวจับ ticket id ต้องกัน false positive**: prefix เป็นตัวอักษรล้วน 2-10 ตัว (กัน `V8-7` จากเลขเวอร์ชัน),
  blocklist ศัพท์เทคนิค (ISO/SHA/RFC/UTF/… → กัน `ISO-8601`, `SHA-256`) และตัด `#` ที่เป็น CSS hex color
  (`#FFFFFF`, `#f5f6fa`) ออกจาก ClickUp ref · ของจริงเจอ 11 ตัวจาก 43 ที่ผิด = เสียเที่ยวค้น ClickUp ทุกครั้ง
  · `scripts/fix-ticket-ids.ts` ซ่อมข้อมูลเก่าได้
- ปริมาณ: ketcms 1,236 commits / 3 เดือน ⇒ ต้อง incremental scan + สรุปก่อนเข้า prompt
- better-sqlite3: Node OK / Bun runtime crash ⇒ กฎ Runtime ข้างบน
- v1 มีของ port ได้เลย: `workload-api.ts` (ครบทุก endpoint), กฎภาษาใน prompt, **cards ที่เคย submit จริงใน `data.db` ⇒ ใช้เป็น style corpus + กันซ้ำ**

## 1. Data model (Drizzle + SQLite, มี migration จริง)

**Config / sources**
- `projects` — path, name, enabled, author_email_filter, default_task_type, default_website
- `settings` (kv) — jwt, task_by, email, clickup_token, clickup_team_id, clickup_user_id,
  ai_model, default_daily_hours, rules_md (แก้ได้จาก UI)
- `task_types` — sync จาก workload API (`/tasks/get-tasktype`) → AI เลือกได้เฉพาะจาก list นี้
- `day_targets` — date PK, target_sec, kind(workday|half|weekend|holiday|leave), note
  (default: จ-ศ=8h, ส-อา+วันหยุดไทย=0 — bundled `thai-holidays.ts` เป็นแค่ค่าเริ่มต้น,
  **ทับด้วยปฏิทินบริษัทจาก Zoho People**)

**Evidence**
- `commits` — project_id, hash, author_date, branch, ticket_ids(json), files_summary(json), stats
- `clickup_tasks` — task_id PK, custom_id, name, status, status_type, list/folder/space, tags,
  assignees, url, date_created/updated/closed, due_date, priority, description, synced_at
- `clickup_events` — task_id, kind(comment|closed|updated), at, actor_id, text
- `commit_task_links` — commit_hash, project_id, task_id, source(**id_match|manual** — ตัด semantic:
  การโยงแบบ fuzzy ให้ AI ทำตอน generate แล้ว validator ตรวจว่า id อ้างจริง), confidence
- `style_examples` — note_html + task_type + duration จาก v1 submitted cards + ที่ submit ผ่าน v2 (few-shot)

**Planning / audit**
- `runs` — from/to, params(json), status, error, progress(json), **heartbeat_at** (resume ได้:
  generate ใหม่เฉพาะวันที่ยังไม่มี cards), created_at, finished_at
- `ai_calls` — run_id, date, attempt, prompt, raw_output, duration_ms, status (audit + replay รายวัน)
- `cards` — run_id, tasks_date, duration_sec, topic, note_html, task_type, website, clickup_task,
  origin(git|clickup|inferred|manual), confidence, evidence(json), time_of_day, fingerprint,
  status(draft|approved|submitted|failed), remote_task_id, error, approved_at, submitted_at
- `card_versions` — snapshot json ต่อการแก้ (undo / เทียบก่อน-หลัง)

## 2. Layout (Next.js)
```
.mcp.json                # next-devtools MCP
next.config.ts           # serverExternalPackages: ["better-sqlite3"]
data/app.db              # gitignored
src/
  db/       schema.ts  client.ts  migrate.ts  + drizzle migrations
  server/   (import "server-only")
    sources/  git.ts  clickup.ts  workload.ts   # workload.ts port จาก v1
    engine/   evidence.ts  prompt.ts  allocator.ts  validator.ts  coverage.ts  matcher.ts
    ai/       provider.ts  cli.ts  fake.ts
    runs.ts   # in-process job orchestration + heartbeat + resume
  app/
    page.tsx               # หน้าเดียวจบ
    settings/  page.tsx
    api/  generate/  runs/[id]/  cards/  submit/  settings/  projects/  evidence/  day-targets/
scripts/  generate.ts  import-v1.ts   # รันด้วย tsx (Node) เท่านั้น
```
กฎ: `matcher / allocator / validator / coverage / prompt` = pure function → vitest ได้ไม่ต้องยิง AI

## 3. Generate pipeline (POST /api/generate → run แบบ async, UI poll /api/runs/[id])
0. **Guard** — ช่วง ≤ 62 วัน
1. **Resolve targets** — จ-ศ 8h default, ส-อา/วันหยุดไทย/วันลา = 0 (แก้รายวันได้)
2. **Preflight dedup** — ดึง remote tasks ในช่วงจาก workload API มาเทียบ (กันซ้ำแม้กรอกเองนอกระบบ)
3. **Refresh evidence** — git incremental scan + ClickUp sync (date_updated_gt, ±7 วัน, ระวัง rate limit 100/min)
4. **Match** — ticket id ใน commit/branch → task ตรง ๆ (id_match เท่านั้น)
5. **Evidence pack ต่อวัน** — **PRIMARY: commits** (เช้า/บ่าย + top files/dirs) แล้วค่อย
   **SUPPLEMENTARY: ClickUp** (tasks ปิด/comment ของเรา/task ค้าง) โดยเรียง task ที่ commit อ้างถึงขึ้นก่อน
   และตัด task ที่ไม่เกี่ยวลงเหลือ 6 รายการเมื่อวันนั้นมี commit; ปิดท้ายด้วย remote tasks ที่มีแล้ว
5b. **Evidence gate** — `hasDayEvidence()`: commit / task ที่ปิดวันนั้น / comment ที่เราเขียนวันนั้น
   เท่านั้นที่นับเป็นหลักฐาน · **task ที่ค้าง (in progress) ไม่นับ** (ค้างมาเป็นเดือนก็ยังโผล่)
   ไม่มีหลักฐาน → `dayStatus: "empty"`, ไม่เรียก AI, ไม่สร้าง card, coverage ขึ้น `empty` ให้เห็นว่าขาดชั่วโมง
   · UI อธิบายเหตุผล + ทางออก (ตั้งเป็นวันลา / เพิ่ม card เอง / gen ใหม่หลัง push)
   > ทำไม: การแต่ง 8 ชม. จาก backlog = ใส่งานที่ไม่ได้ทำจริงเข้ารายงานบริษัท และมันแยกไม่ออกจากกรณี
   > "scan ไม่เจอ" (repo หาย / project ปิด / author filter ผิด) ซึ่งอันตรายกว่า
5c. **Regenerate scope** — ส่ง `regenerateDates` มาเมื่อไหร่ = "ทำใหม่เฉพาะวันเหล่านี้"
   ช่วงที่ใช้ทั้ง sync/preflight/queue หดเหลือ min..max ของวันที่ขอ
   > บั๊กเดิม: `workDays` เอาทุกวันในช่วง วันที่มี card อยู่แล้วถูก skip แต่**วันที่ยังว่างถูกสร้างใหม่หมด**
   > กด "สร้างใหม่" วันเดียวจึงกลายเป็นสร้างทั้งเดือน
6. **AI ต่อวัน** (parallel ≤3, timeout + retry 2) · UI มีหน้าต่างลอย 2 แท็บ:
   แถววันมีสถานะตั้งแต่วินาทีแรก: **อ่านหลักฐาน** (หมุน + meter pulse ระหว่าง sync ซึ่งกินเวลาเป็นนาที
   ตอนดึง ClickUp) → **รอคิว** → **กำลังเขียน** (มี skeleton) → เสร็จ/ไม่มีหลักฐาน/ไม่สำเร็จ
   · เดิม `dayStatus` ถูกคิดหลัง sync เสร็จ แถวจึงว่างเปล่าดูเหมือนค้าง
   · และช่วง **ตั้งแต่กดปุ่มจนกว่า server จะตอบ** (วัดได้ 870ms บนเครื่องนี้ นานกว่านั้นถ้า route ยัง compile)
   ไม่มีอะไรขยับเลย — แก้โดยถือว่า run เริ่มทำงานตั้งแต่คลิก (`generate.isPending`) ปุ่ม/หน้าต่าง/แถววัน
   จึงตอบสนองทันทีในเฟรมถัดไป (~200ms) ก่อนจะมี run row ให้อ่านด้วยซ้ำ
   **ทุกขั้นตอน** = log สดพร้อมเวลา (อ่าน git รายโปรเจกต์ / ClickUp เชื่อมไม่ได้ / เรียก AI ครั้งที่ n /
   token+model+ราคาต่อครั้ง / validator แก้อะไร / รอ retry กี่วินาที / สรุป token รวม)
   และ **รายวัน** = สถานะแต่ละวัน · ย่อได้ ยกเลิกได้ และเปิดย้อนหลังได้จากลิงก์ "บันทึกรอบล่าสุด"

### บันทึกและ token
- `runs.progress.log` เก็บสูงสุด 300 บรรทัด (`appendLog` ตัดของเก่าออก) — ไม่ต้องมีตารางใหม่
- `ai_calls` เก็บ `model / input_tokens / output_tokens / cache_read_tokens / cache_creation_tokens /
  cost_usd` ต่อการเรียกทุกครั้ง (migration 0002) · อ่านจาก envelope ของ `claude -p --output-format json`
  ทั้ง `usage` และ `modelUsage` (ชื่อโมเดลอยู่ใน modelUsage เท่านั้น)
- **fix: หน้าต่างขึ้นบ้างไม่ขึ้นบ้าง** — 2 สาเหตุ: (1) `latestRun` ดึงครั้งเดียว (`staleTime: Infinity`)
  + `manualRunId` ปักหมุด run เก่าไว้ตลอด → run ที่เริ่มจากที่อื่นไม่ถูกจับ (2) **React Query หยุด poll
  เมื่อหน้าต่างไม่ได้ focus** (`refetchIntervalInBackground` default false) + `refetchOnWindowFocus: false`
  → สลับไปหน้าต่างอื่นแล้วข้อมูลค้าง แก้โดย poll `latestRun` ทุก 2 วิ, ให้ run ที่ทำงานอยู่ชนะเสมอ,
  และเปิด `refetchIntervalInBackground` ทั้งสอง query → JSON DayPlan; **insert cards ทันทีที่วันเสร็จ** (UI เห็นสด)
7. **Validate + repair** — task_type ∈ list, evidence id อ้างจริง, **ทุก commit ของวันต้องมี card อ้างถึง
   + ต้องมี card origin `git` อย่างน้อย 1 ใบ** (ไม่ครบ = repair), allocator บังคับชั่วโมง = เป้าเป๊ะ
   (step 15 นาที, card 0.5–4h, 2–5 cards/วัน), ขาด → เติม inferred, กันซ้ำกับ submitted + remote
8. **Coverage report** — commit ไม่ถูกอ้าง, task ปิดแล้วไม่มี card, วันขาดชั่วโมง, **มี evidence วันหยุด → เสนอให้เพิ่ม**

## 3b. วันหยุด / วันลา
- `PUT/DELETE /api/day-targets` รับทั้ง `date` เดียวและช่วง `from`+`to` — ลา 5 วันคือ action เดียว
  · `expandTargetRange()` ข้ามเสาร์-อาทิตย์/วันหยุดในช่วงให้อัตโนมัติ (ไม่เผาวันลาไปกับวันเสาร์)
  · `includeNonWorkdays` สำหรับกรณีบริษัทหยุดยาวทั้งช่วง
- **นำเข้าปฏิทินบริษัทจาก Zoho People** (`POST /api/holidays`, ตัวติดตามการลา → วันหยุด → copy ตารางมาวาง)
  · `parseHolidayText()` อ่านได้ทั้งตารางที่ copy มา (รวม row หลายวันแบบสงกรานต์) และรูปแบบ `YYYY-MM-DD ชื่อ`
  · `planHolidayImport()` เขียนวันหยุดของบริษัท **และคืนวันที่ bundled list เดาว่าหยุดแต่บริษัทไม่หยุด
  กลับเป็นวันทำงาน** — ไม่งั้นระบบจะไม่เคยขอชั่วโมงของวันนั้นเลย · มีปุ่มพรีวิวก่อนเขียน
  > ผลจริงปี 2026: bundled ผิด 8 วัน — บริษัทหยุด 2026-01-02 (ไม่ใช่ 01-01) + 12-30, และ**ทำงาน**
  > วันมาฆบูชา/ฉัตรมงคล/วิสาขบูชา/อาสาฬหบูชา/เข้าพรรษา/รัฐธรรมนูญ

## 4c. เขียนให้ HR อ่านรู้เรื่อง
รายงานนี้คนอ่านคือ HR และหัวหน้าที่ไม่ได้เขียนโค้ด — prompt จึงสั่งให้เขียน **ผลลัพธ์ของงาน**
(ผู้ใช้/ลูกค้าทำอะไรได้เพิ่ม หรือปัญหาอะไรหายไป) ห้ามใส่ชื่อไฟล์ ฟังก์ชัน คอลัมน์ branch flag
หรือรหัสสถานะภายใน · ชื่อสินค้า/ฟีเจอร์ที่บริษัทใช้จริง (Ket-CMS, LINE OA, ClickUp, Order) เก็บไว้ได้
- **validator บังคับจริง** ไม่ใช่แค่ขอ: ตก repair ถ้าเจอ `snake_case`, path ไฟล์, หรือ `func()`
  · ตั้งใจไม่แบน camelCase เพราะชื่อสินค้าจริงเป็น camel (LineShop, ClickUp)
- **style example ต้องคุมด้วย**: corpus จาก v1 เต็มไปด้วยชื่อฟังก์ชัน ถ้าไม่บอกโมเดลจะลอกสไตล์เดิมกลับมา
  → เปลี่ยน label เป็น "copy their SHAPE only ... do NOT copy their wording"
> ของจริงก่อนแก้: `เพิ่ม flag ignore_group_cover ใน search_front พร้อม util และ unit test`
> หลังแก้: `ชื่อสินค้าบนหน้าจอขายอ่านง่ายขึ้น ไม่ยาวเกินช่อง`

## 4b. ClickUp link (deterministic — ไม่ให้ AI เดา)
`engine/clickup-link.ts`: หลัง generate → ไล่ ticket id จาก **commit ที่ card อ้างถึง** (มากสุดชนะ) →
fallback เป็น `clickup_task` ที่โมเดลใส่ → fallback `evidence.tasks` → map กับ `clickup_tasks` ที่ sync ไว้จริง
→ เก็บ `cards.clickup_task` (custom id, ตรงกับที่ workload API รับ) + `cards.clickup_url` (คอลัมน์ใหม่, migration 0001)
**ถ้า resolve ไม่ได้ = ไม่ทำอะไร (null) ไม่มีการเดา url** · UI โชว์เป็นลิงก์กดได้
> เหตุผลที่ต้อง deterministic: v1 73 cards / v2 4 cards **clickup_task เป็น null ทั้งหมด** — ปล่อยให้โมเดลกรอกแล้วไม่เคยติด

## 4. AI contract (JSON เท่านั้น — เดิมจาก rev 1 ทั้งหมด) + เพิ่ม
- **Dry-run mode**: preview prompt ได้จาก UI โดยไม่ยิง AI (debug/จูน rules_md)
- Few-shot จาก `style_examples` (import จาก v1 + สะสมจากที่ submit ผ่าน v2)

## 5. Submit + แก้/ลบหลัง submit (two-way sync)
- ปุ่มเดียว **Submit ทั้งหมด** + confirm; รายใบก็ได้ (secondary)
- Upsert idempotent: fingerprint + remote_task_id (มี id → `update-task`, ไม่มี → `create-task-list` แล้ว re-fetch จับคู่เก็บ id)
- **แก้ card ที่ submit แล้ว → push `update-task/{id}` ทันที**; push ไม่ผ่าน = คงการแก้ไว้ในแอบแต่ mark `failed`
  + error (list จะไม่โกหกว่า workload มีของที่ยังไม่ได้ส่ง)
- **ลบ card ที่ submit แล้ว → ลบที่ workload ก่อน** แล้วค่อยลบ local (`?localOnly=1` เป็นทางออกฉุกเฉิน)
  · endpoint `DELETE /tasks/delete-task/{id}` — **verify กับ API จริงแล้ว 21 ส.ค.** (`POST /tasks/delete-task`,
  `/tasks/task/{id}`, `/tasks/remove-task/{id}` = 404 ทั้งหมด)
- **กับดักที่เจอ: API ตอบ HTTP 200 พร้อม `{"data": <rows affected>}` แม้ id ไม่มีอยู่** → `res.ok` เชื่อไม่ได้
  · `affectedRows()` + `decideWriteOutcome()` แยก 3 กรณี: >0 = สำเร็จ / 0 แต่ยังเจอแถว = no-op (ถือว่าสำเร็จ) /
  0 และไม่เจอแถว = ถูกลบที่ปลายทาง (คืนเป็น draft ให้ส่งใหม่); เช็คซ้ำไม่ได้ = ไม่เดา ไม่ลบ
- **`DELETE /api/cards {from,to}` — ล้างรายการที่ยังไม่ได้อัพ**: ลบเฉพาะ card ที่ `status ≠ submitted`
  **และไม่มี `remote_task_id`** (= ไม่เคยขึ้น workload) · card ที่ถือ remote id ไว้ไม่ถูกแตะ เพราะอาจมีแถวจริง
  อยู่ปลายทาง ต้องลบทีละใบซึ่งจะลบบน workload ให้ด้วย · UI มีปุ่มพร้อมจำนวนและขั้นยืนยัน
- **`POST /api/reconcile` — list ต้องตรงกับตัวจริง**: ดึง `search-tasks` ของช่วงนั้นมาเทียบ (planner pure ที่
  `engine/reconcile.ts`) → ผูก id ที่ขาด / อัปเดตตามของจริงเมื่อ drift / ดึงแถวที่กรอกบนเว็บเข้ามาเป็น card
  (`origin: manual`) / แถวที่หายจาก workload = กลับเป็น draft + error · รันอัตโนมัติหลัง submit และมีปุ่ม
  "ซิงก์กับ workload"
- **JWT หมดอายุ → ตรวจ 401 → แถบ "วาง JWT ใหม่" + fallback "Copy payload"** (ยกพฤติกรรม v1)

## 6. Testing
- vitest: allocator / validator / coverage / matcher (pure) + prompt snapshot
- integration: pipeline เต็มด้วย **FakeProvider** — ไม่ยิง AI จริง
- smoke ท้ายงาน: generate 1 วันจริงด้วย claude CLI

## 7. Phases (สถานะ 20 ส.ค. 2026)
| P | งาน | สถานะ |
|---|---|---|
| P1 | scaffold + db/migrations + settings + workload client (port) + git source + `.mcp.json` | ✅ |
| P2 | ClickUp source + sync + id matcher + **import-v1** (settings/projects/style corpus) + tests | ✅ (รอ token จริงเพื่อทดสอบ ClickUp sync) |
| P3 | engine + FakeProvider + validator/allocator + tests (45 ผ่าน) | ✅ |
| P4 | /api/generate + runs/heartbeat/resume + coverage + CLI (tsx) | ✅ (smoke จริง 19 ส.ค. = 4 cards/8h เป๊ะ) |
| P5 | **UI หน้าเดียว 2-3 คลิก** + secondary tools (edit/regenerate/coverage/calendar) | ✅ (dark mode ด้วย) |
| P6 | polish ต่อได้: recurring templates (ประชุมประจำ), undo UI จาก card_versions, keyboard shortcuts | ⏳ เหลือเป็น backlog |
| P7 | **commit-first priority + git author multi-select + identity link ↔ create-task-list** (89 tests) | ✅ 21 ส.ค. 2026 |
| P18 | **เขียนให้ HR เข้าใจ** (prompt + validator บังคับ) · **ติ๊กเลือกได้ว่าจะค้น ClickUp ไหม** (199 tests) | ✅ 21 ส.ค. 2026 |
| P17 | **fix: ระหว่าง sync แถววันไม่มี loading** — คิดรายการวันก่อนอ่านหลักฐาน (187 tests) | ✅ 21 ส.ค. 2026 |
| P16 | **fix: ticket id จับผิด** (hex color, ISO-8601, V8-7) + สถานะรายวัน กำลังเขียน/รอคิว (186 tests) | ✅ 21 ส.ค. 2026 |
| P15 | **บันทึกทุกขั้นตอนแบบสด + token/model/ราคา ต่อครั้งและรวม** · fix: หน้าต่างขึ้นบ้างไม่ขึ้นบ้าง (178+ tests) | ✅ 21 ส.ค. 2026 |
| P14 | **fix: "สร้างใหม่" รายวันสร้างทั้งช่วง** + หน้าต่างสถานะตอน AI เขียน + ปุ่มล้างรายการที่ยังไม่ได้อัพ (167 tests) | ✅ 21 ส.ค. 2026 |
| P13 | **UX/UI ใหม่ทั้งหมด** (design system + meter + ธีม) · แก้บั๊ก HTML entity ใน stripHtml (161 tests) | ✅ 21 ส.ค. 2026 |
| P12 | **วันหยุด/วันลาเป็นช่วง + import ปฏิทินบริษัทจาก Zoho People** (155 tests) | ✅ 21 ส.ค. 2026 — นำเข้าจริง 14 วันหยุด, คืน 7 วันเป็นวันทำงาน |
| P11 | **empty-day policy: ไม่มีหลักฐาน = เว้นว่าง** + wire commit-coverage validator ที่เดิมไม่เคยถูกเรียก (136 tests) | ✅ 21 ส.ค. 2026 — รันจริง 21 ส.ค. ได้ `empty`, 0 cards |
| P10 | **security: note_html sanitizer bypass + untrusted remote notes** (128 tests) | ✅ 21 ส.ค. 2026 |
| P9 | **ClickUp link deterministic (id + url) + สถานะ อัพแล้ว/ยังไม่อัพ/อัพไม่สำเร็จ** (118 tests) | ✅ 21 ส.ค. 2026 — generate จริง 20 ส.ค. ได้ url ครบทุกใบ |
| P8 | **two-way sync**: แก้/ลบหลัง submit ไปถึง workload + reconcile list ให้ตรงของจริง (104 tests) | ✅ 21 ส.ค. 2026 — verify กับ API จริง: employee 30 (active 22), reconcile ส.ค. เจอ 4 แถวจริง, task_by ปรับเป็น `Tirajet` ตาม directory |

## 8b. Security — note_html เป็น untrusted input ทุกทาง
`note_html` ถูก render ด้วย `dangerouslySetInnerHTML` และมาจาก 3 แหล่งที่เชื่อไม่ได้: โมเดล,
**คนอื่นในทีมพิมพ์ผ่านเว็บ workload** (ดึงกลับมาตอน reconcile), และ v1 DB
- `lib/sanitize.ts` เขียนใหม่เป็น tokenizer: allowed tag → canonical form, tag อื่น → ตัดทั้งก้อน,
  `<` ที่ไม่ใช่ tag → escape เป็น `&lt;` — **การ escape คือหัวใจ** เพราะแบบเดิม (regex ลบ tag อย่างเดียว)
  ข้อความรอบ ๆ ปิดกลับมาเป็น tag ใหม่ได้: `<` + `<img …>` ที่ถูกลบ + `img …>` = `<img onerror>` ที่รันจริง
- sanitize ทุกทางเข้า DB: validator (AI), PATCH card, **reconcile import + update-local**, `import-v1.ts`
  · sanitize ที่ `remoteFields()` ไม่ใช่ตอน write เพื่อให้เทียบ drift แบบต่อแบบ (ไม่งั้น sync จะแก้ card เดิมวน)
- sanitize ซ้ำตอน render (แถวเก่าที่บันทึกก่อนมีกฎนี้)

## 8. ความเสี่ยง / การรับมือ
- AI ตอบไม่ตรง schema → zod validator + repair loop 2 รอบ; ชั่วโมงบังคับด้วย allocator (โค้ด) เสมอ
- **claude CLI ล้มชั่วคราว** (re-login หมุน token / rate limit / timeout) → แยกเป็น `ClaudeCliError`
  retry แยกโควตา 4 ครั้ง backoff 3/10/30/60s ไม่กิน repair budget และไม่ส่ง repair note ที่ไม่เกี่ยว
  + ปุ่ม "ลองใหม่เฉพาะวันที่พลาด" ใน UI
- Next dev HMR ฆ่า run กลางทาง → heartbeat + resume เฉพาะวันที่ยังไม่มี cards
- ClickUp ไม่มี activity history API → ใช้ date_closed/updated + comments เป็น proxy
- เขียนซ้ำ → preflight remote + fingerprint + upsert
- commit เยอะ → incremental scan + สรุปก่อนเข้า prompt

## P7 — จุดที่แก้ (21 ส.ค. 2026)
- `engine/evidence.ts` — commits = PRIMARY, ClickUp = SUPPLEMENTARY; task ที่ commit อ้างถึงขึ้นก่อน + ป้าย
  `← linked to today's commits`; ใส่ชื่อไฟล์จาก commit เข้า evidence
- `engine/prompt.ts` — บล็อก "Evidence priority" + list hash ที่ต้องครอบคลุมทั้งหมด
- `engine/validator.ts` — เช็ค commit coverage / ต้องมี card origin `git`
- `sources/git.ts` — `listAuthors` / `parseAuthorLog` / `isMyCommit` + `scanCommits({ authorFilters })`
  (หลาย `--author` + กรองซ้ำด้วย email/name เป๊ะ)
- `server/authors.ts` — resolve filter ต่อ project แล้วกรอง commit ทั้งตอน scan และตอนอ่าน (pipeline / coverage / dry-run)
- `engine/identity.ts` + `/api/employees` + `/api/git-authors` + `components/IdentitySection.tsx` — เลือก git user
  หลายคน, เลือก employee จาก workload, เตือนเมื่อ `task_by`/`email` ไม่ตรงกับ git user ที่เลือก
- `tests/` — evidence, git-authors, identity, submit-payload (pin field ของ create-task-list)

## ค้างจากผู้ใช้ (ไม่ block จนถึง P2)
- ClickUp personal token `pk_…` → `.env` (`CLICKUP_TOKEN`) หรือหน้า settings
- workload JWT — import จาก v1 `data.db` ให้อัตโนมัติ (`scripts/import-v1.ts`); หมดอายุค่อยวางใหม่
