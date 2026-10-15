# งบเวลา Git metadata ร่วมระหว่างเริ่มระบบ

รอบ87 เพิ่มงบเวลาและ timeout ให้การอ่าน Git metadata ในช่วงก่อน collector เปิด storage โดยแยกข้อมูลเสริมจาก Git ออกจาก file digest ที่ระบุ bytes ของโค้ดจริง

`createGitMetadataBudget()` มีงบ1,000ms เริ่มเมื่อเรียก Git ครั้งแรก และใช้ absolute deadline เดียวตลอด `startServers`: ทั้งรุ่น collector และ registered projects สูงสุด16โครงการใช้ object เดียวกัน ทุกคำสั่งได้เฉพาะเวลาที่เหลือ ตรวจหมดเวลาก่อนและหลังคำสั่ง ไม่เริ่มงบใหม่รายคำสั่งหรือรายโครงการ Public synchronous APIs เดิมยังใช้ได้; direct getCodeVersion/captureProjectVersion/ProjectSources แต่ละการเรียกมีงบของตนเองเมื่อผู้เรียกไม่ได้ส่ง object ร่วม

เมื่อ Git ล้มเหลว หมดเวลา หรือพบว่า root เป็นคนละ repository ให้ commit และ dirty เป็น null พร้อมกันสำหรับ snapshot นั้น ไม่คืน commit ที่สำเร็จเพียงบางส่วน และไม่อ้างว่าเป็น clean working tree การ hash ไฟล์ ตรวจ path และสร้าง snapshot ยังทำใหม่ทุกครั้ง ไม่ข้าม validation หรือใช้ digest เก่า ดังนั้น snapshot จากคนละ invocation อาจมี Git metadata ต่างกันบนเครื่องช้า แม้ file digest จะเท่ากัน

Helper อยู่ใน `src/project-sources.mjs` ซึ่งเป็น adapter module ที่คัดลอกอยู่แล้ว เพื่อรักษา adapter boundary เดิม node-adapter/project-sources ไม่เพิ่ม dependency ที่แอปเก่าขาด First focused11/12 จับ integration regression จาก helper ที่แยกไฟล์ใหม่; แก้ architecture และตรวจ external repository จริงผ่าน โดยไม่แก้ fixture ให้ซ่อน dependency

แก้ assertion ของ CLI ownership ให้ตรวจ21 phases เต็มด้วย รอบ86 ตกหล่น expectation เก่า7 phases ทำให้ CI ล้ม6 cases ต่อช่องทั้ง4ช่องหลัง readiness/shutdown ผ่านแล้ว Source-matched audit4artifacts/136reports/118hashes แยกสาเหตุนี้จาก local startup latency และ native process exits อย่างชัดเจน ไม่กรอง event หรือลด assertion

การตรวจปัจจุบัน: focused12/12, actual CLI9/9, controlled original target deadline guard1/1 และ main203/203ผ่าน default2workers/skip0 Source check แยกอยู่ใน TEST-RUNS ผลผ่านครั้งนี้ไม่พิสูจน์ว่ารหัส Windows3221226505 ในอดีตมีสาเหตุเดียวกันหรือถูกแก้แล้ว

Real-child controls ใช้ owned Node child จำลอง Git ที่หน่วงและให้ native execFileSync timeout/kill ทำงานจริง ทดสอบหน่วงคำสั่ง1/2/3 พร้อม16โครงการ: 17 snapshots เป็น unknown metadata โดย atomic, จำนวน Git attempts1/2/3ไม่เพิ่มรายโครงการ, childหยุด/lockคืน และโปรเจกต์ที่16ซึ่งเปลี่ยนหลัง baseline ถูก hash ใหม่ Healthy controlมี51calls/metadataครบ Local controlled startupที่วัดได้1,140/1,141/1,124ms เทียบ healthy129ms ไม่ใช่ physical Git speed หรือ hard bound ของ OS/process creation บน Windows

ไม่เปลี่ยน target10s/wrapper12s, export shutdown900ms/upload1000ms, buffer/batch/slot, retry หรือเกณฑ์performance≤10% การสร้าง process/การจบ process และ file I/O ยังอาจเกินเวลาที่วัดใน fixture ได้ ต้องตรวจ hosted artifacts บนรุ่นโค้ดที่ตรงกันก่อนขยายข้อสรุป มี Git metadata เป็น unknown ได้เพื่อรักษา startup; ไม่ถือว่าไม่มี Git หรือโค้ดไม่เปลี่ยน

Rollback คือย้อน source budget/wiring และ adapter byte version ผ่านกลไก update/rollback เดิม ไม่มีการเปลี่ยน storage schema หรือ migration; จะกลับมามีความเสี่ยงการรอ Git เดิม Performance/slowdisk delivery/real business pilot/usertrial/release ยังต้องตรวจตามเกณฑ์เดิม

Ordinary HTTP assessmentบนsourceนี้: runner06-26-51-915Zผ่านการวัด/capture แต่performanceFAILED+276.977% (p95baseline3.592ms/traced13.541ms/เกณฑ์10%). Sourcecheck06-26-51-150Z1/1ผ่านและ120programhashesตรงfocused/main/current. ไม่ใช้ผลstartuprepairรับรองrequestoverhead

