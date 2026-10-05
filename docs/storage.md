# การเก็บผลในเครื่อง

## การใช้งาน

`node src/server.mjs` เก็บ metadata ของ 100 actions ล่าสุดใน `data/actions/state.json` ภายในโครงการ เมื่อเปิดใหม่จะโหลดกราฟเดิมรวม evidence IDs, timestamps, uncertainty และ codeVersion ที่ capture ไว้ `running` หมายถึงยังไม่มีผลสุดท้ายที่บันทึกได้ จึงอาจเป็น capture ที่ขาดหลัง process หยุด ไม่ถือว่า success/error โดยอัตโนมัติ

เปลี่ยนที่เก็บด้วย `FLOWATLAS_DATA_DIR` (relative หรือ absolute ภายใน workspace และอยู่นอก src/public/examples/Git/config directories; ไม่ผ่าน symlink/junction) ใช้ `FLOWATLAS_MEMORY_ONLY=1` หากต้องการโหมดชั่วคราว `startServers()` ที่ import ใน tests ใช้ memory โดยปริยาย; ระบุ `dataDir` เพื่อเปิด disk mode และ `workspace` เพื่อเลือก root ของแอป/config/history ต่างจาก tool installation ค่า default เป็นโฟลเดอร์เครื่องมือหรือ FLOWATLAS_WORKSPACE_ROOT

UI และ `/flowatlas/status` แสดง mode ตามจริง ค่า query ของ `/flowatlas/actions` ได้แก่ `q` (ค้นชื่อ/ID, สูงสุด 200 ตัวอักษร), `outcome` (running/success/error), `limit` (1–100) filter เกิดก่อนจำกัดจำนวนและเรียงใหม่ไปเก่า JSON explicit graph ใช้ schemaVersion 0.1 และ normalized HTTP trace ใช้ 0.2; reader รับทั้งสองโดยไม่ rewrite ข้อมูลเก่า storage ใช้ storageVersion 1 Tool รุ่นเก่าอาจปฏิเสธ 0.2 ต้องสำรอง workspace ก่อน rollback ดู [HTTP tracing](otel-http.md)

## หลักประกันที่ตรวจแล้ว

- สร้าง/แก้กราฟบน state ที่จะ commit ก่อน เขียนไฟล์ชั่วคราว, fsync และ rename จึงตอบรับ หาก disk write ล้มตอบ 503 และ ingestion/action-start ไม่ commit ข้อมูลที่ถูกปฏิเสธ
- retention ของทั้ง memory/disk เปลี่ยนพร้อมกันใน state เดียว จำกัด 100 actions, 100 nodes/200 edges ต่อ action และไฟล์ state 64 MiB
- writer lock ป้องกันสอง collector ใช้ directory เดียวกัน graceful close ปลด lock
- โหลดไฟล์ด้วยการตรวจ schema/กราฟ, source paths/hashes/digest และ duplicate IDs หากเสียจะหยุด startup พร้อมเก็บต้นฉบับไว้
- source ของ action เก่าอ่านไฟล์ปัจจุบันได้เมื่อ hash ตรง snapshot; ไฟล์เปลี่ยน/หายตอบ 409 ไม่มีการเก็บเนื้อไฟล์โค้ดทุกเวอร์ชันไว้ใน state
- action ที่ code digest ต่างจาก runtime ปัจจุบันเปิดอ่านได้ แต่ API/ingest ปฏิเสธการเติมเหตุการณ์ด้วย 409 เพื่อไม่ปะปนรุ่นโค้ด
- registered project เก็บ projectId และ snapshot ของแอปเป้าหมายใน graph เดิม; source resolver ใช้ root/allowlist จาก local config ไม่เชื่อ absolute path ในไฟล์ state เมื่อถอน registration จะอ่านกราฟเก่าได้แต่ source/การเติม event ไม่พร้อมใช้งาน

ทดสอบ restart ทั้ง HTTP server ใน process เดิมและการปิด Node process แล้วเปิด process ใหม่จริง ทดสอบ write failure โดยสร้าง filesystem obstruction ใน directory ทดสอบที่ทิ้งได้ แล้วตรวจว่า state ก่อนหน้าไม่ถูกเปลี่ยนและเขียนต่อได้หลังแก้ obstruction

## การสำรองและ recovery

เมื่อ initialize/load/save ล้มเหลว collector พิมพ์ `FlowAtlas storage:` ตามด้วย JSON ใน stderr ของเครื่อง ประกอบด้วย `code`, `operation`, `stage` และ `causeCode` เช่น `save/rename/EPERM` ใช้เฉพาะค่าที่อนุญาต ไม่บันทึก filesystem path, error message/stack, action/body หรือ credentials; cause ที่ไม่ได้จำแนกแสดง `UNKNOWN` ไม่เพิ่มรายละเอียดนี้ใน HTTP response

