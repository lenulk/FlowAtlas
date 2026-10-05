# แผนพัฒนา FlowAtlas ไปถึงรุ่นใช้งานจริง

ปรับแผนวันที่ 1 ตุลาคม 2026 จากโค้ดฐาน `56346f2` และผลทดสอบใน [TEST-RUNS.md](docs/TEST-RUNS.md) แผนนี้กำหนดงานและเกณฑ์รับรองในอนาคต ตัวเลขเป้าหมายด้านเวลา ประสิทธิภาพ และคุณค่าต่อผู้ใช้ยังเป็นเป้าหมายที่ต้องทดลอง ไม่ใช่ผลที่ทำได้แล้ว

## ผลิตภัณฑ์ที่จะส่งมอบ

FlowAtlas v1 เป็นเครื่องมือในเครื่องสำหรับนักพัฒนาและผู้แก้ปัญหาเว็บแอป Node.js: ติดตั้งตัวเชื่อมในแอปที่ตนดูแล เรียกเครื่องมือเมื่ออยากตรวจการทำงาน กด action บนหน้าเว็บ แล้วดูเส้นทาง browser → API → handler → HTTP/บริการปลายทาง พร้อมหลักฐาน รุ่นโค้ด และช่วงที่ยังไม่เห็นข้อมูล เปิดย้อนหลังและส่งออกผลที่ตรวจข้อมูลแล้วได้

รุ่นแรกมี CLI และหน้าเว็บในเครื่อง รองรับ Windows และ Linux VM ที่ทดสอบจริง ฟังก์ชัน HTTP/trace ที่ตัวเก็บรองรับอาจบันทึกได้อัตโนมัติ ส่วนชื่อ action และ business handler ที่ไม่ได้เห็นจาก trace ต้องระบุจุดเชื่อมอย่างชัดเจน การเห็นโค้ดภายในเซิร์ฟเวอร์ต้องอาศัยการติดตั้งตัวเชื่อมและสิทธิ์เข้าถึงแอปของเจ้าของระบบ

ขอบเขต v1 คือการวินิจฉัยใน development/test ของแอปที่เชื่อถือได้ รองรับ Node runtime และ framework ตามตาราง compatibility ที่ผ่านจริง เฟรมเวิร์กแรกเลือกจากแอป pilot; เริ่มจาก Node HTTP ที่มีอยู่แล้ว การรองรับ TypeScript/source maps, CJS และ startup ผ่าน package script ต้องตรวจเป็นกรณีแยกก่อนประกาศรองรับ

Node.js เป็น integration ที่กำลังพัฒนาและมีหลักฐานทดสอบอยู่ ระยะและรุ่นในแผนใช้ตรวจความพร้อมระหว่างทาง เป้าหมายของโครงการยังเป็นเครื่องมือที่เรียกใช้เพื่อเห็นการทำงานของแอปตามที่ผู้ใช้ต้องการ และเดินงานต่อจนใช้ได้จริง ความสามารถเพิ่มเติม เช่น ส่วนเสริม IDE/browser หรือภาษาอื่น ให้เลือกจากปัญหาการใช้งานที่พบ พร้อมเกณฑ์ตรวจของแต่ละ integration

## สถานะเริ่มต้น

