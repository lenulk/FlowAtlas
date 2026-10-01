# รอบทดสอบและปรับปรุง FlowAtlas

## เกณฑ์ผ่านของต้นแบบปัจจุบัน

1. actions ของ demo และแอปแยกโปรเซสให้กราฟตรงกับผลสำเร็จ/ความล้มเหลว
2. ข้อมูลไม่ถูกต้องถูกปฏิเสธด้วย 4xx และไม่ทำลายกราฟเดิม
3. หลักฐานของคนละ action และคนละบริการไม่ปะปนกัน
4. ไม่มีการเลื่อน inferred/unknown เป็น observed โดยไม่มีหลักฐาน
5. ลิงก์โค้ดตรวจรุ่นไฟล์จริงและปฏิเสธ snapshot ที่เปลี่ยน
6. การล้มของ telemetry ไม่เปลี่ยนผลธุรกิจของ fixture; ต้องแจ้งช่องว่างที่เกิดขึ้น
7. ทุกครั้งที่รันทดสอบด้วย `npm test` เก็บผล TAP, metadata และรายการผลโดยอัตโนมัติ

ผลการรันทั้งหมดอยู่ใน [TEST-RUNS.md](TEST-RUNS.md) การผ่านเกณฑ์นี้ไม่ยืนยันว่าผ่านแผนพัฒนาทั้งหมดใน [PLAN.md](../PLAN.md)

## รอบ 1 — ตรวจฐานเดิม

- สภาพเริ่มต้น: commit `a517239`, working tree สะอาด, มี 11 tests
- วิธีตรวจ: อ่านเส้นทาง HTTP, ingestion, evidence validator, fixture และชุดทดสอบเดิม
- สิ่งที่ต้องตรวจเพิ่ม: payload ที่ไม่ใช่ object/เวลาผิดรูปแบบ, ความสัมพันธ์ข้ามบริการ, concurrency, การล้มของ collector และขอบเขต retention
- เครื่องมือ: `npm test` เริ่มไม่ได้เพราะ npm launcher ในเครื่องเสีย ใช้ `node scripts/run-tests.mjs` แทน ไม่เปลี่ยนการติดตั้ง npm ของเครื่อง
- ผล baseline: 11/11 ผ่าน (`2026-09-30T09-54-00-133Z`) ยืนยันเส้นทางหลักเดิม แต่ยังไม่ครอบคลุมกรณีขอบเขตด้านล่าง

## รอบ 2 — ข้อมูลผิดรูปแบบและ atomic ingestion

- สมมติฐานจากการอ่านโค้ด: JSON `null` อาจเป็น 500; `clientTime` อาจเก็บข้อมูลชนิดอื่น; lookup ไฟล์อาจอ่าน property ที่สืบทอดมา; handler ที่ชนกันอาจทิ้ง node หลังปฏิเสธ event
- เกณฑ์: invalid input เป็น 400, graph ไม่เปลี่ยนเมื่อปฏิเสธ event และ validator คืน issues แทน throw เมื่อข้อมูล graph ผิดรูปแบบ
- ผลก่อนแก้: 0/3 ผ่าน (`2026-09-30T09-55-48-329Z`) ยืนยันว่า JSON null เป็น 500, source `__proto__` ทำให้กราฟอ่านไม่ได้หลังตอบ 400, validator throw บน null node
- สาเหตุ: ขาดชนิดข้อมูลที่ขอบ HTTP, lookup file ใช้ inherited property และ ingestion เปลี่ยน graph ก่อนตรวจครบ
- การแก้: ตรวจ JSON object/เวลา, จำกัด body ด้วย byte จริง, source ต้องเป็น own property, สร้าง event บนสำเนาก่อน commit และตรวจ node declaration ที่ชนกัน; validator รับ malformed element ได้
- ความเสี่ยงที่ต้องตรวจต่อ: node คำขออาจชนกันระหว่าง destination และยังต้องตรวจ telemetry outage
- ผลหลังแก้: 14/14 ผ่าน (`2026-09-30T09-57-57-289Z`) ครอบคลุม regression ทั้งสามและเส้นทางเดิม

## รอบ 3 — ตัวตนบริการและ correlation

- สมมติฐาน: node ID ของ outbound ใช้เฉพาะ method/path จึงชนเมื่อส่งไปสองบริการ; outbound trace ไม่ถูกเทียบกับ handler trace
- เกณฑ์: request node และ evidence แยก destination; trace ID ผิดถูกปฏิเสธ แต่ child span ใน trace เดียวกันผ่าน; 20 actions พร้อมกันไม่ปะปน
- ผลก่อนแก้: 1/3 ผ่าน (`2026-09-30T09-59-51-502Z`) concurrency ผ่าน; destination ที่สองถูกปฏิเสธจาก node ชน และ trace ID ต่างกันถูกยอมรับ
- การแก้: request/route/gap IDs ของ ingestion รวม destination, evidence และ node ระบุ destination ตรงกัน; เทียบ trace ID ของ outbound กับ handler โดยยอมรับ child span ใหม่ใน trace เดียวกัน
- ผลหลังแก้: 17/17 ผ่าน (`2026-09-30T10-00-52-696Z`) ป้องกัน regression ทั้งสองและ concurrency

## รอบ 4 — การล้มของ telemetry

- ปัญหาจากโค้ดและ README: fixture รอ collector ทุกเหตุการณ์ และส่ง 502 แม้งานธุรกิจยังทำได้
- เกณฑ์: collector ล้มทั้งก่อนและหลัง action start แล้วธุรกิจยังตอบ 200/503 ตามจริง พร้อมบอก capture ไม่ครบ; invalid input ต้องตรวจได้ใน fixture เอง
- ผลก่อนแก้: 0/3 ผ่าน (`2026-09-30T10-02-50-500Z`) outage ก่อนเริ่มทำให้ 502, ไม่มีสถานะ capture, fixture null payload เป็น 502
- การแก้: registry ของ action ใน fixture แยกจาก collector; ส่ง telemetry แบบ best effort ด้วย timeout 500 ms และหยุดส่งเมื่อ capture ขาด; ผล API มี header complete/incomplete และ UI แสดงคำเตือน/ลิงก์บางส่วน; fixture ตรวจ input ก่อนติดต่อ collector
- ข้อจำกัด: ยังรอ telemetry สูงสุด 500 ms ต่อเหตุการณ์ที่สำเร็จ/timeout, ไม่มี retry queue; capture ที่ขาดอาจค้าง running ใน collector เพราะ finish ส่งไม่ถึง
- ผลหลังแก้: 20/20 ผ่าน (`2026-09-30T10-05-00-539Z`) รวมแอปที่รันแยกโปรเซสเดิม

## รอบ 5 — ขนาดข้อมูลและ retention

- สมมติฐาน: action count ถูกจำกัด แต่กราฟของ action เดียวโตได้ไม่จำกัด
- เกณฑ์: retention ตัดเฉพาะรายการเก่า, UTF-8 body จำกัดตาม byte, graph สูงสุด 100 nodes/200 edges และ overflow เป็น 413 โดยไม่เปลี่ยนกราฟ
- ผลก่อนแก้: 2/3 ผ่าน (`2026-09-30T10-07-05-240Z`) retention และ UTF-8 ถูกต้อง แต่กราฟเกินขอบเขตยังได้ 202
- การแก้: จำกัด 100 nodes/200 edges ใน FlowAtlas; ingestion ตอบ 413 เมื่อเต็มและยังใช้ atomic update
- ผลหลังแก้: 24/24 ผ่าน (`2026-09-30T10-08-12-080Z`) รวมขอบ node count และกราฟเต็มยังอ่าน JSON ได้

## รอบ 6 — UI ผ่านเบราว์เซอร์จริง

- สภาพแวดล้อม: Windows, Codex in-app browser, Node v24.18.0, collector 4173 และ fixture 4180
- ตรวจ view-message: HTTP 200, เปิดกราฟได้ `success · 6 nodes`, evidence แสดง destination/traceparent/echo ตรงกัน, มี observed/inferred/unknown ครบ
- ตรวจ fail-message: หน้า fixture แสดง HTTP 503 และข้อความของบริการตามจริง
- หลักฐานภาพ: `reports/ui/graph-success.jpg`
- ตรวจ outage: ปิด collector แล้วกดส่งข้อความ ได้ HTTP 200 / MSG-1 พร้อมคำเตือน capture ไม่ครบ และไม่มีลิงก์กราฟที่ใช้ไม่ได้ (`reports/ui/collector-outage.jpg`)
- ผล: ผ่านทั้ง 3 กรณีที่ตรวจด้วยมือ; ปิดเซิร์ฟเวอร์ QA แล้ว

## รอบ 7 — ทบทวน diff และ failure boundaries เพิ่มเติม

- จากการทบทวน diff พบว่า downstream transport failure มี graph error ที่ capture ครบ แต่ response ไม่มี telemetry header ทำให้ UI อาจแจ้งผิดว่า collector ล้ม
- ตรวจแยก transport failure, collector ค้างและ timeout, การใช้ action ซ้ำ และ source file เปลี่ยน/ถูกลบหลัง capture
- source check รันแยกด้วย `node scripts/run-tests.mjs scripts/source-check.mjs` เพื่อไม่ให้ fixture file ชั่วคราวแข่งกับการ snapshot ของ tests อื่น
- ผลก่อนแก้: 4/6 ผ่าน (`2026-09-30T10-14-48-160Z`) ยืนยัน source ถูกลบเป็น 500 และ transport failure ไม่มี capture header; collector timeout และการใช้ action ซ้ำผ่าน
- การแก้: source ที่ถูกลบหลัง snapshot ตอบ 409; fixture error response ใส่ capture header เช่นเดียวกับ success response
- ผลหลังแก้: ชุดรวม 26/26 ผ่าน (`2026-09-30T10-17-15-130Z`) และ source check 1/1 ผ่าน (`2026-09-30T10-17-25-115Z`)

## สถานะหลังรอบ 7

- Automated: 27 กรณีผ่าน (26 ชุดหลัก + 1 source check แยก); ไม่พบ failure ค้างในขอบเขตที่ตรวจ
- Manual UI: 3 กรณีผ่าน บันทึกภาพ success graph และ collector outage
- เพิ่ม project `AGENTS.md` ให้การทดสอบครั้งถัดไปใช้ runner และบันทึกการวิเคราะห์ด้วย
- ปรับรายงานให้เก็บ hashes ของ code/tests/runner/package.json เพื่อระบุไฟล์ที่ทดสอบแม้ working tree ยัง dirty; focused runner check ผ่าน 3/3 (`2026-09-30T10-19-01-072Z`) และตรวจ JSON ว่ามี digest + 24 file hashes จริง
- ทบทวน actual diff และ syntax ของ JavaScript ทุกไฟล์แล้ว ผ่าน; `git diff --check` ผ่าน; อ่านภาพ QA ทั้งสองแล้วข้อความ/กราฟไม่ถูกตัด
- ยังไม่ยืนยัน: Node 20/22 (ครั้งนี้ใช้ Node 24), browser อื่น/มือถือ, ปริมาณโหลดระดับ production, แอปภายนอก repository, trace มาตรฐาน, storage ถาวร และประโยชน์กับผู้ใช้จริง
- ความเสี่ยงที่เหลือของ telemetry: ไม่มี retry queue, มีการรอที่จำกัดเวลา และ capture ที่ขาดอาจค้าง running; ต้องตรวจ capture status ควบคู่ผลธุรกิจ

## รอบ 8 — การเก็บผลถาวรและรายการย้อนหลัง

- สภาพเริ่มต้น: commit `df2cfe7`, working tree สะอาด; ทุก action หายเมื่อ process หยุด
- เกณฑ์ผ่าน: completed/partial graphs เปิดได้หลัง restart และ evidence IDs/status/codeVersion ไม่เปลี่ยน; retention ครอบคลุม disk; ไฟล์เสียต้องไม่ถูกเขียนทับ; ป้องกันหลาย collector เขียน directory เดียวกัน
- รูปแบบที่เลือก: JSON snapshot ของ actions ทั้งชุด เขียน temp + fsync + rename เพื่อให้การเพิ่ม/แก้/retention เกิดพร้อมกัน; จำกัด 100 actions / 64 MiB; CLI ใช้ `data/actions/` ส่วน tests เดิมใช้ in-memory และ persistence tests ใช้ directory แยก
- ผลก่อนแก้: 4 กรณีไม่ผ่านตามที่ยังไม่มี storage; test harness ค้างเมื่อ negative startup เปิด server สำเร็จ จึงหยุดและบันทึกด้วยมือ พร้อมแก้ cleanup ของ tests
- การเปลี่ยน: disk save ก่อนตอบรับหรือ commit graph, writer lock, validate saved graph/path/digest ก่อนโหลด, graceful shutdown ปลด lock, source link เลือก snapshot ของ action เก่าได้
- ข้อจำกัดที่กำหนด: synchronous disk write เหมาะกับต้นแบบในเครื่อง; lock ค้างจาก crash ต้องตรวจ process และเก็บ backup ก่อน recovery; fsync/rename ไม่ยืนยันความทนไฟดับหรือความขัดแย้งจาก OneDrive บนหลายเครื่อง
- ผลหลังเพิ่ม storage: 4/4 ผ่าน (`2026-09-30T11-05-26-981Z`) และกำลังตรวจ write failure/source รุ่นเก่าเพิ่ม

## รอบ 9 — รายการย้อนหลังและ JSON query

- เกณฑ์: ค้นด้วยชื่อ/ID, กรองผลลัพธ์ และจำกัดจำนวนหลัง filter; เปิดกราฟเดิมจาก UI ได้หลัง restart; แสดง disk/memory mode ตามจริง
- ผลก่อนเพิ่ม query/UI: 0/2 ผ่าน (`2026-09-30T11-09-01-073Z`) server ยังไม่กรองและยอมรับ filter ผิด
- การเพิ่ม: query `q/outcome/limit` พร้อม 400 สำหรับค่าผิด, ตารางย้อนหลังและตัวกรอง, ลิงก์เปิด action/source snapshot รุ่นที่ capture, footer แสดง disk/memory ตาม API
- ผลหลังเพิ่ม: ชุดรวม 32/32 ผ่าน (`2026-09-30T11-11-41-657Z`); ตรวจ UI จริงและ restart ผ่านในรอบ 11

