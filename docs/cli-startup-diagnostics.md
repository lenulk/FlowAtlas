# หลักฐานเมื่อ CLI fixture เริ่มไม่สำเร็จ

รอบ68 / 6 ตุลาคม 2026 เพิ่มข้อมูลวินิจฉัยใน `test/cli-owner.test.mjs` เท่านั้น ไม่เปลี่ยน production CLI, SDK, collector หรือ readiness timeout 12 วินาที

เมื่อ readiness ล้มเหลว TAP จะแสดง `Owner startup state:` ตามด้วย JSON: `spawned`, `exited`, `closed`, `collectorReported`, `targetReported`, `stdoutBytes`, `stderrBytes`, `errorCode`, `exitCode`, `signal`, `elapsedMs`, `writerLockExists` แล้วโยน error เดิมต่อ หาก reporter ล้มเหลวก็ยังรักษา error เดิม

Reported หมายถึงพบข้อความ readiness ทาง stdout ไม่ใช่ผลเชื่อมต่อพอร์ตหรือหลักฐานว่าบริการยังอยู่ stderr ตั้งค่า readiness ไม่ได้ `writerLockExists=null` หมายถึงตรวจไม่ได้ ไม่ใช่ lock ถูกลบ `closed=false` หมายถึงยังไม่เห็น close ณเวลารายงาน ไม่ใช่ยืนยันว่ามีโปรเซสค้าง

Observer เก็บ tail ส่วนตัว128ตัวอักษรเพื่อรับข้อความแบ่งข้าม pipe chunks และนับ bytes ไม่รายงาน output ดิบ URL/พอร์ต พาธ PID token หรือข้อความ error รับ error/signal เฉพาะรายการคงที่หรือ OTHER ถอด listeners หลัง readiness สำเร็จหรือล้มเหลว ไม่มี timer, IPC, การฆ่าโปรเซส หรือการลบ workspace เพิ่ม cleanup/retention เดิมไม่เปลี่ยน

รัน `node scripts/run-tests.mjs test/cli-owner-startup-diagnostics.test.mjs test/cli-owner.test.mjs` หรือ main regression กรณีควบคุมใช้ Node child ที่ออกด้วย code23 ไม่มี readiness และ stderr จำลองมี token ต้องรักษา error เดิมพร้อมข้อมูลตัวเลขและไม่เปิดเผย token อีกกรณีให้ reporter throw แล้ว error เดิมยังต้องอยู่

นี่เป็นหลักฐานสำหรับ failure ครั้งต่อไป ไม่ใช่การทำซ้ำหรือแก้ root cause ของ timeout รอบ66 (`2026-10-05T20-05-18-750Z`, retained `reports/storage/cli-owner-bWOl5s`) ผลผ่านครั้งใหม่ไม่ปิด failure เดิม ถ้ายังแยก storage / SDK / target startup ไม่ได้ ต้องทำการทดลองเพิ่มก่อนแก้ ไม่เดา PID/ลบ stale lock/ขยาย timeout เพื่อให้ผ่าน
