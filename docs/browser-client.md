# เชื่อม action จาก browser

`src/browser-client.mjs` เป็น ES module สำหรับจุดที่ผู้พัฒนาเลือกเปิด capture ไม่มี dependencies และไม่ patch `window.fetch` คัดลอกไฟล์นี้ไป static assets ของแอปและ serve ด้วย JavaScript MIME type จาก origin ของแอปเอง เพิ่มไฟล์นี้ใน source allowlist และ snapshot ของแอปเพื่อผูก revision ของตัวเชื่อม ตัวอย่างที่สร้างใหม่ด้วย `flowatlas demo` รวม module และ registration แล้ว

```javascript
import { createBrowserActions } from '/browser-client.mjs';
const actions = createBrowserActions({ startUrl: '/action-start', timeoutMs: 1000 });
async function sendMessage() {
  const action = await actions.start('send-message');
  const response = await action.fetch('/api/send', { method: 'POST' });
  const body = await response.json();
  showResult(response.status, body);
  if (!action.complete) showCaptureWarning();
  if (action.viewerUrl) showViewerLink(action.viewerUrl);
}
```

`start` สร้าง UUID ใหม่ต่อ scope และ POST เฉพาะ id/name/clientTime ไป endpoint ของแอป เรียกได้พร้อมกันโดยไม่ใช้ active action global ฝั่ง server ต้องเชื่อม endpoint นี้กับ Node adapter และรับ x-flowatlas-action-id ใน handler ตาม [node-adapter](node-adapter.md); module ไม่เพิ่ม hooks ฝั่ง server ให้เอง และไม่รับรหัส collector ใน browser

สัญญาตอบ start: `{ id, complete, viewerUrl }` หรือ `{ id, telemetry: { complete }, viewerUrl }` โดย id ต้องตรง request Endpoint ควรยังตอบ id เมื่อ collector ไม่พร้อมและระบุ complete=false อย่าให้ business route ต้องอาศัย collector ที่ทำงานอยู่ ตัวรับ metadata รอไม่เกิน timeoutMs (1–5000) และอ่าน response ไม่เกิน 16 KiB ความล้มเหลวไม่ทำให้ start throw; ไม่มี retry ผลธุรกิจยังต้องจัดการตามข้อกำหนดของแอป

แต่ละ scope ใช้ business fetch ได้หนึ่งครั้ง ตาม lifecycle ของ explicit adapter ตัวอย่างปัจจุบัน; close() ปิด scope ที่ไม่ได้ใช้ ไม่ abort คำขอที่เริ่มแล้วหรือส่ง finish แทน server การเรียกหลายคำขอภายใน action เดียว/fan-out ยังต้องออกแบบกับ trace lifecycle ต่อ ไม่ถือว่า module นี้รองรับแล้ว

action.fetch รองรับ URL/string และ Request กับ fetch options คัดลอก headers แล้วเพิ่ม correlation; ไม่แก้ headers ของผู้เรียก ไม่อ่าน/clone/log business body หรือเพิ่ม retry ส่ง Response เดิมรวม status/error ตามจริง ฝั่ง server ใช้ x-flowatlas-telemetry: complete|incomplete เพื่อแจ้ง capture: complete ต้องมีทั้ง start acknowledgment และ header complete; HTTP 4xx/5xx อาจ capture ครบได้ state เป็น ready/running/complete/incomplete และไม่ใช้แทนผลธุรกิจ

## Origin และ redirects

อนุญาตเฉพาะ origin ของหน้าแอป ไม่เพิ่ม correlation ไป origin อื่น (รวมต่างพอร์ต), URL credentials, fragment หรือ mode no-cors Config ของ browser ต้องตรง location.origin ตัว start endpoint ไม่มี query รหัส session ของ collectorไม่อยู่ใน module/state/storage/cookies

คำขอที่ติด correlation ใช้ redirect:error เพื่อไม่ส่ง custom header ต่อไป origin อื่น ทั้ง redirect ภายใน/ภายนอกจะปฏิเสธ ไม่มีการตาม redirect แล้ว retry business request ให้ อย่าใช้กับ flow ที่ต้องตาม redirect: ใช้ fetch เดิมโดยไม่มี scope สำหรับ flow นั้น หรือออกแบบ API ที่ตอบผลโดยตรง URL ที่แอปส่งกลับให้ viewer ต้องเป็น local HTTP origin และ query มี actionId เดียวที่ตรง scope; ลิงก์ไม่รวม credential

เหตุผลการไม่ตาม redirect ตรวจจาก [Fetch Standard](https://fetch.spec.whatwg.org/#http-redirect-fetch) Module ไม่ใช่ full browser recorder และ client report ไม่พิสูจน์ว่ามนุษย์คลิกจริง ไม่ครอบคลุม fetch เดิม/XHR/navigation/websocket/service worker หรือ library ที่ไม่ได้เรียก scope นี้

## หลักฐาน

Node HTTP focused ตรวจ concurrent IDs, request/body/header preservation, success/business error, start failure/timeout/oversize, cross-origin/redirect refusal และ lifecycle boundaries Edge headless ตรวจสาม UI actions และสอง scope พร้อมกันกับ Node app ที่ลงทะเบียน กราฟ/source/session/restart ผ่าน; ยังเป็น fixtures และไม่ใช่ real-business-app pilot ดู [TEST-RUNS](TEST-RUNS.md)