## รอบ 10 — storage failure และ snapshot รุ่นเก่า

- ชุดรวมหลัง storage/query: 32/32 ผ่าน (`2026-09-30T11-11-41-657Z`)
- ตรวจเพิ่มแบบจำลอง filesystem obstruction จริงใน test directory: 503 ต้องไม่ commit graph/action และ temp file ถูกล้าง; หลังแก้ obstruction ต้องเขียนต่อได้
- ตรวจ saved source traversal, digest ผิด, duplicate IDs และการตั้ง data directory ทับ code/Git; source check แยกตรวจการ restart หลังไฟล์เปลี่ยน โดย codeVersion เดิมต้องถูกเก็บไว้
- ผล focused ก่อน guard: 6/7 ผ่าน (`2026-09-30T11-15-01-652Z`); filesystem failure/rollback, validation และ restart ผ่าน แต่ data directory ยังเลือกทับ src ได้
- การแก้: ปฏิเสธ data directory ใต้ src/public/examples/Git/config folders ก่อนสร้างไฟล์
- ผลหลัง guard: ชุดหลัก 35/35 ผ่าน (`2026-09-30T11-16-07-209Z`); source snapshot เดิมหลัง restart 1/1 ผ่าน (`2026-09-30T11-16-16-085Z`)

## รอบ 11 — UI และ restart จริงในเครื่อง

- ใช้ `scripts/qa-session.mjs` เพื่อเปิด collector กับ directory แยกใต้ reports/storage และ restart ผ่าน stdin (ใช้ graceful close แทนบังคับ kill)
- ตรวจ UI: สร้าง actions, ตารางย้อนหลัง, ค้นด้วยชื่อ, กรอง error, โหลดหน้าหลัง restart และเปิดกราฟที่บันทึกก่อน restart
- ผล: ผ่าน — สร้าง 5 actions, error filter แสดง order ที่ล้มเพียงรายการเดียว, restart คืนครบ 5 รายการ, ค้น check-stock แล้วเปิดกราฟเดิม 6 nodes และ source link ผูกกับ action เดิม
- หลักฐาน: `reports/ui/history-after-restart.jpg` และ JSON state ของ QA session เก็บไว้ใน reports/storage ตาม TEST-RUNS.md
- เพิ่ม integration test ที่ปิด Node process แรกแบบ graceful แล้ว spawn process ใหม่ โดยเปรียบเทียบ graph JSON ทั้งชุดและ disk status
- ขอบเขต: การทดสอบนี้ไม่ใช่การจำลองไฟดับหรือบังคับ kill process ระหว่าง rename
- ผล process restart: 1/1 ผ่าน (`2026-09-30T11-23-49-658Z`)

## รอบ 12 — ความถูกต้องของรุ่นโค้ดเมื่อใช้ action เก่า

- ข้อค้นพบจาก actual diff: เมื่อเปิด state ของโค้ดรุ่นเก่า API อาจรับ action ID เก่ามาบันทึกเหตุการณ์ใหม่และคง codeVersion เดิม
- เกณฑ์: อ่านกราฟ/source เก่าได้ตามเดิม แต่เมื่อ code digest ต่างกันต้องปฏิเสธการเติมเหตุการณ์ด้วย 409 และไม่เปลี่ยน graph เดิม
- ผลก่อน guard: 0/1 ผ่าน (`2026-09-30T11-26-20-404Z`) ยืนยัน API ตอบ 200 และเติม graph ของ snapshot เก่าได้
- การแก้: ตรวจ digest เมื่อ ensure/ingest action เดิม, ตอบ 409 เมื่อรุ่นต่างกัน และไม่ finish/mutate graph เก่าใน error handler
- ผลหลัง guard: ชุดหลัก 36/36 ผ่าน (`2026-09-30T11-27-43-620Z`) และ isolated snapshot 1/1 ผ่าน (`2026-09-30T11-27-51-901Z`)

## สถานะหลังรอบ 12

- Automated: 39 กรณีผ่าน (38 ชุดหลัก + 1 isolated source check), Node v24.18.0
- Manual: ตารางเพิ่ม 5 actions, filter error, restart โหลดครบ, ค้นชื่อและเปิดกราฟ/source รุ่นเดิมผ่าน; QA server ปิดแบบ graceful และเก็บข้อมูลทดสอบแยกไว้ใน reports/storage
- Milestone ที่ได้: เก็บผลถาวรและเปิดย้อนหลังได้พร้อม code provenance; metadata/evidence เดิมไม่เปลี่ยนหลัง process ใหม่
- ยังไม่พิสูจน์: แอปภายนอก repository, OpenTelemetry SDK/Playwright capture, ประโยชน์กับผู้ใช้จริง, Node 20/22, production load, forced crash/power loss และ OneDrive ข้ามเครื่อง
- ข้อจำกัดและ recovery บันทึกใน [storage.md](storage.md)

## ตรวจ integration ของ storage รอบสุดท้าย

- การปรับข้อความ source conflict ให้ตรง captured snapshot ผ่าน isolated check 1/1 (`2026-09-30T11-31-51-627Z`)
- เพิ่มกรณี 20 actions พร้อมกันใน disk mode แล้ว reload เพื่อครอบคลุม checkpoint ที่เกิดระหว่าง requests; เพิ่ม port conflict ทั้ง app/inventory เพื่อพิสูจน์ว่า startup failure ปลด writer lock
- ผล: ชุดหลัก 38/38 ผ่าน (`2026-09-30T11-33-55-378Z`) รวม concurrency บนดิสก์และ startup failure ทั้งสอง listener; isolated source check ล่าสุด 1/1 ผ่าน (`2026-09-30T11-31-51-627Z`)
- ตรวจ final diff และ syntax 25 ไฟล์ผ่าน; JSON รายงานชุดหลักยืนยัน 38 passed / 0 failed / 0 skipped; QA state ยังมี 5 actions และไม่มี writer lock หลัง graceful stop
- ตรวจลิงก์ไฟล์ในเอกสาร 12 ลิงก์ ปลายทางมีอยู่ครบ
- เกณฑ์ storage/history ของรอบนี้ผ่านภายในขอบเขตที่ทดสอบ; production stress test ยังไม่มี workload เป้าหมาย และไม่ได้เพิ่มการทดสอบโดยไม่มีความเสี่ยงที่ต้องตอบ

## รอบ 13 — source snapshot ของแอปคนละโครงการ

- เริ่มจาก commit `7b03328`, working tree สะอาด; ingestion เดิมใช้ snapshot ของ collector เท่านั้น
- เกณฑ์: ลงทะเบียนแอปแยกด้วย root/ไฟล์ที่อนุญาต, ตรวจ project ID และ digest ก่อนรับ action, source link อ่านเฉพาะไฟล์ที่ลงทะเบียน, persistence/restart รักษารุ่นเดิม และปฏิเสธการเติมข้อมูลข้ามโครงการ/รุ่น
- ผลก่อนเพิ่ม: 0/3 ผ่าน (`2026-09-30T12-55-03-741Z`); endpoint registration ยังไม่มี, project ID ถูกละเลย และ config ผิดยังเปิด server ได้
- การเปลี่ยน: local config เท่านั้น (ไม่มี HTTP ให้ลงทะเบียน path), root ต้องอยู่ในโฟลเดอร์โครงการ, allowlist 1–64 code files, ตรวจ symlink/path escape และ source size, snapshot ระบุ projectId และใช้ Git commit เฉพาะเมื่อ Git root เป็นแอปนั้นจริง
- ยังต้องตรวจ: adapter ที่ใช้ซ้ำได้และ HTTP integration จาก Node process ใน repository แยก; ไม่ถือว่าการลงทะเบียนเป็นการพิสูจน์ตัวตน event หรือ OpenTelemetry
- ผลหลัง registration: 3/3 ผ่าน (`2026-09-30T12-58-18-358Z`)

## รอบ 14 — ตัวเชื่อม Node.js ที่ใช้ซ้ำได้

- เพิ่ม adapter แบบ explicit instrumentation: start/handler/fetch/finish, correlation + traceparent จริง, best effort timeout และ capture status; ไม่ patch global fetch
- ตรวจ privacy ของ telemetry ด้วย request ที่มี body/token/query/cookie แล้ว event ต้องไม่มีค่าเหล่านั้น; business response/body ต้องอ่านได้ตามเดิม
- ผล focused: 4/4 ผ่าน (`2026-09-30T13-01-26-645Z`) รวม collector หยุด/ค้าง และ downstream transport failure; ขอบเขตเป็น custom metadata protocol ยังไม่ใช่ OpenTelemetry SDK
- integration ที่เพิ่มต่อใช้ adapter สำเนาใน Git repository ใหม่ใต้ reports/storage และ Node process ใหม่ มี mock destination ที่ไม่มี instrumentation ภายใน
- รอบ integration แรกค้าง: stop handler ปิด readline แต่ pipe stdin ของ child ยังไม่จบ; timeout kill ทำให้ cleanup assertion ล้มและข้ามการปิด collector จึงหยุด runner และบันทึกด้วยมือ แก้ทั้ง child stdin และ finally ของ harness ก่อนตรวจกราฟต่อ

## รอบ 15 — ช่องว่างหลักฐานของบริการที่ไม่มี source route

- ผลหลังแก้ harness: 0/1 ผ่าน (`2026-09-30T13-08-58-912Z`) child ปิดปกติและ runner บันทึกผลได้; พบกราฟไม่มี unknown coverage gap เมื่อ outbound event ไม่ประกาศ routeFile
- สาเหตุ: ingestion สร้าง unknown เฉพาะใน branch ที่มี route source; adapter ของแอปจริงไม่ควรต้องประกาศ source ของบริการที่ไม่ได้ติดตั้ง trace
- แก้: เมื่อได้รับ HTTP response แต่ไม่มี route source ให้ต่อ coverage gap โดยตรงจาก external request พร้อมเหตุผลว่าขาดทั้ง source route และ internal spans ไม่เพิ่ม inferred route ที่ไม่มีหลักฐาน
- ผลหลังแก้: integration/adapter/registration 8/8 ผ่าน (`2026-09-30T13-09-53-688Z`) และ child ปิดด้วย exit 0; failed-run collector PID 8500 ตรวจด้วย Get-Process แล้วไม่เหลือ process เก็บ state/lock ของรอบล้มไว้เพื่อการวิเคราะห์

## รอบ 16 — ขอบเขต filesystem ของ registration

- ตรวจ junction จริงบน Windows ทั้ง path component และ root ที่เปลี่ยนหลัง capture, config path นอกโครงการ, config ผิดชนิด และ HTTP status ของ project/digest ผิดให้ตรงกรณี
- ผล: 4/4 ผ่าน (`2026-09-30T13-12-57-241Z`); ไม่มีการอ่านเนื้อไฟล์ปลายทางที่ไม่ได้รับอนุญาต
- ตรวจ generator เพิ่มก่อน manual QA: ไม่เขียนทับ app เดิม, ปฏิเสธ config symlink, validate config เดิมก่อนเพิ่ม, เก็บ field อื่นไว้ และเปลี่ยน config ด้วย temp/rename

## รอบ 17 — เก็บ test artifacts ภายในโครงการ

- อ่าน test เดิมก่อนชุดรวมพบ code-version test ใช้ OS temp directory ซึ่งไม่ตรงคำสั่งผู้ใช้ให้เก็บทุกอย่างในโครงการ
- ย้าย disposable Git fixture ไป reports/storage พร้อม guard ก่อน cleanup; behavior ของการตรวจ commit/dirty/digest เดิมต้องยังผ่าน
- ผล focused: 1/1 ผ่าน (`2026-09-30T13-15-03-111Z`)

## รอบ 18 — ชุดรวมและ UI ของ repository แยก

- ชุดหลัก 47/47 ผ่าน (`2026-09-30T13-15-24-174Z`), isolated source 1/1 ผ่าน (`2026-09-30T13-15-44-920Z`)
- สร้างแอปพร้อมใช้ใน apps/message-app ซึ่งมี Git repository แยก และ config ในโครงการ; Node target อ่าน adapter สำเนาในแอป ไม่ import collector runtime
- UI จริง: view/send HTTP 200, fail HTTP 503, viewer error 5 nodes มี observed 3 + unknown 1; restart collector แล้วยังมี 3 actions และกราฟเดิม
- UI source link แสดง project handler ถูกต้อง แต่ IAB ปฏิเสธเปิด source URL ด้วย ERR_BLOCKED_BY_CLIENT; source HTTP content/hash/status ตรวจด้วย integration แล้ว สาเหตุระดับ browser client ยังไม่ได้ยืนยัน และไม่ได้ข้าม browser protection
- UI outage จริงผ่าน: collector หยุดแล้ว target ยังตอบ HTTP 200 / MSG-1 พร้อมคำเตือน capture ขาดและไม่มีลิงก์กราฟที่เปิดไม่ได้

## รอบ 19 — type guard ของ project provenance

- Actual diff review พบ regex coerces boolean projectId และ array codeDigest เป็น string จึงอาจยอมรับ config ผิดชนิด
- Regression ก่อนแก้: 6/8 ผ่าน (`2026-09-30T13-23-32-533Z`); adapter และ registration รับชนิดผิดจริง
- แก้: ตรวจ typeof ก่อน regex ใน snapshot/adapter และ validator ของ graph/storage; รักษารูปแบบเดิมของ graph ที่ไม่มี projectId
- ผล: ชุดหลัก 47/47 ผ่าน (`2026-09-30T13-24-50-762Z`), isolated source 1/1 ผ่าน (`2026-09-30T13-25-17-418Z`)

## รอบ 20 — handler symbol ของ fixture ต้องตรงฟังก์ชันที่เรียก

