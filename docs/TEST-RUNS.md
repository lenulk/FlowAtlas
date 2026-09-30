# บันทึกการรันทดสอบ

## Linux VM preparation — 2026-09-30

- ผู้ใช้ระบุให้ทดสอบผ่าน SSH บน VM; เชื่อมต่อสำเร็จเป็น Debian GNU/Linux 12 / kernel 6.1.0-53-amd64 / x86_64 ไม่มี Node.js/Git ใน PATH และไม่มี project shared folder ที่ตรวจพบ
- ตรวจ WSL ก่อนคำชี้แจง VM: sandbox ปฏิเสธ enumerate ด้วย E_ACCESSDENIED; read-only check นอก sandboxพบ Kali WSL2 หยุดอยู่ ไม่ใช้เป็นผล Linux VM
- พบ VMware CLI แต่ไม่มี VM ที่ running ในรายการของ CLI; ไม่ใช้ข้อมูลนี้แทน VM ที่ผู้ใช้ระบุผ่าน SSH
- Probe official Node v24.18.0 checksum URL: web tool เปิดไม่ได้ แต่ wget บน VM ตรวจ URL สำเร็จ (exit 0); จะ verify checksum ก่อนใช้ runtime
- ยังไม่เริ่มชุดทดสอบ Linux ในขั้นนี้ ไม่เก็บ credential ในโค้ดหรือรายงาน

## Linux VM main — 2026-09-30T14-00-32-338Z

- จุดประสงค์: Linux VM Debian 12: main integration suite
- ผลบน VM: ผ่าน 47/47; failed 0; skipped 0; runner exit 0
- Runtime: Linux x86_64 / Node v24.18.0; Git 2.39.5; source commit `530e221945e5aa13d29c6c938337580c506d6a59`
- เตรียม Git จาก official Debian repositories (ใช้ sources list ชั่วคราวเฉพาะ apt command), Node จาก official archiveใน QA directory; Node archive และ Git bundle SHA-256 ตรวจผ่านก่อนรัน
- หลักฐาน: VM runner บันทึก TAP/JSON อัตโนมัติ; กำลังนำ raw reports กลับโฟลเดอร์โครงการ

## Linux VM source — 2026-09-30T14-01-44-229Z

- จุดประสงค์: Linux VM Debian 12: isolated source snapshot and restart
- ผลบน VM: ผ่าน 1/1; failed 0; skipped 0; runner exit 0
- ตรวจ source content/hash, changed/deleted files, graph รุ่นเดิมหลัง restart และปฏิเสธการเติมเหตุการณ์ข้าม code snapshot
- ผลนี้เป็น Linux VM จริง แยกจาก Windows browser UI test; กำลังนำ TAP/JSON กลับไว้ใน reports/tests

## Linux report import tool failure — 2026-09-30

- SCP รับ archive กลับสำเร็จ และ SHA-256 ของ archive ตรง VM
- Windows tar.exe เปิด archive ด้วย absolute path ที่มีอักษรไทยไม่สำเร็จ (filename ถูกแสดงเป็น ?); ยังไม่ได้แตกไฟล์หรือเขียนทับ raw reports
- แก้ขั้นตอนนำเข้าให้ tar ใช้ relative ASCII paths จาก project cwd; PowerShell checksum/file operations ยังคงใช้ LiteralPath ตามเดิม
- ผลหลังใช้ relative paths: แตกไฟล์และนำเข้า TAP/JSON 4 ไฟล์สำเร็จ ตรวจ archive SHA-256 และ file checksums ตรง VM; metadata ระบุ linux/x64, Node v24.18.0, kernel 6.1.0-53-amd64 และ commit ที่ทดสอบถูกต้อง
- หลักฐานกลับมาแล้วที่ reports/tests และ `reports/vm/linux-2026-09-30T14-00-32-338Z/`; ตรวจ VM ไม่เหลือ Node process/writer lock และปิด SSH session สำเร็จ
- Final review: actual diff/runner syntax/git diff --check ผ่าน; local documentation links 22 ลิงก์มีปลายทางครบ
## Final registered-project review — 2026-09-30

- อ่าน actual diff รวม registration/adapter/template/tests และตรวจด้วย `node --check`: syntax 32 ไฟล์ผ่าน; `git diff --check` ผ่าน
- local documentation links 18 ลิงก์มีปลายทางครบ; เอกสารแยก fixture เก่า/ใหม่และขอบเขต trace ตามหลักฐาน
- ตรวจ JSON ของชุดหลัก `2026-09-30T13-28-10-353Z`: 47 passed / 0 failed / 0 skipped; isolated source `2026-09-30T13-31-58-491Z`: 1 passed / 0 failed / 0 skipped
- manual storage ยังมี 3 actions และไม่มี writer lock; target Git working tree สะอาด commit `0c40ee2`; QA servers ปิดแล้ว
- เปิดตรวจภาพกราฟและ outage ทั้งสองไฟล์: ข้อความ/หลักฐานอ่านได้ ไม่มีส่วนสำคัญถูกตัด
- ไม่มีการอ้างว่าทดสอบแอปธุรกิจจริง, source UI ใน browser อื่น, OpenTelemetry SDK, Playwright trace capture หรือ production readiness

## Registered app UI — 2026-09-30T13:18Z

