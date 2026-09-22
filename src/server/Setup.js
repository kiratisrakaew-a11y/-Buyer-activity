/**
 * Setup.js — creates and migrates the DB spreadsheet. Safe to run any number of times.
 *
 * Acceptance Test 18: after adding a column to Schema.js, running setup() again must
 * append that column to the existing sheet and leave every existing value untouched.
 * The rule that makes this work: headers already present are never moved or renamed,
 * missing ones are appended on the right, and nothing is ever deleted.
 *
 * Seed data is inserted only where it is absent, so an admin's edits to Config_Lists,
 * Config_Settings or Status_Master survive later runs.
 */

/** Run this once from the Apps Script editor after the first `clasp push`. */
function setup() {
  var report = {
    spreadsheetId: null,
    spreadsheetUrl: null,
    sheetsCreated: [],
    columnsAdded: [],
    settingsAdded: [],
    listRowsAdded: 0,
    statusRowsAdded: 0,
    usersAdded: []
  };

  var ss = ensureDatabase(report);
  Config.__setDbOverride(ss);
  try {
    Schema.tableNames().forEach(function (tableName) {
      ensureSheet(tableName, report);
    });
    seedConfigSettings(report);
    seedConfigLists(report);
    seedStatusMaster(report);
    seedFirstAdmin(report);
    Config.clearCache();
  } finally {
    Config.__clearDbOverride();
  }

  console.log('setup(): ' + report.sheetsCreated.length + ' sheets created, ' +
    report.columnsAdded.length + ' columns added, ' + report.listRowsAdded + ' list rows, ' +
    report.statusRowsAdded + ' statuses — ' + report.spreadsheetUrl);
  return report;
}

/** Opens the configured DB spreadsheet, creating it on the very first run. */
function ensureDatabase(report) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(Config.DB_PROPERTY_KEY);
  var ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('Buyer Procurement Activity — DB');
    props.setProperty(Config.DB_PROPERTY_KEY, ss.getId());
  }
  ss.setSpreadsheetTimeZone(Config.DEFAULT_SETTINGS.APP_TIMEZONE);
  report.spreadsheetId = ss.getId();
  report.spreadsheetUrl = ss.getUrl();
  return ss;
}

/**
 * Creates the sheet if absent, then reconciles its header row against Schema.
 * Existing headers keep their position; schema columns not present are appended.
 */
function ensureSheet(tableName, report) {
  var table = Schema.getTable(tableName);
  var wanted = Schema.getColumnNames(tableName);
  var ss = Config.getDb();
  var sheet = ss.getSheetByName(table.sheet);

  if (!sheet) {
    sheet = ss.insertSheet(table.sheet);
    writeHeaders(sheet, wanted, 1);
    sheet.setFrozenRows(1);
    if (report) report.sheetsCreated.push(table.sheet);
    removeDefaultSheet(ss);
    return sheet;
  }

  var lastColumn = sheet.getLastColumn();
  var existing = lastColumn > 0
    ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (h) { return String(h).trim(); })
    : [];

  // A sheet that exists but has no header row at all (e.g. created by hand).
  if (existing.filter(function (h) { return h !== ''; }).length === 0) {
    writeHeaders(sheet, wanted, 1);
    sheet.setFrozenRows(1);
    return sheet;
  }

  var missing = wanted.filter(function (name) { return existing.indexOf(name) === -1; });
  if (missing.length > 0) {
    writeHeaders(sheet, missing, existing.length + 1);
    if (report) {
      missing.forEach(function (name) { report.columnsAdded.push(table.sheet + '.' + name); });
    }
  }
  return sheet;
}

/**
 * Writes header cells starting at `startColumn`, widening the sheet first.
 * A new sheet is only 26 columns wide, and Cases already needs 30.
 */
function writeHeaders(sheet, headers, startColumn) {
  ensureColumnCount(sheet, startColumn + headers.length - 1);
  var range = sheet.getRange(1, startColumn, 1, headers.length);
  range.setValues([headers]);
  range.setFontWeight('bold');
}

function ensureColumnCount(sheet, needed) {
  var max = sheet.getMaxColumns();
  if (max < needed) sheet.insertColumnsAfter(max, needed - max);
}