- Final source review พบตัวอย่างใหม่ใช้ชื่อ viewMessage/sendMessage/failMessage เป็น route metadata แต่ยังไม่ได้มี named functions เหล่านี้ แม้ source declaration เป็น inferred ก็ไม่ควรแสดง symbol ที่ไม่มีจริง
- Regression ก่อนแก้: 0/1 ผ่าน (`2026-09-30T13-26-54-960Z`) source ของ handler ไม่มีฟังก์ชันที่ชื่อเดียวกับ symbol
- แก้ fixture ให้ route เรียก named functions จริงทั้งสาม และแต่ละฟังก์ชันบันทึก handler-entry จากภายในฟังก์ชันนั้น; source association ยังเป็น declared/inferred และความแท้ของผู้ส่งยังอยู่ในขอบเขต trusted local process
- ผลหลังแก้: ชุดหลัก 47/47 ผ่าน (`2026-09-30T13-28-10-353Z`); graph/source check ของ independent repository ตรวจ named function ครบทั้งสาม
- Final isolated source 1/1 ผ่าน (`2026-09-30T13-31-58-491Z`); final static review ผ่าน syntax 32 ไฟล์, local links 18 ลิงก์ และ git diff --check; manual state มี 3 actions ไม่มี writer lock และ target repository สะอาดที่ commit `0c40ee2`

## สถานะล่าสุดหลังรอบ 20

- Automated: 48 กรณีผ่าน (47 ชุดหลัก + 1 isolated source) บน Windows / Node v24.18.0; ทุก completed run มี TAP/JSON และ log รวม failed regressions
- Manual UI: 3 actions สำเร็จ/ล้มเหลว, graph พร้อม gap, restart โหลดประวัติเดิม และ collector outage ผ่าน; source URL ถูก IAB block และแยกข้อจำกัดนี้จาก HTTP integration ที่ผ่าน
- แอปพร้อมทดลอง: apps/message-app มี repository แยก, local config และ adapter สำเนาในแอป; เอกสารการติดตั้งใน node-adapter.md เซิร์ฟเวอร์ QA ทั้งสองปิดด้วย exit 0
- ยังไม่พิสูจน์: OpenTelemetry SDK/Playwright capture, แอปธุรกิจจริงของผู้ใช้/คุณค่าจาก user trial, Node 20/22, browser อื่น/มือถือ, production load, forced crash/power loss และ OneDrive ข้ามเครื่อง
- ข้อจำกัดใหม่: explicit allowlist/root ภายในโครงการ, declaration ของ symbol เชื่อ sender, adapter ไม่ตาม redirects, telemetry ไม่มี retry; source link ใน IAB ต้องตรวจต่อใน browser อื่นหรือเพิ่ม source viewer

## รอบ 21 — เตรียมการตรวจ Linux VM

- ผู้ใช้เลือก SSH VM แยก; inspect พบ Debian 12 x86_64 และไม่มี Node/Git จึงยังไม่มีผล Linux test
- เกณฑ์: ทดสอบ main + isolated source บน Linux จริง ด้วย source commit ที่ระบุ และเก็บ raw reports กลับในโครงการ; แยกผล Windows/Linux และ failure/skip ตามจริง
- เพิ่ม platform/arch/osRelease ใน test runner เพื่อไม่ให้รายงานของ VM ปะปนกับ Windows; ไม่เปลี่ยน test behavior หรือข้อมูล graph
- เตรียม runtime จาก official Node archive พร้อม SHA-256 และ Git จาก Debian repository โดยไม่แก้ repository sources ของระบบถาวร; ผลต้องตรวจหลังติดตั้งจริง
- Windows runner check 3/3 ผ่าน (`2026-09-30T13-55-42-667Z`); อ่าน JSON ยืนยัน win32/x64/OS 10.0.26200 พร้อม counts ถูกต้อง และ diff whitespace ผ่าน

## รอบ 22 — ผล Linux และการนำเข้ารายงาน

- Main บน Debian 12 VM ผ่าน 47/47 (`2026-09-30T14-00-32-338Z`) และ isolated source ผ่าน 1/1 (`2026-09-30T14-01-44-229Z`), ไม่มี skipped/failure
- Node v24.18.0 ตรวจ archive SHA-256 ผ่าน; source bundle SHA-256 ผ่านก่อน clone/checkout commit `530e221945e5aa13d29c6c938337580c506d6a59`; ไม่ใช้ simulation หรือ WSL แทน VM
- ตรวจหลังทดสอบไม่เหลือ Node QA process หรือ writer lock บน VM; ปิด SSH session แล้ว คง QA workspace/runtime ไว้สำหรับรันซ้ำ
- พบปัญหา host import: Windows tar.exe ไม่อ่าน absolute path ที่มีภาษาไทย ทั้งที่ PowerShell อ่านและตรวจ checksum ได้; ใช้ relative ASCII paths แก้ที่ขั้นตอนนำเข้า ไม่แก้ผล test ที่ผ่านแล้ว
- ผลนำเข้า: archive + raw report 4 ไฟล์ SHA-256 ตรงทั้งหมด; อ่าน JSON บน Windows ยืนยัน platform=linux, counts 47/47 + 1/1, failure/skip 0, commit ตรง และ Node/kernel ตาม VM
- ขอบเขต: ตรวจ Node/HTTP/filesystem บน Linux VM แล้ว แต่ Linux GUI/browser และ distro/Node version อื่นยังไม่ทดสอบ รายละเอียด/วิธีรันซ้ำอยู่ใน [linux-vm.md](linux-vm.md)

## สถานะล่าสุดหลัง Linux VM

- Windows: ชุดหลัก 47 + isolated source 1 ผ่านในรอบ 20; runner environment check เพิ่ม 3/3 ผ่านบน Windows ในรอบ 21
- Linux VM: 48 กรณีผ่าน ไม่มี failure หรือ skip บน Debian 12 / Node v24.18.0 พร้อม raw reports ที่นำกลับมาและตรวจ checksum แล้ว
- ไม่ต้องแก้ app logic จากผล Linux รอบนี้; แก้เฉพาะ runner metadata และวิธีนำเข้า archive บน host ที่มี path ภาษาไทย
- ข้อจำกัดของ trace/user trial/production จากรอบ 20 ยังเหลืออยู่; ไม่ใช้ผล Linux นี้อ้างว่า production ready

## รอบ 23 — Linux Chromium UI และ source popup

- เกณฑ์ปิดช่องว่าง: browser จริงบน Linux ต้องคลิก target ทั้งสามและเปิด graph/source, ค้นหา history, reload หลัง restart, ตรวจ viewport แคบ/source conflict/outage พร้อมภาพและ raw results
- เพิ่ม optional scripts/browser-check.mjs รันผ่าน runner เดิม ไม่เพิ่ม app dependency; app แยก Git/process, collector/data แยก และคืน source หลัง mutation ทดสอบ
- เตรียมเครื่องมือพบ dpkg pager รับคำสั่งเป็น input, npm ETIMEDOUT, host registry fetch EACCES และ host TTY Git ไม่อยู่ใน cwd; แก้ขั้นตอนใช้ pager=cat, wget archives พร้อม registry SHA-512, explicit TTY cwd และ non-TTY static checks
- ชุด browser ผ่าน 8/8 (2026-09-30T14-47-44-954Z) บน Debian 12 / Node v24.18.0 / Chromium 153.0.8010.12 / Playwright 1.63.0 ไม่มี fail/cancelled/skip; uncaught pageerror 0
- Source UI ใน Chromium เปิดได้ทั้งสาม handler และเปลี่ยน source แล้วได้ 409; ปัญหา IAB block ยังไม่ได้พิสูจน์สาเหตุ แต่ไม่เกิดใน Linux Chromium run นี้
- ไม่พบ app bug ในขอบเขตที่ตรวจ จึงไม่แก้ app logic; narrow viewport ผ่าน containment/internal scroll เท่านั้น ไม่อ้างมือถือจริงหรือ touch usability
- Import ครั้งแรกสร้าง destination directory ไม่ครบ ทำให้ Copy-Item ภาพล้มเหลว แม้ checksum ผ่าน; สร้าง directory ก่อน copy และเทียบไฟล์เดิมก่อนข้าม ผลสุดท้าย archive/raw/evidence/source hashes ตรงทั้งหมด
- ตรวจภาพทั้ง 7 แล้ว ไทย/กราฟ/history/conflict/outage ตรงผล automated; VM ไม่มี process ของ QA workspace หรือ writer lock ค้าง ปิด SSH แล้ว หลักฐานและวิธีรันซ้ำใน linux-vm.md
- สถานะ Linux: ชุดหลัก 47 + source 1 + browser 8 = 56 กรณีผ่าน แยกรอบตามหลักฐาน; ยังไม่พิสูจน์ GUI desktop/browser อื่น/มือถือจริง/Node 20–22/production/user trial หรือ trace capture มาตรฐาน

## รอบ 24 — เครื่องมือเรียกใช้ตามต้องการ

- ผู้ใช้ระบุรูปแบบที่ต้องการ: เรียกใช้เครื่องมือ/ตัวเสริมเมื่ออยากเห็นการทำงาน จึงทำ CLI เริ่ม collector กับ Node app ที่ลงทะเบียนและติดตั้ง adapter ด้วยคำสั่งเดียว พิมพ์ URL ของแอปและแผนที่ ปิดทั้งคู่ด้วย `stop`
- เกณฑ์: กด action ของแอปแล้วได้กราฟที่สัมพันธ์ด้วย action ID; ปิดแล้วสองพอร์ตหยุด; URL นอก localhost ถูกปฏิเสธก่อนเปิดบริการ; target startup failure ไม่ทิ้ง writer lock
- First focused test ค้างหลัง stop เพราะ CLI ปิด readline แต่ยังถือ stdin pipe; ยุติ run ก่อน runner สร้าง report และบันทึกใน TEST-RUNS.md ตรวจด้วย direct TTY พบ service ปิดแล้ว; แก้ให้ destroy stdin หลัง stop
- Windows focused 2/2 ผ่าน (`2026-09-30T15-14-23-434Z`) หลังแก้ และ 3/3 ผ่าน (`2026-09-30T15-15-57-442Z`) หลังเพิ่ม startup failure regression
- Linux VM focused 3/3 ผ่าน (`2026-09-30T15-18-33-154Z`), failed/skipped 0; ตรวจ source/archive/raw report checksums ตรง ไม่พบ writer lock ค้าง และปิด SSH
- ขอบเขต: คำสั่งช่วยลดขั้นตอนเปิดใช้งานแอปที่ลงทะเบียนแล้วเท่านั้น ยังต้องใส่ adapter ในแอปจริงเอง และไม่มี OpenTelemetry SDK หรือการดึงโค้ดภายในอัตโนมัติ; ไม่อ้างว่าใช้งานกับทุกเว็บแอปได้
- Windows ชุดหลักหลังเพิ่ม inspector ผ่าน 50/50 (`2026-09-30T15-22-43-835Z`) ไม่มี failed/skipped; ไม่มีการเปลี่ยนพฤติกรรม src collector/adapter ในรอบนี้
- ปรับ shutdown ของ CLI ให้ส่ง SIGTERM โดยตรงเพื่อเลี่ยง race กับ stdin ของแอป และ forward stdout ของแอปหลัง readiness; Windows focused ล่าสุด 3/3 (`2026-09-30T17-53-55-845Z`), Linux focused ล่าสุด 3/3 (`2026-09-30T17-55-39-917Z`) ไม่มี failed/skipped/lock ค้าง ตรวจ checksums ของหลักฐาน VM หลังนำเข้าผ่าน

## รอบ 25 — ตรวจความพร้อมของเส้นทางเรียกใช้จริง

- เกณฑ์: เรียก `inspect` ครั้งเดียวแล้วใช้ browser คลิกครบ 3 action, เปิดกราฟและ source ของ action จริง, ปิดแล้วสองบริการและ writer lock หาย, เปิดใหม่แล้วประวัติ/กราฟเดิมยังอยู่
- เพิ่ม optional `scripts/inspector-browser-check.mjs` เพื่อทดสอบเส้นทางนี้แบบ end-to-end บน Linux VM; ใช้ target/config/storage แยกใน `reports/` โดยไม่เปลี่ยน app logic
- ผล Linux Chromium 1/1 ผ่าน (`2026-09-30T18-21-44-562Z`), failed/skipped 0; source popup ตรง handler, restored 3 actions, pageerror 0, ไม่มี process หรือ lock ค้าง; ตรวจภาพและ raw reports หลังนำเข้าพร้อม checksum แล้ว
- ไม่พบ app bug จากรอบนี้ จึงไม่แก้ผลิตภัณฑ์เพื่อให้การทดสอบผ่าน; Windows regression ล่าสุด 50/50 ก่อนรอบนี้ และไม่มี app logic เปลี่ยนหลังรอบนั้น
- สรุปความพร้อม: **ต้นแบบใช้งานได้สำหรับแอป Node ตัวอย่างที่ลงทะเบียนและติด adapter แล้ว แต่ยังไม่สมบูรณ์เป็นเครื่องมือทั่วไปหรือระบบใช้งานจริง** ต้องทดลองกับแอปงานจริงของผู้ใช้, วัดประโยชน์/ความถูกต้องกับผู้ใช้, ทำ trace capture มาตรฐาน และกำหนด schema/การดูแลข้อมูลสำหรับใช้งานจริง
- ขอบเขตหลักฐาน: Browser test ใช้ Chromium headless บน VM; ไม่ใช่ Linux desktop GUI, browser อื่น, มือถือจริง, production load หรือการยืนยันว่าจะ instrument แอปที่ไม่แก้โค้ดได้
- ขั้นตอนตรวจหลักฐาน: PowerShell `-LiteralPath` ไม่ขยาย wildcard จึงเปลี่ยนเฉพาะคำสั่งแสดงรายการเป็น `-Path` และยืนยันภาพทั้งสองอยู่ครบ; ไม่มีความเสี่ยงต่อข้อมูลทดสอบ
- ขั้นตอนบันทึก Git: environment ไม่มี commit identity ทำให้คำสั่ง commit แรก fail; staged files ไม่เสียหาย ใช้ identity `Codex <codex@localhost>` จาก commit ก่อนหน้ากับคำสั่ง commit เดียว ไม่แตะ config ถาวร