- สร้าง `apps/message-app` ด้วย `node scripts/create-target-app.mjs` สำเร็จ ลงทะเบียน local config และสร้าง Git repository แยก commit `fa217e0`
- เปิด collector QA (4173/4174) กับ storage `reports/storage/registered-ui-a9a33b0f-52e3-4cbf-93f7-4945073f15d6` และ target (4190/4191) คนละ Node process
- เบราว์เซอร์จริง: ดูข้อความได้ HTTP 200 / MSG-1, action `5cc07407-9944-4f9a-b87f-defa3da3fda9`, มี viewer link และไม่มีคำเตือน capture ขาด
- เบราว์เซอร์จริง: ส่งข้อความได้ HTTP 200 / MSG-1, action `70297721-fc8e-48cf-a3bf-0bc4974b4a02`, มี viewer link และไม่มีคำเตือน capture ขาด
- เบราว์เซอร์จริง: ทดลองบริการล้มเหลวได้ HTTP 503 / Message service unavailable, action `202d026f-13d5-4654-862c-582e620c0467`, มี viewer link และ capture ครบ
- เปิดกราฟ error ผ่านเบราว์เซอร์: 5 nodes / 4 edges, observed 3 + unknown 1, รายการย้อนหลัง 3 actions; handler evidence ระบุ service message-app และ source server.mjs ของแอปเป้าหมาย
- ส่ง restart แล้ว retained 3; reload เบราว์เซอร์ยังเปิด error graph เดิมและ source link เดิมได้ ภาพ `reports/ui/registered-project-graph.png`
- ข้อจำกัดการตรวจ source ผ่าน UI: in-app browser ปฏิเสธเปิด URL source ด้วย ERR_BLOCKED_BY_CLIENT; ไม่ข้ามข้อจำกัดเบราว์เซอร์ การส่ง source content/status ตรวจผ่าน HTTP integration tests (200/hash match และ 409 เมื่อไฟล์เปลี่ยน)
- ปิด collector ด้วย stop (exit 0) แล้วกดดูข้อความใน target: HTTP 200 / MSG-1, action `b96ce1a5-f4ba-440f-8989-039ac5a1051a`, แจ้ง capture ไม่ครบและซ่อน viewer link ภาพ `reports/ui/registered-project-outage.png`
- ปิด target ด้วย stop: exit 0; หลัง manual QA อัปเดต SDK type guards และ named handler functions ในสำเนา apps/message-app พร้อมตรวจ repository สะอาดก่อนเขียนทับและ commit แยก ข้อมูล/ภาพ manual เก็บ snapshot ก่อนอัปเดตไว้ตามจริง
## External repository harness failure — 2026-09-30T13:06Z

- คำสั่ง: `node scripts/run-tests.mjs test/external-repository.test.mjs`
- ผล: ไม่ผ่านและต้องหยุด runner — child ไม่จบด้วย exit 0 ภายใน 5 วินาที จึงถูก timeout kill; assertion ใน cleanup ทำให้ collector ไม่ถูกปิดและ runner ค้าง ไม่มีรายงาน JSON อัตโนมัติ
- การตรวจ process ด้วย `Get-CimInstance Win32_Process` ถูกปฏิเสธ Access denied; หยุด session ของ runner ด้วย Ctrl+C สำเร็จ
- แก้: ปิด stdin ของ child ให้ครบ และ cleanup collector แม้ child stop assertion ล้ม; เก็บ directory ของรอบล้มไว้เป็นหลักฐาน ไม่ใช้ผลนี้อ้างว่า integration ผ่าน
- ตรวจภายหลังด้วย Get-Process ตาม PID 8500 จาก writer lock: process ไม่เหลือแล้ว; directory ของรอบล้มยังเก็บไว้ ไม่ได้ใช้เป็น storage ของ collector ใหม่

## Final storage/history review — 2026-09-30

- วิธี: อ่าน actual diff, ตรวจ syntax ด้วย `node --check` สำหรับ src/public/examples/scripts/test และ `git diff --check`
- ผล: syntax 25 ไฟล์ผ่าน; diff whitespace ผ่าน
- ตรวจลิงก์ไฟล์ในเอกสาร 12 ลิงก์: ปลายทางมีอยู่ครบ
- อ่าน JSON ผลชุดหลัก `2026-09-30T11-33-55-378Z`: 38 passed / 0 failed / 0 skipped; source แยกล่าสุด `2026-09-30T11-31-51-627Z`: 1/1 ผ่าน
- ตรวจ QA state หลัง stop: ยังเก็บ 5 actions และไม่มี `.writer.lock` ใน directory ของ session
- ขอบเขต: final static/evidence review; ไม่ใช่การทดสอบ forced crash, power loss, OneDrive ข้ามเครื่อง หรือ production load

## UI history — 2026-09-30T11:18–11:19Z

- คำสั่ง: `node scripts/qa-session.mjs` (ต้องใช้ interactive stdin/TTY; เมื่อ stdin เป็น EOF โปรแกรมปิดตามปกติ)
- Data: `reports/storage/ui-17369e7f-ea68-4a0f-838c-0344d657cb62`
- ผ่าน: สร้าง view-product, check-stock และ place-order 3 ครั้ง รวม 5 actions; order ครั้งที่สาม HTTP 409 และกราฟ error
- ผ่าน: ตารางเพิ่มรายการหลัง action ทุกครั้ง; filter error แสดง order ที่ล้มเพียงรายการเดียว
- ผ่าน: ส่งคำสั่ง restart แล้ว collector โหลดกลับมา 5 actions; reload browser ยังเห็นรายการเดิมทั้งหมด
- ผ่าน: ค้นชื่อ check-stock ได้รายการเดียว และเปิดกราฟเดิม 6 nodes พร้อม evidence/source link ที่มี actionId ตรงกับ snapshot เก่า
- ภาพ: `reports/ui/history-after-restart.jpg`

## รอบ 8 ก่อน storage — 2026-09-30T10:59Z

