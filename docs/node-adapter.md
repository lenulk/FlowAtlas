# เชื่อมแอป Node.js ที่อยู่คนละ repository

ตัวเชื่อมนี้ใช้ explicit instrumentation และโปรโตคอล metadata ของ FlowAtlas ยังไม่ใช่ OpenTelemetry SDK หรือ browser trace recorder ตัวอย่างพร้อมใช้เก็บใน `apps/message-app` ซึ่งมี Git repository ของตัวเองและไม่ import runtime ของ collector

มี [browser action module](browser-client.md) สำหรับสร้าง correlation scope และเรียก API จากจุดที่เลือกเปิด capture; demo ที่สร้างใหม่ใช้ module นี้ แอปเดิมต้องคัดลอก static module/เพิ่ม allowlist/เชื่อม endpoint เอง ไม่มีการแก้ไฟล์ browser ของแอปเดิมตอน adapters update

## ทดลองตัวอย่าง

จากโฟลเดอร์ FlowAtlas สร้างตัวอย่าง (ทำครั้งเดียว; จะไม่เขียนทับแอปเดิม):

```powershell
node scripts/create-target-app.mjs
```

สคริปต์คัดลอกแอปกับ adapter ลง `apps/message-app` และเพิ่ม registration ลง `flowatlas.config.json` ทั้งสองเป็นข้อมูลในเครื่องที่ไม่ใส่ Git ของ collector โดยปริยาย ตัว template และ generator อยู่ใน Git เพื่อสร้างใหม่ได้ สำหรับชุดที่จัดเตรียมในรอบนี้ สร้างแอปและ Git repository แยกไว้แล้ว ไม่ต้องรัน generator ซ้ำ

เปิดแอปที่ลงทะเบียนกับ collector ด้วยคำสั่งเดียวในโฟลเดอร์ FlowAtlas:

```powershell
node scripts/inspect.mjs --project message-app
```

คำสั่งแสดง URL ทั้งสองและ pairing code ใน interactive terminal ใส่รหัสใน viewer ก่อนอ่านกราฟ/source และรอ `stop` เพื่อปิดพร้อมกัน ถ้าต้องการแยกการรันเอง ให้กำหนด `FLOWATLAS_SESSION_TOKEN` ค่าเดียวกันทั้งสองเทอร์มินัลตาม [session access](session-access.md) แล้วเปิดสองเทอร์มินัลในโฟลเดอร์ FlowAtlas:

```powershell
# เทอร์มินัลแรก: collector + แผนที่
node src/server.mjs
```

```powershell
# เทอร์มินัลที่สอง: แอปเป้าหมาย + mock message service
node apps/message-app/server.mjs
```

เปิด `http://127.0.0.1:4190` เพื่อทดลองดูข้อความ/ส่งข้อความ/บริการล้มเหลว กดลิงก์แผนที่เพื่อดูกราฟที่พอร์ต 4173 บริการ mock ไม่มี trace ภายใน กราฟจึงจบด้วย unknown coverage gap เมื่อได้รับ response ปิดตัวอย่างด้วย Ctrl+C หรือพิมพ์ `stop` แล้ว Enter; collector ปิดด้วย Ctrl+C

## ลงทะเบียนแอปอื่นภายในโฟลเดอร์โครงการ

วางแอป Node.js ที่มีอยู่แล้วภายในโฟลเดอร์โครงการ เช่น `apps/my-app` แล้วรันจากโฟลเดอร์ FlowAtlas:

```powershell
node scripts/register-app.mjs --id my-app --root apps/my-app --entry server.mjs --source src/routes.mjs
```

`--source` เพิ่มซ้ำได้สำหรับไฟล์ที่ต้องการให้เปิดหลักฐานต้นทาง; ถ้าไม่มีไฟล์อื่นให้ตัด `--source` ออก คำสั่งตรวจแอปและไฟล์ก่อนเขียน คัดลอก `node-adapter.mjs` กับ `project-sources.mjs` ไปที่ root ของแอปเฉพาะเมื่อยังไม่มี และเพิ่ม registration ใน `flowatlas.config.json` โดยไม่เขียนทับ adapter ที่เนื้อหาต่างกัน ID ซ้ำหรือไฟล์หายจะถูกปฏิเสธ หากต้องใช้ config แยกให้ระบุ `--config reports/storage/my-config.json` โดยสร้าง directory แม่ไว้ก่อน

คำสั่งลงทะเบียนไม่แก้ server/browser code ของแอป ต้องเพิ่ม action ID และ instrumentation ตามตัวอย่างด้านล่างเอง ถ้า entry ไม่อยู่ที่ `server.mjs` ให้ระบุ `--entry` ตอนเรียก `inspect` ด้วย แอปที่ไม่พิมพ์ `Registered app: http://127.0.0.1:<port>` ให้ระบุ `--app-url` ของแอปที่ฟังในเครื่อง การเพิ่มไฟล์ที่ลงทะเบียนแล้วต้อง restart collector และแอป หากต้องการทำแบบ manual ให้นำสำเนา adapter สองไฟล์ไปไว้ด้วยกันในแอป เพิ่ม local config ตาม [ตัวอย่าง](../flowatlas.config.example.json) แล้ว restart collector

- `id`: string เริ่มด้วย a–z ตามด้วย a–z/0–9/underscore/hyphen สูงสุด 64 ตัว; ไม่ซ้ำกัน
- `root`: directory ของแอปภายในโฟลเดอร์ FlowAtlas และอยู่นอก src/public/examples/Git/config ของ collector เพื่อเก็บทุกอย่างตามข้อกำหนดโครงการนี้
- `files`: 1–64 ไฟล์ที่อนุญาตให้อ่านแบบ explicit, relative ต่อ root, ใช้ `/`; รองรับ mjs/cjs/js/ts/tsx/jsx/html/css สูงสุด 1 MiB ต่อไฟล์ ไม่รับ dotfiles, traversal, node_modules หรือ symlink ใน source path
- สูงสุด 16 registrations; config JSON ไม่เกิน 64 KiB เลือก config อื่นด้วย `FLOWATLAS_CONFIG` ภายในโครงการ