| ความสามารถ | หลักฐานปัจจุบัน | งานที่เหลือ |
| --- | --- | --- |
| เปิด/ปิดเครื่องมือ | รุ่น 0e49f48 ผ่าน owner disconnect, startup lease และ controlled SIGINT/SIGTERM handler บน Windows/Linux VM/CI; SDK flush, offline package/reinstall ผ่าน | สัญญาณจาก console จริง, startup ที่เคยล่าช้า, inspector ถูกบังคับหยุด/โปรเซสหลาน, attach แอปที่เริ่มอยู่แล้ว |
| ตั้งค่าแอป | register/allowlist และ managed adapter update/rollback มี backup; opt-in SDK HTTP ไม่ต้องใส่ handler hook | browser→SDK bridge, route/source mapping, existing SDK, แอปธุรกิจจริง |
| แผนที่และ source | รอบ58รุ่น4ab1c61: routing ไม่พาดผ่านกล่องอื่น มีหัวลูกศร/คำอธิบายตำแหน่งไม่ใช่เวลา; actual SDK+Edge/Chromium และ cycle/200edge viewer fixture ผ่าน; CI4/4 ผ่าน | จัดชั้น/แยกเส้นที่ยังตัดกันใน gutter, filter/navigation, async นอก HTTP, source รุ่นเก่า; ห้ามอ้าง user click จาก SDK-only spans |
| หน้าเว็บ | Chromium headless บน Linux และ Edge headless บน Windows ผ่านกับ fixtures | ผู้ใช้จริง, keyboard/accessibility, error/capture states |
| ข้อมูล | storageVersion1 อ่าน graph0.1/0.2, single writer/history100; Windows rename recovery แบบจำกัด ผ่าน simulation/obstruction/restart | persisted completeness, safe metadata retry, export/migration, lock owner/rootcause, overhead |
| คุณภาพ | รุ่น0e49f48 VM/CI main118และgatesผ่าน; รุ่น4ab1c61 WindowsและLinuxVM source1/oldbrowser2/SDKbrowser2ผ่าน; GitHubrun36910555723ผ่าน4/4 ตรวจAPI5ต.ค.2026 ดูHANDOFF.md | performanceของ0e49f48ไม่ผ่านทุกช่อง; ยังไม่ได้อ่านbenchmarkartifacts4ab1c61; sustained-load, acknowledgement pause และ nativeQAexitในfailurepathยังเปิด; เก็บผลล้มเหลวก่อนหน้าไว้ |
| ความเชื่อมั่น | session bearer/pairing/Host/Origin checks; HTTP spans ลดรูปไม่เก็บ URL/header/body/baggage | export privacy/real-app gates; authentication ไม่ได้พิสูจน์ว่า sender report เกิดจริง |
| การใช้งานจริง | ไม่มีแอปธุรกิจของผู้ใช้หรือ user trial | pilot แอปที่ไม่ได้สร้างเพื่อให้ FlowAtlas ผ่านเทสต์ และวัดประโยชน์ |

มี storage recovery test บน Windows/OneDrive ล้มเหลวหนึ่งรอบ (503 หลังคืนไฟล์) แล้วผ่าน focused/serial/default retry สาเหตุยังไม่ยืนยัน ดู [QUALITY.md](docs/QUALITY.md) ห้ามถือว่าปิดปัญหานี้จากการรันซ้ำผ่านอย่างเดียว

## วิธีใช้งานที่ต้องได้ใน v1

1. ผู้ใช้ติดตั้งแพ็กเกจจาก release ที่ตรวจแล้ว และใช้คำสั่งตรวจ runtime, startup, พอร์ต, config และสิทธิ์อ่านไฟล์
2. ลงทะเบียนแอปและอนุญาตเฉพาะไฟล์ที่ต้องการให้เปิดได้ เครื่องมือแสดงการเปลี่ยนแปลงและวิธีถอนตัวเชื่อม
3. เริ่ม session แล้วเปิดแอปใน browser ที่รองรับ กด action; URL ของแอปและ viewer ชัดเจน
4. เปิดแผนที่และหลักฐาน: กรณี success/error/capture ขาดแยกกัน มี trace/span IDs และรุ่นโค้ด; ไม่เดาเส้นที่ไม่มีหลักฐาน
5. ปิดเครื่องมือ แอปทำงานตามโหมดที่เลือก ข้อมูลเก่ายังเปิดได้; restart, export, delete และ recovery มีวิธีตรวจผล

มี CLI `node scripts/cli.mjs` และ executable `flowatlas` ใน package สำหรับ demo/register/doctor/inspect และ --workspace แยกพื้นที่แอป/config/history จาก installation แล้ว ดู [วิธีติดตั้ง](docs/install.md) ยังต้องตรวจ upgrade ข้ามรุ่น/rollback, integration ของแอปทั่วไป และให้ผู้อื่นทดลองติดตั้งก่อนผ่าน R1 ทั้งระยะ

## ระยะพัฒนาและเกณฑ์ผ่าน