- คำสั่ง: `node scripts/run-tests.mjs test/persistence.test.mjs`
- ผล: ทั้ง 4 กรณีไม่ผ่าน — restart เหลือ 0 actions, ไม่มี writer lock, ไม่ตรวจ corrupt file และ actionLimit ยังไม่ใช้
- ตัวทดสอบค้างหลัง assertions เพราะกรณีที่คาดว่า startup จะปฏิเสธกลับเปิด server สำเร็จแล้วไม่ได้ปิด; หยุดด้วย Ctrl+C จึงไม่มีรายงานอัตโนมัติของรอบนี้
- การแก้ test harness: เก็บและปิด server แม้ startup ไม่ได้ปฏิเสธตามคาด

สร้างโดย `node scripts/run-tests.mjs` หรือ `npm test` ทุกครั้ง รายละเอียด TAP และ metadata อยู่ใน `reports/tests/` เวลาเป็น UTC; การวิเคราะห์และการแก้อยู่ใน [QUALITY.md](QUALITY.md)

## Final review — 2026-09-30

- JavaScript syntax checks: ผ่านทุกไฟล์ `.js` / `.mjs` ที่พบในโครงการ
- `git diff --check`: ผ่าน
- Runner JSON: ตรวจ run `2026-09-30T10-19-01-072Z` มีผล 3/3, digest และ hashes ของ 24 ไฟล์จริง
- UI screenshots: เปิดตรวจทั้ง graph-success.jpg และ collector-outage.jpg; layout/ข้อความอ่านได้
- สถานะเซิร์ฟเวอร์ QA: ปิด collector และ fixture แล้ว

## UI manual — 2026-09-30T10:10–10:12Z

- view-message: ผ่าน — HTTP 200 และกราฟ success มี 6 nodes, evidence destination/trace แสดงจริง
- fail-message: ผ่าน — HTTP 503 และข้อความบริการแสดงจริง
- วิธีตรวจ: กดปุ่มและเปิดลิงก์ผ่านเบราว์เซอร์จริง; ไม่ใช่ Playwright trace capture
- ภาพ: `reports/ui/graph-success.jpg`
- collector outage: ผ่าน — ปิด collector แล้วส่งข้อความได้ HTTP 200 / MSG-1, แสดงคำเตือนและซ่อนลิงก์กราฟ ภาพ `reports/ui/collector-outage.jpg`

## รอบ 1 — เรียก npm ไม่สำเร็จ

- วันที่: 2026-09-30 (Asia/Bangkok)
- คำสั่ง: `npm test`
- ผล: ยังไม่ได้เริ่มชุดทดสอบ; exit code 1
- สาเหตุ: npm launcher ในเครื่องหา `C:\Users\lenul\AppData\Roaming\npm\node_modules\npm\bin\npm-cli.js` ไม่พบ (`MODULE_NOT_FOUND`)
- Node ที่พบ: v24.18.0
- การแก้ในโครงการ: ใช้ `node scripts/run-tests.mjs` ซึ่งไม่ต้องพึ่ง npm และยังบันทึกผลอัตโนมัติ

## 2026-09-30T09-54-00-133Z

- จุดประสงค์: รอบ 1: baseline ผ่าน runner ที่บันทึกผล
- ผล: ผ่าน — 11/11; failed 0; skipped 0
- Node: v24.18.0; commit: a517239672631f4d96cecf665350f10b93378fe0; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T09-54-00-133Z.tap` และ `.json`

## 2026-09-30T09-55-48-329Z

- จุดประสงค์: รอบ 2: regression ข้อมูลผิดรูปแบบ ก่อนแก้
- ผล: ไม่ผ่าน — 0/3; failed 3; skipped 0
- Node: v24.18.0; commit: a517239672631f4d96cecf665350f10b93378fe0; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T09-55-48-329Z.tap` และ `.json`
- ไม่ผ่าน: invalid action payloads return 400 and never create an action
- ไม่ผ่าน: rejected handler events leave the existing graph unchanged
- ไม่ผ่าน: graph validation reports malformed nodes and edges without throwing

## 2026-09-30T09-57-57-289Z

- จุดประสงค์: รอบ 2: ตรวจการแก้ validation และ atomic ingestion พร้อมเส้นทางเดิม
- ผล: ผ่าน — 14/14; failed 0; skipped 0
- Node: v24.18.0; commit: a517239672631f4d96cecf665350f10b93378fe0; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T09-57-57-289Z.tap` และ `.json`

## 2026-09-30T09-59-51-502Z

- จุดประสงค์: รอบ 3: regression destination และ trace ก่อนแก้ พร้อม concurrency
- ผล: ไม่ผ่าน — 1/3; failed 2; skipped 0
- Node: v24.18.0; commit: a517239672631f4d96cecf665350f10b93378fe0; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T09-59-51-502Z.tap` และ `.json`
- ไม่ผ่าน: same HTTP path in different destinations creates distinct request nodes
- ไม่ผ่าน: outbound events from a different trace are rejected without changing the graph

## 2026-09-30T10-00-52-696Z

- จุดประสงค์: รอบ 3: ตรวจการแก้ destination และ trace รวมชุดเดิม
- ผล: ผ่าน — 17/17; failed 0; skipped 0
- Node: v24.18.0; commit: a517239672631f4d96cecf665350f10b93378fe0; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T10-00-52-696Z.tap` และ `.json`

## 2026-09-30T10-02-50-500Z

- จุดประสงค์: รอบ 4: regression collector outage ก่อนแก้
- ผล: ไม่ผ่าน — 0/3; failed 3; skipped 0
- Node: v24.18.0; commit: a517239672631f4d96cecf665350f10b93378fe0; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T10-02-50-500Z.tap` และ `.json`
- ไม่ผ่าน: collector outage at action start preserves business success and error responses
- ไม่ผ่าน: collector outage after action start preserves the API result and flags incomplete capture
- ไม่ผ่าน: fixture validates local action input even when the collector is unavailable