/** Google creates a spreadsheet with a "Sheet1" tab we never use. */
function removeDefaultSheet(ss) {
  var sheets = ss.getSheets();
  if (sheets.length <= 1) return;
  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();
    if ((name === 'Sheet1' || name === 'ชีต1') && !Schema.TABLES[name]) {
      ss.deleteSheet(sheets[i]);
      return;
    }
  }
}

/* -------------------------------------------------------------- seed data */

function seedConfigSettings(report) {
  var sheet = Config.getSheet('Config_Settings');
  var existing = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function (r) {
      existing[String(r[0]).trim()] = true;
    });
  }

  var descriptions = {
    MIN_QUOTES: 'จำนวนใบเสนอราคาขั้นต่ำต่อ Case',
    REQUIRE_ALL_ITEMS_PRICED: 'TRUE = vendor ต้องเสนอราคาครบทุก item จึงนับเป็นใบที่ใช้ได้',
    BUYER_CAN_VIEW_ALL: 'TRUE = Buyer เห็น Case ของคนอื่นแบบอ่านอย่างเดียว',
    SPECIAL_REQUIRES_EXCEPTION: 'TRUE = Method SPECIAL ต้องขอ Exception เมื่อใบเสนอราคาไม่ครบ',
    DRIVE_ROOT_FOLDER_ID: 'โฟลเดอร์หลักใน Drive สำหรับเก็บไฟล์แนบ (ว่าง = ระบบสร้างให้ครั้งแรก)',
    REMINDER_HOUR: 'ชั่วโมงที่ส่งอีเมลเตือนรายวัน (0-23)',
    REMINDER_DAYS_AHEAD: 'เตือน Next action ล่วงหน้ากี่วัน',
    APP_TIMEZONE: 'โซนเวลาของระบบ'
  };

  var rows = [];
  Object.keys(Config.DEFAULT_SETTINGS).forEach(function (key) {
    if (existing[key]) return;
    rows.push([key, Config.DEFAULT_SETTINGS[key], descriptions[key] || '']);
    if (report) report.settingsAdded.push(key);
  });
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
  }
}

/**
 * Seed rows for Config_Lists (SPEC §5.3).
 * Parent_Code doubles as the module marker on ACTIVITY_TYPE, so M2..M6 add their own
 * activity types to the same list without a schema change (SPEC §10.4).
 */