## รอบ 26 — เว็บแอปอีกตัวในโครงการ

- เกณฑ์: เว็บ `examples/independent-app` ที่รันคนละโปรเซสส่ง 3 actions ไป FlowAtlas ผ่านการคลิกใน browser จริง; กราฟ/source ตรง action; ปิดแล้วพอร์ตและ lock หาย
- HTTP integration baseline ผ่าน 2/2 (`2026-09-30T18-41-03-640Z`) บน Windows
- Browser run แรกไม่ผ่าน 0/1 (`2026-09-30T18-42-03-055Z`): test รอ `page` event หลังคลิก graph link แต่เว็บนี้ใช้ลิงก์ในแท็บเดิม; timeout 30 วินาที เกิดจากสมมติฐานใน test ไม่ใช่หลักฐานว่า product graph ล้มเหลว
- ปรับ test ให้ตรวจ navigation ในแท็บเดิม แล้วรันซ้ำ; เก็บ failed report เพื่อเทียบผล
- Retry หลังแก้แท็บเดิมชน timeout 60 วินาทีและ runner ไม่ปิดเอง จึงยุติด้วย Ctrl+C ก่อนสร้าง raw JSON/TAP; ยังแยกไม่ออกว่าค้างที่ browser operation หรือ cleanup เพิ่ม step markers/timeout ย่อยและปิด browser ก่อน collector ใน cleanup
- การตรวจ Win32_Process ด้วย CIM ถูก sandbox ปฏิเสธ access denied; หลีกเลี่ยงการสรุปจากการตรวจ process ที่ไม่สำเร็จ ใช้ port/lock checks ใน test ที่ผ่านแทน
- ตรวจ evidence ของ retry ที่ timeout พบ `result.json` มีทั้ง 3 actions และ pageerror 0 ก่อนค้าง จึงระบุจุดค้างอยู่ใน cleanup; ปิด browser ก่อน collector และใส่ timeout ย่อย/step markers แล้วผ่าน 1/1 (`2026-09-30T18-46-26-787Z`)
- ตัด timer ใน `stopApp` หลัง child ออกแล้ว รันรอบสุดท้ายผ่าน 1/1 (`2026-09-30T18-48-22-675Z`); HTTP baseline 2/2, graph/source ตรงทั้งสาม, พอร์ตปิด, lock ของรอบสำเร็จไม่มี, ภาพอ่านได้
- รอบ timeout เหลือ stale lock แม้ PID เจ้าของหยุดแล้ว; ตรวจเจ้าของและลบเฉพาะ lock ของรอบ QA ที่ถูกยุติ ตรวจพื้นที่ของ browser test ทั้งสี่รอบไม่มี lock ค้าง
- ข้อจำกัด: เว็บนี้เป็น fixture ที่สร้างเพื่อเชื่อม FlowAtlas อยู่แล้วและอยู่ใน repository เดียวกับ collector แม้รันคนละโปรเซส ผลนี้เพิ่มหลักฐาน browser บน Windows/Edge แต่ยังไม่พิสูจน์ว่าใช้กับเว็บภายนอกทั่วไปหรือเว็บงานจริงได้โดยไม่ติด adapter

## รอบ 27 — ลดขั้นตอนลงทะเบียนแอป Node.js

- ผู้ใช้ต้องการพัฒนาต่อจากข้อจำกัดด้านการติดตั้ง; ยังไม่มีแอปงานจริงให้ลอง จึงเลือกแก้เฉพาะขั้นตอนคัดลอก adapter และ local source registration ก่อน
- เกณฑ์: คำสั่งเดียวลงทะเบียนแอปที่อยู่ในโครงการ, คัดลอก adapter ที่ขาด, แล้ว `inspect` เปิดแอปและ capture action ได้; เมื่อ adapter ชน/ID ซ้ำ/ไฟล์หาย ต้องไม่เขียนทับ config หรือไฟล์ของแอป
- เพิ่ม `scripts/register-app.mjs` ใช้ source allowlist แบบ explicit และตรวจ project/config path, content ของ adapter, จำนวนรายการ และการลงทะเบียนที่อ่านได้จริงก่อนเขียน config แบบ temp + rename; rollback adapter ที่เพิ่งคัดลอกเมื่อเกิดข้อผิดพลาด
- Windows focused 3/3 ผ่าน (`2026-09-30T19-25-18-874Z`) รวม full action→graph ผ่าน `inspect` กับแอปจำลองที่เริ่มจาก template ไม่มี adapter; ตรวจ failure/duplicate ไม่เปลี่ยนไฟล์เดิม
- ขอบเขต: registration ไม่เพิ่ม instrumentation เข้าแอปอัตโนมัติ ยังต้องส่ง action ID จาก browser/handler; ไม่มีผลทดลองกับแอปธุรกิจจริงของผู้ใช้
- Final contract review พบว่า CLI ไม่ตรวจเพดาน config 64 KiB แบบเดียวกับ inspector; regression ก่อนแก้ผ่าน 3/4 (`2026-09-30T19-31-18-377Z`) เพราะ CLI ยอมลงทะเบียน config ที่ inspector เปิดไม่ได้ ต้องปฏิเสธก่อนคัดลอกไฟล์/เขียน config
- แก้ให้ตรวจขนาด config เดิมและผลลัพธ์หลังเพิ่มรายการก่อนคัดลอก adapter; regression ตรวจทั้งไฟล์เกินเพดานและไฟล์เดิมใกล้เพดานที่เพิ่มแล้วเกิน ผ่าน 4/4 (`2026-09-30T19-32-00-469Z`), failed/skipped 0; config/target คงเดิมเมื่อปฏิเสธ
- Windows full suite ก่อน size fix ผ่าน 53/53 (`2026-09-30T19-26-53-644Z`); หลัง fix รัน focused 4/4 เพราะเปลี่ยนเฉพาะ registration CLI และ test ของมัน ไม่เปลี่ยน collector/adapter behavior
- Linux VM รุ่นแรก 3/3 (`2026-09-30T19-28-58-659Z`) และรุ่นสุดท้ายหลัง size fix 4/4 (`2026-09-30T19-33-24-713Z`) ผ่าน; ตรวจ source hashes, raw TAP/JSON, archive และไม่พบ writer lock ค้าง รายละเอียดใน `docs/linux-vm.md`
- ยังไม่พิสูจน์การติดตั้งบนแอปธุรกิจจริง และการบันทึก event ยังเป็น explicit instrumentation; CLI ลดงานตั้งค่าเท่านั้น

## ประเด็นที่พบระหว่าง final suite — storage recovery บน Windows

- Full suite หลัง size fix ผ่าน 53/54 (`2026-09-30T19-36-03-609Z`); `test/persistence.test.mjs` คาด 202 หลังคืนไฟล์จากการจำลอง write obstruction แต่ได้ 503 ขณะที่ registration focused และ Linux focused ผ่าน
- ข้อนี้อยู่ใน storage recovery ไม่ได้แตะโดย registration CLI; เก็บ failed TAP/JSON แล้ว ตรวจ focused test ซ้ำเพื่อแยกว่าล้มเหลวสม่ำเสมอหรือเกิดตามจังหวะ filesystem/OneDrive ก่อนแก้ app logic
- Focused persistence ผ่าน 9/9 (`2026-09-30T19-37-07-095Z`), full suite แบบ serial ผ่าน 54/54 (`2026-09-30T19-37-39-594Z`) และ default parallel retry ผ่าน 54/54 (`2026-09-30T19-38-27-532Z`); จึงยังไม่ระบุสาเหตุแน่ชัดหรือแก้ storage แบบคาดเดา เก็บเป็นความเสี่ยง intermittent บน Windows/OneDrive หากเกิดซ้ำให้บันทึก `StorageError.cause` ของคำขอที่ได้ 503 ก่อนเลือกวิธีแก้
- ตัวตรวจลิงก์เอกสารครั้งแรกพลาดเพราะ `Split-Path -Parent` ให้ค่าว่างสำหรับไฟล์ที่ root; รันใหม่โดยใช้ `.` และหยุดเมื่อเกิด error ตรวจ local links 24 จุดผ่าน ไม่มี source/doc target หาย

## รอบ 28 — แผนพัฒนาไปถึงการใช้งานจริง

- ปัญหา: ต้องมีแผนจากต้นแบบไปถึงเครื่องมือที่ผู้อื่นติดตั้งและใช้งานได้ โดยไม่ใช้ผล fixture tests แทนหลักฐานจากแอปจริง
- ปรับ `PLAN.md` ให้กำหนดผลิตภัณฑ์ v1 แบบ CLI + viewer ในเครื่องสำหรับ Node.js development/test, ระยะ R0–R5, backlog 14 งานพร้อมข้อพึ่งพา และเกณฑ์ความถูกต้อง/ข้อมูล/ประสิทธิภาพ/ผู้ใช้/release
- ให้ storage recovery intermittent เป็นงานแรกที่ต้องวินิจฉัย; แยกคำสั่งและความสามารถที่เสนอจากของที่มีแล้ว; ใช้ reference app เดิน R0–R3 ได้ แต่ต้องผ่าน independent pilot และ user trial ก่อนรับรอง v1
- ตรวจด้วยมือ: diff whitespace ผ่าน, ลิงก์ในแผน 8 จุดมีอยู่, 14 ID ไม่ซ้ำ, เทียบจำนวน/ขอบเขตผลทดสอบกับรายงานเดิม; แก้เงื่อนไข R1 และ Alpha/Beta ให้สอดคล้องกับการยังไม่มีแอปจริง
- ความเสี่ยงที่เหลือ: ระยะเวลา 24–40 วันทำงานและตัวเลข acceptance เป็นประมาณการ/เป้าหมาย ยังไม่ได้ทดลอง; framework/runtime, ingestion, storage และ license ต้องตัดสินใจตามระยะ; ไม่มีโค้ดใหม่หรือหลักฐานว่าผ่าน release gates ในรอบนี้

## รอบ 29 — diagnostics สำหรับ storage recovery

- เกณฑ์: write failure ทั้ง ingestion/action-start ต้องมี operation/stage/cause code ใน diagnostics ของเครื่อง โดยไม่เพิ่ม path/message/body/credentials ใน HTTP response; rejected state ไม่ commit และ recovery เขียนต่อได้
- Regression ก่อนเพิ่ม diagnostics ไม่ผ่าน 8/9 (`2026-09-30T20-00-40-681Z`): ทั้งสองคำขอได้ 503 แต่ไม่มี local diagnostic ให้แยกสาเหตุ (0 แทน 2); นี่เป็นหลักฐานของช่องว่างด้านวินิจฉัย ไม่ใช่ repro ของ intermittent หลังคืนไฟล์เดิม
- คำสั่งค้นหาไฟล์ครั้งแรกอ่าน `src/storage.mjs` ที่ไม่มีอยู่; ใช้ผล `rg` อ่าน implementation จริง `src/action-store.mjs` ต่อ ไม่มีการเปลี่ยนโค้ดจากการอ่านที่ผิด
- เพิ่ม metadata operation/stage ใน StorageError และสร้าง diagnostic ด้วย allowlist ของ filesystem codes; collector ส่งเฉพาะ diagnostic นี้ไป stderr หรือ synchronous callback ที่ผู้เรียกกำหนด ไม่เปลี่ยน HTTP response หรือ retry write
- Focused Windows ผ่าน 11/11 (`2026-09-30T20-04-37-398Z`), failed/skipped 0: obstruction แสดง `save/rename/EPERM` ทั้งสอง route, rejected graph/ไฟล์เดิมไม่เปลี่ยน, temp cleanup/recovery ผ่าน; canary path/message/stack/unknown code ไม่ออก diagnostic และ callback ที่ throw ไม่เปลี่ยนผลคำขอ
- ผลนี้ยังไม่ใช่ repro ของ intermittent หลังคืนไฟล์; ต้องตรวจ default parallel integration และเก็บ cause หากเกิดอีกครั้ง ก่อนปิดประเด็นเดิม
- Default Windows parallel regression ผ่าน 56/56 (`2026-09-30T20-06-43-000Z`), failed/skipped 0; ไม่พบ recovery 503 หลังคืนไฟล์ในรอบนี้ จึงส่งมอบ diagnostics แต่ยังเปิด investigation ของอาการเดิมไว้ ไม่เพิ่ม retries เพื่อกลบปัญหา
- ขั้นตอน Linux QA: Python ทั้งระบบ/bundled ไม่มี paramiko, ใช้ OpenSSH ที่มีและ host key เดิม; sandbox ปฏิเสธ network ก่อนต่อพอร์ต จึงใช้ escalation ที่อนุญาตแล้ว ต่อ VM สำเร็จ ระบบเป็น Linux และไม่มี Node ใน PATH ปกติ (ใช้ portable runtime เดิมใน QA)
- Linux จาก clean bundle commit `5908428`: main 56/56, isolated source 1/1, Chromium inspector/restart 1/1; source digest ตรง Windows main/source/Edge browser ทุกชุด ตรวจ archive checksum และภาพแล้ว ไม่มี writer lock ค้าง รายละเอียดใน TEST-RUNS; นี่เป็นหลักฐานบนเครื่อง/VM จริงของ fixtures ยังไม่ใช่ real-app/user trial

## รอบ 30 — CI compatibility และการพัฒนาต่อเนื่อง

