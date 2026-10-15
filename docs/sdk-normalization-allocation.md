# ลดการคัดลอก object ใน SDK normalization

รอบ89 วันที่ 15 ตุลาคม 2026 บน branch `diag/sdk-normalization-allocation` ต่อจาก `948336e`. Sol วิเคราะห์และแก้โค้ด, Luna ตรวจ matrix/ช่วย regression test, Root ตรวจ CI รันทดสอบและส่งงาน

## หลักฐานก่อนเลือกแก้

Profile รอบ88 พบ `normalizeSdkHttpSpan` ร่วมกับ OpenTelemetry/Node/profiler work ในทั้งสามคู่ แต่ sampled time ไม่พิสูจน์สาเหตุของ HTTP p95. ตรวจโค้ดพบว่า SDK normalization สร้าง object ใหม่ที่มีเฉพาะ vocabulary ที่อนุญาต จากนั้น `cleanHttpSpan` ตรวจและคัดลอกเก้าฟิลด์เป็นอีก object หนึ่ง

เลือกทดลองลดการคัดลอกนี้ แทนการข้าม timestamp parsing เพราะต้องรักษา Date/TimeClip, `Date.parse` override, cache counters และ FIFO semantics เดิม ก่อนวัดกำหนดว่าจะพิจารณาใช้จริงเมื่อ equivalence ผ่านและตัวทดลองเร็วขึ้นทั้งห้าคู่ที่สลับลำดับ; นี่เป็นเงื่อนไขเลือก refactor ไม่ใช่เปลี่ยนเกณฑ์ release/performance

QA ก่อนแก้ `13-29-35-710Z` ผ่าน1/1: 22 boundary variants, SDK getter order, override parserสามแบบ และ cache checks ผ่านทั้งหมด วัด20,000 calls ต่อ condition ×5คู่/pool1,051 spans ตัวทดลองเร็วขึ้น5/5: median128.4007→115.4493ms (-10.087% ของ isolated elapsed time). เก็บทุกคู่ใน `reports/benchmarks/sdk-normalization-allocation-2026-10-15T13-29-37-538Z.json`; ไม่ใช่ HTTP, actual SDK lifecycle หรือ p95 และไม่มี performance verdict

## Refactor ที่ทดลองแล้วไม่รับเข้า production

ตัวทดลองแยก predicates/read order เดิมเป็น `validateHttpSpan` ซึ่งตรวจแล้วไม่คืน object ที่ sanitize. `cleanHttpSpan` เรียก validator นี้และยังสร้างสำเนาที่ตัด extra fields ตามเดิม. SDK normalization สร้าง fixed-vocabulary object ใหม่เอง ตรวจด้วย validator เดียวกัน แล้วคืน object นั้น เพื่อลดการสร้างสำเนารอบที่สอง **หลังวัด actual refactor ไม่รับการเปลี่ยนแปลงนี้เข้า production และคืน src/test ที่แก้ในรอบนี้เป็นรุ่นฐาน**

ตัวทดลองยังตรวจ trace/span identity, parent, kind, method, เวลา, ลำดับเวลา, duration, status และ error เหมือนเดิม. จับค่า `identity.traceId` สำหรับผลลัพธ์ก่อนสร้าง nested span เพื่อคงลำดับ getter ทุก call อ่าน input ใหม่ ไม่ cache validity หรือคืน object ของแอปโดยตรง. ไม่เพิ่ม numeric timestamp fast path หรือเปลี่ยน exporter/collector batch, deadline, durability, retention และเกณฑ์10%

Focused actual refactor `13-34-17-864Z` ผ่าน38/38 แต่ Root รวม cost script กับไฟล์ทดสอบอื่น/default2workers จึงวัดซ้อนกันและใช้เป็น isolated eligibility ไม่ได้ เก็บรายงานไว้:เร็วขึ้น2/5, median144.1423→155.8068ms (ช้าลง8.092%). แก้เงื่อนไขการวัดด้วย standalone เพียงครั้งเดียว `13-34-44-513Z` ผ่าน1/1ด้าน parity; actual candidate เร็วขึ้นเพียง3/5, median126.4169→116.7318ms (-7.661%) แต่สองคู่แรกช้าลง จึง **ไม่ผ่านเกณฑ์ทั้งห้าคู่ที่ตั้งไว้ก่อนวัด** ไม่ rerun เพื่อหาผลที่ดีขึ้นหรือเปลี่ยนเกณฑ์ภายหลัง

ผล QA clone ครั้งแรก5/5 และ actual production refactor3/5 เป็นคนละ implementation placement/measurement condition ไม่ใช้ clone รับรองผล implementation จริง การคัดลอกน้อยลงตามโค้ดไม่ได้รับประกัน elapsed improvement ที่สม่ำเสมอ เพราะ call boundaries/JIT/GC/host scheduling ยังมีผล เก็บตัวทดลองเฉพาะ QA เพื่อให้ตรวจซ้ำอย่างมีคำถามใหม่ได้

## CI ของรุ่นฐานและ CJS failure