| ระยะ | งานและสิ่งส่งมอบ | เกณฑ์ผ่านก่อนเลื่อนระยะ | ประมาณแรงงาน |
| --- | --- | --- | --- |
| R0: ทำฐานให้ตรวจซ้ำได้ | วินิจฉัย storage failure, เก็บ error cause ที่ไม่เปิดเผยข้อมูลลับ, recovery tests, บันทึก runtime/clean source ของ release, ตั้ง CI พื้นฐาน | failure ที่พบมีสาเหตุและแนวทางแก้ที่พิสูจน์ หรือระบุข้อจำกัดที่ทำซ้ำได้; ข้อมูลเดิมไม่เสีย; default tests ไม่ผ่านด้วยการข้าม/เพิ่ม retry กลบอาการ | 2–4 วัน |
| R1: ติดตั้งและเชื่อมแอป | ออกแบบแพ็กเกจ adapter/CLI, doctor, integration ที่ใช้ซ้ำได้, start/attach lifecycle, browser action IDs, คู่มือถอน/rollback | นักพัฒนาคนอื่นทำตามคู่มือกับ reference app ได้ แล้วตรวจซ้ำกับแอปจริงใน R4; เป้าหมายเวลาถึงกราฟแรก ≤15 นาทีใน environment ที่พร้อม; ไม่ทับไฟล์เจ้าของแอป | 5–8 วัน |
| R2: trace และความเชื่อมั่น | Node OpenTelemetry integration, รับ spans ที่จำกัดขอบเขต, correlation/async context, session access, origin checks, field allowlist/redaction | known-answer scenarios ทั้งหมดไม่มี false observed; แยก concurrent actions, missing/duplicate/out-of-order events; ผู้ส่งผิด session ถูกปฏิเสธและข้อมูลลับไม่เข้า artifacts | 5–8 วัน |
| R3: ข้อมูลและมุมมองสำหรับงานจริง | bounded queue/batching, event IDs/idempotency, timeout/completeness state, retention, backup/recovery, source รุ่นเก่า, UX map/history | collector ล่มไม่เปลี่ยนผลธุรกิจ; queue เต็มแจ้ง dropped events; restart/migration/export/delete ผ่าน; source เก่าต้องตรงรุ่นหรือแจ้ง unavailable | 4–7 วัน |
| R4: pilot และพิสูจน์คุณค่า | ทดลองอย่างน้อย 1 แอปที่ไม่ได้ออกแบบเพื่อ FlowAtlas, business actions ≥3 แบบ, ผู้ทดลอง 3–5 คน, benchmark และ incident tasks | ติดตั้งได้จริง, ตอบเส้นทางและเหตุจากหลักฐานได้ถูก, ไม่มีข้อผิดพลาดวิกฤตค้าง; รายงานเวลา/ความถูกต้องเทียบ baseline พร้อมเคสช่วยไม่ได้ | 5–8 วัน |
| R5: release candidate และ v1 | ตรึง API/schema/support matrix, compatibility/migration, แพ็กเกจ+checksum, license, clean install/update/rollback, release notes | pilot รับรอง, release tests ทุกช่องที่ประกาศรองรับผ่านบน commit เดียวกัน, ไม่มี P0/P1 ค้าง, คนอื่นติดตั้งและใช้งานตามคู่มือได้ | 3–5 วัน |

ประมาณรวม 24–40 วันทำงาน หรือราว 6–10 สัปดาห์เมื่อเผื่อการแก้ integration สำหรับผู้พัฒนาหนึ่งคนที่ทำงานต่อเนื่อง ยังไม่รวมเวลารอแอป/ผู้ทดลองและงานที่ค้นพบใหม่ ประเมินใหม่หลัง R1 และ pilot รอบแรก ไม่ผูกวันเผยแพร่จนผ่านเกณฑ์

งานอยู่ในโฟลเดอร์ FlowAtlas ที่ผู้ใช้กำหนด แอปทดลองแยก repository ภายใต้ `apps/` และ VM ใช้สำเนา QA ตามที่อนุญาตแล้ว ความถูกต้อง/การป้องกันข้อมูลต้องมาก่อนการให้คนนอกทดลอง R2 ต้องผ่านก่อน pilot ที่ใช้ข้อมูลของผู้ทดลอง ส่วนงาน UX ใน R3 เริ่มออกแบบจาก feedback ใน R1 ได้

## Backlog ที่นำไปทำต่อได้

