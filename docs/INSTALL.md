# คู่มือติดตั้งลง Google Apps Script

เอกสารนี้สำหรับคนที่จะติดตั้งระบบครั้งแรก เปิดวางข้างๆ หน้า Apps Script แล้วทำตามได้จนจบ

ใช้เวลาประมาณ **20 นาที** ถ้าใช้ clasp · **45–60 นาที** ถ้า copy-paste เอง

---

## 1. ต้องทำใน Google Sheet หรือทำเป็น script แยก?

### **ตอบ: script แยก (standalone) — ไม่ผูกกับชีต**

| วิธีสร้างโปรเจกต์ | ได้อะไร | ใช้ไหม |
|---|---|---|
| เปิด Google Sheet → `Extensions` → `Apps Script` | script ผูกติดกับชีตนั้น (container-bound) | ❌ **ห้ามใช้** |
| ไปที่ **script.google.com** → `New project` | script แยกอิสระ (standalone) | ✅ **ใช้อันนี้** |

### ชีตที่เก็บข้อมูล ไม่ใช่ชีตที่ผูกสคริปต์ — คนละไฟล์กัน

นี่คือจุดที่เข้าใจผิดกันบ่อยที่สุด

```
  ┌─────────────────────────────────┐
  │  Apps Script project            │   ← โค้ดอยู่ที่นี่ (standalone)
  │  (script.google.com)            │
  └─────────────────────────────────┘
                 │
                 │  รัน setup() ครั้งเดียว — ระบบสร้างให้เอง
                 ▼
  ┌─────────────────────────────────┐
  │  Google Sheet                   │   ← ข้อมูลอยู่ที่นี่
  │  "Buyer Procurement Activity    │
  │   — DB"                         │
  │                                 │
  │  14 แท็บ: Cases, Case_Items,    │
  │  Case_Vendors, Quote_Lines,     │
  │  Activities, Vendors, Users,    │
  │  Change_Log, ...                │
  └─────────────────────────────────┘
```

**คุณไม่ต้องสร้างชีตเอง** — `setup()` สร้างให้ พร้อมหัวคอลัมน์และข้อมูลตั้งต้นครบ
แล้วจำ ID ของชีตนั้นไว้ใน Script Property ให้เอง

### ทำไมต้องแยก ไม่ผูกกับชีต

- **SPEC §3 กำหนดว่าไฟล์ DB ห้ามแชร์ให้ Buyer** — Buyer เข้าถึงข้อมูลผ่านหน้าเว็บเท่านั้น
  โค้ดกับข้อมูลจึงควรแยกไฟล์กัน
- ถ้าผูกกับชีต **ลบหรือย้ายชีต = สคริปต์หายไปด้วย** ทั้งระบบ
- ถ้าผูกกับชีต จะเปลี่ยนไปใช้ชีตอื่นเป็น DB ทีหลังไม่ได้
- ถ้าผูกกับชีต `setup()` ก็ยังไปสร้างชีต DB อีกไฟล์อยู่ดี กลายเป็นมี 2 ไฟล์ให้สับสน

> **ถ้าอยากใช้ชีตที่มีอยู่แล้วเป็น DB** ทำได้ ดูหัวข้อ 6

---

## 2. ทำไม `src/` แบ่งเป็น 2 โฟลเดอร์ แล้วมันไปอยู่ยังไงใน Apps Script

**Apps Script ไม่มีโฟลเดอร์** โฟลเดอร์ใน repo มีไว้ให้คนอ่านโค้ด ตอนอัปโหลด clasp จะเอา path
มาเป็น *ชื่อไฟล์* ที่มี `/` อยู่ในชื่อ

| บนดิสก์ | ชื่อไฟล์ใน Apps Script | ชนิด |
|---|---|---|
| `src/server/Auth.js` | `server/Auth` | `.gs` |
| `src/client/Index.html` | `client/Index` | `.html` |
| `src/client/App.js.html` | `client/App.js` | `.html` |
| `src/client/views/MyCases.html` | `client/views/MyCases` | `.html` |

**ทุกไฟล์อยู่ใน project เดียวกัน** และไม่ใช่แค่ "ได้" แต่ **ต้อง** เพราะไฟล์ `.gs` ทุกไฟล์
ใช้ global scope ร่วมกัน — `Api` เรียก `CaseService.create()` ได้เพราะอยู่ project เดียวกัน
ถ้าแยก project จะมองไม่เห็นกันเลย