## 2026-09-30T10-05-00-539Z

- จุดประสงค์: รอบ 4: ตรวจ best effort telemetry รวม integration เดิม
- ผล: ผ่าน — 20/20; failed 0; skipped 0
- Node: v24.18.0; commit: a517239672631f4d96cecf665350f10b93378fe0; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T10-05-00-539Z.tap` และ `.json`

## 2026-09-30T10-07-05-240Z

- จุดประสงค์: รอบ 5: ตรวจ retention UTF-8 และ regression graph overflow ก่อนแก้
- ผล: ไม่ผ่าน — 2/3; failed 1; skipped 0
- Node: v24.18.0; commit: a517239672631f4d96cecf665350f10b93378fe0; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T10-07-05-240Z.tap` และ `.json`
- ไม่ผ่าน: ingestion caps each graph and rejects overflow atomically

## 2026-09-30T10-08-12-080Z

- จุดประสงค์: รอบ 5: ตรวจ graph capacity และชุดรวมก่อนตรวจ UI
- ผล: ผ่าน — 24/24; failed 0; skipped 0
- Node: v24.18.0; commit: a517239672631f4d96cecf665350f10b93378fe0; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T10-08-12-080Z.tap` และ `.json`

## 2026-09-30T10-14-48-160Z

- จุดประสงค์: รอบ 7: failure header timeout และ source snapshot ก่อนแก้
- ผล: ไม่ผ่าน — 4/6; failed 2; skipped 0
- Node: v24.18.0; commit: a517239672631f4d96cecf665350f10b93378fe0; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T10-14-48-160Z.tap` และ `.json`
- ไม่ผ่าน: source links reject changed and removed files from an actual captured snapshot
- ไม่ผ่าน: a downstream transport failure is distinct from a collector outage

## 2026-09-30T10-17-15-130Z

- จุดประสงค์: รอบ 7: ชุดรวมหลังแก้ failure header
- ผล: ผ่าน — 26/26; failed 0; skipped 0
- Node: v24.18.0; commit: a517239672631f4d96cecf665350f10b93378fe0; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T10-17-15-130Z.tap` และ `.json`

## 2026-09-30T10-17-25-115Z

- จุดประสงค์: รอบ 7: isolated source snapshot หลังแก้ deleted source
- ผล: ผ่าน — 1/1; failed 0; skipped 0
- Node: v24.18.0; commit: a517239672631f4d96cecf665350f10b93378fe0; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T10-17-25-115Z.tap` และ `.json`

## 2026-09-30T10-19-01-072Z

- จุดประสงค์: ตรวจ runner metadata หลังเพิ่ม file hashes
- ผล: ผ่าน — 3/3; failed 0; skipped 0
- Node: v24.18.0; commit: a517239672631f4d96cecf665350f10b93378fe0; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T10-19-01-072Z.tap` และ `.json`

## 2026-09-30T11-05-26-981Z

- จุดประสงค์: รอบ 8: ตรวจ JSON storage restart single writer retention และ corruption
- ผล: ผ่าน — 4/4; failed 0; skipped 0
- Node: v24.18.0; commit: df2cfe7613dae41cafaf24af7ef2e4c89467d91e; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T11-05-26-981Z.tap` และ `.json`

## 2026-09-30T11-09-01-073Z

- จุดประสงค์: รอบ 9: history query และ invalid filters ก่อนเพิ่ม
- ผล: ไม่ผ่าน — 0/2; failed 2; skipped 0
- Node: v24.18.0; commit: df2cfe7613dae41cafaf24af7ef2e4c89467d91e; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T11-09-01-073Z.tap` และ `.json`
- ไม่ผ่าน: history queries filter name or ID and outcome before applying the limit
- ไม่ผ่าน: invalid history filters return 400 and storage status reflects the running mode

## 2026-09-30T11-11-41-657Z

- จุดประสงค์: รอบ 9: ตรวจ storage และ history queries พร้อมชุดเดิม
- ผล: ผ่าน — 32/32; failed 0; skipped 0
- Node: v24.18.0; commit: df2cfe7613dae41cafaf24af7ef2e4c89467d91e; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T11-11-41-657Z.tap` และ `.json`

## 2026-09-30T11-15-01-652Z

- จุดประสงค์: รอบ 10: filesystem failure saved graph validation และ data path ก่อน guard เพิ่ม
- ผล: ไม่ผ่าน — 6/7; failed 1; skipped 0
- Node: v24.18.0; commit: df2cfe7613dae41cafaf24af7ef2e4c89467d91e; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T11-15-01-652Z.tap` และ `.json`
- ไม่ผ่าน: storage cannot be placed outside the project or in code and Git directories

## 2026-09-30T11-16-07-209Z

- จุดประสงค์: รอบ 10: ตรวจ data directory guard และชุดรวม
- ผล: ผ่าน — 35/35; failed 0; skipped 0
- Node: v24.18.0; commit: df2cfe7613dae41cafaf24af7ef2e4c89467d91e; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T11-16-07-209Z.tap` และ `.json`

## 2026-09-30T11-16-16-085Z

- จุดประสงค์: รอบ 10: isolated source snapshot เดิมหลัง restart และไฟล์เปลี่ยน
- ผล: ผ่าน — 1/1; failed 0; skipped 0
- Node: v24.18.0; commit: df2cfe7613dae41cafaf24af7ef2e4c89467d91e; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T11-16-16-085Z.tap` และ `.json`

## 2026-09-30T11-23-49-658Z

- จุดประสงค์: รอบ 11: ปิด Node process แรกและโหลด graph ใน process ใหม่จริง
- ผล: ผ่าน — 1/1; failed 0; skipped 0
- Node: v24.18.0; commit: df2cfe7613dae41cafaf24af7ef2e4c89467d91e; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T11-23-49-658Z.tap` และ `.json`

