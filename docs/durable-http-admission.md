# ต้นแบบ QA สำหรับ durable HTTP admission

รอบ 82 ต่อจากการทดลอง save35→18 ครั้ง ด้วย HTTP ใน loopback จริง แต่ยังเป็นต้นแบบ QA ใน `scripts/` ไม่มีการเปลี่ยน collector, exporter, storage format หรือ deadline ของผลิตภัณฑ์

ต้นแบบรับเฉพาะ POST `/qa/ingest` และ `otel-span-batch` ด้วยตัวตรวจ production เดิม เก็บ body ในหน่วยความจำไม่เกิน16KiB แล้วปฏิเสธ body ที่ยาวเกินหลังอ่านจบ และจำกัดสมาชิก32spansต่อคำขอ ตัวอ่านยัง drain bytes ส่วนเกิน จึงไม่ใช่ขอบเวลาส่ง body หรือขอบจำนวน network bytes; peer ที่ไม่จบยังครอง connection/slot จนปิด มีที่ว่างสองคำขอรวมช่วงอ่าน body/รอบันทึก คำขอเกินขอบเขตตอบ503 เมื่อมีกลุ่ม in-flight จะปิด admission ชั่วคราว แม้ client ในกลุ่มนั้น disconnect ไปแล้ว เพื่อรักษาขอบเขตของต้นแบบ ใช้หน้าต่างรอคู่20ms (ค่าทดลองจำกัด0..50ms) และบันทึกคำขอเดี่ยวเมื่อไม่มีคู่ ตัวเลขนี้เป็นพารามิเตอร์ของ QA ไม่ใช่ configuration ใหม่ของ collector

แต่ละกลุ่มเริ่มจากสำเนา committed graphs เพื่อไม่ให้การแก้ trace เดิมเปลี่ยน live references ก่อนบันทึก ตรวจคำขอตามลำดับผ่าน `ingestHttpSpanBatch` บน staged FlowAtlas แล้วเรียก JsonActionStore.save จริงครั้งเดียวสำหรับ final history≤100 เมื่อ save สำเร็จจึงเผยแพร่ state และตอบ202 หากกลุ่มตรวจไม่ผ่านตอบ400; หาก save ล้มเหลวตอบ503และไม่เผยแพร่ state ของกลุ่มนั้น

การทดสอบ I/O failure ใช้ rename obstruction จริงใน workspace ที่เป็นของ fixture: เก็บไฟล์ state เดิมเป็น backup แล้วใช้ directory ขวางปลายทาง rename หลังการเขียน/fsync เก็บ state ที่สำเร็จก่อนหน้าไว้และ restore backup ก่อน reopen การทดสอบนี้ไม่ใช่ power-loss/crash test และไม่พิสูจน์ว่า state path อ่านได้ในขณะที่ fixture จงใจขวางอยู่

hooks `beforeSave`/`afterCommit` มีไว้ควบคุมจังหวะใน QA เท่านั้น มีขอบรอ1วินาทีที่แยกจาก product deadline ค่าตอบกลับและ snapshot ใช้ข้อมูลแบบคงที่หรือ counts รวม `reading` ไม่เก็บ PID, path, token หรือ body ของแอป การส่ง response จบฝั่ง server ไม่ยืนยันการได้รับ ACK ฝั่ง client การ disconnect หลัง durable commit จึงห้ามอ้างว่าข้อมูลนั้นยังไม่บันทึกหรือได้รับการยืนยันแล้ว `close()` ปฏิเสธงานที่ยังอ่าน body/รอ flush และป้องกันการบันทึกภายหลังจากงานที่ค้างใน beforeSave

ต้องตรวจ pair/single, update และ conflict ของ trace เดิม, admission bound รวม body readers, การปิดขณะมีงานค้าง และ disconnect หลัง commit พร้อม memory/disk state และ lock cleanup ผลผ่านรับรองเฉพาะต้นแบบและเงื่อนไขที่ทดสอบ ไม่แทน exporter drain900ms, application p95, crash recovery, pilot หรือ production adoption ตาม [ADR](adr-durable-drain.md)

`serverResponseFinished` นับการจบ response ทุกสถานะ รวมคำขอที่ปฏิเสธ ไม่ใช่จำนวน client ACK ของ202 การปิดจะ cancel การรอ body ของ handler เพื่อป้องกัน late enqueue แต่ตัว socket/stream ยังต้องปิดโดย peer หรือเจ้าของ fixture

ผล local Windows Node24.19.0 วันที่13ตุลาคม2026: focused `2026-10-13T10-33-21-292Z` ผ่าน10/10; main `2026-10-13T10-33-55-906Z` ผ่าน182/187 โดยห้ากรณีล้มเหลวเป็น startup ของ adapter/CLI SDK/CJS inspector ส่วน HTTP controls ผ่านครบใน main; source `2026-10-13T15-48-10-192Z` ผ่าน1/1 ผลก่อนหน้า syntax0/1, hung2/3 และ lock-owner misuse9/10 เก็บไว้ครบ ไม่อ้างว่าปัญหา startup, performance หรือ shutdown drops ถูกแก้แล้ว