ผู้เรียก `startServers({ onStorageError })` ส่ง callback แบบ synchronous เพื่อรับ diagnostic ที่กรองแล้วได้ เช่นเก็บในรายงาน QA ภายในโครงการ หาก callback throw จะยังคงผลคำขอและ cleanup เดิม ไม่มี retry write เพิ่มจาก diagnostics

ผลจาก rename obstruction ที่จำลองบน Windows แสดง `EPERM` และเขียนต่อได้หลังคืนไฟล์ แต่ยังไม่ยืนยันสาเหตุของ recovery 503 ที่เกิดเป็นบางครั้งในรายงานเดิม หากเกิดซ้ำให้เก็บ diagnostic ของคำขอนั้นเทียบขั้นตอน filesystem ก่อนเลือกแก้ ไม่สรุปว่า OneDrive เป็นสาเหตุจากตำแหน่งโฟลเดอร์อย่างเดียว

1. หยุด collector ให้เรียบร้อยก่อนสำรองทั้ง directory ที่เก็บข้อมูล เก็บสำเนาในโครงการและรักษาข้อมูลต้นฉบับ การ copy ขณะ collector เขียน/OneDrive sync ยังไม่อยู่ในเกณฑ์ที่ทดสอบ
2. ถ้า startup แจ้งไฟล์เสีย ให้เก็บ `state.json` และรายงาน error ไว้ก่อน ตรวจหรือคืนไฟล์จาก backup ที่เชื่อถือได้ ไม่เขียนทับเพื่อให้โปรแกรมเปิดได้อย่างเดียว
3. ถ้าแจ้ง locked ให้ดู `.writer.lock` เพื่อระบุ PID/host ตรวจว่ามี collector ตัวนั้นทำงานหรือไม่ ถ้ามี ให้ปิดตัวนั้นอย่างถูกต้อง
4. หากยืนยันว่า process เจ้าของหยุดแล้วและไม่มี collector บนเครื่องอื่นเขียน directory นี้ ให้สำรอง directory แล้วนำเฉพาะ `.writer.lock` ที่ค้างออก จากนั้นเปิดใหม่ ไม่ลบ state.json
5. เมื่อเปิดใหม่ ตรวจ `/flowatlas/status`, จำนวนรายการ และกราฟที่รู้คำตอบ อย่าสรุปว่ากู้คืนสำเร็จจากการ startup ได้เพียงอย่างเดียว

ไฟล์ใต้ data/ และ reports/storage/ ไม่ถูกใส่ Git โดยปริยาย เนื่องจากอาจมีชื่อบริการ/URL ภายในและเป็นข้อมูลของการทดลองนี้

## ข้อจำกัด

รอบ61: รายการfile hashesที่captureใหม่เป็นreadonly เก็บcomputedSHA-256ซ้ำได้เฉพาะfrozenstringdataผ่านWeakMap ส่วนmutable/getter snapshotsและclaimed digestยังตรวจทุกครั้ง ไม่มีgraphvalidationcache/การเปลี่ยนsavedJSONหรือfsync ดู [การตัดสินใจและrollback](adr-snapshot-digest.md) การลดงานSHAไม่หมายถึงperformanceผ่าน

ยังไม่ทดสอบไฟดับ, disk เต็มจริง, บังคับ kill ระหว่าง rename, lock recovery แบบอัตโนมัติ หรือ OneDrive บนหลายเครื่อง การเขียนเป็น synchronous และ serialize state ทั้งชุดจึงต้องวัด overhead ก่อนเพิ่มโหลด production ไม่มีการเข้ารหัสหรือ authentication เพิ่มจาก filesystem ของเครื่อง และยังไม่มี archive ระยะยาว/schema migration

## Bounded Windows replacement recovery

A real save/rename EPERM occurred in the restart regression2026-10-01T13-41-26-268Z. Windows state replacement now retries only EPERM/EACCES/EBUSY, up to5 attempts with nominal5/10/20/40ms pauses (75ms requested total). It reuses the same already-flushed temporary file; validation/write/fsync and business requests are not retried. These synchronous pauses briefly block the collector; actual elapsed time also depends on OS scheduling. Linux and other error codes are attempted once.

If refusal persists, the same503/error cause is retained, the old state/memory remains unchanged and temporary cleanup still runs. Controlled transient-error simulation, actual permanent filesystem obstruction, restart/fresh-process/20concurrent persistence passed21/21 (13-46-31-959Z). Later fullmain storage checks passed, while an unrelated SDK acknowledgement gate failed; do not claim the fullsuite passed. The original lock owner/rootcause and long-term transient recovery are unverified; this is bounded recovery support, not proof that OneDrive or transport stalls are fixed.