## 2026-09-30T11-26-20-404Z

- จุดประสงค์: รอบ 12: regression การเติม event ลง action รุ่นโค้ดเก่า ก่อน guard
- ผล: ไม่ผ่าน — 0/1; failed 1; skipped 0
- Node: v24.18.0; commit: df2cfe7613dae41cafaf24af7ef2e4c89467d91e; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T11-26-20-404Z.tap` และ `.json`
- ไม่ผ่าน: source links reject changed and removed files from an actual captured snapshot

## 2026-09-30T11-27-43-620Z

- จุดประสงค์: รอบ 12: ชุดรวมหลังเพิ่ม snapshot version guard และ process restart
- ผล: ผ่าน — 36/36; failed 0; skipped 0
- Node: v24.18.0; commit: df2cfe7613dae41cafaf24af7ef2e4c89467d91e; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T11-27-43-620Z.tap` และ `.json`

## 2026-09-30T11-27-51-901Z

- จุดประสงค์: รอบ 12: isolated old snapshot source และปฏิเสธ append ข้ามรุ่น
- ผล: ผ่าน — 1/1; failed 0; skipped 0
- Node: v24.18.0; commit: df2cfe7613dae41cafaf24af7ef2e4c89467d91e; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T11-27-51-901Z.tap` และ `.json`

## 2026-09-30T11-31-51-627Z

- จุดประสงค์: ตรวจ source conflict response หลังปรับข้อความให้ตรง captured snapshot
- ผล: ผ่าน — 1/1; failed 0; skipped 0
- Node: v24.18.0; commit: df2cfe7613dae41cafaf24af7ef2e4c89467d91e; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T11-31-51-627Z.tap` และ `.json`

## 2026-09-30T11-33-55-378Z

- จุดประสงค์: รอบสุดท้าย: concurrent disk checkpoints และ port-conflict cleanup รวมชุดหลัก
- ผล: ผ่าน — 38/38; failed 0; skipped 0
- Node: v24.18.0; commit: df2cfe7613dae41cafaf24af7ef2e4c89467d91e; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T11-33-55-378Z.tap` และ `.json`

## 2026-09-30T12-55-03-741Z

- จุดประสงค์: รอบ 13 ก่อนเพิ่ม registration: โครงการอื่นและ source provenance
- ผล: ไม่ผ่าน — 0/3; failed 3; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T12-55-03-741Z.tap` และ `.json`
- ไม่ผ่าน: registered projects use their own source snapshot and preserve it after restart
- ไม่ผ่าน: project identity and claimed code digest are checked before accepting any evidence
- ไม่ผ่าน: registration rejects path escapes, non-code files, duplicate IDs and inherited Git roots

## 2026-09-30T12-58-18-358Z

- จุดประสงค์: รอบ 13 หลังเพิ่ม registration: snapshot แยกและ persistence
- ผล: ผ่าน — 3/3; failed 0; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T12-58-18-358Z.tap` และ `.json`

## 2026-09-30T13-01-26-645Z

- จุดประสงค์: รอบ 14 adapter: propagation, privacy, outage, timeout และ transport failure
- ผล: ผ่าน — 4/4; failed 0; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T13-01-26-645Z.tap` และ `.json`

## 2026-09-30T13-08-58-912Z

- จุดประสงค์: รอบ 15 ตรวจ graceful child cleanup และ coverage gap ก่อนแก้
- ผล: ไม่ผ่าน — 0/1; failed 1; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T13-08-58-912Z.tap` และ `.json`
- ไม่ผ่าน: copied adapter in a different Git repository captures three actions and survives collector outage

## 2026-09-30T13-09-53-688Z

- จุดประสงค์: รอบ 15 หลังเติม unknown: external repository integration และ adapter
- ผล: ผ่าน — 8/8; failed 0; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T13-09-53-688Z.tap` และ `.json`

## 2026-09-30T13-12-57-241Z

- จุดประสงค์: รอบ 16 ขอบเขต source/config: junction จริงบน Windows และ namespace
- ผล: ผ่าน — 4/4; failed 0; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T13-12-57-241Z.tap` และ `.json`

## 2026-09-30T13-15-03-111Z

- จุดประสงค์: รอบ 17 ตรวจ code-version artifacts ภายในโครงการ
- ผล: ผ่าน — 1/1; failed 0; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T13-15-03-111Z.tap` และ `.json`

## 2026-09-30T13-15-24-174Z

- จุดประสงค์: ชุดรวมหลัง registration/adapter: regression เดิมและ app ใน repository แยก
- ผล: ผ่าน — 47/47; failed 0; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T13-15-24-174Z.tap` และ `.json`

## 2026-09-30T13-15-44-920Z

- จุดประสงค์: isolated source regression หลังเพิ่ม project namespaces
- ผล: ผ่าน — 1/1; failed 0; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T13-15-44-920Z.tap` และ `.json`

## 2026-09-30T13-23-32-533Z

- จุดประสงค์: รอบ 19 ก่อน type guard: project ID และ code digest ห้าม coercion
- ผล: ไม่ผ่าน — 6/8; failed 2; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T13-23-32-533Z.tap` และ `.json`
- ไม่ผ่าน: adapter rejects invalid configuration and programmer inputs before sending requests
- ไม่ผ่าน: registration rejects path escapes, non-code files, duplicate IDs and inherited Git roots

## 2026-09-30T13-24-50-762Z

- จุดประสงค์: รอบ 19 หลัง type guard: ชุดหลักทุก integration รวมการเปิด process ใหม่
- ผล: ผ่าน — 47/47; failed 0; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T13-24-50-762Z.tap` และ `.json`