---

## 3. เอาโค้ดเข้า — เลือกทางใดทางหนึ่ง

### ทาง A — ใช้ clasp (แนะนำ)

ต้องมี [Node.js](https://nodejs.org/) ก่อน

```bash
npm i -g @google/clasp
clasp login
```

1. ไปที่ **script.google.com** → `New project` → ตั้งชื่อ เช่น `Buyer Procurement Activity Tracker`
2. `Project Settings` → คัดลอก **Script ID**
3. เปิด `.clasp.json` ใน repo → แก้เฉพาะบรรทัด `scriptId`

```json
{
  "scriptId": "วาง Script ID ตรงนี้",
  "rootDir": "src",
  "fileExtension": "js"
}
```

> ⚠️ **อย่าใช้ `clasp create`** เพราะจะเขียน `.clasp.json` ใหม่ทั้งไฟล์ ถ้า `"rootDir": "src"` หลุดไป
> ชื่อไฟล์จะกลายเป็น `src/server/Auth` แทนที่จะเป็น `server/Auth`

4. อัปโหลด

```bash
clasp push
clasp open
```

5. **ตรวจว่าถูก:** ใน editor ต้องเห็นชื่อไฟล์ขึ้นต้นด้วย `server/` และ `client/`
   ถ้าเห็น `src/server/` แปลว่า `rootDir` หายไป

ข้ามไปหัวข้อ 4 ได้เลย

---

### ทาง B — copy-paste เองในหน้าเว็บ (ไม่ต้องลง Node)

ไปที่ **script.google.com** → `New project` แล้วสร้างไฟล์ทีละไฟล์ตาม checklist ข้างล่าง

**สองเรื่องที่ทำให้งานเบาลงมาก:**

| | |
|---|---|
| **ไฟล์ `.gs` ตั้งชื่ออะไรก็ได้** | ชื่อไฟล์ไม่มีผลกับการทำงานเลย เพราะทุกไฟล์ใช้ global scope ร่วมกัน จะตั้ง `Auth` เฉยๆ หรือ `server/Auth` ก็ได้ |
| **ไฟล์ `.html` ตั้งชื่อสั้นได้** | ระบบจะไล่ลองชื่อ `client/views/MyCases` → `src/client/views/MyCases` → `views/MyCases` → `MyCases` ให้เอง ดังนั้นตั้งชื่อแค่ `MyCases` ก็ใช้ได้ |

วิธีสร้างไฟล์: กดปุ่ม **`+`** ข้างคำว่า Files → เลือก `Script` (ได้ `.gs`) หรือ `HTML` (ได้ `.html`)

#### Checklist ไฟล์ `.gs` — 26 ไฟล์ (จาก `src/server/`)

| ☐ | ชื่อไฟล์ | เนื้อหาจาก |
|:-:|---|---|
| ☐ | `ActivityService` | `src/server/ActivityService.js` |
| ☐ | `Api` | `src/server/Api.js` |
| ☐ | `Auth` | `src/server/Auth.js` |
| ☐ | `Bootstrap` | `src/server/Bootstrap.js` |
| ☐ | `CaseService` | `src/server/CaseService.js` |
| ☐ | `CaseWorkflow` | `src/server/CaseWorkflow.js` |
| ☐ | `ChangeLog` | `src/server/ChangeLog.js` |
| ☐ | `Config` | `src/server/Config.js` |
| ☐ | `DriveService` | `src/server/DriveService.js` |
| ☐ | `Errors` | `src/server/Errors.js` |
| ☐ | `IdGenerator` | `src/server/IdGenerator.js` |
| ☐ | `ItemService` | `src/server/ItemService.js` |
| ☐ | `Main` | `src/server/Main.js` |
| ☐ | `Notification` | `src/server/Notification.js` |
| ☐ | `QuoteService` | `src/server/QuoteService.js` |
| ☐ | `ReferenceService` | `src/server/ReferenceService.js` |
| ☐ | `Repository` | `src/server/Repository.js` |
| ☐ | `Rules` | `src/server/Rules.js` |
| ☐ | `Schema` | `src/server/Schema.js` |
| ☐ | `Setup` | `src/server/Setup.js` |
| ☐ | `StatusEngine` | `src/server/StatusEngine.js` |
| ☐ | `TeamService` | `src/server/TeamService.js` |
| ☐ | `Utils` | `src/server/Utils.js` |
| ☐ | `Validation` | `src/server/Validation.js` |
| ☐ | `VendorService` | `src/server/VendorService.js` |
| ☐ | `Verify` | `src/server/Verify.js` |

> โปรเจกต์ใหม่จะมีไฟล์ `Code.gs` ติดมาด้วย ใช้เป็นไฟล์ใดไฟล์หนึ่งข้างบนได้ (เปลี่ยนชื่อ)
> หรือลบทิ้งก็ได้

#### Checklist ไฟล์ `.html` — 11 ไฟล์ (จาก `src/client/`)

| ☐ | ชื่อไฟล์ | เนื้อหาจาก |
|:-:|---|---|
| ☐ | `Index` | `src/client/Index.html` |
| ☐ | `Styles` | `src/client/Styles.html` |
| ☐ | `App.js` | `src/client/App.js.html` |
| ☐ | `MyCases` | `src/client/views/MyCases.html` |
| ☐ | `CaseDetail` | `src/client/views/CaseDetail.html` |
| ☐ | `CaseVendors` | `src/client/views/CaseVendors.html` |
| ☐ | `CaseStatus` | `src/client/views/CaseStatus.html` |
| ☐ | `CaseActivity` | `src/client/views/CaseActivity.html` |
| ☐ | `CaseHistory` | `src/client/views/CaseHistory.html` |
| ☐ | `Vendors` | `src/client/views/Vendors.html` |
| ☐ | `TeamView` | `src/client/views/TeamView.html` |

> ไฟล์ `App.js` เวลาสร้างให้พิมพ์ชื่อว่า `App.js` (Apps Script จะแสดงเป็น `App.js.html`)

**ขาดไฟล์เดียวระบบพัง** และไม่มีอะไรเตือนตอน paste — `verifyDeployment()` ในหัวข้อ 5
จะเป็นตัวจับให้ว่าขาดไฟล์ไหน

---

## 4. ตั้งค่า `appsscript.json` — ขั้นที่ข้ามไม่ได้

ถ้าใช้ **ทาง A (clasp)** ไฟล์นี้ถูกอัปโหลดไปให้แล้ว ข้ามไปหัวข้อ 5 ได้

ถ้าใช้ **ทาง B** ต้องทำเอง:

1. `Project Settings` (รูปเฟือง) → ติ๊ก **"Show appsscript.json manifest file in editor"**
2. กลับไปที่ `Editor` จะเห็นไฟล์ `appsscript.json` โผล่มา
3. ลบของเดิมทิ้งแล้ว paste ก้อนนี้ทับ

```json
{
  "timeZone": "Asia/Bangkok",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.send_mail",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/userinfo.email"
  ],
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "DOMAIN"
  }
}
```

**ถ้าข้ามขั้นนี้:** วันที่จะเพี้ยนไปตามโซนเวลาของเซิร์ฟเวอร์ · ระบบขอสิทธิ์ไม่ครบแล้ว
สร้างโฟลเดอร์หรือส่งอีเมลไม่ได้ · และ deploy จะไม่ได้โหมดที่ถูกต้อง

---

## 5. ตั้งระบบให้พร้อมใช้งาน

ทำตามลำดับนี้ในหน้า Apps Script editor

### 5.1 รัน `setup()`

เลือก `setup` จาก dropdown ข้างปุ่ม Run → กด **Run** → กดอนุญาตสิทธิ์
(จะมีหน้าเตือน "Google hasn't verified this app" ให้กด `Advanced` → `Go to ... (unsafe)`
ซึ่งปกติสำหรับสคริปต์ที่เขียนเองภายในองค์กร)

เปิด **Execution log** จะเห็น URL ของไฟล์ DB ที่ระบบสร้างให้ — **เก็บลิงก์นี้ไว้**

ระบบจะเพิ่มบัญชีที่รัน `setup()` ลงในชีต `Users` ด้วยบทบาท `ADMIN` ให้อัตโนมัติ

### 5.2 แก้ข้อมูลในชีต DB

เปิดไฟล์ DB แล้วแก้ 2 แท็บนี้

**แท็บ `Config_Lists`** — ค่าที่ระบบใส่ให้เป็นเพียงตัวอย่าง ต้องแก้ให้ตรงกับบริษัท

| `List_Name` | ที่ให้มา (ตัวอย่าง) | ต้องแก้เป็น |
|---|---|---|
| `DEPARTMENT` | OPS, MKT, FIN | หน่วยงานจริงที่ขอจัดซื้อ |
| `UNIT` | PCS, SET, SQM, JOB | หน่วยนับที่ใช้จริง |
| `MEDIA_TYPE` | BILLBOARD, LED, SIGNAGE | ประเภทสื่อที่มีจริง |
| `SUB_TYPE` | NEW_LOCATION, RENOVATE, WRITE_OFF, GENERAL | ประเภทย่อยของงาน (`Parent_Code` = CAPEX หรือ OPEX) |

วิธีเพิ่ม: ต่อแถวใหม่ท้ายตาราง ใส่ `List_Name`, `Code`, `Label_TH`, `Parent_Code` (ถ้ามี),
`Sort_Order`, `Is_Active` = `TRUE`

**แท็บ `Users`** — เพิ่มทุกคนที่จะใช้ระบบ

| `Email` | `Name` | `Role` | `Responsible_Scope` | `Is_Active` |
|---|---|---|---|---|
| อีเมลบริษัท | ชื่อ-นามสกุล | `BUYER` / `HEAD` / `AUDITOR` / `ADMIN` | (เว้นว่างได้) | `TRUE` |

ต้องมีอย่างน้อย **1 คนเป็น `HEAD`** ไม่งั้นจะไม่มีใครอนุมัติคำขอยกเว้นได้

### 5.3 รัน `installTriggers()`

ตั้งอีเมลแจ้งเตือนรายวัน ถ้าข้ามขั้นนี้จะไม่มีอีเมลเตือน **และใบเสนอราคาที่หมดอายุเองจะไม่ถูกตรวจพบ**

### 5.4 Deploy เป็น Web app

`Deploy` → `New deployment` → กดรูปเฟืองเลือก type **`Web app`**

| ตัวเลือก | ค่าที่ต้องใช้ | ทำไม |
|---|---|---|
| Execute as | **Me** (บัญชีเจ้าของระบบ) | ผู้ใช้เข้าถึงข้อมูลผ่านโค้ดเท่านั้น ไม่ต้องแชร์ไฟล์ DB ให้ใคร |
| Who has access | **Anyone within (โดเมนบริษัท)** | จำกัดเฉพาะคนในองค์กร |

ตั้งผิดสองข้อนี้ = ระบบความปลอดภัยทั้งชุดใช้ไม่ได้

คัดลอก **Web app URL** ที่ได้ไปแจกให้ผู้ใช้

### 5.5 รัน `verifyDeployment()` — ตรวจว่าครบจริง

รันแล้วเปิด Execution log จะได้ checklist 12 ข้อ

```
===== ตรวจความพร้อมของระบบ =====
[ ผ่าน ]   1. ไฟล์ฐานข้อมูล
[ ผ่าน ]   2. ชีตและหัวคอลัมน์ครบตาม Schema
[ ผ่าน ]   3. ไฟล์หน้าเว็บ (ตรวจชื่อที่ clasp ตั้งให้จริง)
...
สรุป: ผ่าน 12 · เตือน 0 · ไม่ผ่าน 0
พร้อมใช้งานจริง
================================
```

**ต้องไม่เหลือข้อ "ไม่ผ่าน"** ถ้ายังมี ให้แก้ตามที่รายงานบอกแล้วรันใหม่

ข้อ 3 สำคัญเป็นพิเศษสำหรับคนที่ติดตั้งด้วยมือ — มันจะบอกว่า **ขาดไฟล์ HTML ไฟล์ไหนบ้าง**

### 5.6 ทดลองใช้ก่อนเปิดให้ทั้งฝ่าย

ทำตาม [`UAT.md`](UAT.md) — 10 เส้นทางที่ต้องมีบัญชี Google จริงถึงจะพิสูจน์ได้
เช่น อีเมลออกจริงไหม ย้อนสถานะอัตโนมัติจริงไหม

---

## 6. ถ้าอยากใช้ชีตที่มีอยู่แล้วเป็น DB

ทำได้ แต่ต้องตั้งค่า **ก่อน** รัน `setup()`

1. เปิดชีตที่ต้องการ คัดลอก **ID** จาก URL

```
https://docs.google.com/spreadsheets/d/1AbC...XyZ/edit
                                        ^^^^^^^^^^  ตรงนี้คือ ID
```

2. ในหน้า Apps Script: `Project Settings` → เลื่อนลงไปที่ **Script Properties** →
   `Add script property`

| Property | Value |
|---|---|
| `DB_SPREADSHEET_ID` | ID ที่คัดลอกมา |

3. รัน `setup()` — ระบบจะใช้ชีตนั้นแทนการสร้างใหม่ สร้างเฉพาะแท็บที่ยังไม่มี **ไม่แตะข้อมูลเดิม**

---

## 7. การอัปเดตภายหลัง

**ทาง A (clasp)**

```bash
clasp push
```
แล้วจาก editor: รัน `setup()` ถ้ามีการเพิ่มตาราง/คอลัมน์ · รัน `verifyDeployment()` ทุกครั้ง

**ทาง B (ด้วยมือ)** — paste ทับเฉพาะไฟล์ที่แก้ แล้วรัน `verifyDeployment()`

**ทั้งสองทาง:** หลังแก้โค้ดต้อง `Deploy` → `Manage deployments` → แก้ deployment เดิมเป็น
**New version** ด้วย ผู้ใช้จึงจะเห็นของใหม่

> ⚠️ ถ้าแก้โค้ดในหน้า Apps Script editor โดยตรง repo จะไม่รู้ และของที่แก้จะหายตอน push
> หรือ paste รอบถัดไป — **แก้ที่ repo เสมอ**

---

## 8. แก้ปัญหาที่พบบ่อย

| อาการ | สาเหตุที่น่าจะเป็น | วิธีแก้ |
|---|---|---|
| เปิด Web app แล้ว**หน้าว่าง** หรือขึ้น error ดิบ | ไฟล์ `.html` ไม่ครบ 11 ไฟล์ | รัน `verifyDeployment()` ดูข้อ 3 จะบอกว่าขาดไฟล์ไหน |
| ขึ้น **"ไม่มีสิทธิ์เข้าใช้งาน"** | อีเมลนั้นไม่มีในชีต `Users` หรือ `Is_Active` = FALSE | เพิ่ม/แก้แถวในชีต `Users` |
| รัน `setup()` แล้วขึ้น **`ReferenceError: ... is not defined`** | paste ไฟล์ `.gs` ไม่ครบ 26 ไฟล์ | เทียบกับ checklist ในหัวข้อ 3 ทาง B |
| **ไม่มีอีเมลเตือน**รายวัน | ยังไม่ได้รัน `installTriggers()` | รัน แล้วตรวจด้วย `verifyDeployment()` ข้อ 10 |
| **วันที่เพี้ยน** ไม่ตรงเวลาไทย | ยังไม่ได้แก้ `appsscript.json` | ทำตามหัวข้อ 4 |
| ใน editor เห็นชื่อไฟล์ขึ้นต้นด้วย **`src/`** | `rootDir` ใน `.clasp.json` หลุด | ใส่ `"rootDir": "src"` กลับไปแล้ว `clasp push` ใหม่ |
| **ยอดรวมราคาไม่ขึ้น** | ยังไม่ได้เพิ่มรายการในแท็บ "รายการ Item" | เพิ่มรายการก่อน จึงจะกรอกราคาได้ |
| **เปลี่ยนสถานะเป็น "หา Vendor ครบแล้ว" ไม่ได้** | ใบเสนอราคาที่ใช้ได้ยังไม่ถึง 3 ราย | ดูคำอธิบายบนหน้างาน จะบอกว่าใบของใครใช้ไม่ได้เพราะอะไร |
| แก้ค่าในชีต `Config_Lists` แล้ว**หน้าเว็บยังเป็นค่าเดิม** | ระบบ cache ค่าไว้ 10 นาที | รอ 10 นาที หรือให้ ADMIN สั่งล้าง cache |

ดูรายละเอียด error ได้ที่ `Executions` ในหน้า Apps Script (เมนูซ้ายมือ รูปนาฬิกา)

---

## เอกสารที่เกี่ยวข้อง

- [`../README.md`](../README.md) — ภาพรวมระบบ การตั้งค่า สิทธิ์ กฎธุรกิจ และการต่อยอด Module 2–6
- [`UAT.md`](UAT.md) — checklist ทดลองใช้ก่อนเปิดให้ทั้งฝ่าย