- เกณฑ์: hosted Windows/Linux รัน main, isolated source และ browser journey ตามลำดับบน source เดียวกัน เก็บรายงานแม้ failure, pin QA dependencies และ action SHA; ยังไม่ประกาศรองรับ Node รุ่นใหม่จนมีผลจริง
- เพิ่ม workflow `quality.yml` matrix Node 22.23.3/24.21.0 บน windows-2025/ubuntu-24.04 จากรุ่น LTS ใน official Node index; Playwright 1.63.0 แยก tools/qa พร้อม lockfile ไม่เพิ่ม runtime dependency ของ app; permissions contents:read, checkout ไม่เก็บ credentials
- npm package-lock-only และ npm ci ของ QA tools ผ่าน; Node bundled ไม่มี module yaml ในพาธที่ลอง จึงไม่อ้างว่าคำสั่งนั้นตรวจ YAML สำเร็จ
- ผู้ใช้ให้พัฒนาต่อจนใช้งานจริงและ push GitHub; การตั้ง heartbeat รายชั่วโมงถูก automatic approval review ปฏิเสธ เพราะยังไม่มี authorization ตารางเวลาโดยตรงและมี repeated repository side effects ส่งคำถามอนุญาตตารางเวลาแล้ว ยังไม่มี automation ถูกสร้าง ไม่ใช้วิธีอื่นเลี่ยงการปฏิเสธ งานที่อนุญาตในรอบปัจจุบันทำต่อได้

## รอบ 31 — CLI และ preflight ก่อนใช้งาน

- เกณฑ์: เรียกผ่าน `flowatlas` ได้จาก working directory อื่น; doctor ตรวจ registration/entry/adapters/storage/ports โดยไม่เปิดแอปหรือแก้ไฟล์เจ้าของ; packaged installation เรียก demo→doctor→inspect→action→graph→stop/restart ได้
- เพิ่ม CLI dispatcher และ doctor พร้อม human/JSON output; ใช้ source registration validator เดิม, ตรวจ syntax ของ entry และ adapter version, ตรวจ lock/สิทธิ์ parent ของ storage และพอร์ต loopback ไม่ลบ lock หรือ kill เจ้าของพอร์ต
- Focused Windows 11/11 (`2026-09-30T20-28-29-329Z`) ผ่าน รวม doctor 4 cases และ inspector/registration integrations เดิม; ยืนยัน failure syntax/mismatch/lock/occupied port/path escape ไม่แก้ไฟล์เจ้าของ
- การแพ็กครั้งแรกถูก EPERM ที่ npm cache นอก workspace จึงไม่ถือว่า package สร้างสำเร็จ เปลี่ยนเฉพาะ cache ไป reports/releases ในโครงการ ไม่แก้โค้ดเพื่อกลบ permission ของ tooling
- Clean package install ผ่านเมื่อใช้ local cache; ระหว่าง code review พบ collector `getCodeVersion()` อาจรับ commit ของ Git repository แม่เมื่อติดตั้ง package ใต้ repository อื่น Regression ก่อนแก้ไม่ผ่าน 0/1 (`2026-09-30T20-32-34-313Z`) โดยได้ parent commit แทน null จึงแก้ให้เช็ค Git root ตรง tool root แบบเดียวกับ target snapshot; file digest ยังมีเสมอ
- หลังแก้ inherited Git identity focused suite ผ่าน 12/12 (`2026-09-30T20-33-11-024Z`); offline package gate ผ่าน 1/1 (`2026-09-30T20-35-13-248Z`) จาก artifact ติดตั้งใหม่: 3 business actions, graph/source, stop ปิดพอร์ตและ lock, restart โหลดกราฟเดิมตรงกัน และ tool/target ไม่รับ parent commit
- Package สำหรับ QA ยังผูก apps/config/data กับ package root และ update อาจแทนที่ directory นี้; ต้องเพิ่ม workspace แยกจาก installation พร้อม backup/update/uninstall checks ก่อนรับรอง R1 หรือเผยแพร่ทั่วไป ไม่ถือว่าผ่านทั้งระยะจาก smoke test นี้
- Windows full regression หลัง CLI/identity ผ่าน 60/60 (`2026-09-30T20-36-52-292Z`) และ isolated source 1/1 (`2026-09-30T20-37-06-171Z`), failed/skipped 0; เพิ่ม offline package gate ใน CI สำหรับตรวจ Windows/Linux บน runtime matrix ด้วย ยังรอ hosted evidence ของ source ใหม่นี้

## รอบ 32 — bounded inspector browser cleanup

- Hosted Ubuntu/Node 22.23.3 main/source ผ่าน แต่ inspector browser step ค้างหลัง test timeout ขณะที่อีกสาม matrix jobs ผ่าน เก็บ metadata ไว้ ยังไม่มี completed job log ระบุตำแหน่งย่อย
- Code inspection พบ stop() รอ child exit แต่ timer ส่ง SIGTERM ซ้ำ ซึ่งไม่รับประกันว่า child ที่ค้าง cleanup จะออก และ test ปิด server ขณะ browser context/HTTP connections ยังเปิด ลำดับนี้คล้าย cleanup issue ที่พบในรอบ 26 แต่ยังไม่ยืนยันว่าเป็นสาเหตุของ hosted job นี้
- ปรับเฉพาะ QA script: stage markers, timeout ย่อยของ browser operations, ปิด context ก่อน stop/restart และ fallback SIGKILL หลัง 8 วินาที; forced kill ยังทำให้ assertion exit code fail จึงไม่เปลี่ยน hang/failure เป็น pass ผลต้องตรวจบน Node 22/Linux ก่อนปิดประเด็น
- Completed hosted log ยืนยัน test timeout 60 วินาทีแล้วค้างถึง job timeout 20 นาที; artifact มี 3 actions/restored=true/browserErrors=[] และภาพหลัง restart (ก่อน final stop) จึงระบุการค้างหลัง result ถูกเขียน ใน final shutdown/cleanup ได้ เป็นปัญหา lifecycle ของ QA ที่ต้องแก้ ไม่ใช่หลักฐานว่า action/graph ไม่สำเร็จ
- QA รุ่นใหม่ผ่าน Linux VM Node 22.23.3/Chromium 1/1 ภายใน 3.5 วินาที และ CLI affected suite 12/12; ตรวจ archive SHA-256, runner source hashes ตรง host และภาพแล้ว ไม่มี lock ค้าง ยังต้องรอ hosted matrix ใหม่ก่อนถือว่าปิด gate นี้
- Hosted run `36775394097` บน commit `1b4213f` completed success ครบ 4 jobs: Ubuntu/Windows กับ Node 22.23.3/24.21.0 รวม main/source/browser/offline package gate; จึงผ่าน gate ที่เคยค้างสำหรับ revision นี้ การเปลี่ยนแปลงใหม่ต้องผ่าน matrix ใหม่ตามเดิม

## รอบ 33 — workspace แยกจาก installation

- ปัญหา: package install directory อาจถูกแทนที่ตอน update/uninstall จึงไม่ควรใช้เก็บแอป/config/history ถาวร เกณฑ์คือแยก workspace ที่ผู้ใช้เลือก และถอน/ติดตั้ง package ซ้ำแล้วแอปและกราฟเดิมอยู่ครบ
- เพิ่ม `flowatlas --workspace DIR` และ FLOWATLAS_WORKSPACE_ROOT; common resolver ใช้ใน CLI/demo/register/doctor/inspect/collector โดย tool templates/static/source snapshot ยังอ่านจาก installation และแอป/config/data อ่านจาก workspace การเรียกเดิมยังใช้ tool folder โดยปริยาย
- ตรวจ data directory กับ root ที่เลือกทั้ง lexical/physical และปฏิเสธ symlink/junction; ไม่สร้างไฟล์นอกรากที่อนุญาต ข้อจำกัด single writer/100 actions/schema เดิมยังใช้
- Focused 26/26 (`2026-09-30T20-56-17-590Z`) ผ่าน; offline package journey 1/1 (`2026-09-30T20-59-56-745Z`) และหลัง uninstall/reinstall 1/1 (`2026-09-30T21-00-02-679Z`) ผ่าน: state SHA-256 ไม่เปลี่ยนระหว่างถอน/ติดตั้ง, กราฟเก่า 3 และใหม่ 3 เปิดหลัง restart ได้ตรงเดิม, lock/ports ปิด, package root ไม่มี app/config/data
- Windows full 64/64 (`2026-09-30T21-00-46-129Z`) และ isolated source 1/1 (`2026-09-30T21-00-59-100Z`) ผ่าน failed/skipped 0; เพิ่ม workspace/reinstall gate ใน CI แต่ยังต้องตรวจ hosted revision ใหม่
- ยังไม่ยืนยัน upgrade ข้าม schema/adapter release หรือ integration/startup กับแอปธุรกิจทั่วไป; R1/R2–R5 ยังมีงานใน PLAN ไม่สรุปว่าโปรเจคบรรลุ v1 จาก installer tests

## รอบ 35 — ทบทวนผล CI และตรวจรอบถัดไป

- CI ของ workspace separation commit 6fcee44 ผ่านครบ 4 matrix jobs; เป็น hosted runtime verification ของ fixture/package journeys ไม่ใช่ pilot ของแอปธุรกิจหรือผู้ใช้
- คำสั่ง staged whitespace check เตือน blank EOF แต่ shell sequence ยัง commit เพราะไม่ได้ตรวจ external exit code; แก้ trailing whitespace และบังคับตรวจ LASTEXITCODE ก่อน commit ต่อไป
- การอ่านพาธ adapter ผิดแก้ด้วย inventory จาก rg; ไม่มี source mutation จาก tool failure

## รอบ 36 — รายงาน target crash หลัง readiness

- เกณฑ์: CLI ต้องจบ nonzero เมื่อ target ล้มหลัง readiness พร้อมปิด collector และคืน writer lock; stop ที่ผู้ใช้สั่งยังจบสำเร็จ
- Regression ก่อนแก้ผ่าน 3/4 (`2026-09-30T21-14-11-853Z`): target exit 9 แต่ CLI คืน 0 เพราะ exit branch เรียก cleanup โดยไม่รายงานความล้มเหลว
- แยก unexpected target exit ออกจาก exit ที่เกิดระหว่าง stop; ให้ error ผ่าน cleanup และ CLI failure path เดิม ไม่ restart แอปหรือ retry business requests
- หลังแก้ Windows focused ผ่าน 12/12 (2026-09-30T21-14-38-013Z), failed/skipped 0; รวม CLI crash exit 9→1, startup error, explicit stop, registration action และ workspace persistence ไม่ทดสอบ auto-restart ซึ่งยังไม่มี

## รอบ 37 — session access ก่อน real-app pilot

- Regression ก่อนแก้ 0/3 (2026-09-30T21-17-05-538Z): bearer/Origin/Host ไม่มี enforcement อ่าน history และส่ง requests ได้โดยไม่มีสิทธิ์
- เพิ่ม allowlisted loopback Host/port, exact same-origin checks และ timing-safe bearer check ก่อน parse/write; CLI/server สร้าง credential ใหม่ใน memory ส่งให้ target ผ่าน environment; redirected output ซ่อนรหัส ไม่มี cookie/URL token
- Viewer pairing เก็บ credential ใน memory เท่านั้น; source/JSON เปิดผ่าน authorized fetch แล้วแสดงเป็น text ใน popup; reload/new tab ต้อง pair ใหม่ adapter ส่งรหัสเฉพาะ collector ไม่เพิ่มใน outbound business headers
- Server focused 3/3 (2026-09-30T21-18-15-656Z) ผ่าน; ยังรอ browser/package/end-to-end และ privacy canary checks ไม่อ้างว่า FA-06 ครบทั้งหมด
- Windows secure CLI/adapter focused ผ่าน 15/15 (2026-09-30T21-21-30-891Z); browser attempt 2026-09-30T21-22-25-632Z ไม่ผ่าน 0/1 ก่อนเริ่มแอป เพราะ local Playwright Chromium binary ไม่มี เพิ่มช่องเลือก installed browser channel สำหรับ QA; CI ยังใช้ pinned Chromium ตามเดิม ไม่กลบ failure เป็น skip
- Patch เอกสารครั้งแรกใช้ exact line ที่ไม่มี backticks หลัง PowerShell string interpolation จึงถูกปฏิเสธ; ตรวจไฟล์จริงแล้วแก้เฉพาะ QA browser option ไม่มีการแก้ source จาก patch ที่ไม่ผ่าน
- Package attempt ไม่ได้เริ่ม: npm shim ใน PATH ชี้ runtime ที่หาย ไม่ใช่แอป regression; ต้องใช้ npm ของ Node installation จริงและเก็บผลใหม่ ไม่แก้ global npm configuration
- Edge secure inspector 1/1 (2026-09-30T21-23-17-401Z) และ combined browser journeys 2/2 (2026-09-30T21-24-37-309Z) ผ่าน; pairing/reject wrong code/source/graph/logout/reload/restart และ independent fixture เดิม; รหัสไม่อยู่ใน URL/cookies/localStorage/sessionStorage ช่อง password ว่างก่อน screenshot; inspected restart image graph/history อ่านได้ ไม่มี secret
- Main regression 69/69 (2026-09-30T21-25-11-226Z) ผ่านก่อนเพิ่ม fixture bearer integration และ frame header; focused integration หลังเปลี่ยน fixture 12/12 (2026-09-30T21-27-52-886Z) รวม standalone CLI default auth, explicit bearer fixture และ outage business behavior ผ่าน ไม่อ้างว่าชุด 69 ใช้ source digest สุดท้าย
- Offline package 1/1 (2026-09-30T21-31-28-841Z) ผ่าน: capture 3 actions/source/restart, token ไม่เข้า state และ credential เก่าอ่าน session ใหม่ไม่ได้; isolated source 1/1 (2026-09-30T21-32-07-228Z) ผ่าน ยังรอ hosted CI สำหรับ commit ใหม่
- Review หุ้ม Playwright operations ที่รับ credential เพื่อไม่ให้ error call-log แสดงรหัส; รหัสอยู่ใน process memory/environment และถือว่า target app เชื่อถือได้ ไม่ป้องกัน same-user malware หรือพิสูจน์การคลิกของมนุษย์ ไม่มี per-project roles/export policy/OTel privacy จึงยังไม่ปิด FA-06 ทั้งหมด
- พบ hypothesis ใน code inspection: URL parsing ของ HTTP handler อยู่ก่อน try/catch อาจทำให้ malformed request target ล้ม process; ยังไม่มี repro เก็บเป็นงาน input-boundary รอบถัดไปก่อน real-app pilot

## รอบ 38 — malformed HTTP request target