| ID | งาน | ขึ้นกับ | เกณฑ์รับงานและหลักฐาน |
| --- | --- | --- | --- |
| FA-01 | วินิจฉัย storage recovery บน Windows/OneDrive | — | เก็บ operation/error code จาก cause ในรายงาน local โดยไม่ส่ง secrets ทาง API; แยก app failure กับ test assumption; ทำ repro ก่อนแก้และตรวจข้อมูลก่อน/หลัง |
| FA-02 | ระบุ compatibility และ CI matrix | FA-01 | pin dependencies/runtime สำหรับ QA, ตรวจ Node ที่จะประกาศรองรับกับนโยบาย official ณ release; main/source/browser บน source revision เดียวกัน; บันทึก skip ตามจริง |
| FA-03 | integration package และ doctor | FA-02 | แพ็กจาก checkout แล้ว clean install ลง target แยก; ตรวจ ESM/startup/config/adapter mismatch; เพิ่ม/ถอน/อัปเดตแล้วไม่ทำลายไฟล์เดิม |
| FA-04 | browser action และ server hooks | FA-03 | ตัวช่วยส่ง correlation เฉพาะ origin ที่อนุญาต, opt-in action scope, ไม่เพิ่ม header ไป third-party; requests พร้อมกันไม่สลับ action; CORS/redirect ระบุพฤติกรรม |
| FA-05 | Node spans และ normalization | FA-03, FA-04 | เก็บ inbound/outbound และ parent/child ที่เครื่องมือรองรับ; initialize instrumentation ก่อน app imports; handle async/fan-out, sampled/missing spans; source symbol จาก declaration ยัง inferred |
| FA-06 | session access และ privacy | FA-03; บังคับก่อน pilot | credential สั้นอายุผ่านช่องทางในเครื่อง ไม่อยู่ใน URL/reports/Git; authorization/origin/host validation, source allowlist, XSS/path traversal tests และ canary secrets ไม่เข้า output |
| FA-07 | queue และ event lifecycle | FA-05, FA-06 | telemetry ส่งผ่าน bounded queue, retries เฉพาะ event ที่ idempotent, ไม่ retry business request; drop/timeout/incomplete state ชัดเจน; flush มีเวลาเพดาน |
| FA-08 | storage policy และ recovery | FA-01, FA-07 | วัด JSON rewrite overhead ก่อนตัดสินใจคง JSON/เปลี่ยน backend ใน ADR; kill/write failure/corrupt file/single-machine OneDrive, retention, backup+restore; ไม่ลบ lock จาก PID อย่างเดียว |
| FA-09 | source history และ schema | FA-05, FA-08 | versioned schema + migration/rollback; source ผ่าน Git revision หรือ snapshot เฉพาะ allowlist ที่เจ้าของอนุญาต; dirty/missing/mismatch ไม่มีการแสดงโค้ดผิดรุ่น |
| FA-10 | UX สำหรับเข้าใจและวินิจฉัย | FA-05, FA-07 | แผนที่เลือก node/trace, ลำดับเวลา, filter/service/error, แสดงช่องว่าง; keyboard navigation/contrast, empty/error states; ไม่ต้องอ่าน JSON เพื่อรู้ผลหลัก |
| FA-11 | browser capture ที่เลือกเปิดได้ | FA-04, FA-06 | เก็บ metadata ที่กรองแล้ว; Playwright artifacts สำหรับ reproduction เป็น opt-in แยก, ตรวจข้อมูลใน DOM/network/source ก่อน export; browser trace ไม่ยืนยันโค้ดเซิร์ฟเวอร์เอง |
| FA-12 | pilot แอปอิสระ | FA-03–FA-10 | inspect แอปก่อนติดตั้งและมี rollback; known-answer cases success/error/slow/upstream outage; บันทึกเวลาติดตั้งและ overhead; ใช้ fixtures เพื่อเตรียมได้แต่ไม่แทน real-app gate |
| FA-13 | user trial | FA-10, FA-12 | ผู้ทดลอง 3–5 คน, 6 โจทย์เทียบเครื่องมือ/ไม่มีเครื่องมือแบบสลับลำดับและโจทย์ใกล้เคียง; เก็บคำตอบผิด/เวลา/ขอบเขตที่ช่วยไม่ได้; ไม่สรุปทั่วไปจากกลุ่มเล็ก |
| FA-14 | release และคำแนะนำ support | FA-02, FA-06–FA-13 | license ที่เจ้าของเลือก, artifact checksum/dependency review, clean install/update/uninstall, release notes, known limits; ไฟล์ข้อมูล/credentials ไม่เข้าชุดเผยแพร่ |
| FA-15 | วินิจฉัย native QA exit บน Windows เมื่อ browser assertion ล้มเหลว | FA-02 | รอบ59แก้boundedcleanup/reproduceเดิมเก็บERR_ASSERTION/stackและclose/lock/portsครบ; 8b1e270 CIrun37298050345ผ่าน4/4 Windows/LinuxNode22/24 รวมdeliberatefailuregate หลังแก้boundarydisposalที่CIรุ่นแรกcancelled สาเหตุภายในNodeและnativefaultทุกชนิดยังไม่ยืนยัน PR#1ยังไม่merge |

FA-11 ทำการทดลองได้ระหว่าง R3 แต่ raw Playwright trace ไม่ใช่ข้อบังคับของ v1 ถ้า metadata capture และ reproduction ที่กำหนดผ่านแล้ว การบันทึก DOM/screenshots/network แบบเต็มต้องมี consent และตรวจข้อมูลก่อนใช้งานจริง แผนนี้ไม่รับประกันว่าจะบันทึกได้ครบทุกฟังก์ชันในแอป

## กลยุทธ์ทดสอบและเกณฑ์ v1

เกณฑ์ตัวเลขต่อไปนี้เป็นเป้าหมายเสนอ ให้เก็บ baseline และตกลง profile ของ pilot ก่อนใช้เป็น gate ห้ามปรับเป้าหมายหลังเห็นผลเพียงเพื่อให้ผ่าน

