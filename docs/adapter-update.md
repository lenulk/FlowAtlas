# อัปเดต adapter และย้อนกลับ

หยุด inspector/แอปก่อนเปลี่ยน adapter แล้วใช้ workspace และ project เดิม:

```powershell
node scripts/cli.mjs adapters update --project message-app
node scripts/cli.mjs doctor --project message-app
node scripts/cli.mjs inspect --project message-app
```

แพ็กเกจใช้ `flowatlas --workspace PATH adapters update --project ID` คำสั่งคืน JSON พร้อม `changed` และพาธ `backup` ถ้าตรงรุ่นปัจจุบันอยู่แล้วจะไม่เขียนไฟล์หรือสร้าง backup

อัปเดตเฉพาะ `node-adapter.mjs` และ `project-sources.mjs` ที่ลงทะเบียนและมี SHA256 ตรงกับ adapter ของเครื่องมือรุ่นปัจจุบันหรือ revision ใน `src/adapter-history.json` ประวัติ hash สร้างจาก Git revisions ที่ระบุ; ไม่มีการดาวน์โหลดโค้ดตอน update ไฟล์ที่มีการแก้ไขเองจะถูกปฏิเสธ ไม่มี `--force` ต้องตรวจ/merge เองก่อน

Catalog รวม exact fingerprints ของ LF และ CRLF ที่แปลงจาก source revision เดียวกัน เพื่อรองรับ Windows checkout; ไม่ตัด comments/whitespace หรือ normalize bytes ของไฟล์เจ้าของ Backup และ rollback เก็บ bytes และ line endings เดิมครบ

สำรอง adapter ทั้งสองไฟล์และ manifest ไป `reports/adapter-backups/<id>` ใน workspace ก่อนเปลี่ยนไฟล์ ไม่แก้ server/browser code, config หรือข้อมูล actions ใช้ temporary + rename ต่อไฟล์ หากเกิด exception จะตรวจ bytes แล้วพยายามคืนไฟล์เดิม โดยไม่เขียนทับการแก้ไขของเจ้าของที่เกิดขึ้นระหว่างนั้น; เมื่อ recovery ทำไม่ได้ให้หยุดใช้งานและตรวจ backup ที่คำสั่งรายงาน

ย้อนกลับโดยใช้พาธ `backup` จากผล update:

```powershell
node scripts/cli.mjs adapters rollback --project message-app --backup reports/adapter-backups/ID
```

Rollback ตรวจ project/root/hash และ contents ของ backup; ยอมรับเฉพาะไฟล์ปัจจุบันที่ตรงกับ before/after ของการอัปเดตรอบนั้น ถ้ามี owner edit จะปฏิเสธทั้งหมดก่อนเขียน Backup ต้องอยู่ใน directory โดยตรงใต้ adapter-backups และไม่ใช้ symlink/junction หากใช้ config หรือ data directory แยก ระบุ `--config`/`--data-dir` เดียวกับ inspector; lock ใน data directory จะปฏิเสธ update/rollback ไม่ลบ lock ให้เอง

ต้อง restart collector/target หลังเปลี่ยน adapter ประวัติ graph เก่ายังอยู่ แต่ source adapter รุ่นเก่าจะตอบ 409 หากไม่มี snapshot ของรุ่นนั้น ไม่มีการแสดงโค้ดใหม่แทนหลักฐานเก่า Rollback adapter รุ่นที่ไม่รองรับ session bearer ทำให้การ capture กับ collector รุ่นปัจจุบันไม่ครบ; ใช้เพื่อคืนไฟล์ระหว่าง rollback ทั้ง tool และ adapter ไม่ใช่รับรอง compatibility ของทุกคู่รุ่น

ข้อจำกัด: ตรวจ exception/failure simulation และ history preservation แล้ว แต่ยังไม่มี released-version upgrade/migration หรือ power-loss durability test การเปลี่ยนสองไฟล์ไม่ใช่ atomic transaction ของ filesystem หาก process ถูก kill ระหว่างทาง backup ใช้ rollback กับไฟล์ before/after ที่ตรง hash ได้ เก็บ workspace/ข้อมูลสำรองก่อนอัปเดตรุ่น release จริงตาม [storage recovery](storage.md)