- เกณฑ์: request target ที่ URL parser อ่านไม่ได้ต้องได้ 400 โดยไม่ล้ม collector; authorized request หลังจากนั้นยังทำงานได้
- Regression ก่อนแก้ไม่ผ่าน 0/1 (`2026-09-30T21-34-28-782Z`): raw HTTP path `http://[` ได้ socket error (status sentinel 0) แทน 400; code inspection พบ URL parse ก่อน try/catch ใน async callback จึงไม่มี error response path
- เพิ่ม bounded URL parse failure response ไม่มี input/token/stack ใน response ไม่เปลี่ยนการ parse route ที่ถูกต้องหรือ retry requests
- Collector focused 9/9 (`2026-09-30T21-35-13-081Z`) ผ่าน แต่ neighboring workflow inspection พบ inventory listener ใน process เดียวกันมี parser ก่อน error handling เช่นกัน; expanded regression 0/1 (`2026-09-30T21-36-03-320Z`) ผ่าน collector path แล้วล้มที่ inventory path จึงแก้ทั้งสอง listener ของ principal issue นี้
- หลังแก้ทั้งสอง listener focused Windows ผ่าน 14/14 (2026-09-30T21-36-41-853Z), failed/skipped 0; malformed targets ได้ 400, inventory stock ยังคง 2, collector ยังรับ authorized status และ action/session flows ผ่าน ไม่รัน source snapshot gate ซ้ำเพราะไม่ได้เปลี่ยน source serving
## รอบ 39 — CI artifact capture deadline

- CI f8b125d run 36778221475 ล้มเฉพาะ Windows Node 22 job 110101417922; log เก็บ reports/vm/ci-job-110101417922.log: main/source/inspector ผ่าน, independent app actions/graph/source ทั้ง 3 ผ่าน แล้ว page.screenshot timeout 8000 ms หลัง fonts loaded
- ข้อผิดพลาดเกิดใน artifact capture ไม่ใช่หลักฐานว่า business graph ผิด; 8 วินาทีเป็น default interactive deadline แต่ full-page capture บน hosted Windows เป็นงานคนละแบบ สาเหตุภายใน browser/runner ยังไม่ยืนยัน
- จะกำหนด screenshot deadline 20 วินาทีแยกจาก interactive actions 8 วินาที, ไม่ retry และยัง fail หากเกินเพดาน; ต้องตรวจผล hosted อีกครั้งก่อนปิด QA risk
- พบ secondary failure: package check รันแม้ pack/install ถูก skipped เพราะ if !cancelled ไม่ตรวจ prerequisite; จดเป็น repair ถัดไป ไม่ถือ ENOENT missing-installed-package ว่า package regression
- Local Edge journeys ผ่าน 2/2 (2026-09-30T21-39-22-368Z) พร้อม deadlines ที่แยก; ผลนี้ไม่ใช่ repro/หลักฐานการแก้ screenshot timeout บน hosted Windows ยังต้องรอ CI
## รอบ 40 — CI prerequisites ของ package gates

- จาก failed log รอบ 39 package journey ถูกเรียกเมื่อ pack/install skipped จึงเพิ่ม ENOENT ที่ไม่ใช่ package regression
- ให้ pack/install รันได้หลัง failure ของ gate อิสระเมื่อยังไม่ canceled เพื่อเก็บหลักฐานเพิ่ม; journey ขึ้นกับ install success, reinstall ขึ้นกับ journey success, replay ขึ้นกับ reinstall success โดยใช้ step outcome จริง ไม่ continue-on-error
- ตรวจ workflow diff ด้วยมือ: step IDs มีหนึ่งแห่งและ dependencies เรียงตาม execution, upload artifacts ยัง always; ไม่มี runtime app change ไม่สร้าง unit test ที่ mirror YAML ต้องใช้ hosted workflow ตรวจจริงก่อนรับรอง
## รอบ 41 — existing workspace adapter update และ rollback

- Doctor ของ message-app ที่มีอยู่จริงแจ้ง adapter mismatch; fresh fixture/package tests ไม่ครอบคลุม workspace รุ่นเดิม Regression ก่อนสร้างคำสั่ง 0/3 (2026-09-30T21-53-14-419Z): CLI ไม่รู้จัก adapters command
- เพิ่ม update/rollback ที่ยอมรับเฉพาะ bytes hash ของ adapter revision ที่รู้จัก; history SHA256 สร้างจาก Git fc273a9/678a247 และเก็บใน package ไม่มี network download ขณะ update; old fixture เก็บเป็น .txt เพื่อไม่ให้ Node test discovery เรียกเป็น test/module
- สำรองสองไฟล์และ manifest ก่อนเปลี่ยน, checked lock, symlink/path/owner edits, idempotent current version, failure recovery จาก bytes before/after ไม่เขียนทับ concurrent owner edits; config/app code/action data ไม่เปลี่ยน Backup metadata ignored จาก Git/package
- Initial focused 3/3 (2026-09-30T21-55-37-997Z), affected doctor/register/workspace 16/16 (2026-09-30T21-57-26-492Z), final update integration 5/5 (2026-09-30T21-59-05-727Z) ผ่าน failed/skipped 0; includes simulation ของ failure หลัง replacement แล้วคืน originals/temp cleanup และ backup ใช้ rollback ได้
- Integration seed graph รุ่นเดิมเป็น storage simulation; หลัง update เปิด inspect และ business HTTP จริง capture success พร้อม session ใหม่ และ graph เดิม byte-equivalent; old adapter source ตอบ 409 ไม่แสดงรุ่นใหม่แทน source รุ่นเก่า
- ใช้คำสั่งกับ existing local message-app ที่ hash ตรง historical adapter; backup reports/adapter-backups/27ae7112-a3e3-43c0-a54d-f7aff3f3e954, doctor ทุกข้อผ่าน และ owner server/browser/config/state hashes ไม่เปลี่ยน ผล manual ใน TEST-RUNS
- ขอบเขต: เป็นการอัปเดตข้าม code revision ที่มีอยู่ ไม่ใช่ released-version schema migration; ไม่ทดสอบ power loss/process kill ระหว่าง replace, ต้องหยุด inspector/target และระบุ data-dir ให้ตรง การ rollback adapter เก่าไม่ทำให้มันรองรับ session bearer ของ collector ใหม่
- Final Windows main ผ่าน 76/76 (2026-09-30T22-01-49-568Z), failed/skipped 0 หลังเพิ่ม adapter lifecycle;ไม่มี snapshot tests ทำงานพร้อม source mutations
- Line-ending regression 5/6 (2026-09-30T22-07-58-961Z): known historical adapter ที่แปลง LF→CRLF ถูกปฏิเสธว่า owner edit เพิ่ม exact SHA256 ของ CRLF variant จาก Git source เดิม ไม่ normalize owner bytes; rollback ต้องคืน original bytes พร้อม CRLF
- CRLF repair verification: adapter/doctor focused 10/10 (2026-09-30T22-08-59-249Z); final packaged CLI journey 1/1 (2026-10-01T06-48-11-666Z), failed/skipped 0. Known Windows adapter bytes update safely and rollback restores original line endings. No owner-byte normalization introduced.
- Hosted a9b1a8d run 36780927859 independently confirmed success in all four jobs. Its main 71/source/browser/package/reinstall gates precede this adapter feature; latest feature needs its own hosted result.
## รอบ 42 — reusable browser action scope

- Intended result: reduce repeated browser correlation code, with separate scopes per action and explicit same-origin boundaries. Added dependency-free ES module; no global fetch patch, collector credential or persistent browser storage. Metadata start is bounded by deadline/16 KiB and failure leaves business request available; business Response/body/header behavior belongs to the app.
- One business request per scope matches current explicit target lifecycle. Following redirects is disabled because custom correlation headers can otherwise cross origins; rejected cross-origin/credentials/fragments/no-cors fail before business dispatch. This opt-in constraint is documented; redirect-dependent flows must use untraced fetch or a direct API. No claim of transparent instrumentation.
- Focused HTTP 4/4 (2026-10-01T06-53-36-099Z) and affected generator/register/doctor/adapter/inspect/external-repository 23/23 (2026-10-01T06-54-35-555Z) passed. Real Edge headless journey 1/1 (2026-10-01T06-55-35-708Z) includes 3 UI actions, 2 browser-evaluated concurrent scopes, exact graph correlation IDs, source and restart with 5 preserved rows. Isolated source 1/1 (2026-10-01T06-56-24-216Z) passed; failed/skipped 0.
- Current local message-app owner code is still its earlier template; fresh demo generator includes module/snapshot/static route. No edits to owner browser code were bundled into adapter update. Real business app, multiple business requests per action/fan-out, OTel, other engines and human trials remain outstanding.
- Documentation patch failed because README heading anchor was wrong; inspected files (no partial mutation), used actual heading and reapplied. Record is in TEST-RUNS; no application change arose from this tooling failure.
- Final offline browser module package gate passed 1/1 (2026-10-01T07-00-07-562Z), with module in package inventory/generated snapshot. Luna read-only docs/link review found no mismatch; lead reviewed code/diffs/evidence before acceptance.
- Adapter feature 3f054c5 hosted run 36826886673 completed success in all four jobs, including full main 77 tests, source/browser and package/reinstall. Browser feature added afterward still requires its own hosted result.
## รอบ 43 — opt-in OpenTelemetry HTTP tracing (implementation in progress)

- Followed official SDK/ESM/HTTP references, checked exact registry versions and installed pinned SDK/HTTP/Undici/core dependencies without lifecycle scripts in project cache. No auto exporter/metrics/logs/resource detectors; W3C trace context only, loopback outgoing instrumentation, collector requests suppressed. Requires explicit inspect --trace http; existing-SDK attach and business function/source tracing not claimed.
- New schema 0.2 HTTP graph accepts normalized IDs/method/time/status/error only. Unknown parent gaps resolve when parent arrives; exact duplicates idempotent, conflicting duplicates/cycles/capacity/snapshot errors reject atomically. Client report unverified and coverage remains partial. Legacy 0.1 reader retained without rewriting history.
- Regression 2026-10-01T07-13-09-367Z passed 10/11: schema downgrade allowed root-only HTTP trace nodes. Added schema/node/normalized span validation. Shared contract extraction initially omitted ID helper import: 18/22 (2026-10-01T07-14-00-198Z); legacy persistence/registration checks passed. Repaired import and targeted contract 7/7 passed (2026-10-01T07-14-32-499Z).
- Actual NodeSDK child CJS/ESM fan-out initial 1/2 (2026-10-01T07-18-51-342Z): CJS fixture readiness hit its 5s polling cap before inspector's documented 10s startup deadline. Root cold-start cause not captured. Added sanitized readiness diagnostics; next focused 2/2 (2026-10-01T07-19-51-498Z). Aligned readiness observation to 12s around the existing inspector 10s deadline; span-delivery deadline remains 5s, no business retries.
- Final bounded exporter/contract/real SDK focused 9/9 (2026-10-01T07-21-12-754Z), failed/skipped 0: actual CJS/ESM HTTP plus Undici create separate concurrent traces with two outbound children; canary URL/header/body/baggage/resource values absent from graphs/state/output. Queue overflow/stalled collector/redirect are controlled HTTP failure tests, not production-load evidence.
- Code review found a queue wakeup edge at drain completion; pump restarts remaining work and forceFlush checks all pending work. Validators guard malformed non-array span metadata. These final changes still need focused verification. SDK package layout inspection repeated obsolete paths; corrected using package exports/rg inventory. No functional cause was inferred from failed reads.
- CI now prepares pinned runtime deps into project cache before offline install. New schema compatibility, packaged trace preload, browser rendering and Linux/Windows same-revision gates remain to be verified before acceptance.
- Final affected contracts/real SDK/legacy inspector/session/persistence passed 29/29 (2026-10-01T07-23-16-162Z). Parentless SERVER is required to declare HTTP root outcome; a remote/uncaptured parent keeps outcome running and finishedAt null. Focused 7/7 (2026-10-01T07-27-26-363Z) passed.
- Added trace-mode doctor without copied adapters and exact schema 0.2 storage reload in runtime tests: 7/7 (2026-10-01T07-31-28-955Z); actual SDK/Edge viewer 2/2 (2026-10-01T07-32-39-463Z). No business functions/client clicks claimed from SDK-only spans.
- Pack initially omitted publishable shrinkwrap due files allowlist; inventory guard stopped before install. Added npm-shrinkwrap.json explicitly; rebuilt offline artifact with all pinned dependencies. Installed explicit journey 1/1 (2026-10-01T07-36-54-807Z) and installed CJS/ESM SDK+schema reload 2/2 (2026-10-01T07-36-57-518Z) passed. No network install scripts or bundled owner data.
- Luna authored only OTel guide; lead checked code/commands/links and added trace doctor, ordinary-app --app-url readiness and explicit/preload mixing limits. Repeated documentation patch anchors were rejected atomically; removed unrelated/partial hunks and applied only inspected exact context. No app failure caused by those tool errors.

## รอบ 44 — HTTP trace parent display order

- Actual SDK/Edge screenshot showed a child span preceding its SERVER parent when rounded start timestamps tied and random child ID sorted first. Graph ancestry metadata was correct, but visual order could mislead.
- Display order now visits captured parents before children and inserts missing-parent placeholders before their children. Original timestamp order stays in trace.spans. Labels include span ID suffix to distinguish equal method/status requests.
- Added equal-timestamp/child-ID-before-parent regression; focused 4/4 (2026-10-01T07-34-41-662Z) passed. Final browser image after fix still needs verification; previous screenshot remains evidence of the original display issue. This does not implement a branch-aware timeline/large-graph UX.
- Final source 1/1 (2026-10-01T07-39-41-381Z), actual SDK/Edge + legacy browser scope journey 3/3 (2026-10-01T07-40-26-394Z) passed; corrected screenshot visually checked after fix. Parent ordering and distinct span labels now readable. No source snapshot mutations ran with browser/main tests.
- Final Windows release integration main 91/91 (2026-10-01T07-41-41-463Z), failed/skipped 0 after SDK/schema/UI changes. Installed trace gate moved before uninstall/reinstall so a failed reinstall cannot cause unrelated missing-package SDK errors. This is workflow review; hosted execution still pending.

