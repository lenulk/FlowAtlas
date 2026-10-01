# ทดลองเก็บ HTTP trace ด้วย OpenTelemetry

โหมดนี้เป็นการทดลองในเครื่องสำหรับแอป Node ที่ลงทะเบียนกับ FlowAtlas โดยใช้ OpenTelemetry SDK จริง เริ่มด้วย `node:http`/`node:https` และ Undici (รวม `fetch` ของ Node) โดย preload ใน child process ของแอป ไม่แก้ source ของแอปและไม่ต้องใส่ handler hook เองสำหรับ HTTP spans

## เตรียม workspace และลงทะเบียน source

ใช้ workspace ที่มี `flowatlas.config.json` และเก็บแอปไว้ภายใน workspace เพื่อให้ FlowAtlas ตรวจ source snapshot และ code digest ได้ ตัวอย่าง config แบบ local ที่เขียนเองได้:

```json
{
  "projects": [
    {
      "id": "my-app",
      "root": "apps/my-app",
      "files": ["server.mjs", "src/routes.mjs"]
    }
  ]
}
```

`files` ต้องรวม entry file และ source ที่อนุญาตให้อ่าน; เลือกเฉพาะไฟล์ที่ต้องการให้เป็นหลักฐาน source อย่าใส่ไฟล์ลับหรือข้อมูล runtime ลงในรายการนี้ การเพิ่ม registration ด้วย `flowatlas register` หรือ `scripts/register-app.mjs` จะคัดลอก `node-adapter.mjs` และ `project-sources.mjs` ไปยังแอปด้วย ส่วนตัวอย่าง config ด้านบนใช้สำหรับ HTTP trace ที่ไม่ต้องคัดลอก adapter

## เริ่ม inspect

จากโฟลเดอร์เครื่องมือ FlowAtlas เรียกคำสั่งโดยให้ PATH ชี้ workspace ที่มี config และ project ID ตรงกับรายการที่ลงทะเบียน:

```powershell
flowatlas --workspace PATH inspect --project ID --entry server.mjs --trace http
```

ตรวจ config/source/พอร์ต/runtime/dependency resolution ก่อนเริ่มได้ด้วย `flowatlas --workspace PATH doctor --project ID --entry server.mjs --trace http` โหมด doctor นี้ไม่ต้องมี copied adapters และไม่ import/start แอป จึงไม่ยืนยัน startup หรือความเข้ากันได้ของ SDK กับ dependencies ของแอป

เช่น:

```powershell
flowatlas --workspace C:\work\flowatlas-workspace inspect --project my-app --entry server.mjs --trace http
```

Entry ต้องอยู่ใน `files` ของ project และเป็นไฟล์ `.mjs`, `.cjs` หรือ `.js` ภายใน app root คำสั่งนี้เปิด collector และ target แยก process; ใช้แอปผ่าน URL ที่แสดงเพื่อสร้าง HTTP traffic แล้วพิมพ์ `stop` เพื่อปิดทั้งคู่ `Ctrl+C`/SIGTERM ก็เรียก shutdown; โหมด trace ใช้ private IPC เพื่อขอ flush SDK ก่อนสั่งหยุด target (Windows kill ไม่เรียก Node signal handler); inspector รอ target สูงสุด 5 วินาทีก่อนบังคับปิด ช่อง IPC ใช้ข้อความสงวน flowatlas:shutdown/flushed/flush-failed; ยังไม่รองรับ target ที่มี IPC control protocol ของตัวเอง

แอปทั่วไปที่ไม่พิมพ์ `Registered app: http://127.0.0.1:<port>` ต้องระบุ `--app-url` ของแอปด้วย เช่นตั้ง `FLOWATLAS_APP_PORT=3000` สำหรับแอปที่อ่าน PORT แล้วเพิ่ม `--app-url http://127.0.0.1:3000` Collector ตรวจ HTTP readiness ของ origin นั้นภายใน 10 วินาที หากแอปไม่ได้อ่าน PORT ให้ใช้พอร์ตจริงที่กำหนดในแอป ไม่ต้องเพิ่มข้อความ log เฉพาะ FlowAtlas

ระยะนี้ใช้โหมด HTTP preload กับแอปที่ไม่มี explicit capture hooks; การใช้พร้อม Node adapter ที่สร้าง traceparent เองยังไม่ผ่าน correlation/compatibility gate ไม่รับรองว่าประวัติ action แบบ explicit และ HTTP trace จะรวมกันได้ โหมด HTTP เปิดกราฟจาก history ของ viewer ตาม FlowAtlas URL ไม่สร้างลิงก์จากปุ่มในแอปให้เอง

โหมด trace ต้องใช้ Node 20.6 ขึ้นไปตาม runtime gate ของ CLI; matrix ที่ระบุในข้อความตรวจ CLI คือ Node 22/24 ตัวอย่าง CJS และ ESM ที่มีผลทดสอบจริงอยู่ใน [TEST-RUNS](TEST-RUNS.md) บน Windows/Node 24 และ Linux VM/Node 22; hosted Windows/Ubuntu × Node 22/24 ผ่านครบใน revision 18b9ddd counter/IPC ใน1114257ผ่านhostedทั้ง4ช่องและLinuxVMแล้ว ESM ต้องใช้ loader hook ของ OpenTelemetry เพิ่มจาก preload; อย่าสรุปว่า OS หรือ Node version อื่นรองรับจนกว่าจะมีผลตรวจเพิ่ม

## สิ่งที่ถูกเก็บ

กราฟ HTTP trace ใช้ schema `0.2` โดยคง graph เก่าไว้ตามเดิม ข้อมูล span ถูกลดรูปเป็น trace/span/parent IDs, ชนิด SERVER/CLIENT, HTTP method จาก vocabulary คงที่, เวลาเริ่ม/จบ/ระยะเวลา, HTTP status และ error boolean เท่านั้น ไม่เก็บ URL, path, query, host, headers, body, cookies, baggage, resource detectors, raw attributes, events หรือ exceptions

