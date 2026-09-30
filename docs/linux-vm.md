# ผลทดสอบ Linux VM

ทดสอบผ่าน SSH บน VM ที่ผู้ใช้ระบุ วันที่ 2026-09-30 ใช้ Linux จริง ไม่ใช่ simulation สภาพแวดล้อมเป็น Debian GNU/Linux 12 (bookworm), kernel 6.1.0-53-amd64, x86_64, Node v24.18.0 และ Git 2.39.5

## ผลที่ตรวจแล้ว

| ชุด | ผ่าน | ไม่ผ่าน | ข้าม | Run ID |
| --- | ---: | ---: | ---: | --- |
| ชุดหลัก | 47 | 0 | 0 | 2026-09-30T14-00-32-338Z |
| Source แยก | 1 | 0 | 0 | 2026-09-30T14-01-44-229Z |

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

## ขอบเขตที่ยังไม่ได้ตรวจ

รอบนี้ทดสอบ Node/HTTP/filesystem บน VM ไม่ได้เปิด GUI browser ใน Linux UI ที่มีภาพหลักฐานเป็นการตรวจบน Windows ในรอบก่อน ยังไม่ยืนยัน Linux distro/architecture อื่น, Node 20/22, filesystem ที่แชร์กับ Windows/OneDrive, power loss, production load หรือ OpenTelemetry/Playwright capture