### Round 45 — remote SDK quality gates (in progress)

VM extraction used Python's newer tar filter argument on an older runtime: compatibility failure before tests, no app failure or test result. Archive checksums and path/type allowlist passed; use the existing explicit validation without that unsupported keyword. Hosted 4a68a3c package step failed after preceding gates; inspect logs before changing implementation. Linux/hosted SDK support remains pending until exact revision evidence passes.

- Hosted failure analysis: Ubuntu job log reports ENOTCACHED for the @opentelemetry/api registry metadata during offline tarball install. Root npm ci caches locked tarballs but does not necessarily fetch package metadata needed by a downstream install; the earlier local cache already contained metadata from development installs. Package shrinkwrap was present and main/SDK tests passed. Next correction explicitly warms the packed package install in a separate disposable prefix before requiring the independent offline install. This is a cache preparation defect, not a reason to remove the offline gate.

- VM exact 4a68a3c Node22.23.3: offline root npm ci succeeded (74 packages); main 91/91 (2026-10-01T07-54-39-018Z), isolated source 1/1 (07-55-00-123Z). Optional paired browser runtime run 07-55-00-488Z failed 0/2 because Chromium executable was absent at configured browser-runtime path; this is browser QA setup failure, not a passed UI result. Subsequent inspector-browser step was not run. Inspect existing VM browser inventory before selecting/installing runtime. Raw reports remain on VM and will be copied back.

- Cold-cache correction manual check: fresh online packed-artifact warm install and separate offline install both succeeded (75 packages each). Follow-up SDK run 2026-10-01T07-55-30-094Z failed before cases because the install prefix was under reports/releases instead of the QA guard's required reports/storage. Guard behaved correctly; no SDK capture ran. Escalated runner also lacked Git safe-directory context (revision metadata unavailable). Re-run installed SDK from an allowed disposable reports/storage prefix with the ordinary sandbox runner; keep cache in reports/releases.

- Cold-cache fix verified: separate online packed-artifact preparation then independent offline install succeeded, followed by guarded installed-package real SDK CJS/ESM run 2026-10-01T07-56-23-160Z 2/2. No application runtime code changed in this correction; CI requires a new hosted run. VM browser inventory contains matching chromium_headless_shell-1243 but lacks full chromium-1243 required by channel=chromium; install full matching Chromium under the fresh QA directory, preserving existing tools/data.

## รอบ 46 — measured HTTP tracing overhead (in progress)

Practical completion check: matched workload manifests and correct1050responses per condition (1000 measured), 3alternating paired rounds, real SDK exporter counters reconciled after bounded shutdown, sanitized raw samples plus p95/throughput/target CPU/RSS evidence. Report measured performance/loss against preselected10% relative or5ms tiny-baseline absolute budget; performance or drop failures stay failures in acceptance, without suppressing the result. History100 limit cannot prove capture totals. Lead implements/validates counters; Luna has bounded benchmark-script/document task, lead reviews/runs.

- Capture accounting regression 2026-10-01T08-02-52-568Z: exporter tests4/4 passed but real Windows SDK cases0/2 failed because no shutdown summary reached inspector output. Windows child.kill(SIGTERM) terminates the process without running the Node signal handler, so the previous stop path did not prove flushing. Add a private IPC flush handshake for trace-mode child before the existing termination step, retaining the5s outer deadline; verify actual CJS/ESM shutdown counters. Tool read also referenced nonexistent test/inspect-cli.test.mjs; inspected existing test inventory instead, no files changed by that failed search.

- Shutdown accounting repair verified 2026-10-01T08-04-49-597Z10/10: bounded/invalid/ignored/acknowledged exporter counts, actualWindows CJS/ESM sixspansdelivered andonesanitizedsummary, pluslegacyinspect success/startupfailure/crash/urlboundary. Trace-only privateIPC asks SDKtoflush before normaltermination; IPCunref avoidskeepingnaturallyfinishedapps alive. The5s inspector kill deadline remains. Collector2xx acknowledges delivery; timeout/unacknowledged drops can be ambiguous if collector already persisted. Benchmark stats use an identical postmeasurement metrics request, expected1051SERVERspans including50warmup+1000measured+1metrics.

- Hosted run36833414845 revision18b9ddd completed success in all4 Windows2025/Ubuntu24.04 ×Node22.23.3/24.21.0 jobs: main91, source, Chromium explicit/independent/SDK viewer, offline package/SDK/reinstall gates. This proves the cache correction at that revision; subsequent IPC/counter changes need their own gates.
- VM4a68a3c full matching Chromium installation succeeded. Paired realSDK CJS/ESM UI2/2 (2026-10-01T08-03-12-214Z) and explicit browser module/restart1/1 (08-03-18-225Z) passed, failed/skipped0. Result archive SHA25646f36e56fd82fc91c03f6a8b984eeef413a8c31c482304dd53de1fd2ce896b7d; retrieval/check/visualinspection pending. These tests predate the newIPC/counter changes.

- Retrieved VM archive checksum/type/path validation and no-overwrite import succeeded using relative tar paths. Imported all5 raw TAP/JSON including failed browser setup into reports/tests and images into reports/browser/vm. All VM run digests equal1149fba920a1bfa9c82c3481acdcadec378243d52b4c3f5c4ad6a91ebcfe5dd4. Compared recorded files byte hashes with Git4a68a3c blobs (not current dirty source); no mismatch. Inspected realSDK HTTP screenshot and explicit5-row restart screenshot: SERVER precedes bothCLIENTspans, parent evidence matches, partialcoverage/unknownclientaction shown, no pairingsecret or canarytext visible. This does not certify large-graph branching UX.

- Final IPC/capture counter CJS/ESM stdio-close check 2026-10-01T08-10-28-953Z2/2 passed; readiness took8s in firstcase within inspector10s policy, no retries added. Actualshutdown summary checked only after allstdio closes to avoid exit/read races. Legacy inspect and controlled stalled/redirect/overflow accounting had passed10/10 in08-04-49-597Z. Final diff reviewed; benchmark script is separate ongoing work and is not included in the IPC repair commit.

- VM1114257 newcheckout/offlineinstall/main92/92 (2026-10-01T08-15-59-510Z), source1/1 (08-16-21-476Z), realSDK+pairedChromium+IPCsummary2/2 (08-16-21-828Z) passed, failed/skipped0. No writerlock found underQAstorage and no matchingCLIprocess found afterstop. Sourcebundle checksum passed. VMresultarchive SHA256ba976062b452dc32b166a158ec471506b3868b02431b1c17f8d97b287e8a4ce1, retrieval pending. This newly verifies actualLinux shutdown counters, not a production/pilot result.

- HostedIPC/counterrun36834857530 commit1114257 completed success in all4Windows/Ubuntu ×Node22/24jobs, main92 plus source/browser/installedSDK/reinstall gates. Capturecounter/shutdown support at this exact revision now has hosted and LinuxVM evidence. Benchmark remains separate and unverified.
- AdditionalUX finding for FA-10: stacklayout draws siblingCLIENT ancestry along overlappingverticalsegments; evidence rows correctly saySERVER→eachCLIENT, but diagramcanlooksequential. Recordbranch-awareedge routing as a separate repair after measurement, avoid bundlingunverifiedUIchanges with counter fix.

- Benchmark leadreview accepted Luna's boundedfixture/guide after correcting firstdraftthreshold and adding condition/request cancellation. Lead pinnedappports0, addedmeasuredsourceDirty provenance and madecleanupfailureinvalidate acceptance. Preselected tinybaselinecutoff1ms, delta≤5ms iftiny, otherwise relativep95≤10%; both metrics reported. Metrics extra request is identicalinbothconditions, excludedfromsamples butcounted1051tracedspans. Testsnotyetexecuted; firstmeasurementbeginsnow.

### Round47 — cross-trace batch throughput repair

First matched3×1000 measurement: all6000 measured business responses pluswarmups/metrics correct, requestcounts1050 andSDKhttpSpans1051 eachtracedrun. Delivered118/116/118, dropped933/935/933; medianpairedp95overhead114.491% (target10%failed), target sampledRSS~120MBvsbaseline62–69MB. No invalidspans/pendingafterstop, allCLIshutdownsconfirmed, failedtracedworkspacesretained. Codeinspection: exporter groupsonlysametrace, soindependentrequests requireonecollectorHTTPPOST andfull100graphsyncJSONrewriteeach. Practicalrepair: flatbatch≤32 normalizedspans acrossdistincttraces, atomicvalidation/build +onesave, bounded256queue/16KiBbody/300msdelivery and900msflush unchanged; rejectbad/conflictingitemswholebatch. Regressionchecks: singletracelegacyprotocol, multi-traceisolation/idempotency/lateparent, wholebatchreject, savefailurepreservesmemory/disk, onesaveperbatch, bodylimit/canary/auth, realSDKshutdown. Re-run identicalbenchmark withoutchangingrequests/concurrency/thresholds. CPU/RSS covers targetonly, notcollector/fullmachine.
- Tool failure at roundstart: after new usermessage the functions store root variable was unavailable, so command defaulted to parentdirectory and could not find docs/src; no write occurred. Re-established explicitprojectworkdir and recordedthe failedread/append here; sourcepatch used absoluteprojectpaths and appliedsuccessfully.

- Atomiccross-tracebatch affectedregressions29/29 passed (2026-10-01T12-18-06-722Z): realSDKCJS/ESM, oldsingletraceevents, one-savebatch/idempotency/retention/bodybounds, no partialmutation after invaliditems/controlledsavefailure, legacydisk/source/session behavior. Queuecapacity256, perrequestdeadline300ms, shutdown900ms unchanged. New rawbenchmarkdirectory addedto.gitignore (initialinventory showed ituntracked); artifacts staylocal andpackagefilesalreadyexcludereports. Nextidenticalbenchmarkmeasures repair; nooverheadpassclaimed from unitcases.

- Aftercross-tracebatch benchmark 2026-10-01T12-19-32-032Z measurement/capturetest1/1passed: all3pairs1000measuredresponses correct; all3153HTTPspans acknowledged (1051each), dropped/invalid/pending0; all6workspaces shutdownconfirmed/removed. Sanitizedartifact reports/benchmarks/2026-10-01T12-19-32-485Z-97b33b9c-c319-43aa-a1ec-eda6ce8b20db.json. Performancegate FAILED: baselinep95 4.680/4.091/4.878ms, traced13.314/24.881/19.107ms; medianpairedrelative+291.697%, mediandelta14.229ms, target10%notmet. Passingmeasurement/capture doesnotmean acceptableoverhead. Before/afterruns occurredatdifferenttimes andhostloadcanvary; thisisnotacontrolledcausalperformancecomparison. Completecapture doesmoreworkthanthepreviouslossycollector. NeedCPUprofile/isolate exporterwork andLinuxbenchmarkbeforestoragebackend/SDKdecisions; no thresholdchange.

- Finalbenchmarkrerun2026-10-01T12-26-08-847Z failed0/1: allresponses/countsreconciled but captureCompleteWithoutDrops=false. Report817d1e56..., retaineddiagnosticworkspace; baselinep95median8.271ms (vs4.680 prior), traced22.318ms, performance stillfails. Capture therefore not yet repeatably lossfree; don'tpublish zero-dropstableclaim from onepassingrun. Add fixed-vocabulary drop-reason counters before tuning deadlines/capacity/storage so causescanbe distinguished; no businessretry, no thresholdrelaxation.

- Added fixedvocabulary deliveryhealth counters after32-spanloss rerun: overflow/invalid/rejected/timeout/transport/shutdown; no messages/URLs/statuspayload/privatepaths. Focused7/7 (2026-10-01T12-28-49-833Z) passed including controlledtimeout vs503 vs900ms shutdown andrealSDK. This is diagnosis, not a fix for the lastloss. Benchmarknowrequiresdrop-reason countsreconcile withtotal dropped; firstdiagnosticmeasurementnext.

- Diagnosticbenchmark2026-10-01T12-29-22-081Z failed0/1: drops30/27/0 were collectorREJECTIONS, notqueue overflow, timeout, transport orshutdown. Allresponses/counts remainedcorrect. Parseexistingcollector fixedstorage diagnostic lines into sanitizedbenchmarkJSON beforeclassifying cause; do notimplement timeout/retry changes based on the previousguess. Luna's follow-up analysis is unavailable due agentusage-limit error; lead is analyzing actualresults directly (Luna's earlierfixtureauthorship remainscorrect).

- Storage-diagnosticbenchmark2026-10-01T12-34-46-663Z passedmeasurement/capture1/1 (all3153spans/zero drops), no storageerrorlines in thisrun. Earlierrejectionsremainunexplained; thispassingrerun is not a rootcausefix. AddedfixedHTTPstatus counters400/401/403/409/413/503/other todiagnosticoutput/report so subsequentCI/VM failures distinguish validation/auth/snapshot/body/storage refusal withoutreadingrawerrorpayloads. Coredeadlines/capacities/thresholds unchanged; no speculativefilesystemretry implemented.

- Final batch/diagnostic/inspect focused18/18 passed (2026-10-01T12-38-50-422Z); diagnostics encode fixedstatus counters only. Shipping this as developmentprogress with hosted/VMload gates next, not v1 or stablezero-loss/overheadacceptance. Localbench has bothpassesandintermittentrejection failures; retainall reports andfailedworkspaces. Application source/adapter files untouched.

- Hostedrun36863352104 ae55301 initialsnapshot: Ubuntu22/24 completedwith failurein newloadcapture gate; precedingfunctional gates passed. Windowsrunning atsnapshot. This shows intermittent refusal is not provenOneDrive-specific. RetrieveactualCIbenchmarkartifact/drop-status/storage diagnostics beforefixingfilesystem or retry policy. Sourcebundle/VMfreshcheckout checksumverified; VMmain/load stillrunning.

