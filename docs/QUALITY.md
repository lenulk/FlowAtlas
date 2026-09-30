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

## สถานะหลังรอบแก้

- Automated: 27 กรณีผ่าน (26 ชุดหลัก + 1 source check แยก); ไม่พบ failure ค้างในขอบเขตที่ตรวจ
- Manual UI: 3 กรณีผ่าน บันทึกภาพ success graph และ collector outage
- เพิ่ม project `AGENTS.md` ให้การทดสอบครั้งถัดไปใช้ runner และบันทึกการวิเคราะห์ด้วย
- ปรับรายงานให้เก็บ hashes ของ code/tests/runner/package.json เพื่อระบุไฟล์ที่ทดสอบแม้ working tree ยัง dirty; focused runner check ผ่าน 3/3 (`2026-09-30T10-19-01-072Z`) และตรวจ JSON ว่ามี digest + 24 file hashes จริง
- ทบทวน actual diff และ syntax ของ JavaScript ทุกไฟล์แล้ว ผ่าน; `git diff --check` ผ่าน; อ่านภาพ QA ทั้งสองแล้วข้อความ/กราฟไม่ถูกตัด
- ยังไม่ยืนยัน: Node 20/22 (ครั้งนี้ใช้ Node 24), browser อื่น/มือถือ, ปริมาณโหลดระดับ production, แอปภายนอก repository, trace มาตรฐาน, storage ถาวร และประโยชน์กับผู้ใช้จริง
- ความเสี่ยงที่เหลือของ telemetry: ไม่มี retry queue, มีการรอที่จำกัดเวลา และ capture ที่ขาดอาจค้าง running; ต้องตรวจ capture status ควบคู่ผลธุรกิจ