| ด้าน | วิธีตรวจและเป้าหมาย |
| --- | --- |
| ความถูกต้องของเส้นทาง | ≥10 known-answer scenarios รวม success, business error, upstream error/timeout, async fan-out, concurrent actions, missing/out-of-order/duplicate events; false observed ต้องเป็น 0 ในชุดนี้และแสดง uncertainty ครบ |
| การไม่รบกวนแอป | collector unavailable/queue full/storage error ไม่เปลี่ยน business status/body; ไม่มี business retry เพิ่ม; metadata loss มีสถานะชัดเจน |
| ประสิทธิภาพ | baseline เทียบเปิด/ปิด capture บน workload เดียวกัน ≥1,000 requests ต่อแบบ; เป้าหมายเริ่มต้น p95 latency เพิ่ม ≤10% โดยรายงานค่าจริง/CPU/memory/drop rate; ถ้า baseline สั้นมากให้ตั้ง absolute budget ก่อนรัน |
| ขอบเขตโหลด | reference workload 20 actions พร้อมกันต่อเนื่อง 30 นาที; memory/disk/queue อยู่ใต้ limit ที่ระบุ ไม่มี crash/ข้อมูลสลับ; ไม่ใช้ผลนี้อ้างว่าเหมาะกับ production load |
| ข้อมูล | graceful restart, forced process stop ในจุดเขียนที่ควบคุมได้, simulated I/O failure, corruption/migration/backup restore; accepted data ต้องคืนได้ตาม durability policy ที่ประกาศ |
| ความปลอดภัย | ผู้ส่งไม่มีสิทธิ์อ่าน source/ส่ง events ไม่ผ่าน; canary token/cookie/body/query/DOM ไม่เข้า default artifacts; export มี preview และ privacy rules |
| ผู้ใช้ | ติดตั้งถึงกราฟแรกตามเป้า, ตอบงาน tracing/incident ถูก ≥80% ใน pilot และไม่แย่กว่า baseline; ประเมินเวลาและความผิดพลาดรายคน ถ้ายังไม่ช่วยให้แก้โจทย์ได้ชัดเจนให้ปรับ product ก่อน v1 |
| การติดตั้ง | clean machine/VM Windows และ Linux; main suite+isolated source+browser บน source revision เดียว; Node/browser versions ที่ไม่ได้ตรวจไม่อยู่ในรายการรองรับ |

ทุกรอบใช้ [run-tests](scripts/run-tests.mjs) เก็บ TAP/JSON ทั้ง pass/fail/skip, commit+digest+environment; manual test/user trial แยกชนิดหลักฐาน เก็บการวิเคราะห์ใน [QUALITY.md](docs/QUALITY.md) รัน source check แยกตาม AGENTS.md ไม่เพิ่ม retry ใน test เพื่อซ่อน failure และไม่รันซ้ำเมื่อไม่มีความเสี่ยงหรือการเปลี่ยนแปลงใหม่ให้ตรวจ

P0 คือข้อมูลสูญหาย/รั่วหรือการ capture เปลี่ยนผลแอป; P1 คือเส้นทางหลักใช้ไม่ได้หรือ observed ไม่จริง Release ต้องไม่มี P0/P1 ที่ยังไม่แก้ และความเสี่ยง intermittent ที่ยังไม่อธิบายต้องได้ข้อจำกัดหรือแนวทางรองรับที่พิสูจน์ก่อนรับรอง environment นั้น

## แอปจริงและจุดตัดสินใจ

อัปเดต5ต.ค.2026: ผู้ใช้ยืนยันยังไม่มีแอปธุรกิจ ให้พัฒนาฐาน/เตรียมpilotต่อ มี [protocolและแบบบันทึก](docs/pilot.md) ตามเกณฑ์เดิมแล้ว ไม่มีreal-app/usertrialresult รอบ60ลดต้นทุนnodeindexในvalidationเฉพาะส่วนที่วัด `44151a5`CIrun37299083948ผ่าน4/4/main124ทุกช่อง/sourceinventoriesตรงGit แต่HTTPperformanceยังFAILEDทุกช่อง(+71.129%ถึง+303.755%; ในเครื่อง+479.671%) จึงไม่ผ่านperformance/FA-07/FA-08/sustainedloadจากrepairนี้ PR#1และstackedPR#2ยังไม่merge รายละเอียด/งานต่ออยู่HANDOFF

