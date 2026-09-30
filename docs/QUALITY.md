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
