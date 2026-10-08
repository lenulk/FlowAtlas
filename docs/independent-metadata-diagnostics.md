# การตรวจ metadata ของ independent fixture

รอบ79เพิ่ม diagnostics แบบ opt-in ให้แอปตัวอย่างและ browser QA เพื่อหาว่าหลักฐานขาดช่วงใด โดยไม่เปลี่ยนผลธุรกิจหรือเพิ่ม retry แอปตัวอย่างยังใช้ telemetry timeout500ms และ browser test60s ตามเดิม

`startIndependentApp({ onMetadataDiagnostic })` รับ callback ที่ส่ง snapshot แยกจาก capture state; callback ที่ throw หรือคืน rejected Promise ไม่มีผลต่อ capture/status/body. CLI ของแอปตัวอย่างเปิด callback เฉพาะเมื่อ `FLOWATLAS_INDEPENDENT_DIAG=1`; browser QA ตั้งให้เฉพาะ process ที่ตัวเองเปิด

แต่ละ action ใช้ ordinal และชื่อ fixture ที่กำหนดไว้ ไม่มี action ID, URL, token, header, body หรือข้อความ error ใน `diagnostics.json`. มี4 phases: `action-start`, `handler-entry`, `outbound-result`, `finish`

| Field | ความหมาย |
| --- | --- |
| attempted / skipped | จำนวนครั้งที่ส่ง หรือไม่ได้ส่งเพราะ capture ขาดไปแล้ว |
| status | HTTP status ของ collector; null เมื่อยังไม่ได้รับ status |
| bodyRead | จำนวนครั้งที่อ่านและ decode JSON สำเร็จ ไม่ยืนยันว่าไม่มี partial bytes เมื่อเป็น0 |
| settled | จำนวน attempt ที่จบ; แยกจากยังรอผล |
| elapsedMs | เวลาของ attempt ที่จบ ปัดเป็นจำนวนเต็ม |
| failure | none / timeout / network / http-status / body / unknown |

Parser รับเฉพาะ prefix `FlowAtlas independent metadata: ` จำกัด8192bytesต่อframe และ100ordinals; ตัด extra fields และเก็บ invalid/overflow counters. `browserStartBodiesSettled` หมายถึง response JSON ของ browser action-start เท่านั้น; child collector attempts มี settled ในแต่ละ phase แยกกัน

Browser QA ตรวจ status/body จริง กราฟ/sourceเดิม และเก็บ start-complete กับ business telemetry header เป็นคนละค่า. เมื่อ assertion ล้มเหลว จะเขียน diagnostics พร้อม storage timing/error vocabulary, partial graph readback และ owned cleanup แล้วโยน error เดิมต่อ. Readback timeout1s เป็นขอบเขตงานตรวจ ไม่ขยาย telemetry timeout. `result.json` มี complete:true และเขียนเมื่อ phase/graph/source/cleanup ผ่านครบเท่านั้น

Negative guard ควบคุม collector ของ fixture ให้ปฏิเสธ503 ที่ action-start ครั้งแรก หรือ outbound-result ครั้งที่สอง หลัง view-message ผ่าน เพื่อทดสอบลำดับเดียวกับ send-message failureที่เคยเห็น. Inner browser testต้องfailedด้วยassertionเดิม, business200/bodyเดิม, รายงานต้องระบุ phaseและปิดprocess/collector/browser/lockครบ. Guard watchdog70s/outer75s รองรับ browser test60sและboundedteardown ไม่ใช่การเพิ่มdeadlineของแอป

HTTP202ตาม collector ปัจจุบันเกิดหลัง ingest/store commit สำเร็จ ส่วน timeout หรือ bodyอ่านไม่สำเร็จยังไม่พิสูจน์ว่า collectorไม่ได้บันทึก. Controlled503เป็นผลจำลอง ไม่ใช่สาเหตุที่ยืนยันของ historical CI หรือ19-span loss. Diagnostics นี้ไม่รับรอง performance, pilot หรือrelease

ผลที่ตรวจ: focused20/20; normalEdge1/1; controlledguard2/2พร้อมinnerfailedทั้งสอง; isolatedsource1/1. Maindefault2workers155/161failed6 และresourceexperimentworker1 164/165failedCLI SDK readinessหนึ่งรายการ จึงส่งงานเป็นDraft PR และเปิดstartup causeต่อ

ผู้ใช้กำหนด Sol (`gpt-6-sol`) ควบคุมการคิด/วางแผน/review และ Luna (`gpt-6-luna`) ช่วยตรวจหลักฐานและเขียนpureparser/tests. Rootประสานการแก้ไฟล์/รันchecks/ส่งPR; ไม่อ้างว่าเปลี่ยนmodelแชตหลัก. Solเคยถึงusage limitแล้วกลับมาreviewต่อเมื่อบัญชีใช้งานได้
