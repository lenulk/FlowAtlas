# ผลทดสอบ Linux VM

ทดสอบผ่าน SSH บน VM ที่ผู้ใช้ระบุ วันที่ 2026-09-30 ใช้ Linux จริง ไม่ใช่ simulation สภาพแวดล้อมเป็น Debian GNU/Linux 12 (bookworm), kernel 6.1.0-53-amd64, x86_64, Node v24.18.0 และ Git 2.39.5

## ผลที่ตรวจแล้ว

| ชุด | ผ่าน | ไม่ผ่าน | ข้าม | Run ID |
| --- | ---: | ---: | ---: | --- |
| ชุดหลัก | 47 | 0 | 0 | 2026-09-30T14-00-32-338Z |
| Source แยก | 1 | 0 | 0 | 2026-09-30T14-01-44-229Z |
| Chromium headless UI | 8 | 0 | 0 | 2026-09-30T14-47-44-954Z |

ครอบคลุม HTTP integration, แอปคนละ Node process/คนละ Git repository, action/trace correlation, source allowlist และ symlink, disk persistence/retention, write/startup failures, collector outage/timeout, malformed input และกราฟรุ่นเดิมหลัง restart ไม่พบปัญหาที่ต้องแก้ในพฤติกรรมแอปจากการรัน Linux รอบนี้

Source commit ที่ทดสอบ: `530e221945e5aa13d29c6c938337580c506d6a59` ส่งผ่าน Git bundle แล้วตรวจ SHA-256 ก่อน clone/checkout ชุดหลักเริ่มจาก checkout สะอาด; source run มี dirty=true เนื่องจาก runner เพิ่ม docs/TEST-RUNS.md หลังชุดหลัก ไม่ใช่การแก้โค้ดแอป รายงานแต่ละชุดมี hashes ของไฟล์ที่ใช้จริง

## หลักฐานในโครงการ Windows

- Raw TAP/JSON: `reports/tests/{runId}.tap` และ `.json`
- สำเนาจาก VM รวม environment/console/runner log: `reports/vm/linux-2026-09-30T14-00-32-338Z/`
- Git bundle และ archive ของผล: `reports/vm/project.bundle`, `reports/vm/linux-results.tgz`
- รายการผลและการวิเคราะห์ที่ติดตามใน Git: [TEST-RUNS.md](TEST-RUNS.md), [QUALITY.md](QUALITY.md)

ตรวจ archive SHA-256 หลัง SCP และ checksums ของ raw reports ทั้ง 4 ไฟล์ตรงกับ VM ก่อนนำเข้า โดยไม่เขียนทับ report เดิมที่ checksum ต่าง เก็บ artifacts ไว้ในโฟลเดอร์ FlowAtlas ตามข้อกำหนดผู้ใช้ รายงานเก่าบางชุดไม่มี platform field; ตั้งแต่รอบ 21 runner ระบุ platform/arch/osRelease อัตโนมัติ

## การรันซ้ำบน VM เดิม

QA workspace ที่คงไว้บน VM:

```text
/home/test/FlowAtlas-MVP-linux-qa-20260930-fc273a9/project
```

ใช้ Node portable ที่ตรวจ checksum จาก official Node archive แล้ว (ไม่ได้เปลี่ยน Node ของระบบ):

```bash
export PATH=/home/test/FlowAtlas-MVP-linux-qa-20260930-fc273a9/runtime/node-v24.18.0-linux-x64/bin:$PATH
cd /home/test/FlowAtlas-MVP-linux-qa-20260930-fc273a9/project
FLOWATLAS_TEST_PURPOSE='Linux VM: main' node scripts/run-tests.mjs
FLOWATLAS_TEST_PURPOSE='Linux VM: isolated source' node scripts/run-tests.mjs scripts/source-check.mjs
```

รัน source check แยกจาก main ตาม AGENTS.md หลังทดสอบไม่พบ Node QA process หรือ writer lock ค้าง และปิด SSH session แล้ว Git/git-man/liberror-perl ติดตั้งจาก Debian repositories; ใช้ apt sources list ชั่วคราวเฉพาะคำสั่ง ไม่แก้ source configuration ของระบบถาวร Runtime/workspace คงไว้สำหรับรันซ้ำ ไม่เก็บ password/private key ในโครงการ

## Browser UI บน Linux

ใช้ Playwright 1.63.0 และ Chromium headless shell 153.0.8010.12 บน VM จริง ไม่มี DISPLAY จึงไม่ได้เปิดหน้าต่าง GUI ตรวจ 1440×1000 และ viewport 390×844 (ไม่ใช่มือถือจริง):

