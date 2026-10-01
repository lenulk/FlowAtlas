# การตรวจคุณภาพอัตโนมัติ

[quality.yml](../.github/workflows/quality.yml) ทำงานเมื่อ push, pull request หรือเรียกด้วยมือ โดยรันบน Windows Server 2025 และ Ubuntu 24.04 กับ Node 22.23.3/24.21.0 ทีละขั้นในแต่ละ job:

1. ติดตั้ง QA tools ด้วย `npm ci --prefix tools/qa` จาก lockfile แล้วติดตั้ง Chromium ของ Playwright 1.63.0
   เตรียม runtime tracing dependencies ด้วย root npm ci/shrinkwrap และ project cache เพื่อให้ offline package install ได้ dependencies ที่ตรึงรุ่น
2. main regression ผ่าน `scripts/run-tests.mjs`
3. isolated source check แยกจาก main
4. inspector browser journey พร้อม stop/restart/history
5. independent browser journey พร้อมกราฟ/source ของสาม actions
   ตรวจจริง NodeSDK CJS/ESM HTTP/Undici กับ paired Chromium viewer และหลังติดตั้ง package ตรวจ preload/schema reload อีกครั้ง
6. pack แล้วติดตั้งออนไลน์ใน disposable prefix เพื่อเตรียม tarballs/metadata cache จากแพ็กเกจจริง ก่อนบังคับ offline install ใน prefix ใหม่ พร้อม workspace แยก แล้วตรวจ package CLI/action/graph/source/stop/restart และถอน/ติดตั้งซ้ำโดยตรวจ hash ของประวัติเดิม; package journey ตรวจอัปเดต historical adapter ใน disposable fixture ด้วย
7. upload raw reports และภาพ fixtures พร้อม TEST-RUNS และ pack inventory แม้ทดสอบไม่ผ่าน

Actions pin ด้วย SHA, token ใช้ contents:read และไม่เก็บ credential หลัง checkout; artifacts อายุ 14 วัน ไม่ส่ง data/, reports/ssh/, QA runtime หรือแอปของผู้ใช้ขึ้น GitHub CI ไม่ push ผลทดสอบกลับ branch หาก job ถูก cancel บางชุดอาจไม่รัน ให้ตรวจสถานะตามจริง

ขั้นตอน QA ต่อกันบน source commit เดียวกัน; runner เพิ่ม TEST-RUNS ทำให้ Git dirty หลังชุดแรกได้ จึงต้องเทียบ source digest/files ด้วย `dirty=true` เพียงอย่างเดียวไม่ได้แปลว่า app code เปลี่ยน QA tools แยกจาก runtime app dependencies

Hosted [run 36780927859](https://github.com/lenulk/FlowAtlas/actions/runs/36780927859) ของ a9b1a8d ผ่านครบทั้งสี่ช่อง รวม main 71 tests และ source/browser/package/reinstall gates หลักฐานนี้ครอบคลุม revision นั้น; managed adapter update gates ผ่านครบสี่ช่องใน [run 36826886673](https://github.com/lenulk/FlowAtlas/actions/runs/36826886673) ของ 3f054c5 (main 77 tests); browser module ผ่านครบสี่ช่องใน [run 36827991849](https://github.com/lenulk/FlowAtlas/actions/runs/36827991849) ของ b5c7fd0 (main 81 tests); OpenTelemetry HTTP tracing พร้อมแก้ cold-cache install ผ่านครบสี่ช่องใน [run 36833414845](https://github.com/lenulk/FlowAtlas/actions/runs/36833414845) ของ 18b9ddd (main91); counter/IPC ผ่านครบสี่ช่องใน [run 36834857530](https://github.com/lenulk/FlowAtlas/actions/runs/36834857530) ของ1114257 (main92) เมื่ออัปเดต runtime/QA tools ต้องทบทวน lockfile และผล gate ใหม่ ไม่มี retry อัตโนมัติที่เปลี่ยน failed test เป็น pass

อ้างอิง: [Node releases](https://nodejs.org/en/about/previous-releases), [checkout](https://github.com/actions/checkout), [setup-node](https://github.com/actions/setup-node), [upload-artifact](https://github.com/actions/upload-artifact)

CI เพิ่ม paired fixture benchmark 3 รอบ ×1,000 measured requests ต่อแบบ ตรวจ business responses และ capture accounting โดย performance acceptance แสดงค่าจริงแยกใน log/JSON หาก overhead เกินเป้า gate การวัดอาจยังผ่าน แต่ไม่ถือว่า performance ผ่าน รายงาน reports/benchmarks แนบ artifact และไม่ติดตามใน Git

Hosted [ae55301 run36863352104](https://github.com/lenulk/FlowAtlas/actions/runs/36863352104) FAILED: Windows24 passed all gates; Ubuntu22/24 and Windows22 failed only fixture load capture. Main96/source/browser/SDK/offline package/reinstall passed in all four jobs. Artifact diagnosis found overflow19 in Ubuntu22 round1 and38 in Windows22 round3, no collector rejection/storage/timeout in those results. Performance budgets also failed. The following two-slot repair needs its own exact-revision hosted result; do not present the older green matrix as this feature's certification.

[Two-slot e83f48f run36866592260](https://github.com/lenulk/FlowAtlas/actions/runs/36866592260): Ubuntu24/Windows22/Windows24 succeeded; Ubuntu22 failed only fixture load. Its artifact11163982273 first round overflow440/timeout64, later rounds zero-drop, no rejection/storage diagnostics. Two slots alone did not fix hosted stability.

[Coalescing2f40612 run36868875718](https://github.com/lenulk/FlowAtlas/actions/runs/36868875718) failed only Ubuntu24 fixture load; the other three jobs succeeded. All main100/source/browser/SDK/offline package/reinstall gates passed. Failed artifact11166236048: first two rounds used33batches and zero drops; round3 overflow635/timeout64, no refusal/storage diagnostic. Dense batches therefore do not eliminate intermittent delivery stalls. New validation/storage recovery and fixed runtime-test diagnostics need their own exact-revision hosted result.