ตอนนี้ผู้ใช้ยังไม่มีแอปงานจริงให้ทดลอง พัฒนา R0–R3 และเตรียม reference app ที่มี business flow, data store และบริการปลายทางได้ โดยแยก repository ภายในโครงการ ก่อนรับรอง R4 ต้องหาแอปที่เจ้าของยอมให้ทดสอบและไม่ได้ถูกสร้างเพื่อรองรับ FlowAtlas โดยเฉพาะ หากยังไม่มีให้รายงานว่า Alpha สำหรับ fixtures เท่านั้น; Beta/v1 ยังไม่ผ่าน

ตัดสินใจ framework/runtime ใน R1 จาก reference app และยืนยันหรือปรับจาก pilot ใน R4; วิธีรับ OpenTelemetry spans และการแปลงเป็น graph ใน R2; storage backend ใน R3 หลังวัด; API schema/แพ็กเกจและ license ก่อน R5 เขียน ADR พร้อมทางเลือก ผลกระทบ และวิธี rollback แทนการเลือก framework/database/ส่วนเสริมหลายตัวล่วงหน้า

Release levels: Alpha = ติดตั้งและ trace เส้นทางที่รองรับได้อย่างปลอดภัย; Beta = real-app pilot ผ่าน พร้อม recovery/UX และ feedback; v1 = user trial, compatibility และ release gates ผ่านทั้งหมด รุ่น local dev นี้ไม่หมายถึงพร้อมติดตั้งใน production infrastructure

## งานรอบแรกที่จะลงมือ

เริ่ม FA-01: เพิ่ม diagnostics ของ storage error อย่างจำกัด, เก็บ repro ของกรณี 503, ตรวจว่าผลก่อนหน้าอยู่ครบและเขียนต่อหลัง recovery ได้ แล้วทำ FA-02 ให้การทดสอบ release ใช้โค้ด revision เดียวกันบน Windows/Linux เมื่อฐานนี้ผ่านจึงทำ package/doctor ใน FA-03

ความคืบหน้าวันที่ 1 ตุลาคม: ส่งมอบ local diagnostics ของ FA-01 แล้วใน `5908428`; Windows/Linux main 56/56 และ source/browser gates ผ่านบน source digest เดียวกัน แต่ intermittent หลังคืนไฟล์เดิมยังไม่ทำซ้ำ จึงยังเปิด investigation ไว้ FA-02 ผ่าน hosted [CI matrix](docs/ci.md) ครบ Windows/Linux × Node 22/24 ใน a9b1a8d รวม main 71 tests, source, browser และ offline reinstall; VM a9b1a8d main/source/Chromium ผ่านด้วย FA-03 มี CLI/doctor/แพ็กเกจ แยก workspace และ managed adapter update/rollback พร้อม backup แล้ว Windows main 76/76 ก่อน CRLF regression, focused หลังแก้ 10/10 และ final package journey 1/1; ยังไม่ใช่ released-version/schema migration FA-06 มี session bearer/pairing/origin/Host checks แล้ว แต่ privacy ของ trace/export และ real-app integration ยังไม่ผ่าน ไม่ถือว่าโครงการใช้งานจริงสมบูรณ์ ผู้ใช้ให้เดินทุกงานที่จำเป็นต่อจนถึงเป้าหมาย ระยะในแผนเป็น milestone ไม่ใช่จุดหยุดงาน

## แหล่งอ้างอิงและข้อจำกัดทางเทคนิค

รอบ65controlledslow-fsyncreproduction+scopeguard:120mspauseก่อนrealfsyncเฉพาะownedfixturetempfiles ทำให้diskทั้ง3conditionsชน900msdeadline; transport/memorycontrolsครบและpersisted100graphsreloadตรง, faultinnerยังfailed/retained. Outer2/2/main134ผ่าน, exactCIpending14gates/channel. Productioncode/backend/schema/ackpolicyเดิม. [ADRdurabledrain](docs/adr-durable-drain.md)บันทึกว่าคงfsync/ackหลังpersistและไม่ขยายdeadline; รอบ66isolatedjournal-vs-snapshotcomparisonก่อนrepairพร้อมatomicity/crash/corruption/bounds/migration/rollbackproof. SDK-onlycost/performance/stablecapture/sustained/realpilot/users/releaseยังเปิด ฐานff8b972ordinaryCIshutdowndrop763ไม่ถูกกลบโดยcontrolledtestผ่าน.