## 2026-09-30T13-25-17-418Z

- จุดประสงค์: final isolated source check: รักษารุ่นเก่าหลังเปลี่ยนโค้ดและ restart
- ผล: ผ่าน — 1/1; failed 0; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T13-25-17-418Z.tap` และ `.json`

## 2026-09-30T13-26-54-960Z

- จุดประสงค์: รอบ 20 ก่อนแก้ fixture: source symbol ต้องเป็นฟังก์ชันจริง
- ผล: ไม่ผ่าน — 0/1; failed 1; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T13-26-54-960Z.tap` และ `.json`
- ไม่ผ่าน: copied adapter in a different Git repository captures three actions and survives collector outage

## 2026-09-30T13-28-10-353Z

- จุดประสงค์: รอบ 20 หลังแก้ named handlers: ชุดหลักสุดท้าย
- ผล: ผ่าน — 47/47; failed 0; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T13-28-10-353Z.tap` และ `.json`

## 2026-09-30T13-31-58-491Z

- จุดประสงค์: final isolated source gate หลัง template/source symbol review
- ผล: ผ่าน — 1/1; failed 0; skipped 0
- Node: v24.18.0; commit: 7b033281433bad92b2d63cd3bc574a7191e1bb34; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T13-31-58-491Z.tap` และ `.json`

## 2026-09-30T13-55-42-667Z

- จุดประสงค์: รอบ 21 ตรวจ runner ที่ระบุ OS ก่อนย้ายไป Linux VM
- ผล: ผ่าน — 3/3; failed 0; skipped 0
- Environment: win32/x64; OS 10.0.26200; Node v24.18.0
- commit: fc273a9d9a9eaee7651341c9e4162061c3de97e9; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T13-55-42-667Z.tap` และ `.json`

## 2026-09-30 — เตรียม Linux browser QA

- ตรวจ VM: Debian 12, Node v24.18.0, npm 11.16.0, พื้นที่ว่าง 15 GiB, ไม่มี DISPLAY หรือ browser executable; checkout เดิมมีเพียง docs/TEST-RUNS.md ที่ runner เพิ่มไว้
- Tool failure: dpkg แสดงผลผ่าน pager ใน SSH TTY ทำให้ข้อความคำสั่งติดตั้งถูกอ่านเป็น pager input; ยังไม่ใช่ผลทดสอบแอป และยังไม่ได้ติดตั้งสำเร็จ
- แก้ขั้นตอน: ออกจาก pager ตั้ง PAGER/DPKG_PAGER=cat ก่อนส่งคำสั่งใหม่; เก็บการติดตั้งเฉพาะ QA workspace

- Installation check ไม่ผ่าน: VM npm ETIMEDOUT; browser CLI MODULE_NOT_FOUND เพราะแพ็กเกจยังไม่มี; host Node registry fetch ถูก sandbox ปฏิเสธ EACCES; VM wget HTTPS เข้าถึง registry ได้ จึงใช้ archive ที่ตรวจ integrity แทน
- Host TTY git diff ไม่อยู่ใน repository แม้ระบุ workdir; ตรวจซ้ำ non-TTY ได้และ syntax/diff whitespace ผ่าน ใช้ตำแหน่งชัดเจนสำหรับ TTY ต่อไป

- Playwright/playwright-core 1.63.0 archive ดาวน์โหลดผ่าน wget และ SHA-512 ตรงกับ registry integrity ทั้งคู่; install-deps --dry-run chromium ยืนยัน system dependencies มีครบ ยังไม่เปลี่ยน package ของระบบ

## 2026-09-30T14-47-44-954Z — Linux browser

- ชุด browser-check ผ่าน 8/8, fail/cancelled/skip 0, exit 0; Debian VM / Chromium headless / Node v24.18.0
- ผ่าน: target 3 actions HTTP 200/200/503, กราฟ 5 nodes observed 3 + unknown 1, source popup ของ named handler ทั้งสาม, history ID/outcome/ไม่มีผล/Enter, restart, viewport 390px และ internal graph scroll, changed source 409, collector outage app HTTP 200 ไม่มีลิงก์กราฟเสีย และไม่มี pageerror
- กำลังนำ raw reports และภาพกลับมาตรวจ SHA-256/visual; ยังไม่อ้างว่า visual QA เสร็จ


- Import check: archive/file/source checksums ผ่าน แต่ Copy-Item ภาพไม่ผ่านเพราะยังไม่ได้สร้าง destination directory; raw TAP/JSON นำเข้าแล้ว แก้โดยสร้างโฟลเดอร์ก่อนและห้ามทับไฟล์ checksum ต่าง

- Final import/visual: archive SHA-256 และ raw/evidence checksums ตรง; source hashes ทุกไฟล์ตรงกับ host; ตรวจภาพทั้ง 7 แล้ว กราฟ/ภาษาไทย/ประวัติ/error/outage แสดงตรงผลทดสอบ หน้าจอแคบมี horizontal scroll ภายในกราฟ/ตาราง
- Runtime: Chromium 153.0.8010.12, Playwright 1.63.0, headless=true; browser-errors=[]; ไม่พบ QA workspace process หรือ writer lock ค้าง ปิด SSH สอง session แล้ว
- หลักฐาน: reports/tests/2026-09-30T14-47-44-954Z.{tap,json}, reports/vm/browser-2026-09-30T14-47-45-088Z-468e9944/, reports/ui/linux-chromium-{graph,outage}.png


- Final static review: browser script syntax, git diff whitespace และเอกสาร local links 18 ลิงก์ผ่าน; raw JSON ยืนยัน Linux 8/8 exit 0; app source ไม่มี diff
- Static check รอบแรกพบ blank line ท้าย TEST-RUNS.md; ตัดบรรทัดว่างท้ายไฟล์แล้วตรวจซ้ำก่อน commit

## 2026-09-30 — Inspector round 1

- Focused run `node scripts/run-tests.mjs test/inspect.test.mjs` แสดง TAP header แล้วค้างเกิน 40 วินาที จึงยุติด้วย Ctrl+C; runner ถูกยุติก่อนเขียน TAP/JSON อัตโนมัติ
- Direct interactive run เปิด collector/app และคำสั่ง stop ปิด exit 0; กำลังแยกสาเหตุที่ test harness ค้างก่อนอ้างว่าผ่าน


## 2026-09-30T15-14-23-434Z

- จุดประสงค์: inspector command starts both services, captures action and stops cleanly
- ผล: ผ่าน — 2/2; failed 0; skipped 0
- Environment: win32/x64; OS 10.0.26200; Node v24.18.0
- commit: 649c6dacbb84bed522a16d21866c113c1b0d7f39; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T15-14-23-434Z.tap` และ `.json`