- คลิก view/send/fail ได้ HTTP 200/200/503; เปิด viewer ผ่านลิงก์จริง กราฟ 5 nodes มี observed 3 และ unknown 1
- เปิด source popup ผ่าน UI ของทั้งสาม named handlers ได้; source ที่เปลี่ยนหลัง capture ตอบ conflict 409 โดยไม่แสดงโค้ดใหม่
- ค้นหาด้วย ID, outcome, คำที่ไม่มีผล และ Enter; restart collector แล้ว history/graph ทั้งสามตรงกับก่อนปิด
- viewport แคบไม่ทำให้ทั้งหน้าล้น; ตารางและกราฟกว้างเลื่อนภายใน container ตามการออกแบบ ภาพ mobile-viewer เป็นตำแหน่งหลังเลื่อนกราฟไปขวาสุด
- collector outage ยังได้ผลธุรกิจ HTTP 200 พร้อมคำเตือน capture ขาด ไม่มีลิงก์ viewer และปุ่มกลับมาใช้ได้; browser pageerror 0

ใช้ source commit `530e221` พร้อมสคริปต์ [browser-check.mjs](../scripts/browser-check.mjs) ที่ส่งเพิ่มเติม (dirty=true); ตรวจ hashes ทุกไฟล์ใน runner JSON ตรงกับโครงการ Windows ปัจจุบัน ไม่เปลี่ยน app logic เพื่อให้ทดสอบผ่าน เก็บ screenshot 7 ภาพ, environment, graphs, browser-errors และ target console ใน `reports/vm/browser-2026-09-30T14-47-45-088Z-468e9944/` และ raw TAP/JSON ใน `reports/tests/` ตรวจ archive SHA-256 และไฟล์หลักฐานทุกไฟล์หลัง SCP ผ่าน และตรวจภาพทั้ง 7 ด้วยตาแล้ว