function defaultConfigLists() {
  return [
    ['BUDGET_TYPE', 'CAPEX', 'CAPEX', '', 10],
    ['BUDGET_TYPE', 'OPEX', 'OPEX', '', 20],

    ['SUB_TYPE', 'NEW_LOCATION', 'ติดตั้งจุดใหม่', 'CAPEX', 10],
    ['SUB_TYPE', 'RENOVATE', 'ปรับปรุง/Renovate', 'CAPEX', 20],
    ['SUB_TYPE', 'WRITE_OFF', 'รื้อถอน/ตัดจำหน่าย', 'CAPEX', 30],
    ['SUB_TYPE', 'GENERAL', 'งานทั่วไป', 'OPEX', 40],

    ['METHOD', 'NORMAL', 'จัดซื้อปกติ', '', 10],
    ['METHOD', 'SPECIAL', 'กรณีพิเศษ', '', 20],

    ['ACTIVITY_TYPE', 'INTAKE_FOLLOW_UP', 'ติดตามข้อมูลจากผู้ขอ', 'M1', 10],
    ['ACTIVITY_TYPE', 'VENDOR_SEARCH', 'ค้นหา Vendor', 'M1', 20],
    ['ACTIVITY_TYPE', 'CALL', 'โทรติดต่อ', 'M1', 30],
    ['ACTIVITY_TYPE', 'EMAIL_RFQ', 'ส่งอีเมลขอใบเสนอราคา', 'M1', 40],
    ['ACTIVITY_TYPE', 'SITE_SURVEY', 'สำรวจหน้างาน', 'M1', 50],
    ['ACTIVITY_TYPE', 'QUOTE_RECEIVED', 'ได้รับใบเสนอราคา', 'M1', 60],
    ['ACTIVITY_TYPE', 'CLARIFICATION', 'ขอความชัดเจน/สอบถามเพิ่ม', 'M1', 70],
    ['ACTIVITY_TYPE', 'FOLLOW_UP', 'ติดตามงาน', 'M1', 80],
    ['ACTIVITY_TYPE', 'CORRECTION', 'แก้ไขข้อมูล', 'M1', 90],
    ['ACTIVITY_TYPE', 'OTHER', 'อื่นๆ', 'M1', 100],

    ['CHANNEL', 'EMAIL', 'อีเมล', '', 10],
    ['CHANNEL', 'PHONE', 'โทรศัพท์', '', 20],
    ['CHANNEL', 'LINE', 'LINE', '', 30],
    ['CHANNEL', 'MEETING', 'ประชุม', '', 40],
    ['CHANNEL', 'SITE_VISIT', 'ลงพื้นที่', '', 50],
    ['CHANNEL', 'OTHER', 'อื่นๆ', '', 60],

    ['EXCEPTION_REASON', 'SOLE_AGENT', 'ตัวแทนจำหน่ายรายเดียว', '', 10],
    ['EXCEPTION_REASON', 'URGENT', 'งานเร่งด่วน', '', 20],
    ['EXCEPTION_REASON', 'VENDOR_DECLINED', 'Vendor ปฏิเสธการเสนอราคา', '', 30],
    ['EXCEPTION_REASON', 'LIMITED_MARKET', 'ผู้ขายในตลาดมีจำกัด', '', 40],
    ['EXCEPTION_REASON', 'OTHER', 'อื่นๆ', '', 50],

    // ตัวอย่าง — ผู้ดูแลระบบเพิ่มเองได้ (SPEC §5.3)
    ['UNIT', 'PCS', 'ชิ้น', '', 10],
    ['UNIT', 'SET', 'ชุด', '', 20],
    ['UNIT', 'SQM', 'ตารางเมตร', '', 30],
    ['UNIT', 'JOB', 'งาน', '', 40],

    ['MEDIA_TYPE', 'BILLBOARD', 'ป้ายบิลบอร์ด', '', 10],
    ['MEDIA_TYPE', 'LED', 'จอ LED', '', 20],
    ['MEDIA_TYPE', 'SIGNAGE', 'ป้ายทั่วไป', '', 30],

    ['DEPARTMENT', 'OPS', 'ฝ่ายปฏิบัติการ', '', 10],
    ['DEPARTMENT', 'MKT', 'ฝ่ายการตลาด', '', 20],
    ['DEPARTMENT', 'FIN', 'ฝ่ายการเงิน', '', 30],

    ['RESPONSE_STATUS', 'INVITED', 'เชิญแล้ว', '', 10],
    ['RESPONSE_STATUS', 'QUOTED', 'เสนอราคาแล้ว', '', 20],
    ['RESPONSE_STATUS', 'DECLINED', 'ปฏิเสธ', '', 30],
    ['RESPONSE_STATUS', 'NO_RESPONSE', 'ไม่ตอบกลับ', '', 40],
    ['RESPONSE_STATUS', 'WITHDRAWN', 'ถอนตัว', '', 50],

    ['QUALIFICATION_STATUS', 'NOT_CHECKED', 'ยังไม่ตรวจสอบ', '', 10],
    ['QUALIFICATION_STATUS', 'PASSED', 'ผ่าน', '', 20],
    ['QUALIFICATION_STATUS', 'FAILED', 'ไม่ผ่าน', '', 30],

    ['VENDOR_STATUS', 'NEW', 'รายใหม่', '', 10],
    ['VENDOR_STATUS', 'APPROVED', 'อนุมัติแล้ว', '', 20],
    ['VENDOR_STATUS', 'BLACKLIST', 'บัญชีดำ', '', 30],
    ['VENDOR_STATUS', 'INACTIVE', 'ไม่ใช้งาน', '', 40],

    ['EXCEPTION_STATUS', 'PENDING', 'รออนุมัติ', '', 10],
    ['EXCEPTION_STATUS', 'APPROVED', 'อนุมัติ', '', 20],
    ['EXCEPTION_STATUS', 'REJECTED', 'ไม่อนุมัติ', '', 30],

    ['REF_TYPE', 'PR', 'PR (ใบขอซื้อ)', '', 10],
    ['REF_TYPE', 'PO', 'PO (ใบสั่งซื้อ)', '', 20],
    ['REF_TYPE', 'GR', 'GR (ใบรับของ)', '', 30],

    ['ROLE', 'BUYER', 'เจ้าหน้าที่จัดซื้อ', '', 10],
    ['ROLE', 'HEAD', 'หัวหน้าฝ่ายจัดซื้อ', '', 20],
    ['ROLE', 'AUDITOR', 'ผู้ตรวจสอบ', '', 30],
    ['ROLE', 'ADMIN', 'ผู้ดูแลระบบ', '', 40],

    ['MODULE', 'M1', 'M1 ค้นหา Vendor', '', 10],
    ['MODULE', 'M2', 'M2 ราคาจากอดีต', '', 20],
    ['MODULE', 'M3', 'M3 ราคาตลาด', '', 30],
    ['MODULE', 'M4', 'M4 ราคาประเมินภายใน', '', 40],
    ['MODULE', 'M5', 'M5 เจรจาต่อรอง', '', 50],
    ['MODULE', 'M6', 'M6 ตรวจคุณสมบัติ Vendor', '', 60],

    // [RESERVED] M2/M3/M4
    ['SOURCE_TYPE', 'PAST_PR', 'PR ในอดีต', '', 10],
    ['SOURCE_TYPE', 'MARKET', 'ราคาตลาด', '', 20],
    ['SOURCE_TYPE', 'INTERNAL_ESTIMATE', 'ราคาประเมินภายใน', '', 30]
  ];
}