HTTP spans สร้าง request trace history และช่วยเห็นการเชื่อมโยงระหว่าง HTTP requests ที่ instrument ได้ แต่ไม่ได้พิสูจน์ว่าผู้ใช้คลิกปุ่มหรือเรียก action ใด ไม่ยืนยัน business function ภายใน handler, source symbol, หรือความครอบคลุมของทั้งแอป กราฟจะแสดง `partial` coverage และช่องว่างเสมอ; parent ที่ยังไม่มี span จะแสดงเป็น unknown จนกว่าจะได้รับ span นั้น ดู [ADR ของ HTTP tracing](adr-otel-http.md) สำหรับสัญญาและข้อจำกัด

เฉพาะ outbound HTTP ที่ไป loopback ได้รับการ instrument ในช่วงนี้ และ collector ถูกยกเว้นจาก trace เพื่อไม่ให้เกิด loop การเรียกบริการภายนอกจะไม่ถูกติดตามหรือส่ง `traceparent` ไปหา service นั้น โหมดนี้ไม่รองรับแอปที่ initialize OpenTelemetry SDK ของตัวเองอยู่แล้ว

## ข้อมูลและการย้อนกลับ

การส่ง span เป็น best effort ผ่าน bounded queue; เมื่อเต็ม, timeout, collector ปฏิเสธ หรือ shutdown deadline หมด span อาจหายและรายงานว่า capture ไม่ครบ โดยไม่ retry business request โหมดนี้สร้างข้อมูลใน `data/actions` ของ workspace ที่ระบุ เช่นเดียวกับประวัติอื่นของ FlowAtlas

ปิดโหมดโดยเอา `--trace http` ออกจากคำสั่ง แล้วกลับไปใช้การเชื่อมแบบ explicit ตาม [Node adapter](node-adapter.md) ได้ แต่ข้อมูล trace schema `0.2` ยังอยู่ใน workspace และ reader รุ่นเก่าอาจเปิดไม่ได้ ก่อนใช้เครื่องมือรุ่นเก่ากับ workspace เดิม ให้สำรอง workspace และแยกข้อมูล `0.2` ออกก่อน ยังไม่มีการรับรอง migration/rollback สำหรับ released version หรือการกู้คืนจากการ sync ข้ามเครื่อง

ผลทดสอบปัจจุบันครอบคลุม real NodeSDK preload ทั้ง CJS และ ESM บน Windows/Node 24 โดยใช้ local fixture: HTTP/Undici fan-out, requests พร้อมกัน, canary filtering, response และ shutdown ตรวจแล้ว offline package CJS/ESM preload และ schema reload ผ่าน 2/2 ด้วย revision 18b9ddd ผ่าน hosted ทั้ง4ช่อง และ Linux VM revision 4a68a3c ผ่าน main/source/Chromium; counter/IPC revision1114257 ผ่าน hostedทั้ง4ช่องและLinuxVM main92/source1/SDKChromium2 แล้ว แอปงานจริงและ compatibility matrix อื่นยังรอการตรวจ ผลนี้ไม่รับรองความพร้อม production ดู [รายงานทดสอบ](TEST-RUNS.md) และ [แผน/ข้อจำกัด](../PLAN.md)

เมื่อหยุด SDK จะพิมพ์ summary ที่มีเฉพาะจำนวน httpSpans/invalidSpans/delivered/dropped/queued/inFlight ค่า delivered หมายถึง collector ตอบ HTTP 2xx; dropped รวมการปฏิเสธ/เต็ม/timeout ที่ไม่รับ acknowledgement บาง timeout อาจถูกบันทึกก่อนแล้ว จึงไม่ใช่จำนวนข้อมูลสูญหายที่พิสูจน์แน่นอน และจำนวน history ที่คงไว้สูงสุด100ไม่ใช่จำนวน span ทั้งหมด

Shutdown diagnostics also report fixed drop reasons (overflow/invalid/rejected/timeout/transport/shutdown), fixed HTTP rejection buckets and collector storage diagnostic fields. Counters carry no URLs, messages or credentials. Intermittent collector refusal and performance targets remainopen; see benchmark/QUALITY for passes and failures.

## Delivery limits and current evidence

The exporter sends at most two collector batches concurrently, each with at most32 normalized spans. The total queued plus in-flight capacity remains256; default delivery timeout is300ms, shutdown drain budget900ms. There are no delivery retries. Acknowledged and dropped counts reconcile after normal shutdown, but unacknowledged delivery can be ambiguous if persistence happened before response loss. All HTTP graphs retain partial coverage; completeness is not yet persisted into each graph.

Focused two-slot/lifecycle/SDK checks passed20/20 on Windows. One matched3x1000 load run acknowledged all3153 spans with zero drops, while measured p95 overhead exceeded the existing budget. Earlier hosted ae55301 load failed from queue overflow in three jobs; local collector rejection cause remains unresolved. This is development evidence, not stable-load or production acceptance.

The current exporter coalesces partial batches for20ms, sends full32-span batches immediately, and bypasses this scheduling wait during forceFlush/shutdown. This scheduling delay is independent of the300ms per-upload timeout. Sparse traffic drains without a subsequent application request; SDK callbacks remain immediate. Fixed transport health records only numeric batches/submittedSpans/smallBatches/peakRequests. In one Windows fixture run,1051 spans used36/42/39 batches (mean25–29spans) instead of63–91 before coalescing; capture passed but the performance budget still failed. Exact hosted/VM verification and sustained-load acceptance remain open.
