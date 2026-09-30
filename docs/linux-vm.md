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

## ขอบเขตที่ยังไม่ได้ตรวจ

ยังไม่ยืนยัน Linux GUI desktop, browser engine อื่น, มือถือจริง/touch, Linux distro/architecture อื่น, Node 20/22, filesystem ที่แชร์กับ Windows/OneDrive, power loss, production load หรือ OpenTelemetry/Playwright capture การใช้ Playwright ทดสอบ UI ไม่ใช่การเพิ่ม browser trace recorder ให้ผลิตภัณฑ์
