# ADR: cache ผล parse timestamp ที่เป็นสตริงคงที่

รอบ71 / 6ตุลาคม2026 ย้าย Date.parse ที่ contractใช้ไปhelperร่วม เก็บเฉพาะสตริงUTCรูปแบบ24ตัวอักษร YYYY-MM-DDTHH:mm:ss.sssZ สูงสุด2048ค่า/FIFO ไม่มีgraph/validation-result cache ทุกgraph/source/correlation/status/digest/spanJSONยังตรวจใหม่ตามเดิม ตัวเลขผลparseรวมNaNเก็บได้เพราะสตริงและparserมาตรฐานเป็นdeterministic ไม่เก็บวัตถุ/getter/mutableinputหรือรูปแบบอื่น

ต้องเป็นDate.parseมาตรฐานของNode (native source/name/arity) ที่capturedตอนโหลดmoduleและfunctionidentityยังเดิม หากoverrideก่อนหรือหลังโหลดให้parsefresh ไม่ reusecache รูปแบบอื่น/inputที่ต้องtoStringก็fresh ไม่มีการเพิ่มความเข้มcalendarvalidationจากรุ่นก่อน เช่นDate.parseที่rolloverวันตามnativeยังได้ผลเดิม ไม่เปลี่ยนacceptedformat/schema

Helperรองรับnumericinfoแบบreadonly(size/capacity/computed/reused) ไม่เปิดเผยcachedtimestamps ไม่เขียนcacheลงdisk/privateappdata ไม่สร้างtimerหรือI/O และrollbackreverthelper/importsไม่มีmigration ค่า2048เป็นresourceboundที่ตั้งก่อนวัด ไม่ใช่capacityของspanqueue

Before21-44-55-633Z2/4แสดงrepeatedparse2แทน1/ยังไม่มีcache. Finalfocused21-57-16-888Z23/23รวม5parserguards(nativeequivalence/unusual+mutableinput/reuse/before-afteroverride/bounds+eviction), contract/HTTP/source-mutationchecks. Old81f3846validator exactGitcopies (เปลี่ยนarchiveimportpathเท่านั้น) เทียบ100graphs+18malformedcasesdiagnosticsตรง; 5alternatingpairs×20,000validations median142.644→113.647ms (`21-57-19-081Z`) เป็นsyntheticvalidatorcost/met=null ไม่ใช่businessHTTP/SDKperformancegate

Finalmain21-57-47-076Z148/148; SDKcomponent21-57-31-478Z1/1; parity/503guard21-57-39-396Z2/2โดยinnerยังfailedตามตั้งใจ; SDK+Edge+assertion22-02-26-598Z3/3; source22-02-47-215Z1/1. Ordinary21-57-21-584Zresponses/capture3153ack0dropsแต่performanceFAILED200.909%(3.079→9.265ms). ต่างจากก่อนรันด้วยbaselineที่เปลี่ยน ไม่claimcausalHTTPspeedupหรือผ่าน10%. ต้องรอexacthostedCIและsustained/realpilotต่อ
