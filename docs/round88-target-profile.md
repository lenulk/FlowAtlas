# รอบ 88: target CPU profile และหลักฐาน startup

วันที่ 15 ตุลาคม 2026 ใช้โค้ดฐาน `3ece8c1` โดย Sol วิเคราะห์และตรวจงาน, Luna ช่วยงานย่อย, Root รันทดสอบและตรวจหลักฐาน เป้าหมายแรกคือดูว่าต้นทุน SDK ใน target เกิดที่ฟังก์ชันใดซ้ำในสามคู่ ก่อนเลือกปรับ production

## ตรวจรุ่นก่อนหน้า

Latest push [38692911967](https://github.com/lenulk/FlowAtlas/actions/runs/38692911967) และ PR [38692916999](https://github.com/lenulk/FlowAtlas/actions/runs/38692916999) สำเร็จทั้งสี่ช่อง ตรวจ raw artifacts ของ PR เทียบ merge `981f60928681d9fb4eee4943a47a050b1f72f2ce` แล้ว: 136 runner reports มี program inventory 120 ไฟล์ตรงทั้งหมด ชุดหลักผ่าน 203/203 ทุกช่อง ไม่มี skip; explicit browser และ installed package gates ผ่านด้วย

Shared Git metadata controls ครบ 16 เงื่อนไข (สี่ต่อช่อง) แต่ละเงื่อนไขตรวจ 17 snapshots; file hashes สดตรงต้นฉบับ, delayed child หยุดแล้ว, lock ปล่อยแล้ว และ workspace ลบหลังตรวจขอบเขตครบ การควบคุมนี้ใช้ Node child จำลอง Git output กับ timeout จริง ไม่พิสูจน์ hard bound ของ Windows process creation หรือปิดสาเหตุ native exit เดิม

Ordinary HTTP capture ครบ แต่ performance **ไม่ผ่านทุกช่อง**: Ubuntu Node22 +91.372%, Ubuntu Node24 +130.380%, Windows Node22 +196.821%, Windows Node24 +187.475% เทียบเกณฑ์ relative 10% เดิม การที่ CI ผ่านไม่ใช่การผ่านเกณฑ์ประสิทธิภาพ ตัว benchmark แยก measurement/capture ออกจาก verdict นี้

Audit ครั้งแรก `13-08-53-956Z` ล้มเพราะสมมติว่า nested runners ต้อง failed=0 ทั้งหมด แก้ audit ให้ตรวจห้าชื่อ negative controls และชื่อ assertion ที่ต้องล้มอย่างเจาะจง พร้อม outer guards เดิม; corrected audit `13-09-21-969Z` ผ่าน 1/1 ไม่แก้ผล CI ต้นฉบับ

## Target profile ที่ยังไม่ครบ

รันผ่าน `node scripts/run-tests.mjs scripts/benchmark-http-trace.mjs` โดยเปิด `FLOWATLAS_BENCHMARK_PROFILE=target` ครั้งเดียว ผล `13-07-37-481Z` **FAILED 0/1**. Artifact `reports/benchmarks/2026-10-15T13-07-38-044Z-ff4e6638-eb0d-417d-86d0-8d5b5f98160c.json` ระบุ sourceDirty=false, diagnosticTiming=false และ sourceCommit=3ece8c1

คู่แรก baseline สำเร็จ แต่ traced ล้ม `inspector_exited_before_ready`; ไม่มี traced CPU profile และไม่มีตัวเลข exit/phase ในรายงานเก่านี้ จึงไม่สรุปว่าเป็น native exit หรือ Git timeout เก็บ workspace `reports/storage/benchmark-http-C1Z1Li` ไว้ แม้ตรวจภายหลังไม่เห็น lock ก็ยังไม่ยืนยัน descendant cleanup และไม่ลบหรือ kill PID ที่ไม่ทราบเจ้าของ

คู่ 2–3 baseline/traced สำเร็จ traced แต่ละคู่ส่งครบ 1,051 spans/drop0 รวมได้ห้า raw profiles จากหกที่คาดไว้ ผลรวม workload/capture ยัง false, completedPairs=2/3 และ performance assessable=false/met=null/reason=profiled_run ห้ามใช้สองคู่ที่เหลือรับรอง performance หรือเปรียบเวลา profiler กับ ordinary run Raw profiles อาจมี filesystem URLs ให้เก็บเฉพาะ ignored reports; เอกสารส่งต่อใช้ตัวเลขและหมวดฟังก์ชันเท่านั้น

## สิ่งที่อ่านได้จากสองคู่ที่ครบ

Partial-profile audit `13-12-11-138Z` ผ่าน 1/1 โดยตรวจ source commit, manifest ห้าไฟล์, node/sample/timeDelta references และเก็บ original failed condition. Summary อยู่ `reports/releases/round88-target-profile-summary.json` ตัวเลขนี้เป็น V8 sampled self-time ตาม timeDelta ไม่ใช่เวลาจริงของทุก call หรือ causal attribution ของ request latency; ไม่รวม inclusive time และตัด idle/program ออกจาก active summary

หมวด OpenTelemetry มี sampled self-time 110,573/110,871 microseconds ใน traced คู่ 2/3; หมวด FlowAtlas SDK 9,074/16,039 microseconds ขณะที่ `node:inspector` มี `post` 53,969/60,437 microseconds จึงเห็น overhead ของเครื่องมือวัดเองด้วย ชื่อที่พบเพิ่มทั้งสองคู่มี `getIncomingRequestAttributes`, `incomingRequest`, `startSpan` และ `parseEvidenceTime` แต่ summary รวมชื่อฟังก์ชันเดียวกันในหมวดเดียวกันจากหลาย module จึงไม่ใช่ symbol identity เฉพาะจุด

ข้อมูลนี้ยังไม่สนับสนุนว่าการลดการแปลง timestamp เพียงจุดเดียวจะแก้ overhead ทั้งหมด ไม่แก้ production normalization โดยเดา และไม่อ้างว่า elapsed time ลดลงจาก profiler run. เปลี่ยนงานหลักของรอบนี้เป็นเติมหลักฐาน startup ให้ benchmark diagnostic ด้วย observer/parser ที่มีอยู่ แล้วตรวจ owned-child failure และความเป็นส่วนตัวก่อนส่ง

## งานที่ยังเปิด

ต้องใช้ startup exit/phase ที่จำกัดข้อมูลแยกเหตุหากเกิดซ้ำ; ไม่ใส่เหตุย้อนหลังใน failed artifact เดิม Performance, slow-disk delivery, sustained loss เดิม, native-exit root cause, pilot กับแอปธุรกิจจริง, ผู้ทดลอง และ release gates ยังไม่ผ่าน ไม่ลดเกณฑ์หรือเพิ่ม deadline/retry/skip

## ผลหลังเพิ่มหลักฐาน

เพิ่ม `scripts/benchmark-startup-evidence.mjs` ประกอบ owner observer และ phase parser เดิม โหมด target profile เท่านั้นเปิด QA startup และเก็บ `atFailure`/`afterCleanupAttempt`; ordinary/collector profile คืน startupEvidence=null และล้าง inherited QA flag. เก็บเฉพาะ schema เดิม ไม่มี raw output หรือ arbitrary error. หาก diagnostic snapshot อ่านไม่ได้ คืน null โดยไม่แทนความผิดพลาดเดิม; null ไม่ใช่หลักฐานว่า startup สำเร็จ

- Focused `13-15-48-446Z`: 18/18 ผ่าน รวม owned Node child exit23, split frame/UTF8, canary privacy, unknown signal เป็น OTHER และถอด listeners ครบ
- Target profile หลังแก้ `13-15-57-039Z`: 1/1 ผ่าน ทั้งสามคู่ตอบถูก/capture3,153/drop0/หก profiles; ทุก condition มี 26 phases (inspector21/wrapper5), invalid/overflow0, CLI closed/exit0/lockfalse และ cleanup ตามเกณฑ์เดิม ไม่ใช่การยืนยันว่า startup failure เก่าหายแล้ว
- Complete-profile audit แรก `13-18-25-288Z` ล้มเพราะ expected schema keys ไม่ได้ sort; แก้เฉพาะ ignored analyzer แล้ว `13-18-45-688Z` ผ่าน 1/1 ตรวจหก condition/source digest/26 phases/exit/lock/cleanup โดยไม่เปลี่ยน report ต้นฉบับ
- Main `13-16-32-035Z`: **FAILED 204/205**, skip0/default2workers. CJS OTel target ออกก่อน ready ด้วย numeric exit3221225794; MJS ผ่าน. รหัสนี้ต่างจาก historical3221226505 แต่ยังไม่รู้สาเหตุ ไม่เชื่อมเหตุเข้ากับ patch QA ที่ไม่ได้เรียกจาก OTel test. Cleanup รายงาน closed/lockRemoved/removed=true แต่ portsClosed=[] เพราะไม่มีพอร์ตถูกรายงาน จึงไม่อ้างว่ารู้สถานะทุก descendant/port. ไม่ rerun main เพื่อกลบผลนี้
- Standalone source `13-17-39-297Z`: 1/1 ผ่าน; inventory audit `13-19-04-785Z`: 1/1 ยืนยัน 122 program files ตรงกับ focused/profile/main/source ทั้งสี่ชุด ไม่มี source/test เปลี่ยนระหว่าง final checks

Full-profile summary แยกเก็บใน `reports/releases/round88-complete-target-profile-summary.json` และยัง met=null. ชื่อ grouped function ที่เพิ่มทั้งสามคู่มี `incomingRequest`, `normalizeSdkHttpSpan`, `startSpan` และ Node/profiler work; normalizeSdkHttpSpan sampled self-time15,630/14,249/7,024 microseconds เป็น candidate สำหรับตรวจ timestamp conversion ด้วย equivalence/cost experiment ในรอบถัดไป ไม่พิสูจน์ว่าลดจุดนี้แล้ว ordinary p95 จะผ่าน และไม่ใช้เวลาจากสอง profiler revisions เทียบเพื่ออ้างความเร็ว
