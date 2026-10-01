# Session access ในเครื่อง

`flowatlas inspect` และ `node src/server.mjs` เปิด session ที่มี bearer credential 32 random bytes เมื่อเริ่มใหม่ รหัสแสดงเป็น pairing code เฉพาะ interactive terminal; ไม่ใส่ URL หรือ redirected stdout/stderr ผู้ใช้เปิด viewer แล้วใส่รหัสในช่อง pairing ก่อนอ่านข้อมูล

ประวัติ, graph, source, project snapshot, ingest และ demo API ต้องมี `Authorization: Bearer <session credential>` ไม่มี token ใน query/cookie และไม่มี CORS สำหรับเว็บไซต์อื่น ตรวจ Host เป็น loopback + พอร์ตจริง และ Origin ตรง origin ของ request ก่อนอ่าน body หรือเขียนข้อมูล หน้า static และ `/flowatlas/session` เปิดได้เพื่อ pair; endpoint นี้คืนเพียง boolean ไม่คืนรหัส

Viewer เก็บรหัสใน memory ของหน้าเท่านั้น ไม่ใช้ localStorage/sessionStorage/cookie; reload หรือเปิด tab ใหม่ต้อง pair อีกครั้ง ลิงก์ประวัติในหน้าเดิมใช้ session เดิม ปุ่มล็อกล้างข้อมูลที่แสดงในหน้าปัจจุบัน Source/JSON เปิดด้วย authorized fetch แล้วแสดงเป็น text ใน popup ไม่มีรหัสใน URL ของ popup ข้อมูลที่เปิดหรือคัดลอกไว้แล้วไม่ได้ถูกเรียกคืนเมื่อกดล็อก

`inspect` ส่ง credential ให้แอปที่เปิดผ่าน environment `FLOWATLAS_SESSION_TOKEN` ตัว adapter ส่งเฉพาะ ingestion ที่ collector loopback และไม่ตาม redirect; ไม่ส่ง credential ให้บริการธุรกิจปลายทาง แอปยังต้องจัดการ business authentication เอง

## เรียกจากสคริปต์หรือแยกเทอร์มินัล

หาก output ถูก redirect จะไม่แสดง pairing code ให้สร้างรหัสใน memory และใช้ environment เดียวกันกับ collector/target โดยไม่ใส่ literal secret ใน command history หรือไฟล์ ตัวอย่าง PowerShell:

```powershell
$env:FLOWATLAS_SESSION_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
node scripts/cli.mjs inspect --project message-app
# แสดงให้ตนเองเพื่อ pair เฉพาะใน terminal ที่ไม่บันทึก output:
# Write-Host $env:FLOWATLAS_SESSION_TOKEN
```

เมื่อรัน collector และแอปแยกกัน ต้องกำหนดค่า environment เดียวกันทั้งสองเทอร์มินัล และใช้ adapter รุ่นปัจจุบัน หากแอปใช้ adapter เก่าให้ `doctor` ตรวจ mismatch แล้วหยุดแอปก่อนใช้ [adapters update](adapter-update.md) ซึ่งสำรองและอัปเดตเฉพาะ revision ที่รู้จัก ไฟล์ที่แก้เองต้องตรวจ/merge เอง อย่าบันทึกรหัสใน config, reports, Git หรือ screenshots ที่มีช่อง password กำลังกรอก

เลิกใช้ environment override หลังจบรอบด้วย `Remove-Item Env:FLOWATLAS_SESSION_TOKEN`; หากปล่อย override เดิมไว้ รหัสจะถูกใช้ซ้ำเมื่อเริ่มใหม่ Default ที่ไม่กำหนด override สร้างรหัสใหม่ทุก process และรหัสเดิมไม่ใช้กับ session ใหม่

## ขอบเขต

- ป้องกัน HTTP reads/writes จากผู้ที่ไม่มีรหัส และ requests ของ origin/Host ที่ไม่ผ่านเงื่อนไข ไม่พิสูจน์ว่า event มาจากมนุษย์คลิกจริงหรือ symbol ถูกเรียกจริง ผู้ถือรหัสส่งเหตุการณ์ที่ผ่าน schema ได้
- แอปที่เปิดได้รับรหัสใน environment จึงต้องเป็นแอปที่เจ้าของเครื่องเชื่อถือ ไม่ป้องกันโปรเซสอันตรายที่มีสิทธิ์อ่าน environment/ไฟล์ของบัญชีเดียวกัน
- Storage อยู่ภายใต้สิทธิ์ filesystem ของเครื่อง ไม่เข้ารหัส ไม่มีบัญชีผู้ใช้/role separation หรือการแชร์ผ่าน network
- `startServers` เป็น internal fixture/test helper; ค่า `sessionToken: null` ใช้กับ QA ที่ควบคุมได้เท่านั้น Entry points สำหรับผู้ใช้เปิด authorization เสมอ อย่าใช้ helper นี้เปิดบริการให้แอปอื่นโดยไม่กำหนด credential
- Canary tests ตรวจ metadata/graph และ redirected tool output; ยังต้องมี privacy review ของชื่อ action/service/path, export และ OpenTelemetry ก่อน pilot ข้อมูลจริง

ผลทดสอบและ failure logs ดู [QUALITY](QUALITY.md) และ [TEST-RUNS](TEST-RUNS.md)