## 2026-09-30T15-15-57-442Z

- จุดประสงค์: inspector: action path, local URL validation, startup cleanup
- ผล: ผ่าน — 3/3; failed 0; skipped 0
- Environment: win32/x64; OS 10.0.26200; Node v24.18.0
- commit: 649c6dacbb84bed522a16d21866c113c1b0d7f39; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T15-15-57-442Z.tap` และ `.json`

## 2026-09-30T15-18-33-154Z — Linux inspector

- ชุด focused ผ่าน 3/3, failed 0, skipped 0, exit 0 บน Debian 12 / Node v24.18.0
- ส่ง `scripts/inspect.mjs` และ `test/inspect.test.mjs` ไป VM, ตรวจ SHA-256 ตรงกับ host; archive และ raw TAP/JSON/console ตรวจ checksum หลัง SCP แล้ว
- ครอบคลุมเปิด collector + แอปตัวอย่างคำสั่งเดียว, action→graph, stop แล้วพอร์ตปิด, ปฏิเสธ URL นอกเครื่อง, และ startup failure ปล่อย writer lock
- ไม่พบ writer lock ใน QA storage หลังจบ ปิด SSH แล้ว; raw files อยู่ใน `reports/tests/` และ `reports/vm/inspect-results.tgz`

## 2026-09-30T15-22-43-835Z

- จุดประสงค์: Windows full regression after adding on-demand inspector
- ผล: ผ่าน — 50/50; failed 0; skipped 0
- Environment: win32/x64; OS 10.0.26200; Node v24.18.0
- commit: 649c6dacbb84bed522a16d21866c113c1b0d7f39; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T15-22-43-835Z.tap` และ `.json`

## 2026-10-01 — Inspector final shutdown check

- ปรับ CLI ให้ส่ง SIGTERM เพื่อหยุดแอปและส่ง stdout ของแอปต่อไปยังเทอร์มินัล; ไม่มีการเปลี่ยน collector/adapter
- Windows focused 3/3 ผ่าน (`2026-09-30T17-53-55-845Z` UTC), failed/skipped 0, exit 0
- Linux VM focused 3/3 ผ่าน (`2026-09-30T17-55-39-917Z` UTC), failed/skipped 0, exit 0; source SHA-256 ตรง host
- ตรวจ archive SHA-256 และ raw TAP/JSON/console checksums หลัง SCP ตรงทั้งหมด; ไม่พบ writer lock ใน QA storage, ปิด SSH แล้ว
- หลักฐาน: `reports/tests/{runId}.{tap,json}` และ `reports/vm/inspect-final.tgz` ภายในโครงการ

## 2026-09-30T17-53-55-845Z

- จุดประสงค์: inspector final shutdown signal and stdout forwarding
- ผล: ผ่าน — 3/3; failed 0; skipped 0
- Environment: win32/x64; OS 10.0.26200; Node v24.18.0
- commit: 649c6dacbb84bed522a16d21866c113c1b0d7f39; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T17-53-55-845Z.tap` และ `.json`

## 2026-09-30T18-21-44-562Z — Inspector + Chromium บน Linux VM

- จุดประสงค์: ตรวจตั้งแต่คำสั่ง `inspect` ไปถึงคลิกในแอป, กราฟ/source, ปิด และเปิดใหม่ดูประวัติ
- ผล: ผ่าน 1/1; failed 0; skipped 0; exit 0 บน Debian 12 / Node v24.18.0 / Chromium headless 153.0.8010.12
- คลิก view/send/fail ได้ HTTP 200/200/503; กราฟแต่ละ action มี 5 nodes/4 edges, observed 3 และ unknown 1; source popup พบ handler ที่ตรงกัน
- หลัง `stop` ทั้งสองพอร์ตปิดและไม่มี writer lock; เปิดใหม่แล้วพบ 3 actions และกราฟเก่า; browser pageerror 0
- หลักฐาน: `reports/tests/2026-09-30T18-21-44-562Z.{tap,json}`, `reports/vm/inspector-browser-2026-09-30T18-21-44-748Z-3c4f3f41/{result.json,inspector-graph.png,inspector-restart.png}` และ `reports/vm/inspector-browser-results.tgz`
- ตรวจ SHA-256 ของ archive หลังส่งกลับ (`7fe65322862fc60e01bbdba20feeb8f33703470a603ce069e86ee086fdf86821`) และไฟล์ทั้งหมดกับ manifest จาก VM ผ่าน; ตรวจภาพทั้งสองด้วยตาแล้ว ไม่พบ UI defect ในขอบเขตนี้
- VM ใช้ checkout ฐาน `530e221` แบบ dirty โดยส่งสคริปต์ทดสอบและ `inspect.mjs` รุ่นปัจจุบันเพิ่ม; SHA-256 ของไฟล์ใน runner JSON ตรงกับ host ไม่ใช่การทดสอบ clean checkout ของ commit ปัจจุบัน
- ตรวจรายการภาพครั้งแรกใช้ `Get-ChildItem -LiteralPath` กับ wildcard จึงหาไฟล์ไม่พบ; รันใหม่ด้วย `-Path` พบภาพทั้งสองครบ (205432 และ 172186 bytes) ไม่กระทบผลทดสอบหรือไฟล์
- บันทึก Git ครั้งแรกไม่สำเร็จเพราะ environment นี้ไม่มี `user.name`/`user.email`; staged files ยังครบ ตรวจ `git log` พบ commit เดิมใช้ `Codex <codex@localhost>` จึงใช้ identity เดิมเฉพาะคำสั่ง commit ไม่เปลี่ยน global/local config

## 2026-09-30T18-41-03-640Z

- จุดประสงค์: Other web app HTTP integration baseline
- ผล: ผ่าน — 2/2; failed 0; skipped 0
- Environment: win32/x64; OS 10.0.26200; Node v24.18.0
- commit: d83e26d86a9a0f67100e394be67d6bec91d777bd; dirty: false
- หลักฐาน: `reports/tests/2026-09-30T18-41-03-640Z.tap` และ `.json`

## 2026-09-30T18-42-03-055Z

- จุดประสงค์: Second web app real Edge browser integration
- ผล: ไม่ผ่าน — 0/1; failed 1; skipped 0
- Environment: win32/x64; OS 10.0.26200; Node v24.18.0
- commit: d83e26d86a9a0f67100e394be67d6bec91d777bd; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T18-42-03-055Z.tap` และ `.json`
- ไม่ผ่าน: a second web app works through actual browser clicks and FlowAtlas graph links

