# บันทึกการรันทดสอบ

## Linux VM preparation — 2026-09-30

- ผู้ใช้ระบุให้ทดสอบผ่าน SSH บน VM; เชื่อมต่อสำเร็จเป็น Debian GNU/Linux 12 / kernel 6.1.0-53-amd64 / x86_64 ไม่มี Node.js/Git ใน PATH และไม่มี project shared folder ที่ตรวจพบ
- ตรวจ WSL ก่อนคำชี้แจง VM: sandbox ปฏิเสธ enumerate ด้วย E_ACCESSDENIED; read-only check นอก sandboxพบ Kali WSL2 หยุดอยู่ ไม่ใช้เป็นผล Linux VM
- พบ VMware CLI แต่ไม่มี VM ที่ running ในรายการของ CLI; ไม่ใช้ข้อมูลนี้แทน VM ที่ผู้ใช้ระบุผ่าน SSH
- Probe official Node v24.18.0 checksum URL: web tool เปิดไม่ได้ แต่ wget บน VM ตรวจ URL สำเร็จ (exit 0); จะ verify checksum ก่อนใช้ runtime
- ยังไม่เริ่มชุดทดสอบ Linux ในขั้นนี้ ไม่เก็บ credential ในโค้ดหรือรายงาน
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
