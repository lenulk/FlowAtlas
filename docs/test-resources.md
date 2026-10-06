# ขอบเขต resource ของ automated tests

รอบ73 / 6ตุลาคม2026 `node scripts/run-tests.mjs` ใช้ `--test-concurrency=2` เป็นค่าเริ่มต้นของtest-file workers เพราะแต่ละfixtureอาจบูตCLI/inspector/SDKtargetหลายโปรเซส จำนวนworkerไม่ผูกกับCPUที่hostรายงาน ไม่ใช่การจำกัดจำนวนbusinessactionsหรือspanqueue และไม่รับรองจำนวนOSprocessทั้งหมด

ทุกtest/assertion/timeoutเดิมยังทำงาน ไม่เพิ่ม12sapplicationreadiness/900msshutdown/1000msuploadหรือskiptest. Explicit `--test-concurrency=1` และ `--test-concurrency 1` ส่งผ่านตามเดิมเพื่อทดลองresourcecondition โดยต้องตั้งpurposeให้ชัด Actualargs/sourcehash/environmentเก็บในrunnerJSON

รอบ72default4workersเกิดCLIstartup2failures/stdout0/stderr622/locktrue; ประกาศทดลอง2workersบนsamecodeแล้ว148/148ผ่าน ไม่พิสูจน์SDKinternalrootcauseหรือความทนต่อresourceexhaustion. รอบ73runnerdefault2 main10-28-25-404Z148/148/failed-skipped0 ผ่าน และexplicitสองรูปแบบ10-29-11-346Z/10-29-11-956Z5/5แต่ละชุด. ไม่รันdefault4ซ้ำเพื่อกลบfailureเดิม ไม่ใช้QAworkerpolicyเป็นperformance/pilotgate