แพ็กเกจ Playwright ดาวน์โหลดจาก npm registry ด้วย wget และตรวจ SHA-512 กับ registry integrity หลัง npm install ติด ETIMEDOUT; browser ดาวน์โหลดผ่าน official Playwright CLI ตาม [เอกสาร Playwright](https://playwright.dev/docs/browsers) เก็บ runtime ใน `reports/vm/browser-runtime/` บน VM ตรวจ install-deps --dry-run แล้ว dependency ระบบมีครบ จึงไม่ติดตั้ง package ระบบเพิ่มในรอบนี้ หลังจบไม่มี process ของ QA workspace หรือ writer lock ค้าง; SSH ปิดแล้ว

รันเฉพาะ gate นี้จาก QA project เดิม หลัง export PATH ตามด้านบน:

```bash
FLOWATLAS_PLAYWRIGHT_PACKAGE="$PWD/reports/vm/browser-runtime/node_modules/playwright/package.json" \
PLAYWRIGHT_BROWSERS_PATH="$PWD/reports/vm/browser-runtime/browsers" \
FLOWATLAS_TEST_PURPOSE='Linux Chromium UI' \
node scripts/run-tests.mjs scripts/browser-check.mjs
```

สคริปต์สร้าง app/data แยกใน reports/storage และคงหลักฐานไว้ การทดสอบ browser เป็น optional gate จึงไม่เพิ่ม dependency ให้ app หรือชุดหลัก

## Inspector end-to-end บน Linux Chromium

รัน `scripts/inspector-browser-check.mjs` ผ่าน test runner บน VM เดิม โดยใช้ Playwright/Chromium runtime ข้างต้น ผล 1/1 ผ่าน (`2026-09-30T18-21-44-562Z`), failed/skipped 0 ทดสอบ `inspect` เริ่ม collector และ target พร้อมกัน, คลิก 3 actions, เปิดกราฟและ source popup, `stop` แล้วพอร์ตปิด, เริ่มใหม่แล้วประวัติและกราฟทั้งสามกลับมา; pageerror 0 และไม่เหลือ writer lock/process ของ QA workspace ดู raw TAP/JSON ใน `reports/tests/`, ภาพและ result JSON ใน `reports/vm/inspector-browser-2026-09-30T18-21-44-748Z-3c4f3f41/` ตรวจ checksums หลังนำเข้าจาก VM แล้ว

```bash
FLOWATLAS_PLAYWRIGHT_PACKAGE="$PWD/reports/vm/browser-runtime/node_modules/playwright/package.json" \
PLAYWRIGHT_BROWSERS_PATH="$PWD/reports/vm/browser-runtime/browsers" \
FLOWATLAS_TEST_PURPOSE='Linux VM on-demand inspector full Chromium journey' \
node scripts/run-tests.mjs scripts/inspector-browser-check.mjs
```

VM checkout ฐาน `530e221` แบบ dirty; ส่ง `inspect.mjs` รุ่นปัจจุบันและสคริปต์ทดสอบเข้าไป ตรวจ SHA-256 ของไฟล์ใน runner JSON ตรงกับ host แล้ว จึงอ้างผลเฉพาะไฟล์ที่ทดสอบ ไม่อ้างว่าเป็น clean commit `e6232db`.

## คำสั่งลงทะเบียนแอป Node.js

ทดสอบ `scripts/register-app.mjs` และ `test/register-app.test.mjs` บน QA VM เดิม โดยส่งสองไฟล์เข้า checkout เดิม (dirty) ผ่าน archive ที่ตรวจ SHA-256 แล้ว รุ่นสุดท้าย `2026-09-30T19-33-24-713Z` ผ่าน 4/4, failed/skipped 0 บน Debian 12 / Node v24.18.0 ครอบคลุมลงทะเบียนแอปจำลองและเรียกผ่าน `inspect` จนได้ action graph, ปฏิเสธ adapter ที่เนื้อหาไม่ตรง/ID ซ้ำโดยไม่เขียนทับ, และปฏิเสธ config เกิน 64 KiB ทั้งก่อนและหลังเพิ่มรายการ ไม่พบ writer lock ค้าง

Raw TAP/JSON เก็บใน `reports/tests/2026-09-30T19-33-24-713Z.{tap,json}` พร้อม archive `reports/vm/register-app-final-results.tgz`; ตรวจ SHA-256 ของ archive และ raw files หลังนำเข้า host ตรง VM ใช้ source hashes ของ script/test และ `inspect.mjs`/`project-sources.mjs` เทียบกับ host ไม่อ้างว่าเป็น clean commit ของ branch ปัจจุบัน รุ่นก่อน size fix ผ่าน 3/3 (`2026-09-30T19-28-58-659Z`) และเก็บ raw reports แยกไว้

```bash
PATH=/home/test/FlowAtlas-MVP-linux-qa-20260930-fc273a9/runtime/node-v24.18.0-linux-x64/bin:$PATH \
FLOWATLAS_TEST_PURPOSE='Linux VM final registration CLI size contract' \
node scripts/run-tests.mjs test/register-app.test.mjs
```

## ขอบเขตที่ยังไม่ได้ตรวจ

รอบ diagnostics วันที่ 1 ตุลาคม 2026 ใช้ Git bundle `59084282a98123da43dee5785987056de9d5b082` clone ลง `/home/test/FlowAtlas-qa-5908428` แล้วใช้ portable Node 24.18.0 เดิม: main 56/56 (`2026-09-30T20-12-18-506Z`), isolated source 1/1 (`2026-09-30T20-12-27-693Z`), Chromium inspector journey/restart 1/1 (`2026-09-30T20-12-27-995Z`) ผ่าน ไม่มี failed/skipped และไม่พบ writer lock หลังจบ Source digest ทุกชุดตรง host Windows; main เริ่มจาก clean commit ส่วนรอบหลัง runner เพิ่ม TEST-RUNS ทำให้ dirty แต่ source คงเดิม

นำ raw TAP/JSON และภาพกลับเข้าโครงการด้วย archive `reports/vm/flowatlas-5908428-results.tgz` ตรวจ SHA-256 `45d2842e565a772bd2fdda3fb7bb0aea3425a2862419bd07a0eca64918e004f6` ตรง VM ก่อน extract และตรวจภาพด้วยตาแล้ว ผลนี้เพิ่มหลักฐาน fixtures บน commit เดียวกัน ยังไม่ได้ปิดสาเหตุ intermittent บน Windows/OneDrive หรือยืนยัน external business app

ยังไม่ยืนยัน Linux GUI desktop, browser engine อื่น, มือถือจริง/touch, Linux distro/architecture อื่น, Node 20/22, filesystem ที่แชร์กับ Windows/OneDrive, power loss, production load หรือ OpenTelemetry/Playwright capture การใช้ Playwright ทดสอบ UI ไม่ใช่การเพิ่ม browser trace recorder ให้ผลิตภัณฑ์
## Session/HTTP/workspace revision a9b1a8d

ตรวจ clean bundle clone ใหม่บน VM เดิม /home/test/FlowAtlas-qa-a9b1a8d ด้วย portable Node 22.23.3: main 71/71 (2026-09-30T21-42-31-937Z), isolated source 1/1 (2026-09-30T21-42-48-575Z), secure Chromium inspector 1/1 (2026-09-30T21-42-48-983Z), failed/skipped 0; no writer lock after stop. ครอบคลุม pairing/graph/source/logout/reload/restart; source hashes ทุกไฟล์ตรง host ณ revision นี้

Archive reports/vm/flowatlas-a9b1a8d-results.tgz SHA256 320efcdcbac65b2df4cf24b6cb6aad079173ddfe435777dea3b54a04abc25c28 ตรวจ checksum/paths/no-overwrite ก่อนนำเข้า; ตรวจภาพ restart ด้วยตาแล้ว ผลนี้ไม่รวม adapter-update feature ที่เพิ่มหลัง revision นี้ และไม่ใช่ external-business-app/user trial