- CI Ubuntu22 artifact11162582648 actualfailure: round1 overflow19, noHTTPrejections/storageerrors/timeout; next2roundszerodrop. This is a differentcause fromthelocal collectorrejections; do not conflate them orassumefilesystem. Queue256 stillsaturates duringfastbursts. VMae55301 main96/source1/SDKChromium2passed; benchmark1/1passed all3153acknowledged/zero drops, performanceFAILED baselinep95median5.341ms/traced14.083ms (+163.677%). RawVMarchive SHA25615b2490f1d216c12576b4e6bdc46f66498c10870d75a64c642c66290317301ca; retrieve next. Businessstatus/body remainedcorrect across allknownruns. Needprofile normalization/export/collectorvalidation andreadremainingCIevidence beforechanging queue/storagepolicy.

- Hosted ae55301 completed: Windows24jobpassed, other3jobsfailedloadcapture only; allmain96/source/browser/SDK/package/reinstall gatespassed. Windows22artifact11162662816 showsround3overflow38, noHTTPrefusals/storageerrors; Ubuntu22round1overflow19. Actualcapacitysaturation is proven independently; localcollector-rejection cause stillunknown. Addedopt-in collector-only CPUprofile mode tobenchmark, preservingfixture/workload/budgets but markingprofiledresults incomparablewithunprofiledones. Rawprofiles staylocal/ignored andcancontain filesystemURLs; notanapp/production recorder. Nextdiagnosticprofile aims at actualnormalization/validation/storageCPUhotspots, no queuesizeorFSretry changes.

- Diagnosticprofilerun2026-10-01T12-50-39-540Z passedmeasurement/capture1/1, but CPUprofiles mostlyidle/spawn: they captured CLIwrapper, not collectorprocess. CLI spawns inspect as a separateNodeprocess anddoesnotpropagateexecArgv; profilerselected wrongprocess. No CPUhotspot conclusion drawn and no validationoptimization yet. Correctdiagnosticmode toprofile scripts/inspect.mjs directlywith the same workspaceenvironment/arguments, recordmethoddifference explicitly; rawprofileslocalonly.

### Round 48 — bounded parallel collector delivery

Completion check: at most two active HTTP batch requests, each <=32 spans, total queue+in-flight <=256, exact acknowledged/drop counts, no retries, bounded shutdown aborts every active slot. Existing real SDK and atomic collector contracts must pass; unchanged 3x1000 load gate then determines capture stability and separately reports the existing performance budget.

Actual collector CPU profiles from 12-52-19-621Z include graph validation and durable save/fsync/rename work as well as idle time. They do not isolate application SDK overhead or prove a filesystem fault. CI Ubuntu22/Windows22 shows overflow, not rejection. Serial exporter requests also leave a transport wait between batches; two bounded slots are the next measured repair, without weakening validation, queue limits, timeouts or workload. Added controlled concurrency/shutdown regressions before implementation.

- Round48 regression 2026-10-01T13-03-31-601Z: 5/7 pass, both new slot tests failed (peak/received1 instead of2), confirming the prior serial delivery. Implemented fixed two-slot batch delivery with aggregate in-flight accounting and shutdown abort across all controllers; capacity256/batch32/deadlines unchanged. Focused contracts and actual SDK verification next.

- Round48 focused20/20 and unchanged unprofiled load capture1/1 passed (13-04-10-194Z,13-04-29-290Z). All3153 spans acknowledged with zero drops, no application retries/changed outputs. Performance acceptance stillFAILED (+551.464% aggregatep95; baseline4.201ms/traced27.368ms). Two slots fix the controlled serial limitation; a single passing fixture run cannot prove stable capture or lower overhead. Exact CI revision is required next. Prior VMae55301 evidence imported/checksummed and all 67-file inventories matched Gitblobs; its main96/source1/benchmark1/SDKChromium2passes predate this change.

- e83f48f Ubuntu22 artifact11163982273: first round delivered547/dropped504: overflow440 and timeout64, no rejections/storage diagnostics; later rounds zero-drop. This disproves a stable fix from two slots alone. VM e83f48f main98/load1/SDKChromium2 passed capture but overhead remains above budget. Add fixed numeric batch-density counters before changing batch scheduling or storage; no timeout/queue increase or retry.

### Round 49 — batch utilization diagnosis and repair

Completion check: measure submitted spans/batches/small batches/peak upload requests, then reduce redundant small collector commits if confirmed. Preserve queue256/batch32/two slots/300ms delivery/900ms shutdown; business callbacks must remain prompt, sparse traffic must drain without another export, forceFlush must bypass any batching wait. Record exact results before accepting any performance claim.

- Transport diagnostics focused9/9 passed (2026-10-01T13-17-49-275Z). Unchanged load measurement2026-10-01T13-18-10-868Z1/1 capture passed, overhead stillFAILED (+161.479%). Submitted1051 spans required91/68/63 batches, of which90/64/55 were below32; mean11.55/15.46/16.68. Most requests therefore force small durable commits. Add a20ms partial-batch coalescing window; full32 dispatch immediately, no application callback wait, flush bypasses the wait, queue/slots/delivery/shutdown limits stay unchanged. Regression first, then measure density and capture without changing workload/budgets.

- Coalescing regressions before implementation2026-10-01T13-20-57-231Z7/9 passed: prior exporter immediately emitted partial batches, failing both independent delay and flush-bypass checks. Added20ms scheduling only for partial batches; full32 immediate, two active slots remain bounded, forceFlush cancels timer and drains directly, shutdown aborts all slots within existing budget. No storage validation skipped and no retries introduced.

- Round49 final focused22/22 (2026-10-01T13-21-50-095Z) and matched load1/1 capture (13-22-33-249Z) passed. All3153 spans acknowledged, zero drops/invalid/pending; batches36/42/39 with mean29.19/25.02/26.95 instead of prior91/68/63 (means11.55/15.46/16.68). Actual batch utilization improved under this fixture. Performance stillFAILED: aggregatep95 +68.287%, pairedmedian +197.904%; baselinep95 varied5.21–25.557ms, and background evidence import/provenance work ran on host, so timing cannot establish a causal speed improvement. Exact CI/coalesced VM still needed, no stable-load claim.

- Postcommit confirmation13-26-01-528Z0/1 failed on three readiness timeouts (including untraced baseline), leaving cleanup unconfirmed. Completed traced round3 had1051 acknowledged/zero drops. No evidence links these readiness failures to batching or OneDrive. Preserve failed workspaces, inspect exact QA process tree, and resolve orphan cleanup separately before trusting more local timing. Partial-pair timing aggregates must not be used for overhead acceptance.

- 2f40612 Ubuntu24 artifact11166236048: first2rounds used33batches (32span full batches except final remainder), capture complete; third round overflow635/timeout64, only416 submitted/352 acknowledged, no refusals/storage diagnostics. Coalescing achieved full batches but did not eliminate intermittent delivery stalls. Next diagnosis profiles actual fixture target workload (SDK/export), using a local Node inspector Session only in generated diagnostic fixture; no profiler/port/file writer added to owner apps. Counts/workload/budgets remain unchanged, timings explicitly incomparable. CLI lifecycle/readiness is recorded as a separate unresolved issue, not silently bundled.

### Round 50 — measured normalization validation cost

Target CPU profiles show normalizeSdkHttpSpan/cleanHttpSpan/identity checks among application-side work; they do not identify fetch as the stall cause. Reuse the two fixed ID regexes and parse each ISO timestamp once instead of twice; preserve the same accepted/rejected values and sanitized output. No mutable-graph validation cache, storage shortcut, new retry or deadline change. Boundary checks cover zero/uppercase/wrong-length IDs, invalid/backwards time, NaN/Infinity/duration/status limits; actual SDK/collector/storage checks follow. Startup/readiness/lifecycle and intermittent stalls remain separate unresolved gates.

- Round50 affected contracts passed32/33 (13-41-26-268Z): failing legacy persistence restart emitted real save/rename EPERM, while normalization boundary tests, SDK and atomic graph tests passed. Actual filesystem refusal now reproduced independently of SDK transport; it does not explain CI Linux timeout/overflow. File-lock owner/rootcause unconfirmed. Original state preserved and rejected event was not committed. A bounded Windows rename-only retry may address transient refusal; persistent failure must still503/preserve old state. Keep this in separate Round51, not a silent validation change.

- Round50 unprofiled13-41-57-648Z1/1 capture passed, all3153acknowledged/zero drops, performanceFAILED (+126.125%, baseline12.111ms/traced27.386ms). No overhead acceptance or causal speed claim. Target profiles show normalization among application costs; no proof fetch causes stalls. Validator uses fixed regex reuse and one parse per timestamp, with strict boundary regression. Related32/33 storage gate remains failed pending separate recovery repair. Review complete diff, preserve failure evidence and commit this bounded diagnosis/validation round before the next storage change.

### Round 51 — bounded Windows state replacement recovery

Actual save/rename EPERM reproduced in persistence test13-41-26-268Z. Implemented only Windows EPERM/EACCES/EBUSY rename retry, same already-flushed temporary bytes, pauses5/10/20/40ms (75ms total,5attempts). Validation/write/fsync are not repeated and memory is committed only after replacement succeeds. Persistent refusal retains the original error/503/old state/temp cleanup. Linux/other filesystem errors are attempted once. File-lock owner/rootcause remains unknown; this is bounded transient recovery, not confirmed resolution of OneDrive or CI stalls. Completion check: controlled transient simulation succeeds with old bytes unchanged until rename; persistent/other-platform failures stay bounded; real filesystem obstruction and restart/concurrent persistence gates pass.

- Round51 affected21/21 (2026-10-01T13-46-31-959Z) passed: controlled transient Windows refusal simulation recovered same bytes, persistent/other-platform errors bounded, real filesystem obstruction still503/preserves old state, restart/fresh-process/20-concurrent persistence and atomic span batches passed. Review added explicit canonical-path guards for generated test cleanup; main quality gate next. A passing replay does not identify the original file-lock owner or prove all intermittent refusals resolved.

- Round51 main102/103 (13-47-52-402Z): storage/restart/concurrent/persistent-failure checks allpassed; CJS SDK failed final acknowledgements (delivered5/dropped1 despite six persisted spans). Local runtime reports8 available parallel workers. No timeout/reason was captured by that assertion, so do not attribute the drop to storage/CPU yet. Retain the failed main gate; add fixed diagnostics in a separate capture investigation, and compare bounded2-worker main as diagnosis without altering app deadlines or business workload.

### Round52 — runtime acknowledgement diagnosis (no production change)

A main CJS case persisted six spans but acknowledged five, so inspect fixed delivery/rejection/transport counters before classifying loss. Test now emits only allowlisted nonnegative numeric counters on dropped capture; no raw childoutput/paths/messages/credential/bodies. Run all103 tests at2workers as a bounded-resource comparison, retaining the prior8-worker failure. This changes only test orchestration for this diagnostic command, not default runner, request/deadline/queue/acceptance or business concurrency assertions. Passing bounded comparison cannot certify the original main gate or performance.

- Bounded2worker comparison2026-10-01T13-54-46-940Z103/103 passed failed/skipped0, including actual CJS/ESM acknowledgements and storage recovery. This does not erase prior default102/103 failure or prove its cause. Fixed numeric diagnostics are now present; default103-case run next checks unchanged default orchestration and captures any recurrence. No production behavior changed in Round52.

- Round52 default101/103 (13-56-58-375Z) diagnosis: CJS SDK lost acknowledgement1 fromTIMEOUT only (overflow/rejected/transport/shutdown0); all six spans had already persisted. Another external-repository action returned complete=false in the existing fail-open adapter path. Bounded2worker main103/103 passed earlier. This establishes the collector response can exceed the300ms SDK acknowledgement budget under this local workload; it does not identify the pause source or prove missing persisted spans. CIcoalesced Ubuntu24 separately overflow635/timeout64 in a1051spanburst. Reconsider bounded exporter resource policy based on these measured bursts/delays; acceptance workloads, performance targets and business retry behavior stay unchanged. Record policy changes explicitly, do not describe them as a rootcause fix.

### Round53 — measured bounded capture resource policy

Observed coalesced1051span fixture burst lost635 to capacity256 and64 to300ms acknowledgement timeout; local6span case persisted allspans but lost1 acknowledgement to timeout under8-worker load. Adopt default/max queued+in-flight2048 and default uploadtimeout1000ms (existing maximum), retain batch32/two slots/20ms coalescing and900ms shutdown. This accommodates the measured burst/pause while keeping callbacks immediate and memory/counts bounded; no metadata/business retries, performance acceptance/workload unchanged. It increases potential buffer memory and acknowledgement wait and does not fix the pause source; forced/900ms shutdown stillmaydrop. New3000span stalled-collector boundary test must prove952overflow+2048shutdown, no pending work, invalid oversized settings rejected; then same unprofiled fixture/default main/exact CI/VM must verify. Luna receives read-only policy review; lead decides/reviews evidence.

- Round53 focused2026-10-01T14-04-02-178Z20/20 passed: capacity2048 boundary/stalled collector/952overflow+2048shutdown, fixed numeric bounds, actualSDK/atomic contracts. Luna read-only policy review supports this as a measured bounded adjustment only, highlights added buffer residence/memory and900ms shutdown preceding1000ms upload timeout; no edits/tests by Luna. Lead accepts those limits, retains prior failures and unchanged acceptance. Exact unprofiled load then default main next.

- Round53 matched unprofiled2026-10-01T14-04-43-130Z1/1 capture passed: all3153acknowledged, zero dropped/invalid/pending, correct6000measuredresponses. Performance target FAILED (aggregate+16.336%, pairedmedian+15.719%, baseline12.31ms/traced14.321ms). Host timing differs from prior rounds; no causal speed claim. Same workloads/thresholds preserved, larger bounded buffer and upload budget recorded as production policy, not a test retry.

- Round53 default2026-10-01T14-06-03-543Z104/104 passed failed/skipped0 under unchanged default orchestration, including explicit external-repository and actualSDK CJS/ESM acknowledgements. Focused20/20 and identical unprofiled load1/1 capture passed; performance stillFAILED. This verifies a bounded policy at these fixtures, not rootcause resolution or sustained losslessness. Lead reviewed actual diff and Luna's no-edit review; exact hosted/VM gates next, previous failures retained.
