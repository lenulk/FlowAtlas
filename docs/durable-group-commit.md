# ทดลองรวม durable commits สองคำขอ

รอบ 81 ตรวจความเป็นไปได้ใน QA ก่อนตัดสินใจเปลี่ยน collector จริง โดยไม่เพิ่ม shutdown 900 ms, upload timeout 1000 ms หรือ ACK ก่อน durable save สำเร็จ

Selected Ubuntu Node24 artifacts ของ PR21 และ PR22 ตรงกับ Git inventories 102/105 files และ 28/29 runner reports ตาม audit `2026-10-08T18-06-12-573Z` ปัญหาสี่กรณีเป็น shutdown drops เมื่อ exporter หมดเวลา ลำดับ retained graphs และ reload ยังตรง; rejected/timeout/transport drops เป็นศูนย์ การตรวจนี้ครอบเฉพาะสอง artifact ไม่ใช่ทุก CI jobs

PR21 controlled disk rounds 1/2: ACK 160/128, shutdown drops 891/923, collector accepted 224/192. PR22 ordinary disk rounds 2/3: ACK 256/192, shutdown drops 795/859, accepted 320/256. แต่ละกรณีมี accepted มากกว่า ACK อยู่ 64 spans จึงห้ามตีความ dropped ทั้งหมดว่าไม่เคยบันทึกลง disk อีกส่วนยังค้างใน queue การส่งไม่มีการลองซ้ำ

Exporter มีสอง upload slots และ batch ละไม่เกิน 32 spans การรวมสองคำขอจึงลด 33 saves ของ burst 1051 spans ได้อย่างดีที่สุดเหลือ 17 saves ภายใต้เงื่อนไขว่ารวบคำขอได้ทุกคู่ นี่เป็นขอบเขตเชิงโครงสร้าง ไม่ใช่เวลา drain ที่วัดได้จริง การหาร sync รวมด้วยจำนวน saves ใน hosted failure ไม่สามารถคาดการณ์ latency ของ workload ใหม่หรือรับรองว่าจะจบภายใน 900 ms

การทดลองใช้ states ต่อเนื่อง 35 states: 1051 synthetic traces และ updates อีก 64 traces/history 100 เปรียบเทียบ production snapshot save ทุก state (35 saves) กับ save state สุดท้ายของแต่ละกลุ่มติดกันไม่เกินสอง state (18 saves) ทั้งสองใช้ JsonActionStore จริง พร้อม fsync และ reload การสร้าง fixture และกลไกทดลองนี้ไม่ใช่ HTTP admission coordinator หรือ production group-commit implementation

ตรวจ failure ที่ขอบกลุ่มด้วย: synthetic published indicesของสมาชิกต้องเกิดหลัง synchronous save สำเร็จเท่านั้น และถ้า validation ของ state ในกลุ่มล้มเหลวต้องไม่ publish indices ของกลุ่มนั้น พร้อมรักษา state ที่สำเร็จก่อนหน้า การตรวจนี้ไม่แทน I/O failure, process crash/power-loss test หรือการจัดการคำขอจริงที่สลับลำดับ มาถึงช้า ยกเลิก หรือมาจากหลายแอป จำนวน sync อนุมานจากจำนวน production save ที่สำเร็จซึ่งเรียก fsync หนึ่งครั้งต่อ save; encoded bytes คำนวณจาก states ที่เลือก ไม่ใช่การดัก syscall แต่ตรวจ final bytes และ reload จริงแยกด้วย

ผลต้องระบุจำนวน saves/bytes/time และ reload แยกจาก application p95/SDK overhead; performance acceptance เป็น `met=null` หาก atomicity check ล้มเหลวให้ปฏิเสธรูปแบบนั้น การเทียบเวลาบันทึกกับ 900 ms เป็นเพียงบริบท ไม่ใช่ exporter drain test เพราะไม่มี HTTP/exporter/coalescing wait ในการทดลอง แม้เวลาอยู่ต่ำกว่า 900 ms ก็รับรอง drain ไม่ได้ ก่อนนำไป production ต้องออกแบบ bounded queue/coalescing wait/fresh validation/close/failure propagation และทดสอบ Windows/Linux พร้อม workload เดิมตาม [ADR](adr-durable-drain.md)

ผล local Windows Node24.19.0 วันที่ 13 ตุลาคม 2026: focused run `2026-10-13T09-52-36-171Z` ผ่าน 7/7; report `reports/benchmarks/durable-group-2026-10-13T09-52-40-906Z.json` มี 12 conditions และ validation-rejection controls สองชุด ทั้งหมด final bytes/reload/cleanup ตรง ผลนี้ระบุ core, script, helper และ fixture digests แยกกัน

| Synthetic source files | Saves baseline/pairs | Median storage ms baseline/pairs | Expected encoded bytes baseline/pairs |
| --- | --- | --- | --- |
| 1 | 35 / 18 | 155.315 / 84.065 | 6,371,360 / 3,354,132 |
| 64 | 35 / 18 | 281.729 / 136.600 | 25,359,776 / 13,229,004 |

เวลาครอบคลุม production save เท่านั้นตามขอบเขตข้างต้น ไม่มีการ subtract ค่าเหล่านี้จาก application p95 และไม่มี production backend change จากผล local นี้ ขั้นถัดไปต้องตรวจ failure หลังเริ่มเขียนจริงและการเผยแพร่กลุ่มที่สำเร็จ ก่อนออกแบบ queue/coalescing สำหรับ HTTP จริง
