# บันทึกการรันทดสอบ

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
