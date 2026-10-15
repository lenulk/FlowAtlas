# หลักฐานขั้นตอนเริ่ม CLI

รอบ 80 เพิ่มการสังเกตสำหรับ QA เมื่อ `FLOWATLAS_QA_STARTUP=1` และ CLI เป็นเจ้าของ inspector เท่านั้น ไม่เพิ่ม timeout หรือ retry และไม่เปลี่ยน preload ของแอปที่ตรวจ

Wrapper บันทึกการ spawn inspector และการตอบ owner check; inspector ส่งสถานะ collector start, owner confirmation, target spawn และ readiness ผ่านช่อง IPC ของเจ้าของที่มีอยู่แล้ว แต่ละ record มีเพียง role, phase, elapsedMs, ownerConnected และ childSpawned ตัวอ่านจำกัด 32 records และ 8 KiB ต่อ frame ตัด field อื่นออก ไม่มี PID, URL, token, path หรือข้อมูลแอปใน milestone records

elapsedMs นับจากจุดเริ่มของแต่ละ role จึงห้ามเทียบเป็นนาฬิกากลาง ลำดับ stdout ของ wrapper และ IPC อาจสลับกัน ตรวจลำดับภายใน inspector แยกต่างหาก การไม่มี milestone ถัดไปบอกได้เพียงขั้นสุดท้ายที่สังเกต อาจเกิดจากการค้างหรือส่งข้อมูลไม่สำเร็จ ยังไม่พิสูจน์ตำแหน่งหรือสาเหตุของปัญหา

Owned CLI tests เขียน snapshot เมื่อ assertion ล้มเหลวลง `reports/diagnostics/cli-startup/` แยกจาก runner JSON ใน `reports/tests/` CI อัปโหลดทั้งสอง directory การเก็บ diagnostic ต้องไม่แทนที่ assertion เดิม และไม่ใช้ lock/PID ที่ไม่ยืนยันว่าเป็นของ fixture มาหยุด process

`scripts/cli-startup-phase-failure-check.mjs` สร้าง target จำลองที่รอ 20 วินาทีก่อน listen เพื่อยืนยันว่า deadline เดิม 10 วินาทียังล้มเหลว บันทึกขั้น readiness-failed และยืนยัน wrapper child closed/lock absent ได้ แต่ไม่ทราบ target PID จึงไม่ probe และเก็บ workspace ไว้ นี่เป็น failure control ไม่ใช่การทำซ้ำสาเหตุของ SDK startup failure ในอดีต และไม่รับรอง business pilot

## รอบ86: ช่วงก่อน storage lock

เปิดใช้เฉพาะ QA ผ่านกลไกเดิม เพิ่ม14 fixed milestone names เริ่ม/จบ file hashing, Git metadata, project snapshot, store initialization, writer lock, state load และ listener startup. `onStartupPhase` เป็น synchronous callback แบบเลือกใช้ใน getCodeVersion/startServers/JsonActionStore; exceptionsจากcallbackไม่แทนที่ผลstartup/storage. ไม่มี timeout/retry/cache/metadatafallbackใหม่ และ hash/validatorยังอ่านfreshเหมือนเดิม. Store initializeรวมdirectory resolution/mkdir/lock; store loadแยกหลังlock. Startที่ยังไม่มีfinishบอกlastobservedwindow ไม่พิสูจน์OS/Gitcommandใดเป็นเหตุ

Corrected focused05-54-05-859Z10/10ผ่าน: bounded parser/privacy/exactpackageversion/throwingcallback HTTP201+durablereload+listenfailure lockrelease. Initial9/10เกิดจากfixtureส่งactionnameนอกallowlistจึง400ถูกต้อง; retainไว้และแก้เพียงinputเป็นview-product

Controlledguard05-52-06-229ZFAILED0/1: versionhash4→11ms, Gitmetadata11→9311ms, projectsnapshot9312→13700ms, lock13704→13957ms, collectorready14002ms/targetspawn14019ms. Watchdog24sจบก่อนoriginaltarget10sfailureจะรายงาน; exitCodenull/originalFailureObservedfalse. Report/workspace retained; ไม่อ้างguardpass/cleanupdescendantsครบหรือใช้เพิ่มwatchdog. Exact21-inspector-sequence assertionยังต้องยืนยันในconditionที่guardเดินถึงassertionsนั้น

Finalmain05-54-20-931Z181/192reportedFAILED11/default2workers: nativeabortadapter-update+doctorและreadiness; บางcasesไม่ถึงขั้นรายงานจึงไม่อ้างครบcoverage. Source05-58-04-002Z1/1ผ่าน/118hashesตรง. ActualfailedCLIมีGitmetadata-startedแต่ไม่finishedที่12s/lockfalse; ไม่ผูกทุกfailureหรือnativeexitเป็นเหตุเดียวกัน. Nativeexitยังไม่ทราบcause

งานถัดไปคือsharedabsoluteGitmetadata budget across collector+projectsที่รักษาfiledigestสดและatomicunknownmetadata. ต้องตรวจdelayedrealchildหลายตำแหน่ง/16projectsและข้อจำกัดWindowsspawnก่อนรับรองelapsedbound. Rollbackคือถอดcallbackphase wiring/parser extensions/controls; ไม่มีstorage migration. Performance/businesspilot/usersยังเปิด