รอบ64QA-onlycollectorcomponentreplay+controlled503guard: exactceddc0f PRCI2/4/pushCI4/4 (13gates/channel); main134ทุก8jobs/79exactfiles/104reportsauditครบ. PRLinuxdiskburstshutdownloss635/891และnegativeguarddiskloss795; save sync915/944/860msเป็นช่วงใหญ่ ต้องเก็บfailureไม่rerunกลบ. Transport/memorysimulationครบและdisk100graphreloadตรงแต่ไม่พิสูจน์ackครบ; met=nullไม่ใช้แทนNodeSDK/applicationp95/pilot. รอบ65controlledslow-fsync reproduction+ADRdurable drainก่อนrepairหนึ่งประเด็น ไม่ขยาย900ms/ลดfsync/ackpolicy. SDK-onlycostยังค้าง. Ordinaryperformance7/8FAILED; PRWindows24ผ่านtinybaselineabsolutecriterionเดิมครั้งเดียว ไม่ใช่readiness. Performance/sustained/stablecapture/pilot/releaseยังเปิด

รอบ63reuseclean span JSONในvalidationcallเดียว ลดserialization4→3/spanโดยยังอ่านnode/traceและตรวจใหม่ทุกครั้ง Exact5c6172a PR/pushCI4/4ทั้งสอง/main134ทุกช่อง/77filesตรงGit/normal+diagnosticcaptureครบ แต่isolated48spanไม่ได้เร็วขึ้นและordinaryperformanceFAILEDทุกช่อง. Stablecapture/rootcause827ยังเปิด รอบ64แยกSDK/transport/memory/durablestorageต้นทุนในdiagnosticsก่อนตัดสินใจjournal/ADRcrashrecovery/migration/rollback ไม่ลดdurability/ackguaranteeหรือใช้diagnosticแทนacceptance. Realpilot/users/sustained/releaseยังไม่ผ่าน

รอบ62เพิ่มopt-in flush/storagetimingเพื่อวิเคราะห์shutdown827 โดยคงpolicy/backend/threshold. Exactb554312 PR/pushCI4/4ทั้งสอง/main132ทุกช่อง/77filesตรงGit/normal+diagnosticcaptureครบ; ordinaryperformanceFAILEDทุกช่อง, diagnosticmet=null. พบfsyncpause589msในPRUbuntu24แต่ไม่reproducefailed827จึงยังเปิดshutdownrootcause/stablecapture. รอบ63ลดvalidation/serializationที่วัดได้ หรือADRdurablejournalก่อนbackendchangeโดยคงdurability/recovery. Sustainedload/realpilot/users/releaseยังไม่ผ่าน

รอบ61 ลดการ hash source snapshot ซ้ำเฉพาะ immutable file map พร้อม [ADR](docs/adr-snapshot-digest.md); local main127/source1/SDK+Edge+failure3 ผ่านและ inventory ตรง source เดียวกัน. Exact8eff7e2 pushCI4/4 แต่ PRCI3/4เพราะUbuntu22shutdowndrop827; main127ทุกช่อง/75filesตรงGit ไม่ปิดstablecapture. FA-07/FA-08 ยังเปิด: performanceFAILEDทุกช่องและไม่ยืนยันHTTPimprovement. รอบ62วัดflush/storage/shutdowntimelineก่อนrepairโดยคงdeadline/queue/threshold. Pilot protocolพร้อมแต่ยังไม่มีแอปหรือผู้ทดลอง จึงยังไม่ผ่านR4/R5หรือพร้อมproduction

