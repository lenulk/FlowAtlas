# ติดตั้งและเรียกใช้ FlowAtlas

## จาก source checkout

ใช้ Node ที่ตรวจผ่านตาม [CI](ci.md) ในโฟลเดอร์ FlowAtlas:

```powershell
node scripts/cli.mjs --help
node scripts/cli.mjs demo
node scripts/cli.mjs doctor
node scripts/cli.mjs inspect
```

`demo` สร้าง apps/message-app และ config เมื่อยังไม่มีตัวอย่างนี้เท่านั้น ไม่เขียนทับแอปเดิม หากมีแอปที่ลงทะเบียนอยู่แล้ว ใช้ `doctor --project ID` และ `inspect --project ID` แทน demo ใช้ `--entry` หาก entry ไม่ใช่ server.mjs และ `--config` หากไม่ได้ใช้ flowatlas.config.json

เปิด App URL ที่คำสั่ง inspect แสดง คลิก action แล้วเปิดลิงก์ FlowAtlas เพื่อดูกราฟ/source พิมพ์ `stop` ใน terminal เพื่อปิด target และ collector เมื่อเรียก inspect ใหม่ประวัติจะโหลดจาก data/actions การลงทะเบียนแอปของตนใช้ `register` กับตัวเลือกตาม [Node adapter](node-adapter.md); ยังต้องเพิ่ม instrumentation ตามคู่มือ

## แพ็กเกจสำหรับติดตั้งในโฟลเดอร์ที่เตรียมไว้

ตอนนี้เป็น artifact สำหรับ QA ยังไม่เผยแพร่บน npm registry การสร้างจาก checkout:

```powershell
npm pack --pack-destination reports/releases --cache reports/releases/npm-cache
```

เลือกโฟลเดอร์ติดตั้งว่างภายในโครงการ แล้วติดตั้งไฟล์ tgz ด้วย npm install --prefix โฟลเดอร์นั้น แพ็กเกจมี executable `flowatlas` ใน node_modules/.bin ใช้คำสั่ง demo, doctor, inspect แบบเดียวกับด้านบน เมื่อใช้ package ให้แอป/config/history อยู่ภายใน package root ตามข้อจำกัด source registration ปัจจุบัน; ถ้าต้องการพื้นที่ทำงานถาวร ใช้ source checkout จนกว่าจะมี workspace option และ update/migration ที่ตรวจแล้ว

การอัปเดต package ผ่าน npm อาจแทนที่ directory ของ package จึงต้องหยุดเครื่องมือและสำรอง apps/config/data ก่อน ไม่อ้างว่า npm update รักษาข้อมูลได้แล้ว ดู [storage recovery](storage.md) ยังต้องเลือก license และผ่าน release gates ก่อนเผยแพร่รุ่นทั่วไป

`doctor` ตรวจ runtime, config/source allowlist, syntax ของ entry, adapter versions, storage parent/lock และพอร์ต loopback มี `--json` และ exit 1 เมื่อพบปัญหา ไม่เริ่มแอปหรือสร้างข้อมูล การตรวจผ่านไม่ได้ยืนยัน business instrumentation/imports/dependencies/startup และพอร์ตอาจเปลี่ยนหลังตรวจ ต้องใช้ running integration check ด้วย