## 2026-09-30T18-43-16-785Z — Browser retry ที่ถูกยุติ

- หลังแก้สมมติฐานเรื่องลิงก์แท็บเดิม รอบ browser ยังชน test timeout 60 วินาที; TAP แสดง 0/1 และ `testTimeoutFailure` แต่ runner ค้างระหว่างปิด จึงส่ง Ctrl+C ก่อนสร้าง JSON/TAP ฉบับสมบูรณ์ ไม่อ้างว่ารอบนี้ผ่าน
- เก็บ working evidence ใน `reports/browser/independent-browser-2026-09-30T18-43-16-785Z-2b0d37e2/`; ระบุจุดค้างและจำกัดเวลาของ browser operation ก่อนรันทดสอบใหม่
- ขั้นตอนตรวจ process ใช้ working directory ภาษาไทยผิดหนึ่งครั้ง ทำให้ CreateProcess ปฏิเสธ; retry ด้วย path ที่ถูกต้อง แต่ Win32_Process query ถูก sandbox ปฏิเสธ access denied จึงยังไม่ได้ยืนยันด้วย command line ว่า process ค้างหรือไม่

## 2026-09-30T18-46-26-787Z

- จุดประสงค์: Second web app Edge browser integration with bounded operations
- ผล: ผ่าน — 1/1; failed 0; skipped 0
- Environment: win32/x64; OS 10.0.26200; Node v24.18.0
- commit: d83e26d86a9a0f67100e394be67d6bec91d777bd; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T18-46-26-787Z.tap` และ `.json`

## 2026-09-30T18-48-22-675Z — เว็บอีกตัวผ่าน Edge browser

- หลังตัด timer ที่เกินจำเป็นใน test cleanup รอบสุดท้ายผ่าน 1/1, failed/skipped 0 บน Windows / Node v24.18.0 / Edge 154.0.4258.37
- คลิก view/send/fail ผ่านหน้าเว็บที่รันคนละโปรเซสกับ FlowAtlas ได้ HTTP 200/200/503; เปิดแผนที่ในแท็บเดิม กราฟแต่ละ action มี 6 nodes/5 edges (`observed` 3, `inferred` 1, `unknown` 1) และเปิด source handler ตรง action ทั้งสาม; pageerror 0
- ปิดแอปและ collector แล้วทดสอบว่า URL ทั้งสองไม่ตอบ และไม่มี `.writer.lock` ในพื้นที่ทดสอบใหม่; ตรวจภาพ `reports/ui/independent-browser-graph.png` ด้วยตาแล้ว
- หลักฐาน: `reports/tests/2026-09-30T18-48-22-675Z.{tap,json}`, `reports/browser/independent-browser-2026-09-30T18-48-23-186Z-3f8f2afb/{result.json,graph.png}` และภาพที่ติดตามใน Git; SHA-256 ของภาพต้นฉบับตรงสำเนา `1fe2c177db3d65de3b30521a09020abb508a4ab09811e902e4db305d6a86db2a`
- รอบที่ถูกยุติสร้าง stale lock ใน QA directory; ตรวจ PID `24280` จาก lock ว่าไม่มีโปรเซสแล้วก่อนลบเฉพาะไฟล์ล็อกนั้น ตรวจซ้ำแล้ว test directories ทั้งสี่ไม่มี lock ค้าง ไม่แตะ lock เก่าของ test อื่น

## 2026-09-30T18-48-22-675Z

- จุดประสงค์: Second web app final Edge browser and cleanup verification
- ผล: ผ่าน — 1/1; failed 0; skipped 0
- Environment: win32/x64; OS 10.0.26200; Node v24.18.0
- commit: d83e26d86a9a0f67100e394be67d6bec91d777bd; dirty: true
- หลักฐาน: `reports/tests/2026-09-30T18-48-22-675Z.tap` และ `.json`