ไม่มี endpoint ลงทะเบียน path ผ่าน HTTP การลงทะเบียนต้องมาจากไฟล์ที่ผู้ดูแลในเครื่องกำหนด `GET /flowatlas/projects/{id}` คืน projectId/commit/dirty/digest/file hashes โดยไม่ส่ง absolute root

Git commit/dirty เป็นของแอปเป้าหมายเฉพาะเมื่อ Git root ตรง directory ของแอป หากมีเพียง Git repository ของโฟลเดอร์แม่จะเป็น null และใช้ digest ระบุโค้ดแทน dirty ตรวจเฉพาะไฟล์ที่ลงทะเบียน

## ตัวอย่าง instrumentation

```javascript
import { createFlowAtlasClient, captureProjectVersion } from './node-adapter.mjs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = dirname(fileURLToPath(import.meta.url));
const projectId = 'my-app';
const version = captureProjectVersion(appRoot, ['server.mjs', 'node-adapter.mjs', 'project-sources.mjs'], projectId);
const client = createFlowAtlasClient({ projectId, codeDigest: version.digest });

async function viewMessage(browserActionId) {
  const capture = await client.start({ id: browserActionId, name: 'view-message' });
  await capture.handler({ method: 'GET', path: '/api/message', symbol: 'viewMessage', file: 'server.mjs' });
  try {
    const response = await capture.fetch('http://127.0.0.1:4191/message', {
      symbol: 'viewMessage', destination: 'message service', signal: AbortSignal.timeout(5000),
    });
    await capture.finish(response.ok ? 'success' : 'error');
    return response;
  } catch (error) {
    await capture.finish('error');
    throw error;
  }
}
```

แอปต้องเชื่อม action ID จาก browser ให้ตรงคำขอและตรวจการใช้ซ้ำเอง สร้าง capture แยกสำหรับแต่ละ action และรอ handler-entry ก่อน outbound/finish; อย่าแชร์ capture ระหว่าง requests ถ้า business fetch throw ให้บันทึก finish error ใน error handler ของแอป การรายงานชื่อไฟล์/symbol ต้องมาจากจุดที่ instrument จริง การเชื่อม symbol กับ source declaration ยังคง inferred ไม่ใช่ผลจาก stack inspection

`capture.fetch()` รับ URL/string และ fetch options พร้อม symbol/destination ส่ง action ID + traceparent จริง วัดเวลาเมื่อได้รับ response headers แล้วคืน Response เดิมให้แอปอ่าน body เอง HTTP 4xx/5xx ถูกบันทึกเป็น completed request พร้อม status; แอปตัดสินผล action ผ่าน finish แยกต่างหาก

## ความล้มเหลวและขอบเขต

- Collector timeout/rejection/outage ทำให้ `capture.complete` เป็น false และ viewerUrl เป็น null; หยุดส่ง event ต่อใน capture นั้น แต่ business fetch ยังทำงานตามจริง ไม่มี retry queue
- รอ collector สูงสุด 500 ms ต่อ event โดยปริยาย ปรับ timeoutMs ได้ 1–5000; ไม่ใช่ระบบส่ง telemetry ที่ไม่มี overhead
- ส่งเฉพาะ field ที่กำหนด ไม่ส่ง headers/cookies/request body/response body และ outbound URL เก็บเฉพาะ pathname ไม่มี query; caller ต้องไม่ใส่ความลับในชื่อ action/service/destination/handler path
- Adapter ไม่ตาม HTTP redirects เพื่อไม่ให้ correlation ไปยังปลายทางที่ไม่ได้กำหนด; แอปที่ต้องตาม redirects ต้องกำหนด integration เพิ่ม ไม่ถือว่าทดสอบแล้ว
- action-start ของ registered project ต้องส่ง codeDigest ตรง snapshot ของ collector (409 เมื่อไม่ตรง) event ต่อมาต้องมี projectId เดียวกัน; restart ทั้ง collector/target หลังเปลี่ยนไฟล์ที่ลงทะเบียน
- ใช้ project ID เดิมกับแอปเดิมเสมอ กราฟเก่ายังคง snapshot เดิม ถ้าถอน registration จะอ่านกราฟ JSON เก่าได้ แต่ source ไม่พร้อมใช้งาน และเติม event ไม่ได้ ไม่มี source archive ทุกเวอร์ชัน
- CLI ใช้ session bearer และ origin/host checks ตาม [session access](session-access.md); adapter อ่านรหัสจาก environment และส่งเฉพาะ collector ไม่ส่งไป business downstream ยังไม่มี symbol verification จาก runtime หรือ OpenTelemetry spans; ผู้ถือรหัสยังเป็นผู้รายงานเหตุการณ์ ต้องใช้กับแอปที่เจ้าของเครื่องเชื่อถือ
- In-app browser ที่ใช้ QA ปฏิเสธเปิด source link โดยตรง; Linux Chromium headless เปิด source popup ของทั้งสาม handler ได้ และ source ที่เปลี่ยนหลัง capture ตอบ 409 ตามจริง ยังไม่ยืนยันสาเหตุที่ IAB block

รายละเอียด persistence/recovery อยู่ใน [storage.md](storage.md) และผลทดสอบอยู่ใน [QUALITY.md](QUALITY.md)
