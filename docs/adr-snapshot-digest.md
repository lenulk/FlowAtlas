# ลดการคำนวณ digest ซ้ำของ source snapshot

วันที่5ตุลาคม2026 รอบ61 ต่อจาก4b5c2ec การตัดสินใจนี้จำกัดเฉพาะ SHA-256 ของรายการ file hashes ไม่เปลี่ยน backend/schema/durability/queue/deadline และไม่ใช้ cache ของผล graph validation

## หลักฐานและทางเลือก

JsonActionStore ตรวจทุกกราฟที่อยู่ใน history ก่อนเขียนแต่ละ batch กราฟจากprojectเดียวกันใช้snapshotเดียวกัน แต่เดิมคำนวณdigestไฟล์ซ้ำทุกกราฟ/ทุกsave Regressionก่อนแก้ `11-11-43-564Z`ผ่าน1/3: capturedhashmapยังแก้ไขได้และsaveเดิม3ครั้งเรียกSHA3ครั้ง อีกกรณีตรวจmutable/getter/graphmutationผ่านอยู่แล้ว ไม่ใช้failureนี้กล่าวว่าHTTPรับข้อมูลผิดรุ่นได้

ทางเลือกคือคงการhashซ้ำ, cacheผลvalidateGraph, หรือ cacheเฉพาะdigestของimmutablehashmap เลือกข้อสุดท้ายเพื่อรักษาการตรวจgraph/paths/claimedversionทุกครั้ง ไม่ข้ามvalidationด้วยreferenceของกราฟที่แก้ไขได้ และไม่ลดfsyncหรือย้ายเวลาตอบack

## วิธีและขอบเขต

- getCodeVersion/captureProjectVersion คืนfilesที่Object.freeze หลังcaptureเสร็จ เป็นownstringdata การเปลี่ยนsource/allowlistต้องcaptureใหม่ ไม่เขียนทับhashของsnapshotเก่า
- Storageใช้WeakMapเก็บcomputed digestสำหรับfrozenplain/null-prototypefilemapที่ทุกpropertyเป็นstringdata เฉพาะเท่านั้น ไม่มีstrongreferenceเก็บhistoryเพิ่ม
- Frozenaccessorไม่ใช่immutabledata: getterยังเปลี่ยนค่าได้ จึงไม่cache กรณีmutable/customprototype/ค่าที่ไม่ใช่stringใช้การคำนวณเดิม
- ทุกsaveยังvalidateGraph, filepaths/hashbounds และเปรียบเทียบcomputedกับclaimed digestทุกครั้ง cacheไม่มีสิทธิ์รับรองdigestที่ผู้ส่งเปลี่ยน อดีตstate.jsonที่JSON.parseกลับมาเป็นmutableobjectsยังตรวจแบบเดิม
- JSON bytes/storageVersion1/atomictemp→write→fsync→rename/retention100/64MiBเดิมคงอยู่

## ผลและความเสี่ยง

Afterfocused `11-12-28-291Z`26/26ผ่าน ยืนยันSHAครั้งเดียวสำหรับimmutablemapที่saveซ้ำ แต่claimedwrongdigest/graphmutation/pathescape/mutable/getterเปลี่ยนค่าไม่ผ่านและเก็บstateเดิม

Archive4b5c2ecก่อนแก้และcheckoutใหม่หลังแก้ใช้Node24.19.0/Windowsเดียวกัน กับworkloadเดิม3pairs×1000/concurrency8: capture3153ack0dropsทั้งคู่ แต่performanceFAILEDก่อน+347.753% (base2.425/traced10.858ms) และหลัง+254.808% (base3.567/traced12.656ms). Relativeลดเพราะbaselineต่าง ขณะที่tracedp95สูงกว่า จึงไม่อ้างcausalHTTPimprovementหรือperformanceacceptance มีเพียงงานSHAซ้ำที่ลดได้โดยตรง

ผลกระทบที่ตั้งใจ: ผู้ใช้moduleที่เคยแก้version.filesในหน่วยความจำจะพบreadonly/TypeErrorในstrictmode ให้สร้างsnapshotใหม่แทน ไม่มีการเปลี่ยนHTTPprotocolหรือsavedJSON นี่เป็นการคงตัวตนของevidence ไม่ใช่การรองรับsourcehistoryใหม่ Performance/sustainedload/rootcauseของpause/realpilotยังเปิด ต้องตรวจexactCIรุ่นนี้ต่อ

Exact8eff7e2: pushCI4/4 แต่ PRCI3/4เพราะUbuntu22shutdown827drops; inventories75filesตรงGitและmain127ทุกช่อง PerformanceFAILEDทุกช่องทั้งสองruns ดูQUALITY/HANDOFF. ไม่รับรองstablecaptureจากpassingpush และไม่ระบุcacheเป็นสาเหตุของshutdownโดยไม่มีtimeline

Rollback: คืนการhashทุกครั้งในJsonActionStoreและคืนmutablefilesในสองcapturefunctionsได้โดยไม่migrateข้อมูล เพราะรูปแบบ/digestalgorithmไม่เปลี่ยน แต่จะเสียimmutableidentityguardและงานSHAซ้ำกลับมา