Latest PR30 merge `225c15a065a8439f3bfa9b8602fae35320105b11` มี raw artifactsครบสี่ช่อง:136 runner reports/122 exact program files/main205/205ทุกช่อง รวม browser/package gates และ metadata controls16ผ่าน Audit `13-30-24-365Z` ผ่าน1/1 แต่ ordinary performance FAILEDทั้งสี่ช่อง: Ubuntu22+54.714%, Ubuntu24+134.587%, Windows22+232.404%, Windows24+228.785%

ผล hosted ไม่ลบ local main รอบ88 FAILED204/205. Numeric CJS target exit3221225794 เท่ากับ0xC0000142 ซึ่ง [Microsoft NTSTATUS](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55) ระบุ `STATUS_DLL_INIT_FAILED`. ยังไม่รู้ DLL/สาเหตุ; read-only Application-event query ช่วง13:16–13:18UTCไม่พบ record ที่มี AppName=node.exe (ไม่ใช่หลักฐานว่าไม่มี fault หรือระบุเหตุได้). CJS/MJS ใช้ CLI/inspect/preload เดียวกัน ต่าง entry require/import จึงไม่แก้ startup หรือเปลี่ยน Node จากรหัสนี้อย่างเดียว

## ข้อจำกัด

Isolated elapsed cost ไม่ใช่จำนวน allocation ที่วัดด้วย heap profiler และไม่แยกผล JIT/GC/host scheduling. เมื่อถอด production refactor ไม่รัน ordinary HTTP บนพฤติกรรมเดิมเพื่อหา passing result; exact hosted baseline ทั้งสี่ช่องยังไม่ผ่าน performance ตามข้างต้น รอบถัดไปควรแยก SDK instrumentation/normalization allocation ด้วยหลักฐาน allocation หรือ question เฉพาะก่อนเลือกการเปลี่ยนแปลงใหม่. Performance, native startup cause, slow-disk/sustained delivery, real business pilot/users และ release gates ยังเปิด ผู้ใช้ยังไม่มีแอป pilot

## รุ่นที่ส่งงานและการตรวจสุดท้าย

เก็บเฉพาะ `scripts/benchmark-sdk-normalization-allocation.mjs` และเอกสาร. QA เก็บ legacy normalize/clean/timestamp ที่ pin function hashes จากรุ่นฐาน เทียบ production ปัจจุบันและ local rejected candidate. ตรวจ src สามไฟล์ตรง baseline SHA; ไม่ต้องใช้ Git object เก่าจึงไม่มี dependency ต่อ fetch history. Legacy กับ candidate ใน QA ใช้ parser/cache ร่วมกันตามที่รายงาน ไม่ใช่ isolated heap/allocation profile

รันตรวจ parity/provenance โดยไม่วัด cost:

```powershell
node scripts/run-tests.mjs scripts/benchmark-sdk-normalization-allocation.mjs
```

Default report ระบุ costMeasured=false/cost=null และ adoptionDecision เป็น **การตัดสินจากการทดลองรอบ89** ไม่ใช่เครื่องมือรับรอง performance อัตโนมัติ การวัด cost ต้องเปิด `FLOWATLAS_NORMALIZATION_COST=1` โดยมีคำถามการทดลองใหม่ชัดเจน; ไม่เปิดซ้ำเพื่อเลือกผลที่ดีขึ้น. ไม่มีการเพิ่ม QA นี้ใน CI; local execution ที่ยืนยันในรอบนี้คือ Windows Node24.19.0

- Final parity `13-37-45-822Z`:1/1 ผ่าน 22 variants/getter/override/cache และไม่มี cost remeasurement
- Main `13-37-53-630Z`:205/205 ผ่าน/default2workers/skip0 รวม actual CJS/MJS; ไม่มี native exit ใน condition นี้ ไม่พิสูจน์ว่าแก้ historical DLL/native failure แล้ว. ไม่เปิด optional local browser flag จึงไม่อ้าง new local browser pass
- Standalone source `13-39-23-584Z`:1/1 ผ่าน
- Inventory audit แรก `13-39-58-766Z`:FAILED0/1 เพราะ raw Git hash ต่างใน test files. ตรวจพบ mixed CRLF/LF ใน `test/git-metadata-child.test.mjs` และ `test/startup-phase-isolation.test.mjs`; ยืนยัน UTF-8 roundtrip และ LF equivalence ทุก byte พร้อม Git diff ของ production/test ว่าง โดยไม่แก้สองไฟล์นี้. Corrected audit `13-40-54-795Z`:1/1 ผ่าน;123 program files ตรง raw hashes ของ final parity/main/source ทั้งสามชุด. เทียบ baselineได้ตรงหลัง normalization เฉพาะ EOL สองไฟล์ จึงไม่อ้าง raw Git bytes เท่ากันทั้งหมด

Sol/Luna ไม่แก้ source/test ระหว่าง final checks และไม่มี production refactor เหลือใน diff. First clone, overlapping actual measurement, isolated actual negative result และ failed audit เก็บครบใน TEST-RUNS/reports
