# ADR: opt-in Node HTTP traces

## เป้าหมายและการตัดสินใจ

เพิ่มโหมด tracing ผ่าน SDK จริงที่เริ่มก่อน app imports โดย CLI preloads SDK ใน child process แยก เลือก HTTP/Undici instrumentation เป็นจุดเริ่มต้น ลดการใส่ handler hooks สำหรับการเห็น HTTP parent/child ไม่ใช้ span name หรือ source declaration ยืนยัน business function

เครื่องมือเก็บข้อมูลที่ normalize แล้วเท่านั้น: trace/span/parent IDs, SERVER/CLIENT, method ที่อยู่ใน fixed vocabulary, start/end/duration, HTTP status และ error boolean ไม่เก็บ raw attributes, URL/path/query/host, headers/body/cookies, resource detectors, events/exceptions หรือ baggage Default graph ใช้ชื่อ HTTP SERVER/CLIENT กับ method และมี coverage gap เสมอ Client action correlation และ source symbols ยังต้องมีหลักฐานแยก; graph HTTP ที่ไม่มี client report ห้ามเรียกว่า user click ที่สังเกตจริง

กราฟชนิด trace ใช้ schema 0.2; validator/reader ยังรับ 0.1 เพื่อเปิดข้อมูลเดิม ไม่มีการ rewrite graph เก่า SDK exporter ส่งโปรโตคอล normalized ของ FlowAtlas ที่มี session bearer ไม่ใช่ OTLP endpoint Parent ที่ยังไม่มามี unknown placeholder; เมื่อมาถึงจึงเปลี่ยนเป็น span relationship พร้อม IDs การส่งซ้ำเหมือนเดิมไม่เพิ่ม graph/edge; duplicate ID ที่ contents ต่างกันปฏิเสธ batch ทั้งชุด มีเพดานต่อ batch/trace ก่อนเขียนและตรวจ project/code digest ทุกครั้ง

Queue มีขนาดจำกัดและส่งแบบ best effort ไม่ retry business หรือ metadata ในระยะแรก Queue/full/timeout/rejection มี dropped diagnostic และกราฟยังระบุ partial coverage ไม่ทำให้ HTTP outcome กลายเป็น telemetry error ภายหลังต้องเพิ่ม persisted dropped/completeness และ benchmark ตาม FA-07 ก่อนรับรองโหลด

SDK ใช้ custom exporter เท่านั้น ไม่ auto resource detectors/logs/metrics/default OTLP; child environment สำหรับโหมดนี้ควบคุม OTEL_* และ propagation ใช้ W3C trace context โดยไม่ส่ง baggage Outbound เริ่มด้วย loopback เท่านั้น และยกเว้น collector ไม่เพิ่ม trace headers ไปบริการภายนอกที่ไม่ได้อนุญาต โหมดนี้ไม่ใช้กับแอปที่เปิด SDK ของตัวเองอยู่แล้ว จนกว่าจะมีวิธี attach ที่ผ่าน compatibility tests

## ตรวจและย้อนกลับ

ต้องตรวจ native HTTP/Undici ใน CJS/ESM child process จริง, concurrent/fan-out, parent gaps, duplicates/out-of-order, secrets canary, collector outage และ bounded shutdown ก่อนรับรองโหมดนี้ SDK/dependencies ตรึงด้วย lockfile การติดตั้ง offline ต้องมี dependency cache พร้อมจาก npm ci ขั้นเตรียม environment

ปิดโหมด tracing เพื่อกลับ explicit integration ได้โดยไม่เปลี่ยนแอป Graph 0.2 ต้องใช้ reader รุ่นที่รองรับ ก่อน rollback tool รุ่นเก่าให้สำรอง workspace และแยกข้อมูล 0.2; reader เก่าอาจปฏิเสธ schema ใหม่ ไม่อ้าง released-version migration/rollback ที่ยังไม่ตรวจ

## แหล่งอ้างอิง

- [SDK Node](https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/opentelemetry-sdk-node/README.md)
- [ESM initialization and hooks](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md)
- [HTTP semantic conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/)
- [Exporter selection](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/#exporter-selection)

ADR เป็นเกณฑ์ implementation/test ไม่ใช่หลักฐานว่าฟีเจอร์ผ่านแล้ว ผลจริงต้องบันทึก TEST-RUNS/QUALITY

### Cross-trace batch transport

Exporter ส่ง kind=otel-span-batch พร้อม projectId/codeDigest และ items1–32 แต่ละitemมี traceId และ span ที่ลดรูปตามสัญญาข้างต้น Collector แยกกลุ่ม trace/build/validate ทั้งชุดก่อนบันทึก durableครั้งเดียว หาก itemใดขัดแย้ง/ไม่ผ่าน หรือsaveล้ม จะไม่เปลี่ยนกราฟใดในmemory ทุกgraphยังschema0.2และcoveragepartial; legacy kind=otel-spans ยังอ่านได้ การรับackเป็นbatchไม่ได้ขยายqueue256/history100/16KiBbody หรือdeadlineเดิม
