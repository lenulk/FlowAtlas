# หลักฐานขั้นตอนเริ่ม CLI

รอบ 80 เพิ่มการสังเกตสำหรับ QA เมื่อ `FLOWATLAS_QA_STARTUP=1` และ CLI เป็นเจ้าของ inspector เท่านั้น ไม่เพิ่ม timeout หรือ retry และไม่เปลี่ยน preload ของแอปที่ตรวจ

Wrapper บันทึกการ spawn inspector และการตอบ owner check; inspector ส่งสถานะ collector start, owner confirmation, target spawn และ readiness ผ่านช่อง IPC ของเจ้าของที่มีอยู่แล้ว แต่ละ record มีเพียง role, phase, elapsedMs, ownerConnected และ childSpawned ตัวอ่านจำกัด 20 records และ 8 KiB ต่อ frame ตัด field อื่นออก ไม่มี PID, URL, token, path หรือข้อมูลแอปใน milestone records

elapsedMs นับจากจุดเริ่มของแต่ละ role จึงห้ามเทียบเป็นนาฬิกากลาง ลำดับ stdout ของ wrapper และ IPC อาจสลับกัน ตรวจลำดับภายใน inspector แยกต่างหาก การไม่มี milestone ถัดไปบอกได้เพียงขั้นสุดท้ายที่สังเกต อาจเกิดจากการค้างหรือส่งข้อมูลไม่สำเร็จ ยังไม่พิสูจน์ตำแหน่งหรือสาเหตุของปัญหา

Owned CLI tests เขียน snapshot เมื่อ assertion ล้มเหลวลง `reports/diagnostics/cli-startup/` แยกจาก runner JSON ใน `reports/tests/` CI อัปโหลดทั้งสอง directory การเก็บ diagnostic ต้องไม่แทนที่ assertion เดิม และไม่ใช้ lock/PID ที่ไม่ยืนยันว่าเป็นของ fixture มาหยุด process

`scripts/cli-startup-phase-failure-check.mjs` สร้าง target จำลองที่รอ 20 วินาทีก่อน listen เพื่อยืนยันว่า deadline เดิม 10 วินาทียังล้มเหลว บันทึกขั้น readiness-failed และยืนยัน wrapper child closed/lock absent ได้ แต่ไม่ทราบ target PID จึงไม่ probe และเก็บ workspace ไว้ นี่เป็น failure control ไม่ใช่การทำซ้ำสาเหตุของ SDK startup failure ในอดีต และไม่รับรอง business pilot
