# ส่งต่องาน FlowAtlas

ตรวจสถานะสำหรับส่งต่องานวันที่ 5 ตุลาคม 2026 เอกสารนี้เป็นจุดเริ่มอ่านงานต่อ ต้องตรวจโค้ด Git และผล CI ปัจจุบันอีกครั้งก่อนเปลี่ยนไฟล์

## เป้าหมายของเจ้าของโปรเจกต์

พัฒนา FlowAtlas จนใช้งานได้จริง เป็นเครื่องมือที่เรียกใช้เพื่อเห็นการทำงานของแอปและความสัมพันธ์ระหว่างส่วนต่าง ๆ พร้อมหลักฐานและรุ่นโค้ด แยก observed / inferred / unknown ให้ชัด ปัจจุบันมี CLI และ viewer ในเครื่อง พร้อม Node HTTP/Undici tracing และ browser/Node adapter เป้าหมายยังต้องผ่านเกณฑ์ใน [PLAN.md](../PLAN.md) ไม่ลดเกณฑ์เพื่อให้ต้นแบบดูเสร็จ

Repository: https://github.com/lenulk/FlowAtlas; branch หลัก `master` ไม่จำเป็นต้องใช้พาธของเครื่องเดิมบนเครื่องใหม่ อ่าน [AGENTS.md](../AGENTS.md), [PLAN.md](../PLAN.md), [QUALITY.md](QUALITY.md), [TEST-RUNS.md](TEST-RUNS.md), [install.md](install.md), [linux-vm.md](linux-vm.md) ก่อนเริ่ม

## สถานะที่ตรวจแล้ว