- [OpenTelemetry Node.js](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/): instrumentation ต้องเริ่มก่อน app code การรองรับอัตโนมัติขึ้นกับไลบรารีที่ instrument ได้; ไม่ยืนยัน business functions ทุกตัว แผน FA-05 เป็นการออกแบบต่อยอดที่ยังต้องทดสอบ
- [OpenTelemetry security](https://opentelemetry.io/docs/security/): telemetry อาจมีข้อมูลอ่อนไหวและต้องป้องกันการแก้ไขข้อมูล; ใช้เป็นเหตุผลของ FA-06 และ export policy
- [Playwright tracing](https://playwright.dev/docs/api/class-tracing): บันทึก browser operations/network และเลือก DOM/screenshots/sources ได้; context tracing ไม่ได้บันทึก test assertions และไม่มีหลักฐานภายในเซิร์ฟเวอร์จากตัวมันเอง
- [สัญญา ingestion ปัจจุบัน](docs/ingest-protocol.md), [Node adapter](docs/node-adapter.md), [storage/recovery](docs/storage.md), [Linux VM evidence](docs/linux-vm.md)
ความคืบหน้าเพิ่มเติม: FA-04 มี browser action scope แบบ opt-in แล้ว ใช้หนึ่ง business request ต่อ scope และแยก concurrent actions; Edge ตรวจสาม UI actions และสอง scope พร้อมกันพร้อมกราฟ/history (1/1), affected HTTP/CLI 23/23 และ source 1/1 ผ่านใน dirty workspace หลัง 3f054c5 hosted browser revision b5c7fd0 ผ่านครบ4ช่อง; ยังไม่แทน real-app integration หรือ human trial
FA-05 เพิ่ม opt-in inspect --trace http ด้วย pinned NodeSDK/HTTP/Undici และ schema 0.2 normalized spans แล้ว Windows CJS/ESM จริงมี concurrent fan-out และ exact storage reload; SDK+Edge viewer 2/2, offline installed SDK 2/2 และ explicit package 1/1 ผ่าน hosted18b9dddครบ4ช่องและLinux VM4a68a3c main91/source1/SDKChromium2/browser1ผ่านแล้ว (ก่อน counter/IPC changes) การจับ HTTP root ไม่ยืนยัน user click/business function; coverage partial เสมอและ outbound จำกัด loopback ยังต้องเชื่อม browser action, route/source mappings ที่อนุญาต, existing-SDK attach, async spans beyond HTTP และวัด overhead/drop policy FA-07
FA-07/FA-08 measured fixture progress: cross-trace32span transport commits eachbatchonce; Windows3paired1000requestconditions allresponses/capturecounts correct, 3153spansacknowledged/zero drops. Performance target still FAILED (medianpairedp95+291.697% vs10%); this closes neither overhead nor sustained-load/pilot gate. CPUprofiling andLinuxmatchedbenchmark are next; history100rows is not a capturetotal. Rawlocalevidence/limits in docs/benchmark-http.md and QUALITY.

FA-07/FA-08 update: ae55301 hosted load gate failed in3/4jobs from proven queue overflow on Ubuntu22 andWindows22; local collector refusals remain a separate unknown cause. VMae55301 main96/source1/SDKChromium2/benchmark1 passed capture, overhead failed (+163.677%). Next fixed two-slot exporter keeps queue256/batch32/deadlines; Windows focused20/20 and one unprofiled benchmark1/1 capture passed, overhead FAILED (+551.464% aggregatep95). Exact hosted/VM verification and sustained-load/performance acceptance remain open; see QUALITY and benchmark guide.

FA-07 batching update: e83f48f VMmain98/load1/SDKChromium2passed capture, overhead failed; Ubuntu22 exact CI still failed overflow440/timeout64. Fixed numeric transport diagnostics measured mostly small batches. New20ms partial-batch coalescing (full32 immediate, flush bypass, unchanged queue/slots/timeouts) passed focused22/22 and local load capture1/1; batches36/42/39 vs91/68/63 prior. Performance still failed; background evidence work prevents causal timing claims. Exact CI/VM/sustained-load gates remain open.

FA-01 update: real save/rename EPERM reproduced (13-41-26-268Z). Windows same-file replacement retry bounded5attempts/nominal75ms pauses, persistent errors still503 and preserve prior state; Linux unchanged. Simulated transient + actual obstruction/restart/fresh-process/20concurrent persistence21/21passed. Fullmain102/103 failed one CJS SDK acknowledgement (5delivered/1drop despite six persisted spans), not storage. Root lockowner and stable SDK capture remain open; next fixed diagnostics must determine cause. No skips, business retries or app deadline extension.

FA-07 bounded resource policy: measured Ubuntu24 635overflow/64timeout and localSDK timeout1 after persisted6 support default/max capacity2048 and default uploaddeadline1000ms. Keep two32-span slots/20ms coalescing/900ms shutdown/no retries; see ADR capture policy. Windows default104/104, focused20/20 and unchanged3x1000 load capture1/1passed. Performance16.336%aggregateoverhead stillfails10%target; exact CI/VM/sustained-load and pause rootcause remain open. Existingfailed runs retained; no acceptance relaxation.

Current exact-evidence update: da9a0b6 hosted3/4 (Windows22mainfixturefailed), VMmain102/104failed; isolatedVMsource/load/SDKChromiumpassed and allfourhostedloadcapturescomplete. AllhostedperformancebudgetsandVM185.79%failed. Next priority is acknowledgement/lifecycle/fixturediagnosis and overhead; largerboundedpolicydoesnotclose them. Round54 reporting repair prevents incomplete orprofiled runs issuingperformanceverdicts (met=null), verifiedfocused4/replay2/unchangedload1. No performance/sustained-load/pilot acceptance.

FA-03 lifecycle repair: managed CLIinspect now has private ownership proof and disconnect shutdown. Windows hidden inspector escapes parentforced-kill job so it can performexistingboundedstop/SDKflush/collectorlockclose; Linux remainsnon-detached. Focused14/14 verifies ready/startup/silentowner paths and actualSDKdrain, defaultmain/exactCI/VM pending. Directinspectorkill/arbitrarygrandchildren and historicalprocesscleanup remainunverified; see installguide.
