# ADR: exporter เป็นเจ้าของ HTTP transport

รอบ70 / 6ตุลาคม2026 เลือก native Node HTTP Agent แบบ keepalive จำกัด2socket/2free sockets ต่อexporter แทนglobalfetch pool เพื่อให้ขอบเขตและการปิดconnectionผูกกับexporterเอง SDK/applicationcallbackยังตอบทันที ไม่awaitcollector ไม่มีretry/redirect/proxy transport โดยcollectorURLยังจำกัดloopback/rootเดิม bearer token/body/schemaเดิม

Agent/requestโหลดแบบlazyผ่านpromiseเดียว หลังSDKสร้างspanแล้ว ไม่importnode:httpก่อนSDKstartup: eagerimportทำให้CJSfixtureมีCLIENT3แทน2ต่อtrace (SERVER1/total4) และtimeoutเดิมไม่ปิดเอง; lazyimportคืนCJS/ESMจำนวนเดิม3spans/trace พร้อมactualupstreamcontexts4และEdgeviewer. เก็บfailedrunsไว้ ไม่เพิ่มwaitหรือเปลี่ยนexpectedcounts

Successful2xxต้องจบHTTPresponseครบก่อนนับdelivered, drainstreamโดยไม่เก็บ/parsebody. นี่เข้มกว่ารุ่นfetchเดิมที่นับหลังheaderแล้วcancelbody; truncated/stalled2xxจึงนับtimeout/transportdropแม้collectorอาจpersistไปแล้ว สถานะนี้ไม่ยืนยันว่าไม่มีข้อมูลในdisk และไม่มีการretry อาจมีpersistedแต่unacknowledgedตามfailurepolicy. Non2xxรวมredirectนับrejectedทันที/destroyresponse ไม่ต้องรอbody. Errorlistenersรับresponse/requesterrorsทุกสถานะ; abortยังใช้1000msupload/900msshutdownเดิม

Shutdowndrainเดิมแล้วdestroyเฉพาะAgentของexporter ไม่แตะglobalbusinessagent. Buffer2048/2slots/batch32/20mscoalescing/history100/fsync/atomicreplace/ackหลังpersist/backendschemaเดิม. No localdata migration; rollbackreverttransportแต่จะกลับไปheader-onlyack/globalfetchpoolตามรุ่นก่อน ต้องทบทวนข้อจำกัดนั้น

Before21-05-40-428Z13/15failed: connectionsเกิน2และincomplete2xxนับdelivered1. Finalfocused21-14-47-068Z25/25, SDKcomponents21-14-52-093Z1/1, parity/503guard21-15-04-122Z2/2 (innerfailedตามตั้งใจ), actualSDK+Edge+assertion21-15-16-030Z3/3, main21-15-39-158Z143/143, source21-19-50-319Z1/1. IntermediateCJSfailures21-09-08-444Z/21-09-30-018Z/21-11-35-837Zเก็บพร้อมnumericcountdiagnosticและcleanupconfirmed

Ordinaryfinal21-19-34-290Zcapture3153ack0drops แต่performanceFAILED+560.428%(2.992→19.760ms). Diagnosticcount/sinklatencyผันผวน ไม่ใช่proofว่าเร็วขึ้น และไม่มีpairedtransportcausalcomparison. เลือกtransportนี้จากownership/response-completion correctness ไม่ประกาศperformanceผ่านหรือปิดfsynccaptureloss/startuprootcause/sustained/pilot. ต้องรอexacthostedCIของcandidateก่อนรับรองcompatibilitymatrix