**สถานะปัจจุบันบนbranchของงานต่อ:** [PR#6](https://github.com/lenulk/FlowAtlas/pull/6) `diag/trace-cost-isolation`, โค้ดceddc0f; PR CI37339435370ผ่าน2/4เพราะsimulated disk burstชนshutdown900msในLinuxทั้งสอง, push37339368441ผ่าน4/4แต่ไม่ปิดfailure. Main134ทุกช่อง/79filesตรงGit/104runnerreportsauditครบ. ดูQUALITYรอบ64สำหรับfsync915/944/860msและackloss635/891/795. PR#1–#6ยังOPENstacked ไม่merge/forcepush; เอกสารบันทึกหลังceddc0fไม่เปลี่ยนโค้ดที่auditแล้ว. รอบ65เริ่มcontrolled slow-fsync regression+ADRdurable drainก่อนrepairหนึ่งประเด็น; SDK-onlycostยังต้องวัดแยก. Performance/sustained/pilot/users/releaseยังไม่ผ่าน. ย่อหน้ารอบ58ด้านล่างเป็นประวัติฐาน ไม่ใช่รุ่นล่าสุดของbranchนี้.

- Functional code ล่าสุดที่ส่งขึ้น GitHub: `4ab1c61d6f5d2267a3c9ad37ff6830797988147d` รอบ 58 แก้เส้นแผนที่ไม่ให้พาดผ่านกล่องอื่น เพิ่มหัวลูกศร/title และระบุว่าตำแหน่งกล่องไม่ใช่เวลา ยังเรียงกล่องเป็นแถวเดิม เส้นต่าง edge ยังตัดกันหรือมีช่วงร่วมกันใน gutter ได้ ไม่ใช่ layered graph ที่เสร็จแล้ว
- ตรวจ GitHub API วันที่ส่งต่องาน: [run 36910555723](https://github.com/lenulk/FlowAtlas/actions/runs/36910555723) ของ SHA นี้ completed/success ทั้ง 4 jobs: Windows 2025 และ Ubuntu 24.04 กับ Node 22.23.3 / 24.21.0 ไม่มี failed step ผลนี้ไม่ได้รับรอง performance; ยังไม่ได้อ่าน benchmark artifacts ของ run นี้
- รุ่นก่อน `0e49f48` ผ่าน CI 4/4 และ main118/118 ทุกช่อง รวม browser/offline package/reinstall; Linux VM main118/source1/SDK+Chromium2/load1 ผ่าน Capture fixture3153 spans acknowledged ไม่มี drops แต่ p95 overhead ไม่ผ่าน: VM +199.569%; CI Windows22 +229.851%, Windows24 +224.212%, Ubuntu22 +161.766%, Ubuntu24 +144.292%
- รอบ 58 บน Windows: source1/1, browser journeys2/2, actual SDK+Edge2/2 ผ่าน บน Linux VM สำเนา exact4ab1c61: source1/1, actual SDK+Chromium2/2, browser journeys2/2 ผ่าน มี geometry checks สำหรับ HTTP fan-out จริง และ viewer fixture จำลอง cycle/self-edge/disconnected/200edges แยกหลักฐานสองประเภทนี้เสมอ
- Linux round58 source inventory71ไฟล์ตรง Git; Windows70 program files ตรง Git และ package.json ต่างเฉพาะ newline ซึ่งตรวจ JSON/LF equivalence แล้ว raw digest จึงต่างกัน ดู linux-vm.md
- Raw TAP/JSON/screenshots/archives อยู่ใน `reports/` ที่ Git ignore เครื่องใหม่จะไม่ได้ไฟล์เหล่านี้จาก clone ให้สร้างหลักฐานใหม่หรือขอเจ้าของส่งไฟล์เมื่อจำเป็น ห้ามอ้างว่าอ่าน raw artifact แล้วจากบันทึกอย่างเดียว

## งานค้างแรก: รอบ 59 / FA-15

### งานรับช่วงรอบ64 — collector cost isolation

Branch `diag/trace-cost-isolation` ต่อจาก6bac098/PR5 สำหรับstackedPR base perf/span-validation-json. เพิ่ม [component diagnostic](collector-cost.md) และ503negativeguardเป็นQA-only: productionexporterคนละprocessกับcontrolledsink/memory/diskcollector, 3rotatedrounds×1051simulatedspans, disk100graphsexactstore-reopen. Defaultapp/SDK/sourcecode/policyไม่เปลี่ยน; CIเพิ่ม2gatesเป็น13reportsต่อช่อง

Finallocalcomponent1/1และnegativeguard1/1ผ่าน, coremain134ผ่านก่อนfinalQAmetadata-only/envsanitationpatch; ต้องตรวจexacthostedrevisionต่อ. SHAผูกdiagnosticscript/generatedfixtureแยกจากcoresource; privateIPCtokenไม่เข้ารายงาน Faultinnerยังfailed/rejected1051/workspaceretainedและother8conditionscomplete ไม่ใช้passingguardแทนcaptureacceptance. Met=null/component_diagnosticทั้งnormal/fault, SDKcreation/applicationp95ไม่ถูกวัดและห้ามsubtractcrossworkloads. ระหว่างfixturedevelopmentมีค่าจับเวลาเปลี่ยน ไม่claimcausalproductionimprovement

รอบ65ปรับpriorityจากexactCI: simulateddiskdeadlinefailuresมีsyncเป็นช่วงใหญ่ของsave; ทำcontrolled slow-fsync reproductionและADRdurable drainก่อนเลือกระหว่างstorage/drainrepair ไม่ขยายdeadlineหรือลดfsync. NodeSDK-onlycostยังค้างแยก; ถ้าเปลี่ยนbackendต้องADRatomicity/ackหลังfsync/crash/corruption/bounds/migration/rollback. Prior827shutdownlossยังไม่พิสูจน์samecause; performance/sustained/pilot/usertrial/releaseยังเปิด ผู้ใช้ยังไม่มีแอปธุรกิจ/ผู้ทดลอง

### งานรับช่วงรอบ63 — span validation JSON

**โค้ดล่าสุดที่ตรวจแล้ว:**5c6172a [PR#5](https://github.com/lenulk/FlowAtlas/pull/5), stackedbase `diag/shutdown-timing`/PR4. ExactPR37334972757/push37334881014ผ่าน4/4ทั้งสอง; artifactaudit88reports/77filesตรงGit, main134ทุกช่อง/11gatesต่อช่อง, normal+diagnosticcapture3153ack0drops, originalassertionreportครบ. OrdinaryperformanceFAILEDทุกช่อง(71.669–252.867% across bothruns), diagnosticmet=null; ดูQUALITY. Docscommitถัดจาก5c6172aไม่เปลี่ยนprogramsourceนี้ PR1–5ยังOPENไม่merge

Branch `perf/span-validation-json` ต่อจาก3ebc2b5, stackedbase `diag/shutdown-timing`/PR4. เก็บcleanJSONภายในvalidateGraph callเดิมเพื่อเทียบnode แทนserializecleanobjectซ้ำ ลด4→3calls/span แต่ยังserializetraceinput/nodeinputแยกทุกครั้ง และทุกvalidationอ่านข้อมูลใหม่ ไม่มีcacheข้ามcall/readonlyAPI/backend/schema/durabilitypolicyเปลี่ยน

Before8/9จากserializationcountregression; afterfocused28/28, diagnosticsเทียบGit3ebc2b5+isolatedcost2/2, main134/source1/SDK+Edge+failure3/audit1ผ่าน. Isolated1spanmedian10.644→9.996msแต่48spans293.582→304.038ms จึงไม่claimlatencyimprovement. Ordinarybefore/aftercapture3153ack0dropsแต่performanceFAILED568.733%/304.718%; diagnosticmet=null. ExactCIรุ่นใหม่ยังรอ; prior827shutdowndropsยังเปิด

รอบ64แยกSDK-only/transport/memorycollector/durablecollectorcostด้วยdiagnosticsที่labelชัดก่อนเลือกbackend แล้วประเมินdurablejournalเพื่อลดการserialize/เขียนhistoryทั้งชุดต่อbatch เทียบกับJSONsnapshotเดิม: ADRต้องกำหนดackหลังfsync, batchatomicity, crash/torn-write/corruptionrecovery, retention/sizebounds, migration+backup/rollback และbenchmarkworkloadเดิม. Diagnosticconditionsไม่แทนordinaryacceptance/realpilot ไม่เปลี่ยนqueue/deadlineเพื่อให้ผ่าน; ผู้ใช้ยังไม่มีแอปหรือผู้ทดลอง

### งานรับช่วงรอบ62 — วิเคราะห์ shutdown drain

**รุ่นโค้ดที่ตรวจแล้ว:** b554312, [PR#4](https://github.com/lenulk/FlowAtlas/pull/4), stackedbase diagจากPR3 `perf/immutable-snapshot-digest`. PRCI37331499111และpush37331409424ผ่าน4/4ทั้งสอง; audit88reports/77filesตรงGit, main132ทุกช่อง/11gatesต่อช่อง/normalและdiagnosticcapture3153ack0drops. PerformanceยังFAILEDทุกช่อง ดูQUALITY. Docscommitถัดไปไม่เปลี่ยนprogramsourceนี้ PR1–4ยังOPENไม่merge

**สิ่งที่พบ/งานถัดไป:** DiagnosticPRUbuntu24firstpairfsync589.189ms/save684.922ms/shutdown297.307msแต่captureครบ พิสูจน์pauseเฉพาะrunนี้ ยังไม่พิสูจน์causeของ827dropsรุ่นก่อน; เก็บfailedrun37302472603ไว้. รอบ63วัด/ลดvalidationหรือserializationที่ยังทำซ้ำด้วยnegativeevidenceguardsบนworkloadเดิม; หากเลือกdurablejournal/asyncstorageต้องมีADRdurability/crashrecovery/migration/rollbackก่อนimplementation ไม่เลื่อนackก่อนdurablewrite/ไม่ขยาย900msdeadlineเพื่อให้ผ่าน. Performance≤10%,sustained20actions×30นาที,persisted/export/migration,browser→SDK/pilot/usertrial/releaseยังเปิด

Branch `diag/shutdown-timing` ต่อจากcb82561, stackedbase `perf/immutable-snapshot-digest`. เพิ่มopt-in numericdiagnostics exporter/atomicstorage+benchmarkreport/CIgateแยก ตาม [วิธีรัน](benchmark-http.md). Defaultไม่มีtiminglog/clock; diagnosticsไม่เก็บข้อมูลแอปและไม่เปลี่ยนqueue/slots/900msshutdown/1000msupload/fsync/ack. Diagnosticperformance met=null คงordinaryworkload/thresholdเดิม

Localmain132/source1/SDK+Edge+failure3/audit1ผ่านตรงsourceเดียวกัน; normalและdiagnosticloadcapture3153ack0drops แต่normalperformanceFAILED194.036%. Diagnosticshutdown12–17ms/deadlineFired0ไม่reproduceUbuntu22shutdown827 จึงยังไม่ปิดrootcause/stablecapture. ขั้นต่อไปตรวจexactCI11gatesต่อช่องและtimingถ้าfailed; หากยังไม่reproduceให้เลือกcostrepairจากvalidation/serialization/fsyncที่วัดได้และคงfailed827ไว้สำหรับregression ห้ามขยายdeadlineเพื่อกลบปัญหา Pilot/ผู้ทดลอง/performance/sustained/releaseยังเปิด

**อัปเดตรับช่วง 5 ตุลาคม 2026:** [PR #1](https://github.com/lenulk/FlowAtlas/pull/1) branch `fix/fa15-fixture-cleanup`, commit `8b1e270` แก้ teardown gapแล้ว ก่อนแก้ WindowsNode24.19.0/Edge reproduce native3221226505 (`10-23-44-212Z`); หลังแก้ deliberatefaultยังfailedตามตั้งใจแต่ERR_ASSERTION/stackครบและclose/lock/knownportsยืนยัน (`10-25-48-947Z`). Boundary5/normalSDK2/failureharness1/main123ผ่านในเครื่อง; CIรุ่นแรก3749c99พบboundarydisposalcancelledบนNode22ทั้งสองOS แก้refhandleในtestก่อนรอcloseแล้ว [run37298050345](https://github.com/lenulk/FlowAtlas/actions/runs/37298050345) ของ8b1e270ผ่านทั้ง4jobs/ทุกstep ตรวจAPIสดแล้ว ไม่ประกาศว่าสาเหตุภายในNodeหรือnativefaultทุกแบบปิดแล้ว รายละเอียดด้านล่างเป็นสภาพก่อนแก้สำหรับทำซ้ำเทียบ

คำสั่ง regression ที่ติดตามใน Git ใหม่: `node scripts/run-tests.mjs scripts/otel-failure-check.mjs` (กำหนด Playwright package/browser channel ที่มีจริง). Outer test ต้องผ่านเฉพาะเมื่อ inner test ยังคง assertion failureพร้อมรายละเอียดและcleanupครบ Raw inner TAP อยู่ `reports/browser/otel-runtime-fault-*/assertion-fault.tap` และถูกเก็บในCIartifact รอบถัดไปวัดperformanceด้วยworkloadเดิม/วิเคราะห์ต้นทุน ก่อนเลือกrepairหนึ่งประเด็น ผู้ใช้ยืนยันยังไม่มีแอปธุรกิจสำหรับpilot ให้เตรียมฐานต่อก่อน

### งานรับช่วงรอบ 61 บน branch แยก

**ผลที่ตรวจแล้ว:** [PR#3](https://github.com/lenulk/FlowAtlas/pull/3), โค้ด8eff7e2. PushCI37302444123ผ่าน4/4 แต่ PRCI37302472603ผ่าน3/4 Ubuntu22loadpairแรกshutdowndrop827 (224ack); อีก2pairsครบและothergatesผ่าน ไม่มีrootcauseที่พิสูจน์ ไม่ถือว่าcaptureเสถียรจากpushpassingrun. Auditทั้งสองartifactsยืนยัน75filesตรงGitทุก80reports/main127ทุกช่อง/innerfailureครบ; ดูQUALITYสำหรับตัวเลขperformanceที่ยังFAILEDทุกช่อง

PR3stackedbase perf/graph-validation-index; PR1/2/3ยังไม่merge. Commitบันทึกผลถัดจาก8eff7e2เป็นdocumentation-only ไม่เปลี่ยนprogramsourceที่auditแล้ว รอบ62ให้เพิ่มbounded numeric timelineของflush/storageเพื่อแยกqueuewait/write/fsync/ack/shutdowntimeบนworkloadเดิมก่อนเลือกrepair ห้ามใช้passingrerunลบfailed827หรือขยาย900msdeadlineโดยไม่มีADR/หลักฐาน. Pilot/ผู้ทดลองยังไม่มี

Branch `perf/immutable-snapshot-digest` ต่อจาก4b5c2ec สำหรับ stacked PR base `perf/graph-validation-index`. ลด SHA ของ source file hashes ที่ใช้ร่วมกันใน history ด้วย WeakMap เฉพาะ frozen own string data; capture คืน readonly files และทุก save ยังตรวจ graph/path/hash/claimed digest. ดู [ADR](adr-snapshot-digest.md) สำหรับผลกระทบต่อ module callers และ rollback ไม่เปลี่ยน schema/backend/fsync/ack policy

ก่อนแก้ regression1/3 (immutable identity/hash repetition), หลังแก้ focused26/26/main127/127/source1/1/actualSDK+Edge+deliberatefailure3/3 ผ่าน. Local inventory audit11-20-19-776Z ยืนยัน final gates บน source เดียวกันและ archived baseline ตรง4b5c2ec. Before/after load capture3153ack0dropsแต่ performance FAILED +347.753%/+254.808%; traced p95 หลังสูงกว่า จึงไม่อ้าง HTTP improvement. ผล exact CI อยู่ย่อหน้าแรก ไม่รับรอง stable captureจากlocalผ่านเพียงอย่างเดียว

ผู้ใช้ยังไม่มีแอปธุรกิจ/ผู้ทดลอง: pilot protocol เป็นการเตรียมงานเท่านั้น ยังเปิด performance≤10%, sustained20actions×30นาที, persisted completeness/export/migration, browser→SDK/UX/pilot/usertrial/release. ขั้นถัดไปวัดต้นทุน storage/serialization/validation ที่ยังเหลือด้วย workload เดิมและเลือกหนึ่งประเด็นโดยไม่ลดเกณฑ์

### งานรับช่วงรอบ 60 บน branch แยก

**ผลสุดท้ายที่ตรวจแล้ว:** [PR #2](https://github.com/lenulk/FlowAtlas/pull/2), โค้ด `44151a5`, [CIrun37299083948](https://github.com/lenulk/FlowAtlas/actions/runs/37299083948) ผ่าน4/4 Windows2025/Ubuntu24.04×Node22.23.3/24.21.0. ดาวน์โหลดartifactsและaudit `10-57-17-148Z`1/1ผ่าน: main124/124ทุกช่อง, runner10ชุดต่อช่องexit0/failed0/skipped0, inventories74ไฟล์ตรงGit44151a5ทุกชุด, innerdeliberatefaultยังERR_ASSERTIONและcleanupครบ. Capture3153ack0dropsทุกช่อง แต่performanceFAILED: Ubuntu22+71.129%, Ubuntu24+117.530%, Windows22+196.786%, Windows24+303.755% aggregatep95. ไม่ใช้ตัวเลขต่างenvironmentหรือbaselineที่เปลี่ยนอ้างcausalHTTPimprovement

PR#1ยังเปิดbase master; PR#2stackedbase fix/fa15-fixture-cleanup ต้องreview/รวม#1ก่อนretarget#2 ไม่mergeหรือforcepushในรอบนี้ ตรวจfetchแล้วmasterยังตรงorigin/masterที่c9563bd. Commitถัดจาก44151a5ที่บันทึกผลนี้เป็นdocumentation-only; testedprogramsourceยังตรงinventoryเดิม ไม่ใช้docstipที่CIอาจกำลังทำงานรับรองใหม่โดยปริยาย

`perf/graph-validation-index` ต่อจาก8b1e270 เป็นstackedPRให้reviewเฉพาะoptimization หลังรวมPR#1จึงเปลี่ยนbaseเป็นmasterได้ ลดnodeindexที่เคยสร้าง/ค้นซ้ำทุกedgeให้สร้างใหม่ครั้งเดียวต่อvalidateGraph ไม่ใช้mutablecache คงfirst-matchและdiagnosticsเดิม Equivalence/HTTP/storage23ผ่าน, localmain125ผ่าน(core124+ignoreddiagnostic1), SDK+Edge+deliberatefailure3ผ่านบนsourceเดียวกัน; hostedmain124ผ่านทุกช่อง ดูQUALITY/TEST-RUNS. Rawcost/profilesอยู่reports/benchmarksและCIartifactsอยู่reports/releases/ci-*ซึ่งGitignore เครื่องใหม่ต้องสร้างใหม่หรือดาวน์โหลดrunที่อ้างถึงก่อนartifactหมดอายุ14วัน

Performanceในเครื่องยังFAILED: baseline+386.389%, after+479.671% aggregatep95ทั้งสองcaptureครบ3153ack0drops ไม่อ้างHTTPดีขึ้น Isolatedvalidatorcostลดเฉพาะส่วนที่วัดและsyntheticdensegraph ไม่แทนrealpilot. เตรียม [pilot protocol](pilot.md) แล้วแต่ยังไม่มีแอป/ผู้ทดลอง ขั้นถัดไปวัดต้นทุนvalidation/storageที่เหลือโดยแยกworkloadจากstartup ก่อนเลือกrepairหนึ่งประเด็น; sustained20actions×30นาที, persistedcompleteness/export/migration, browser→SDKและUX/realpilotยังเปิด ไม่ลดเกณฑ์หรือเปลี่ยนbackendก่อนมีADR/rollbackที่ตรวจได้

ยังไม่ได้แก้โค้ดรอบ 59 พบ Windows Node v24.18.0 native exit3221226505 เมื่อ browser geometry assertion ล้มเหลว สองรอบแรกเก็บ geometry4crossingsได้ และทดลอง deliberate assertion fault ซ้ำได้เป็นรอบที่สาม (2026-10-01T19-03-31-498Z0/1) การทดลองนี้ตั้งใจให้ assertion ล้มเหลว ไม่ใช่ผล acceptance

`test/otel-runtime.test.mjs` ใน finally ปัจจุบัน forcekill CLI wrapper และรอ `exit` แล้วลบ workspace การ exit ของ wrapper ไม่ยืนยันว่า managed inspector/target ปิดเสร็จหรือปล่อย writer lock เพราะ inspector บน Windows แยกจาก parent job จุดนี้เป็น teardown gap ที่ตรวจจาก source ได้ แต่ยังไม่พิสูจน์สาเหตุภายใน Node ของ native exit

แนวทางตรวจต่อ: reproduce ด้วย test-only assertion driver ก่อนแก้; ขอหยุด fixture ผ่าน `stop\n` ตามปกติ รอ `close` แบบมีเพดาน ตรวจ writer lock และพอร์ตที่ทราบจาก fixture ก่อนลบ ถ้ายืนยัน cleanup ไม่ได้ให้เก็บ workspace ห้ามลบล็อก/ฆ่าโปรเซสจาก PID ที่คาดเดา เกณฑ์ผ่านคือ deliberate fault ยังรายงาน assertion เดิมได้ครบและ cleanup ยืนยันได้ จากนั้นรัน actual SDK CJS/ESM + browser แบบไม่มี fault ให้ผ่าน อย่าอ้างว่า native fault ทุกแบบแก้แล้วจากการเทียบครั้งเดียว

Driver ที่ใช้เป็นไฟล์ QA ในเครื่องเดิมและไม่อยู่ใน Git สร้างใหม่ภายใต้ reports/ ได้ตามนี้ โดยโหลดเฉพาะ test process:

```js
import assert from 'node:assert/strict';
const original = assert.deepEqual;
assert.deepEqual = function (...args) {
  if (args[2] === 'Relationship paths must stay outside all card interiors') {
    return original([1], [], 'FA15 deliberate assertion fault to inspect failed fixture cleanup');
  }
  return Reflect.apply(original, this, args);
};
```

ใช้ runner ของโปรเจกต์ และกำหนด Playwright package / browser channel ที่มีจริงบนเครื่อง ตั้ง `FLOWATLAS_OTEL_BROWSER_CHECK=1` สำหรับ browser gate ตัวอย่าง diagnostic:

```text
node scripts/run-tests.mjs --test-name-pattern=cjs --import ./reports/vm/assertion-fault-driver.mjs test/otel-runtime.test.mjs
```

ผล diagnostic นี้ต้องยังเป็น failed assertion เพราะตั้งใจ inject fault ให้เปรียบเทียบรูปแบบการรายงานและ cleanup ไม่เปลี่ยน expectation ให้ผ่าน

## งานต่อเพื่อใช้งานจริง

1. ประสิทธิภาพ/ต้นทุนการบันทึกและ sustained capture: ยังไม่ผ่าน acceptance, acknowledgement pause และ Windows filesystem lock owner ยังไม่รู้สาเหตุ ห้ามเพิ่ม timeout/queue/retry หรือเปลี่ยน workload/threshold เพื่อกลบผล ต้องบันทึก policy change พร้อม tradeoff หากมีเหตุผลและหลักฐานใหม่
2. Browser→SDK correlation, route/source mapping, existing SDK/attach/startup/TypeScript ต้องตรวจตาม integration ที่จะประกาศรองรับ HTTP spans อย่างเดียวไม่ยืนยัน user click หรือฟังก์ชันภายใน
3. Persisted completeness, export/history/schema migration/recovery และ FA-10 layered layout/filter/keyboard navigation ยังเปิด
4. ไม่มีแอปธุรกิจจริงของเจ้าของให้ลอง และไม่มี user trial ต้องเตรียม pilot และขอข้อมูลเมื่อถึงขั้นที่ต้องใช้แอป/ผู้ทดลองจริง ห้ามใช้ fixture แทน real-app/user-value gate
5. Release/license/support/upgrade/rollback ตาม PLAN ยังไม่ครบ จึงยังไม่ใช่ v1 หรือ production-ready

## วิธีทำงานร่วมกันผ่าน GitHub

- ตรวจสถานะและ pull ก่อนเริ่มแต่ละรอบ รักษางานค้างของผู้อื่น ใช้ branch ของตัวเองเมื่อทำพร้อมอีกเครื่อง และส่ง PR เพื่อรวมเข้า master
- ทดสอบด้วย `node scripts/run-tests.mjs ...` เท่านั้น ตั้งชื่อ purpose ของแต่ละรอบ บันทึก failure และวิเคราะห์ใน QUALITY.md แก้ทีละประเด็น ตรวจ source-check แยกจาก snapshot tests ตาม AGENTS.md
- เก็บไฟล์ของโปรเจกต์ใน checkout และเก็บรายงานใน reports/ ตรวจ diff และทดสอบที่ตรงกับความเสี่ยงก่อน commit/push ไม่ forcepush ไม่ทับงานอีกเครื่อง และไม่ส่งข้อมูลลับลง Git
- รายงานแยก source inspection / simulation / automated fixture / VM / CI / real pilot ไม่ประกาศสมบูรณ์จากเทสต์ผ่านเพียงอย่างเดียว
