# เตรียม pilot และ user trial

สถานะ 5 ตุลาคม 2026: ผู้ใช้ยืนยันยังไม่มีแอปธุรกิจสำหรับทดลอง เอกสารนี้เป็น protocol เตรียมงาน ไม่มีผล real-app หรือ user trial และไม่ผ่าน R4/R5 จากการมีเอกสารนี้ เกณฑ์หลักอยู่ใน [PLAN.md](../PLAN.md); fixtures, SDK integration และ simulated viewer ใช้เตรียมเครื่องมือได้แต่ไม่แทน pilot

## ข้อมูลที่ต้องมีเมื่อได้แอป

- Repository/commit และสิทธิ์ของเจ้าของสำหรับ development/test, Node/framework/package manager, entry/package script, dependencies และวิธีตั้งค่าโดยใช้ข้อมูลทดสอบ ไม่มี credential ในรายงานหรือ Git
- Business actions อย่างน้อย3แบบที่แอปมีอยู่จริง และเส้นทางที่เจ้าของตรวจจากโค้ด/logsได้ไว้เป็นคำตอบอ้างอิงก่อนเปิด FlowAtlas
- รายการ source allowlist, บริการปลายทาง/origins ที่อนุญาต, ขอบเขตข้อมูลที่จะบันทึกและผู้เข้าถึง ไม่เปิด browser DOM/network artifacts โดยปริยาย
- แผนสำรอง/ถอน instrumentation/rollback โดยตรวจ Git status และสำรอง config/workspace ก่อนเริ่ม ติดตั้งบนสำเนาหรือ test environment ที่อนุญาตเท่านั้น

## Gate ก่อนเริ่มทดลอง

ตรวจ compatibility และทุก gate ที่ประกาศรองรับบน source revision เดียวกัน รวม install/stop/restart/privacy และ capture loss. Performance และ sustained-load ยังไม่ผ่านตามสถานะปัจจุบัน ต้องแก้หรือจัดทำข้อจำกัดที่พิสูจน์ก่อนรับรองรุ่นใช้งานจริง ไม่ใช้ CI สีเขียวแทนค่า overhead

ตรวจ canary token/cookie/body/query/DOM ไม่เข้า default reports และ accepted data คืนได้ตาม durability policy ก่อนใช้ข้อมูลผู้ทดลอง กำหนด baseline/workload/absolute budget กรณี baselineสั้นไว้ก่อนเห็นผล ห้ามเปลี่ยน thresholdเพื่อให้ผ่าน

## Known-answer scenarios

เตรียมอย่างน้อย10กรณีจากแอปที่เลือก: success, business error, upstream error, upstream timeout, slow handler, async fan-out, concurrent actions, missing events, out-of-order events และ duplicate events. Faults ต้องสร้างในtestenvironmentที่อนุญาต; การจำลอง event ให้ระบุ simulation และไม่ใช้ยืนยัน business behavior ของแอปจริง

| สิ่งบันทึกต่อกรณี | รายละเอียด |
| --- | --- |
| ตัวตนการรัน | case ID, วันเวลา/เขตเวลา, app/tool commit+digest, runtime/browser/OS และคำสั่ง |
| คำตอบอ้างอิง | trigger, status/body ที่ควรได้, route/handler/upstream และหลักฐานจากแอปก่อนตรวจด้วยเครื่องมือ |
| ผล FlowAtlas | action/trace/span IDs, observed/inferred/unknown, missing coverage และ code version ที่เปิด source |
| ความถูกต้อง | edge ที่ตรง/ผิด, false observed ต้อง0, สิ่งที่ไม่เห็นหรือยืนยันไม่ได้ |
| ผลธุรกิจ | เทียบ status/body กับ baseline ทั้ง collector unavailable/queue full/storage error; ไม่มี business retryเพิ่ม |
| การเก็บข้อมูล | acknowledged/dropped/pending แยกจาก persisted; ตรวจ graceful restartและrecoveryตามpolicy ไม่ใช้history100แทนtotalcapture |
| ผล/ข้อจำกัด | ผ่าน/ไม่ผ่าน/ยังไม่ตรวจ พร้อมpathหลักฐานที่ผ่านprivacyreview |

## ประสิทธิภาพและโหลด

Baseline/เปิดcaptureใช้workloadเดียวกัน ≥1000requestsต่อแบบ รายงานp95/CPU/RSS/drop rateจริงตามPLAN เป้าหมายเริ่มต้นp95เพิ่ม≤10%; fixture benchmarkปัจจุบันกำหนด5msเมื่อbaseline<1msไว้ล่วงหน้า แต่ต้องตกลงprofileของpilotก่อนใช้gateใหม่ ไม่ใช้profiled/incompletepairsออกperformanceverdict

Sustainedreference:20actionsพร้อมกัน30นาทีตามPLAN รายงานmemory/disk/queue/captureและผลธุรกิจ ทั้งช่วงเริ่ม/ต่อเนื่อง/หยุด ไม่อ้างว่าproductionloadพร้อมจากการผ่านreferenceworkload เก็บผลล้มเหลวทุกครั้งก่อนเลือกrepairประเด็นเดียว

## User trial หลัง pilot พร้อม

ผู้ทดลอง3–5คน ติดตั้งตามคู่มือโดยเก็บเวลาถึงกราฟแรก (เป้า≤15นาทีเมื่อenvironmentพร้อม) แล้วทำ6โจทย์trace/incidentที่ใกล้เคียงกัน สลับลำดับมี/ไม่มีเครื่องมือและชุดโจทย์เพื่อลดlearningeffect ผู้ทดลองไม่เห็นคำตอบอ้างอิงก่อนตอบ

เก็บเวลารายโจทย์ คำตอบ/ความถูกต้องและเหตุผลที่อ้างหลักฐานได้ ความช่วยเหลือที่ได้รับและเคสที่เครื่องมือช่วยไม่ได้ เป้าหมายคำตอบถูก≥80%และไม่แย่กว่าbaselineตามPLAN รายงานรายคนพร้อมกลุ่มเล็ก ไม่สรุปทั่วไป หากตอบผิดจากfalseobservedหรือไม่ช่วยแก้โจทย์ให้แก้productก่อนv1 การนัด/ส่งข้อความหาผู้ทดลองต้องได้รับคำสั่งจากเจ้าของก่อน

## แบบบันทึกที่เริ่มกรอกได้

```text
Evidence kind: real-app pilot / simulation / fixture / user trial
App repository+revision:
Tool revision+source digest:
Runtime/browser/OS:
Approved environment, data and source allowlist:
Install time to first graph:
Cases and independent expected answers:
Observed correctness and coverage gaps:
Business baseline vs capture/outage:
Benchmark workload and budgets fixed before run:
Capture acknowledgement vs persisted accounting:
Restart/recovery/rollback results:
Trial task order, participant pseudonym, answers, correctness and timings:
Failures, limitations and next repair:
Privacy-reviewed evidence paths:
Decision: pass / fail / not yet assessed (state gate scope)
```
