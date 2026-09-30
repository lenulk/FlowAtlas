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

เลือกโฟลเดอร์ติดตั้งว่างภายในโครงการ แล้วติดตั้งไฟล์ tgz ด้วย npm install --prefix โฟลเดอร์นั้น แพ็กเกจมี executable `flowatlas` ใน node_modules/.bin ใช้คำสั่ง demo, doctor, inspect แบบเดียวกับด้านบน สำหรับ package ให้สร้าง workspace ถาวรที่อยู่นอก node_modules แล้วระบุ `flowatlas --workspace PATH demo`, `flowatlas --workspace PATH doctor`, `flowatlas --workspace PATH inspect`; PATH ต้องเป็น directory ที่มีอยู่ ไม่อยู่ใน src/public/examples/Git/config ของเครื่องมือ แอปที่ลงทะเบียน, config และ data/actions จะอยู่ใน workspace นี้ ส่วนตัวเครื่องมือและหน้า viewer อ่านจาก package

การอัปเดต package ผ่าน npm อาจแทนที่ directory ของ package จึงต้องหยุดเครื่องมือและสำรอง apps/config/data ของ workspace ก่อน ใช้ workspace เดิมหลัง install/update/uninstall; doctor ตรวจ adapter version แล้วแจ้ง mismatch โดยไม่ทับไฟล์แอปเอง ดู [storage recovery](storage.md) การเปลี่ยน schema/adapter ระหว่าง release ยังต้องมี migration/rollback ที่ตรวจแล้ว การถอนและติดตั้งรุ่นเดิมซ้ำไม่แทนการพิสูจน์ upgrade ข้ามรุ่น ยังต้องเลือก license และผ่าน release gates ก่อนเผยแพร่รุ่นทั่วไป

หากไม่กำหนด --workspace ค่า default คือโฟลเดอร์เครื่องมือ เพื่อรองรับ source checkout เดิม เมื่อใช้ package ควรกำหนด workspace ทุกครั้ง หรือใช้ environment `FLOWATLAS_WORKSPACE_ROOT` ที่ชี้ไป workspace เดิม ไม่เก็บข้อมูลถาวรใน node_modules

`doctor` ตรวจ runtime, config/source allowlist, syntax ของ entry, adapter versions, storage parent/lock และพอร์ต loopback มี `--json` และ exit 1 เมื่อพบปัญหา ไม่เริ่มแอปหรือสร้างข้อมูล การตรวจผ่านไม่ได้ยืนยัน business instrumentation/imports/dependencies/startup และพอร์ตอาจเปลี่ยนหลังตรวจ ต้องใช้ running integration check ด้วย