function seedConfigLists(report) {
  var sheet = Config.getSheet('Config_Lists');
  var existing = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 2).getValues().forEach(function (r) {
      existing[String(r[0]).trim() + '|' + String(r[1]).trim()] = true;
    });
  }

  var rows = defaultConfigLists()
    .filter(function (r) { return !existing[r[0] + '|' + r[1]]; })
    .map(function (r) { return [r[0], r[1], r[2], r[3], r[4], true]; });

  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
    if (report) report.listRowsAdded = rows.length;
  }
}

/**
 * Every status of every module exists from day one (SPEC §5.3) so that adding M2..M6
 * is a matter of filling in Allowed_Next, not of migrating Cases.
 * SOURCING_DONE also allows CLOSED so HEAD can close a Case by hand while M2..M6 are absent.
 */
function defaultStatuses() {
  return [
    ['INTAKE', 'รอข้อมูลจากผู้ขอ', 10, 'M1', false, 'SOURCING,CANCELLED'],
    ['SOURCING', 'กำลังหา Vendor', 20, 'M1', false, 'SOURCING_DONE,INTAKE,CANCELLED'],
    ['SOURCING_DONE', 'หา Vendor ครบแล้ว', 30, 'M1', false, 'SOURCING,CLOSED,CANCELLED'],
    ['PRICE_RESEARCH', 'สืบค้นราคา', 40, 'M2/M3', false, ''],
    ['INTERNAL_ESTIMATE', 'จัดทำราคาประเมินภายใน', 50, 'M4', false, ''],
    ['NEGOTIATION', 'เจรจาต่อรอง', 60, 'M5', false, ''],
    ['QUALIFICATION', 'ตรวจคุณสมบัติ Vendor', 70, 'M6', false, ''],
    ['READY_FOR_PO', 'แจ้งหน่วยงานเปิด PO', 80, 'M6', false, ''],
    ['CLOSED', 'ปิดงาน', 90, '', true, ''],
    ['CANCELLED', 'ยกเลิก', 99, '', true, '']
  ];
}

function seedStatusMaster(report) {
  var sheet = Config.getSheet('Status_Master');
  var existing = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function (r) {
      existing[String(r[0]).trim()] = true;
    });
  }
  var rows = defaultStatuses().filter(function (r) { return !existing[r[0]]; });
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
    if (report) report.statusRowsAdded = rows.length;
  }
}

/** Without this the first person to open the web app would lock themselves out. */
function seedFirstAdmin(report) {
  var sheet = Config.getSheet('Users');
  if (sheet.getLastRow() > 1) return;
  var email = '';
  try {
    email = Session.getEffectiveUser().getEmail();
  } catch (e) {
    email = '';
  }
  if (!email) return;
  sheet.appendRow([email, email.split('@')[0], 'ADMIN', '', true]);
  if (report) report.usersAdded.push(email);
}

/* --------------------------------------------------------------- triggers */

/** Installs (or re-installs) the daily reminder trigger at REMINDER_HOUR. */
function installTriggers() {
  var handler = 'dailyReminderJob';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
  var hour = Config.getNumber('REMINDER_HOUR', 8);
  ScriptApp.newTrigger(handler).timeBased().atHour(hour).everyDays(1).create();
  console.log('installTriggers(): dailyReminderJob scheduled at ' + hour + ':00');
  return { handler: handler, hour: hour };
}
