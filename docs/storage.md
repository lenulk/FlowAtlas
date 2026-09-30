# การเก็บผลในเครื่อง

## การใช้งาน

`node src/server.mjs` เก็บ metadata ของ 100 actions ล่าสุดใน `data/actions/state.json` ภายในโครงการ เมื่อเปิดใหม่จะโหลดกราฟเดิมรวม evidence IDs, timestamps, uncertainty และ codeVersion ที่ capture ไว้ `running` หมายถึงยังไม่มีผลสุดท้ายที่บันทึกได้ จึงอาจเป็น capture ที่ขาดหลัง process หยุด ไม่ถือว่า success/error โดยอัตโนมัติ

เปลี่ยนที่เก็บด้วย `FLOWATLAS_DATA_DIR` (relative หรือ absolute ภายในโครงการ และอยู่นอก src/public/examples/Git/config directories) ใช้ `FLOWATLAS_MEMORY_ONLY=1` หากต้องการโหมดชั่วคราว `startServers()` ที่ import ใน tests ใช้ memory โดยปริยาย; ระบุ `dataDir` เพื่อเปิด disk mode

UI และ `/flowatlas/status` แสดง mode ตามจริง ค่า query ของ `/flowatlas/actions` ได้แก่ `q` (ค้นชื่อ/ID, สูงสุด 200 ตัวอักษร), `outcome` (running/success/error), `limit` (1–100) filter เกิดก่อนจำกัดจำนวนและเรียงใหม่ไปเก่า JSON graph ยังใช้ schemaVersion 0.1; storage ใช้ storageVersion 1

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

1. หยุด collector ให้เรียบร้อยก่อนสำรองทั้ง directory ที่เก็บข้อมูล เก็บสำเนาในโครงการและรักษาข้อมูลต้นฉบับ การ copy ขณะ collector เขียน/OneDrive sync ยังไม่อยู่ในเกณฑ์ที่ทดสอบ
2. ถ้า startup แจ้งไฟล์เสีย ให้เก็บ `state.json` และรายงาน error ไว้ก่อน ตรวจหรือคืนไฟล์จาก backup ที่เชื่อถือได้ ไม่เขียนทับเพื่อให้โปรแกรมเปิดได้อย่างเดียว
3. ถ้าแจ้ง locked ให้ดู `.writer.lock` เพื่อระบุ PID/host ตรวจว่ามี collector ตัวนั้นทำงานหรือไม่ ถ้ามี ให้ปิดตัวนั้นอย่างถูกต้อง
4. หากยืนยันว่า process เจ้าของหยุดแล้วและไม่มี collector บนเครื่องอื่นเขียน directory นี้ ให้สำรอง directory แล้วนำเฉพาะ `.writer.lock` ที่ค้างออก จากนั้นเปิดใหม่ ไม่ลบ state.json
5. เมื่อเปิดใหม่ ตรวจ `/flowatlas/status`, จำนวนรายการ และกราฟที่รู้คำตอบ อย่าสรุปว่ากู้คืนสำเร็จจากการ startup ได้เพียงอย่างเดียว

ไฟล์ใต้ data/ และ reports/storage/ ไม่ถูกใส่ Git โดยปริยาย เนื่องจากอาจมีชื่อบริการ/URL ภายในและเป็นข้อมูลของการทดลองนี้

## ข้อจำกัด

ยังไม่ทดสอบไฟดับ, disk เต็มจริง, บังคับ kill ระหว่าง rename, lock recovery แบบอัตโนมัติ หรือ OneDrive บนหลายเครื่อง การเขียนเป็น synchronous และ serialize state ทั้งชุดจึงต้องวัด overhead ก่อนเพิ่มโหลด production ไม่มีการเข้ารหัสหรือ authentication เพิ่มจาก filesystem ของเครื่อง และยังไม่มี archive ระยะยาว/schema migration
