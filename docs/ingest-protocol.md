# โปรโตคอลรับเหตุการณ์รุ่นทดลอง

เว็บแอปตัวอย่างใน `examples/independent-app` ส่งเหตุการณ์แบบ JSON ไปยัง `POST http://127.0.0.1:4173/flowatlas/ingest` ตัวรับตอบ HTTP 202 เมื่อรับได้ ทุกเหตุการณ์มี `actionId` เดียวกันและต้องส่งตามลำดับต่อไปนี้

1. `action-start` แจ้งชื่อการกระทำจาก client
2. `handler-entry` แจ้งคำขอ API และฟังก์ชันที่เข้าสู่การรัน
3. `outbound-result` แจ้งผลคำขอไปบริการปลายทาง
4. `finish` แจ้งผลสุดท้าย

สำหรับแอปที่ลงทะเบียนผ่าน local config: `action-start` เพิ่ม `projectId` และ `codeDigest` ของแอปเป้าหมาย (digest ไม่ตรงเป็น 409); ทุก event ต่อมาต้องมี projectId เดียวกับ action (ผิดเป็น 400) source ของกราฟใช้ files ของ project snapshot ไม่ใช้ collector snapshot รายละเอียด adapter/config อยู่ใน [node-adapter.md](node-adapter.md) เส้นทางเดิมที่ไม่ส่ง projectId ยังรองรับ fixture ภายใน collector

ตัวอย่างเหตุการณ์:

```json
{
  "kind": "handler-entry",
  "actionId": "a0b1c2d3-4444-5555-6666-777788889999",
  "name": "view-message",
  "service": "independent-app",
  "method": "GET",
  "path": "/api/message",
  "symbol": "viewMessage",
  "file": "examples/independent-app/server.mjs",
  "traceparent": "00-11111111111111111111111111111111-2222222222222222-01"
}
```

ตัวรับสร้าง node และ edge จากเหตุการณ์เหล่านี้ และใช้ตัวตรวจใน `src/evidence-contract.mjs` ก่อนส่งกราฟออกทาง JSON โปรโตคอลนี้ปฏิเสธเหตุการณ์ที่ไม่มี `action-start` มาก่อน การจับคู่ route ของบริการปลายทางจากไฟล์โค้ดเป็น `inferred` แม้ HTTP response จะได้รับจริง

JSON body ต้องเป็น object และไม่เกิน 16,384 bytes; `clientTime` เป็นเวลาแบบ string ที่ parse ได้ หรือ null แต่ละกราฟจำกัด 100 nodes และ 200 edges (413 เมื่อเต็ม) เหตุการณ์ที่ถูกปฏิเสธไม่เปลี่ยนกราฟที่เก็บไว้ `destination` แยกตัวตนของคำขอที่มี method/path เหมือนกัน เมื่อ handler และ outbound มี traceparent ต้องอยู่ใน trace ID เดียวกัน โดย span ID เปลี่ยนได้

เมื่อใช้ CLI ตัวรับเก็บ actions ลงดิสก์ก่อนตอบรับ event หาก write ล้มตอบ 503 เมื่อโหลดกราฟรุ่นโค้ดเก่ากลับมา API อ่านยังใช้ได้ แต่การเติม event ต้องมี code digest ตรงกับ runtime ปัจจุบัน มิฉะนั้นตอบ 409 ให้เริ่ม action ID ใหม่ การสำรอง/recovery อยู่ใน [storage.md](storage.md)

fixture เก็บ action IDs ในเครื่องเพื่อทำงานได้เมื่อ collector ล้ม คำตอบ `/action-start` มี `telemetry.complete`; คำตอบ API มี header `x-flowatlas-telemetry: complete|incomplete` เมื่อขาดเหตุการณ์จะหยุด capture ของ action นั้นและ UI แจ้งว่าหลักฐานไม่ครบ กราฟที่ collector รับไปบางส่วนอาจยังเป็น `running` จึงห้ามตีความว่าเป็นหลักฐานครบหรือผลธุรกิจล้มเหลว

## ขอบเขตความเชื่อมั่น

CLI ตรวจ session bearer และ Origin/Host ก่อนรับเหตุการณ์ตาม [session access](session-access.md); ยังเชื่อเนื้อหาที่ผู้ถือรหัสรายงาน ไม่ตรวจว่า client เป็นมนุษย์คลิกจริง `traceparent` ที่ส่งต่อได้รับการ echo กลับจากบริการจำลอง เพื่อแสดงว่าค่าถึงปลายทาง แต่บริการนั้นยังไม่มี span ภายใน ข้อมูลที่ไม่เห็นจึงคงเป็น `unknown`

ตัวรับรู้จัก file hash ของ collector และไฟล์ที่ลงทะเบียนแบบ explicit สำหรับ project อื่นภายในโฟลเดอร์โครงการ ไม่รับ root/path registration จาก HTTP โปรโตคอลยังไม่ใช่ OTLP/OpenTelemetry ingestion และยังไม่มี role separation สำหรับระบบหลายผู้ใช้

ส่งเฉพาะ metadata ที่จำเป็น ห้ามใส่ request body, token, cookie หรือข้อมูลส่วนตัวใน event ตัวรับฟังเฉพาะ `127.0.0.1`; ส่ง bearer ใน header สำหรับ session ที่เปิดจาก CLI ห้ามส่ง credential ใน event/URL
