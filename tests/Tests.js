/**
 * Tests.js — the one acceptance-test suite, shared by both runners.
 *
 *   Node:         node tests/node/run.js
 *   Apps Script:  open the editor and run runAllTests()
 *
 * Numbers in test names map to the Acceptance Test Cases in SPEC §13.
 * Each test gets a brand-new DB spreadsheet built by the real setup(), so the
 * tests exercise the same code path an administrator does on day one.
 */

/* ------------------------------------------------------------- mini framework */

var TEST_REGISTRY = [];

function test(name, fn) {
  TEST_REGISTRY.push({ name: name, fn: fn });
}

function assert(condition, message) {
  if (!condition) throw new Error('assert failed: ' + (message || ''));
}

function assertEquals(actual, expected, message) {
  var a = actual instanceof Date ? actual.toISOString() : actual;
  var e = expected instanceof Date ? expected.toISOString() : expected;
  if (a !== e) {
    throw new Error((message || 'values differ') + ' — expected ' + JSON.stringify(e) + ', got ' + JSON.stringify(a));
  }
}

function assertDeepEquals(actual, expected, message) {
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  if (a !== e) throw new Error((message || 'values differ') + ' — expected ' + e + ', got ' + a);
}

function assertContains(haystack, needle, message) {
  if (String(haystack).indexOf(needle) === -1) {
    throw new Error((message || 'missing substring') + ' — ' + JSON.stringify(needle) + ' not in ' + JSON.stringify(String(haystack)));
  }
}

/** Asserts that fn() throws an AppError carrying the given code. */
function assertThrowsCode(expectedCode, fn, message) {
  try {
    fn();
  } catch (e) {
    if (e && e.code === expectedCode) return e;
    throw new Error((message || 'wrong error') + ' — expected ' + expectedCode + ', got ' +
      (e && e.code ? e.code : (e && e.message) || String(e)));
  }
  throw new Error((message || 'expected an error') + ' — expected ' + expectedCode + ', nothing was thrown');
}

/** Asserts that an api_* envelope failed with the given code. */
function assertApiError(response, expectedCode, message) {
  assert(response && response.ok === false, (message || 'expected failure') + ' — got ' + JSON.stringify(response));
  assertEquals(response.error.code, expectedCode, message || 'error code');
  return response.error;
}

/** Asserts that an api_* envelope succeeded, and returns its data. */
function assertApiOk(response, message) {
  if (!response || response.ok !== true) {
    throw new Error((message || 'expected success') + ' — got ' + JSON.stringify(response));
  }
  return response.data;
}

/* ------------------------------------------------------------------ fixtures */

/**
 * Builds a fresh database with the real setup(), runs fn(report), then cleans up.
 * Deleting the script property first guarantees setup() creates a new spreadsheet
 * rather than reusing the previous test's.
 */
function withFreshDatabase(fn) {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(Config.DB_PROPERTY_KEY);
  Config.__clearDbOverride();
  Config.clearCache();

  var report = setup();
  try {
    return fn(report);
  } finally {
    Config.clearCache();
    Config.__clearDbOverride();
    try {
      DriveApp.getFileById(report.spreadsheetId).setTrashed(true);
    } catch (e) {
      // A scratch spreadsheet that cannot be trashed is not a test failure.
    }
    props.deleteProperty(Config.DB_PROPERTY_KEY);
  }
}

/* ----------------------------------------------------------------- the runner */

function runAllTests(options) {
  var opts = options || {};
  var selected = TEST_REGISTRY.filter(function (t) {
    if (opts.caseNumber) {
      var prefix = String(opts.caseNumber).trim();
      if (t.name.indexOf('T' + prefix + ' ') !== 0 && t.name.indexOf('T' + prefix + ':') !== 0) return false;
    }
    if (opts.grep && t.name.toLowerCase().indexOf(String(opts.grep).toLowerCase()) === -1) return false;
    return true;
  });

  var results = [];
  var passed = 0;
  var failed = 0;

  selected.forEach(function (t) {
    var started = new Date().getTime();
    try {
      t.fn();
      passed++;
      results.push({ name: t.name, ok: true, ms: new Date().getTime() - started });
    } catch (e) {
      failed++;
      results.push({
        name: t.name,
        ok: false,
        ms: new Date().getTime() - started,
        error: (e && e.code ? '[' + e.code + '] ' : '') + ((e && e.message) || String(e)),
        stack: e && e.stack ? e.stack : ''
      });
    }
  });

  var summary = { passed: passed, failed: failed, results: results };
  console.log('Tests: ' + passed + ' passed, ' + failed + ' failed');
  results.forEach(function (r) {
    if (!r.ok) console.error('FAIL ' + r.name + ': ' + r.error);
  });
  return summary;
}

/* ============================================================================
 * Phase 1 — Schema, Setup, Counters, IdGenerator
 * ==========================================================================*/

test('setup creates every sheet declared in Schema', function () {
  withFreshDatabase(function () {
    var ss = Config.getDb();
    Schema.tableNames().forEach(function (tableName) {
      var sheetName = Schema.getTable(tableName).sheet;
      assert(!!ss.getSheetByName(sheetName), 'missing sheet ' + sheetName);
    });
  });
});

test('setup writes the exact schema headers into row 1', function () {
  withFreshDatabase(function () {
    Schema.tableNames().forEach(function (tableName) {
      var expected = Schema.getColumnNames(tableName);
      var sheet = Config.getSheet(Schema.getTable(tableName).sheet);
      var actual = sheet.getRange(1, 1, 1, expected.length).getValues()[0];
      assertDeepEquals(actual, expected, 'headers of ' + tableName);
    });
  });
});

test('setup seeds Config_Settings, Config_Lists and Status_Master', function () {
  withFreshDatabase(function () {
    assertEquals(Config.getNumber('MIN_QUOTES'), 3, 'MIN_QUOTES default');
    assertEquals(Config.getBool('REQUIRE_ALL_ITEMS_PRICED'), true, 'REQUIRE_ALL_ITEMS_PRICED default');
    assertEquals(Config.getTimezone(), 'Asia/Bangkok', 'timezone');

    assertEquals(Config.getList('BUDGET_TYPE').length, 2, 'BUDGET_TYPE entries');
    assertEquals(Config.getList('SUB_TYPE', 'CAPEX').length, 3, 'SUB_TYPE under CAPEX');
    assertEquals(Config.getList('SUB_TYPE', 'OPEX').length, 1, 'SUB_TYPE under OPEX');
    assert(Config.isValidCode('ACTIVITY_TYPE', 'EMAIL_RFQ'), 'EMAIL_RFQ is a valid activity type');

    var statuses = Config.getStatusMaster();
    assertEquals(statuses.length, 10, 'all statuses of all modules exist');
    assertDeepEquals(Config.getStatus('SOURCING').allowedNext,
      ['SOURCING_DONE', 'INTAKE', 'CANCELLED'], 'SOURCING transitions');
    assertEquals(Config.getStatus('CLOSED').isTerminal, true, 'CLOSED is terminal');
    assertEquals(Config.getStatus('PRICE_RESEARCH').allowedNext.length, 0, 'M2 status is reserved');
  });
});

test('T18 rerunning setup appends new schema columns and keeps existing data', function () {
  withFreshDatabase(function () {
    // Put a row in Cases so we can prove the data survives.
    var sheet = Config.getSheet('Cases');
    var headers = Schema.getColumnNames('Cases');
    var row = headers.map(function (h) { return h === 'Case_ID' ? 'SRC-2026-0001' : 'keep-' + h; });
    sheet.getRange(2, 1, 1, headers.length).setValues([row]);

    var listRowsBefore = Config.getSheet('Config_Lists').getLastRow();
    var settingRowsBefore = Config.getSheet('Config_Settings').getLastRow();

    // Simulate a future module adding a column to an existing table.
    var casesTable = Schema.getTable('Cases');
    casesTable.columns.push({ name: 'M2_Benchmark_Done', type: 'bool', reserved: true });
    try {
      var report = setup();

      assertEquals(report.sheetsCreated.length, 0, 'no sheet recreated on a rerun');
      assert(report.columnsAdded.indexOf('Cases.M2_Benchmark_Done') !== -1, 'new column reported');

      var after = Config.getSheet('Cases');
      var afterHeaders = after.getRange(1, 1, 1, after.getLastColumn()).getValues()[0];
      assertEquals(afterHeaders[afterHeaders.length - 1], 'M2_Benchmark_Done', 'new column appended last');

      // Every original header kept its original position.
      headers.forEach(function (h, i) {
        assertEquals(afterHeaders[i], h, 'header ' + h + ' stayed at column ' + (i + 1));
      });
      // Every original value is still there.
      var afterRow = after.getRange(2, 1, 1, headers.length).getValues()[0];
      assertDeepEquals(afterRow, row, 'existing Cases row untouched');

      // Seed data was not duplicated.
      assertEquals(Config.getSheet('Config_Lists').getLastRow(), listRowsBefore, 'lists not re-seeded');
      assertEquals(Config.getSheet('Config_Settings').getLastRow(), settingRowsBefore, 'settings not re-seeded');
    } finally {
      casesTable.columns.pop();
    }
  });
});

test('setup does not overwrite an administrator edit to Config_Settings', function () {
  withFreshDatabase(function () {
    var sheet = Config.getSheet('Config_Settings');
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < values.length; i++) {
      if (values[i][0] === 'MIN_QUOTES') sheet.getRange(i + 2, 2).setValue('5');
    }
    Config.clearCache();
    assertEquals(Config.getNumber('MIN_QUOTES'), 5, 'admin value read back');

    setup();
    Config.clearCache();
    assertEquals(Config.getNumber('MIN_QUOTES'), 5, 'admin value survives a rerun');
  });
});

test('IdGenerator mints sequential, correctly formatted ids', function () {
  withFreshDatabase(function () {
    var year = IdGenerator.currentYear();
    assertEquals(IdGenerator.next('Cases'), 'SRC-' + year + '-0001', 'first Case id');
    assertEquals(IdGenerator.next('Cases'), 'SRC-' + year + '-0002', 'second Case id');
    assertEquals(IdGenerator.next('Case_Items'), 'ITM-000001', 'item id has no year');
    assertEquals(IdGenerator.next('Vendors'), 'VEN-00001', 'vendor id is padded to 5');

    var batch = IdGenerator.reserve('Quote_Lines', 3);
    assertDeepEquals(batch, ['QL-000001', 'QL-000002', 'QL-000003'], 'batch reservation');
    assertEquals(IdGenerator.next('Quote_Lines'), 'QL-000004', 'counter continues after a batch');
  });
});

test('T2 concurrent id allocation never repeats a number', function () {
  withFreshDatabase(function () {
    var seen = {};
    for (var i = 0; i < 50; i++) {
      var id = IdGenerator.next('Cases');
      assert(!seen[id], 'duplicate id issued: ' + id);
      seen[id] = true;
    }
    assertEquals(IdGenerator.peek('Cases', IdGenerator.currentYear()), 50, 'counter matches issued ids');
    assert(!Utils.isLockHeld(), 'script lock released after allocation');
  });
});

/* ============================================================================
 * Phase 2 — Repository, Change_Log, optimistic locking, soft delete
 * ==========================================================================*/

/** Change_Log rows for one record, oldest first. */
function logsFor(tableName, recordId) {
  return Repository.readAll('Change_Log').filter(function (l) {
    return l.Table_Name === tableName && l.Record_ID === recordId;
  });
}

function makeVendor(overrides) {
  var payload = {
    Vendor_Name: 'บริษัท ทดสอบ จำกัด',
    Tax_ID: '0105500000001',
    Contact_Phone: '021112222',
    Contact_Email: 'sales@vendor.example',
    Vendor_Status: 'NEW'
  };
  Object.keys(overrides || {}).forEach(function (k) { payload[k] = overrides[k]; });
  return Repository.insert('Vendors', payload, { actor: 'buyer.a@example.com' });
}

test('Repository.insert fills audit columns and logs a CREATE', function () {
  withFreshDatabase(function () {
    var vendor = makeVendor();

    assertEquals(vendor.Vendor_ID, 'VEN-00001', 'generated id');
    assertEquals(vendor.Version, 1, 'version starts at 1');
    assertEquals(vendor.Is_Deleted, false, 'not deleted');
    assertEquals(vendor.Created_By, 'buyer.a@example.com', 'Created_By');
    assertEquals(vendor.Updated_By, 'buyer.a@example.com', 'Updated_By');
    assert(vendor.Created_At instanceof Date, 'Created_At is a date');

    var logs = logsFor('Vendors', 'VEN-00001');
    assertEquals(logs.length, 1, 'one CREATE entry');
    assertEquals(logs[0].Action, 'CREATE', 'action');
    assertEquals(logs[0].Field, '', 'CREATE has no field (SPEC 5.4)');
    assertContains(logs[0].New_Value, 'Tax_ID=0105500000001', 'CREATE snapshot');

    // Reading it back by id returns the same record.
    var reread = Repository.requireById('Vendors', 'VEN-00001');
    assertEquals(reread.Vendor_Name, 'บริษัท ทดสอบ จำกัด', 'round trip');
  });
});

test('Repository.insert ignores client-supplied ids and audit columns', function () {
  withFreshDatabase(function () {
    var vendor = Repository.insert('Vendors', {
      Vendor_ID: 'VEN-99999',
      Vendor_Name: 'ผู้ขายปลอม',
      Tax_ID: '0105500000002',
      Vendor_Status: 'APPROVED',
      Version: 42,
      Is_Deleted: true,
      Created_By: 'attacker@example.com'
    }, { actor: 'buyer.a@example.com' });

    assertEquals(vendor.Vendor_ID, 'VEN-00001', 'system issues the id');
    assertEquals(vendor.Version, 1, 'client Version ignored');
    assertEquals(vendor.Is_Deleted, false, 'client Is_Deleted ignored');
    assertEquals(vendor.Created_By, 'buyer.a@example.com', 'client Created_By ignored');
  });
});

test('T12 update logs one row per changed field with old, new and reason', function () {
  withFreshDatabase(function () {
    makeVendor();
    var updated = Repository.update('Vendors', 'VEN-00001', {
      Vendor_Name: 'บริษัท ทดสอบ (แก้ไข) จำกัด',
      Contact_Phone: '029998888',
      Vendor_Status: 'NEW'                      // unchanged — must not be logged
    }, 1, { actor: 'head@example.com', reason: 'แก้ชื่อตามหนังสือรับรอง' });

    assertEquals(updated.Version, 2, 'version bumped once for the whole update');
    assertEquals(updated.Updated_By, 'head@example.com', 'Updated_By');

    var changes = logsFor('Vendors', 'VEN-00001').filter(function (l) { return l.Action === 'UPDATE'; });
    assertEquals(changes.length, 2, 'only the two fields that actually changed');

    var byField = {};
    changes.forEach(function (c) { byField[c.Field] = c; });
    assert(!byField.Vendor_Status, 'an unchanged field is not logged');
    assertEquals(byField.Vendor_Name.Old_Value, 'บริษัท ทดสอบ จำกัด', 'old value');
    assertEquals(byField.Vendor_Name.New_Value, 'บริษัท ทดสอบ (แก้ไข) จำกัด', 'new value');
    assertEquals(byField.Vendor_Name.Reason, 'แก้ชื่อตามหนังสือรับรอง', 'reason');
    assertEquals(byField.Contact_Phone.New_Value, '029998888', 'second field');

    // Audit columns never appear as their own log rows.
    changes.forEach(function (c) {
      assert(!Schema.isAuditColumn(c.Field), 'audit column ' + c.Field + ' must not be logged');
    });
  });
});

test('T11 a stale version is rejected with CONFLICT', function () {
  withFreshDatabase(function () {
    makeVendor();

    // Two users opened the same form; both hold version 1.
    Repository.update('Vendors', 'VEN-00001', { Vendor_Name: 'บันทึกโดยคนแรก' }, 1,
      { actor: 'user1@example.com' });

    var error = assertThrowsCode('CONFLICT', function () {
      Repository.update('Vendors', 'VEN-00001', { Vendor_Name: 'บันทึกโดยคนที่สอง' }, 1,
        { actor: 'user2@example.com' });
    }, 'second save must conflict');
    assertEquals(error.details.expected, 1, 'conflict reports the version sent');
    assertEquals(error.details.actual, 2, 'conflict reports the stored version');

    assertEquals(Repository.requireById('Vendors', 'VEN-00001').Vendor_Name, 'บันทึกโดยคนแรก',
      'the losing write changed nothing');

    // Reloading and retrying with the current version succeeds.
    Repository.update('Vendors', 'VEN-00001', { Vendor_Name: 'บันทึกโดยคนที่สอง' }, 2,
      { actor: 'user2@example.com' });
    assertEquals(Repository.requireById('Vendors', 'VEN-00001').Version, 3, 'retry applied');
  });
});

test('update with no real change leaves the version alone', function () {
  withFreshDatabase(function () {
    makeVendor();
    var same = Repository.update('Vendors', 'VEN-00001', { Vendor_Name: 'บริษัท ทดสอบ จำกัด' }, 1,
      { actor: 'buyer.a@example.com' });
    assertEquals(same.Version, 1, 'version unchanged');
    assertEquals(logsFor('Vendors', 'VEN-00001').length, 1, 'only the CREATE entry exists');
  });
});

test('softDelete hides the row, keeps it in the sheet and logs DELETE', function () {
  withFreshDatabase(function () {
    makeVendor();
    var sheetRowsBefore = Config.getSheet('Vendors').getLastRow();

    Repository.softDelete('Vendors', 'VEN-00001', 1, { actor: 'admin@example.com', reason: 'สร้างซ้ำ' });

    assertEquals(Config.getSheet('Vendors').getLastRow(), sheetRowsBefore, 'no row was removed');
    assertEquals(Repository.findById('Vendors', 'VEN-00001'), null, 'hidden from normal reads');
    assert(!!Repository.findById('Vendors', 'VEN-00001', { includeDeleted: true }), 'still reachable for audit');
    assertEquals(Repository.query('Vendors').length, 0, 'excluded from queries');
    assertEquals(Repository.query('Vendors', { includeDeleted: true }).length, 1, 'included when asked');

    var del = logsFor('Vendors', 'VEN-00001').filter(function (l) { return l.Action === 'DELETE'; });
    assertEquals(del.length, 1, 'one DELETE entry');
    assertEquals(del[0].Reason, 'สร้างซ้ำ', 'reason recorded');

    Repository.restore('Vendors', 'VEN-00001', null, { actor: 'admin@example.com', reason: 'ลบผิด' });
    assert(!!Repository.findById('Vendors', 'VEN-00001'), 'restored');
    assertEquals(logsFor('Vendors', 'VEN-00001').filter(function (l) { return l.Action === 'RESTORE'; }).length,
      1, 'one RESTORE entry');
  });
});

test('fieldActions let a caller label a change STATUS_CHANGE instead of UPDATE', function () {
  withFreshDatabase(function () {
    makeVendor();
    Repository.update('Vendors', 'VEN-00001', { Vendor_Status: 'BLACKLIST' }, 1, {
      actor: 'admin@example.com',
      reason: 'พบพฤติกรรมสมยอมราคา',
      fieldActions: { Vendor_Status: ChangeLog.ACTIONS.STATUS_CHANGE }
    });
    var logs = logsFor('Vendors', 'VEN-00001');
    assertEquals(logs[logs.length - 1].Action, 'STATUS_CHANGE', 'action overridden per field');
  });
});

test('updateMany applies a batch and writes all entries at once', function () {
  withFreshDatabase(function () {
    var a = makeVendor({ Tax_ID: '0105500000011', Vendor_Name: 'ผู้ขาย A' });
    var b = makeVendor({ Tax_ID: '0105500000012', Vendor_Name: 'ผู้ขาย B' });

    var result = Repository.updateMany('Vendors', [
      { id: a.Vendor_ID, patch: { Vendor_Status: 'APPROVED' }, version: 1 },
      { id: b.Vendor_ID, patch: { Vendor_Status: 'APPROVED' }, version: 1 }
    ], { actor: 'admin@example.com', reason: 'ผ่านการตรวจสอบ' });

    assertEquals(result.length, 2, 'both returned');
    assertEquals(Repository.requireById('Vendors', a.Vendor_ID).Vendor_Status, 'APPROVED', 'first applied');
    assertEquals(Repository.requireById('Vendors', b.Vendor_ID).Version, 2, 'second version bumped');

    assertThrowsCode('CONFLICT', function () {
      Repository.updateMany('Vendors', [{ id: a.Vendor_ID, patch: { Vendor_Status: 'NEW' }, version: 1 }],
        { actor: 'admin@example.com' });
    }, 'batch honours optimistic locking too');
  });
});

test('Repository coerces types on the way in and out of the sheet', function () {
  withFreshDatabase(function () {
    var stored = Repository.insert('Case_Items', {
      Case_ID: 'SRC-2026-0001',
      Line_No: '2',
      Item_Description: 'จอ LED P4',
      Quantity: '12.5',
      Unit: 'SQM'
    }, { actor: 'buyer.a@example.com' });

    assertEquals(stored.Line_No, 2, 'int coerced');
    assertEquals(stored.Quantity, 12.5, 'number coerced');

    var read = Repository.requireById('Case_Items', stored.Item_Row_ID);
    assertEquals(typeof read.Quantity, 'number', 'reads back as a number');
    assertEquals(read.Is_Deleted, false, 'bool reads back as a boolean');

    assertThrowsCode('VALIDATION', function () {
      Repository.update('Case_Items', stored.Item_Row_ID, { Quantity: 'สิบสอง' }, 1,
        { actor: 'buyer.a@example.com' });
    }, 'non-numeric quantity rejected');
  });
});

test('queryByCase finds only the rows of that Case', function () {
  withFreshDatabase(function () {
    ['SRC-2026-0001', 'SRC-2026-0001', 'SRC-2026-0002'].forEach(function (caseId, i) {
      Repository.insert('Case_Items', {
        Case_ID: caseId, Line_No: i + 1, Item_Description: 'รายการ ' + (i + 1),
        Quantity: 1, Unit: 'PCS'
      }, { actor: 'buyer.a@example.com' });
    });

    assertEquals(Repository.queryByCase('Case_Items', 'SRC-2026-0001').length, 2, 'two rows for case 1');
    assertEquals(Repository.queryByCase('Case_Items', 'SRC-2026-0002').length, 1, 'one row for case 2');
    assertEquals(Repository.queryByCase('Case_Items', 'SRC-2026-0009').length, 0, 'none for an unknown case');
  });
});

test('softDeleteWhere cascades and every removal is logged', function () {
  withFreshDatabase(function () {
    for (var i = 0; i < 3; i++) {
      Repository.insert('Quote_Lines', {
        Case_ID: 'SRC-2026-0001', Case_Vendor_ID: 'CV-000001', Item_Row_ID: 'ITM-00000' + i,
        Vendor_Unit: 'PCS', Vendor_Unit_Price: 100 + i
      }, { actor: 'buyer.a@example.com' });
    }
    var removed = Repository.softDeleteWhere('Quote_Lines', 'Case_Vendor_ID', 'CV-000001',
      { actor: 'buyer.a@example.com', reason: 'ลบ vendor ออกจากงาน' });

    assertEquals(removed, 3, 'all three cascaded');
    assertEquals(Repository.queryByCase('Quote_Lines', 'SRC-2026-0001').length, 0, 'none visible');
    var deletes = Repository.readAll('Change_Log').filter(function (l) {
      return l.Table_Name === 'Quote_Lines' && l.Action === 'DELETE';
    });
    assertEquals(deletes.length, 3, 'one DELETE entry per row');
  });
});

test('Change_Log has no update or delete API', function () {
  assertEquals(typeof ChangeLog.update, 'undefined', 'no ChangeLog.update');
  assertEquals(typeof ChangeLog.remove, 'undefined', 'no ChangeLog.remove');
  assertEquals(Schema.getTable('Change_Log').appendOnly, true, 'schema marks it append-only');
  withFreshDatabase(function () {
    assertThrowsCode('INTERNAL', function () {
      Repository.update('Change_Log', 'LOG-00000001', { Reason: 'แก้ประวัติ' }, null, { actor: 'x@example.com' });
    }, 'Repository refuses to update an append-only table');
  });
});

/* ============================================================================
 * Phase 3 — Auth, roles, api envelope
 * ==========================================================================*/

var USERS = {
  buyerA: 'buyer.a@example.com',
  buyerB: 'buyer.b@example.com',
  head: 'head@example.com',
  auditor: 'auditor@example.com',
  admin: 'admin@example.com',
  outsider: 'nobody@example.com'
};

/** Adds the five standard people to the Users sheet of the current test database. */
function seedUsers() {
  [
    [USERS.buyerA, 'บายเออร์ เอ', 'BUYER', 'CAPEX', true],
    [USERS.buyerB, 'บายเออร์ บี', 'BUYER', 'OPEX', true],
    [USERS.head, 'หัวหน้าจัดซื้อ', 'HEAD', '', true],
    [USERS.auditor, 'ผู้ตรวจสอบ', 'AUDITOR', '', true],
    [USERS.admin, 'ผู้ดูแลระบบ', 'ADMIN', '', true]
  ].forEach(function (u) {
    Repository.insert('Users', {
      Email: u[0], Name: u[1], Role: u[2], Responsible_Scope: u[3], Is_Active: u[4]
    }, { actor: 'setup' });
  });
}

/** Runs fn while the server sees `email` as the caller. */
function asUser(email, fn) {
  Auth.__setUserOverride(email);
  try {
    return fn();
  } finally {
    Auth.__setUserOverride(null);
  }
}

/** A fresh database that already has the five standard users. */
function withUsers(fn) {
  return withFreshDatabase(function (report) {
    seedUsers();
    return fn(report);
  });
}

test('T17 a user who is not in the Users sheet is refused', function () {
  withUsers(function () {
    asUser(USERS.outsider, function () {
      var error = assertApiError(api_bootstrap(), 'UNAUTHORIZED', 'unknown account');
      assertContains(error.message, USERS.outsider, 'the message names the account');
    });
    // An inactive account is refused in the same way.
    var users = Repository.readAll('Users');
    var head = users.filter(function (u) { return u.Email === USERS.head; })[0];
    Repository.update('Users', head.Email, { Is_Active: false }, null, { actor: 'admin' });
    asUser(USERS.head, function () {
      assertApiError(api_bootstrap(), 'UNAUTHORIZED', 'deactivated account');
    });
  });
});

test('api_bootstrap gives each role its own permission set', function () {
  withUsers(function () {
    var buyer = asUser(USERS.buyerA, function () { return assertApiOk(api_bootstrap()); });
    assertEquals(buyer.user.role, 'BUYER', 'role resolved');
    assertEquals(buyer.permissions.canCreateCase, true, 'buyer opens cases');
    assertEquals(buyer.permissions.canApproveException, false, 'buyer cannot approve');
    assertEquals(buyer.permissions.canSeeTeamView, false, 'buyer has no team view');
    assertEquals(buyer.permissions.canSetVendorApproval, false, 'buyer cannot approve vendors');
    assert(buyer.lists.BUDGET_TYPE.length > 0, 'lists are delivered for the dropdowns');
    assert(buyer.statuses.length > 0, 'status master is delivered');
    assertEquals(buyer.settings.MIN_QUOTES, 3, 'settings are delivered');

    var head = asUser(USERS.head, function () { return assertApiOk(api_bootstrap()); });
    assertEquals(head.permissions.canApproveException, true, 'head approves');
    assertEquals(head.permissions.canReassign, true, 'head reassigns');
    assertEquals(head.permissions.canEditAnyCase, true, 'head edits any case');

    var auditor = asUser(USERS.auditor, function () { return assertApiOk(api_bootstrap()); });
    assertEquals(auditor.permissions.canCreateCase, false, 'auditor does not open cases');
    assertEquals(auditor.permissions.canEditAnyCase, false, 'auditor never edits');
    assertEquals(auditor.permissions.canSeeTeamView, true, 'auditor sees the team view');

    var admin = asUser(USERS.admin, function () { return assertApiOk(api_bootstrap()); });
    assertEquals(admin.permissions.canSetVendorApproval, true, 'only admin approves vendors');
    assertEquals(admin.permissions.canEditAnyCase, false, 'admin does not edit cases (SPEC 7)');
  });
});

test('api_clearCache is restricted to ADMIN', function () {
  withUsers(function () {
    asUser(USERS.buyerA, function () {
      assertApiError(api_clearCache(), 'FORBIDDEN', 'buyer may not clear the cache');
    });
    asUser(USERS.head, function () {
      assertApiError(api_clearCache(), 'FORBIDDEN', 'head may not clear the cache');
    });
    asUser(USERS.admin, function () {
      assertEquals(assertApiOk(api_clearCache()).cleared, true, 'admin may');
    });
  });
});

test('the api envelope never leaks a stack trace', function () {
  withUsers(function () {
    asUser(USERS.buyerA, function () {
      var response = handle('api_boom', null, function () {
        throw new Error('ENOENT: secret/internal/path.js line 42');
      });
      assertApiError(response, 'INTERNAL', 'unexpected errors become INTERNAL');
      assertEquals(response.error.message, 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง', 'generic message');
      assertEquals(response.error.details, null, 'no details');
      assertEquals(JSON.stringify(response).indexOf('path.js'), -1, 'nothing internal escapes');
    });
  });
});

test('doGet renders the access-denied page for an unknown account', function () {
  withUsers(function () {
    asUser(USERS.outsider, function () {
      var html = doGet().getContent();
      assertContains(html, 'ไม่มีสิทธิ์เข้าใช้งาน', 'denied heading');
      assertContains(html, USERS.outsider, 'the account is shown');
    });
  });
});

test('escapeHtml neutralises markup in the denied page', function () {
  assertEquals(escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;', 'tags and quotes escaped');
  assertEquals(escapeHtml("O'Brien & Co"), 'O&#39;Brien &amp; Co', 'quote and ampersand escaped');
});

/* ============================================================================
 * Phase 4 — Cases, Items, Drive folders
 * ==========================================================================*/

function newCasePayload(overrides) {
  var payload = {
    Request_Date: '2026-01-15',
    Request_Ref: 'MEMO-2026-001',
    Requester_Name: 'คุณสมชาย ใจดี',
    Requester_Email: 'somchai@example.com',
    Department_Code: 'OPS',
    Method: 'NORMAL',
    Budget_Type: 'CAPEX',
    Sub_Type: 'NEW_LOCATION',
    Description: 'ติดตั้งป้ายบิลบอร์ดจุดใหม่ ถนนพระราม 9',
    Required_Date: '2026-03-01',
    Intake_Complete: true,
    Intake_Note: ''
  };
  Object.keys(overrides || {}).forEach(function (k) { payload[k] = overrides[k]; });
  return payload;
}

/** Opens a Case as buyer A and returns its id. */
function createCaseAs(email, overrides) {
  return asUser(email, function () {
    return assertApiOk(api_createCase(newCasePayload(overrides))).caseRecord.Case_ID;
  });
}

function addItem(email, caseId, overrides) {
  var item = Object.assign({
    Item_Description: 'โครงสร้างเหล็กป้าย',
    Quantity: 2,
    Unit: 'SET',
    Media_Site: 'RAMA9-001',
    Media_Type: 'BILLBOARD'
  }, overrides || {});
  return asUser(email, function () {
    return assertApiOk(api_saveItem(caseId, item)).item;
  });
}

test('T1 opening a Case issues SRC-YYYY-0001, sets INTAKE, makes a folder and logs CREATE', function () {
  withUsers(function () {
    var result = asUser(USERS.buyerA, function () {
      return assertApiOk(api_createCase(newCasePayload()));
    });
    var c = result.caseRecord;

    assertEquals(c.Case_ID, 'SRC-' + IdGenerator.currentYear() + '-0001', 'first case id of the year');
    assertEquals(c.Status, 'INTAKE', 'starts in INTAKE');
    assertEquals(c.Buyer_Owner, USERS.buyerA, 'the creator owns it');
    assertEquals(c.Version, 1, 'version starts at 1');
    assert(!!c.Drive_Folder_ID, 'a Drive folder was created');
    assertDeepEquals(result.warnings, [], 'no warnings for the first case');

    var folder = DriveApp.getFolderById(c.Drive_Folder_ID);
    assertEquals(folder.getName(), c.Case_ID + ' - ติดตั้งป้ายบิลบอร์ดจุดใหม่ ถนนพระราม 9', 'folder name');
    assertEquals(folder.sharing.access, 'DOMAIN', 'folder shared inside the domain only');

    var creates = logsFor('Cases', c.Case_ID).filter(function (l) { return l.Action === 'CREATE'; });
    assertEquals(creates.length, 1, 'one CREATE entry');
    assertEquals(creates[0].User, USERS.buyerA, 'logged against the buyer');
    assertEquals(creates[0].Case_ID, c.Case_ID, 'log row carries the Case_ID');
  });
});

test('creating a Case rejects codes that are not in Config_Lists', function () {
  withUsers(function () {
    asUser(USERS.buyerA, function () {
      assertApiError(api_createCase(newCasePayload({ Department_Code: 'NOT_A_DEPT' })), 'VALIDATION', 'bad department');
      // SUB_TYPE is filtered by Budget_Type, so an OPEX sub-type under CAPEX is invalid.
      assertApiError(api_createCase(newCasePayload({ Budget_Type: 'CAPEX', Sub_Type: 'GENERAL' })),
        'VALIDATION', 'sub-type must belong to the budget type');
      assertApiError(api_createCase(newCasePayload({ Description: '' })), 'VALIDATION', 'description required');
      assertApiError(api_createCase(newCasePayload({ Requester_Email: 'not-an-email' })), 'VALIDATION', 'bad email');
    });
  });
});

test('an auditor cannot open a Case', function () {
  withUsers(function () {
    asUser(USERS.auditor, function () {
      assertApiError(api_createCase(newCasePayload()), 'FORBIDDEN', 'auditors only read');
    });
  });
});

test('a second Case with the same Request_Ref warns but is still created', function () {
  withUsers(function () {
    var first = createCaseAs(USERS.buyerA);
    var second = asUser(USERS.buyerA, function () {
      return assertApiOk(api_createCase(newCasePayload()));
    });
    assertEquals(second.warnings.length, 1, 'one warning');
    assertContains(second.warnings[0], first, 'names the earlier Case');
    assert(!!second.caseRecord.Case_ID, 'the Case was still created');
  });
});

test('T10 a buyer cannot edit another buyer\'s Case', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);

    asUser(USERS.buyerB, function () {
      var error = assertApiError(api_updateCase(caseId, { Description: 'แก้โดยคนอื่น' }, 1), 'FORBIDDEN',
        'buyer B may not edit');
      assertEquals(error.details.owner, USERS.buyerA, 'the error names the owner');

      // Reading it is fine while BUYER_CAN_VIEW_ALL is on.
      var bundle = assertApiOk(api_getCase(caseId));
      assertEquals(bundle.permissions.canEdit, false, 'read-only for buyer B');
    });

    // HEAD may edit any Case.
    asUser(USERS.head, function () {
      assertApiOk(api_updateCase(caseId, { Description: 'แก้โดยหัวหน้า' }, 1));
    });
    assertEquals(Repository.requireById('Cases', caseId).Description, 'แก้โดยหัวหน้า', 'head edit applied');
  });
});

test('BUYER_CAN_VIEW_ALL = FALSE hides other buyers\' Cases', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    Config.setSetting('BUYER_CAN_VIEW_ALL', 'FALSE');

    asUser(USERS.buyerB, function () {
      assertApiError(api_getCase(caseId), 'FORBIDDEN', 'hidden from other buyers');
    });
    asUser(USERS.auditor, function () {
      assertApiOk(api_getCase(caseId), 'auditors always see everything');
    });
  });
});

test('api_updateCase refuses to change owner or status through the back door', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    asUser(USERS.buyerA, function () {
      assertApiError(api_updateCase(caseId, { Buyer_Owner: USERS.buyerB, Status: 'SOURCING_DONE' }, 1),
        'VALIDATION', 'neither field is editable here');
    });
    var stored = Repository.requireById('Cases', caseId);
    assertEquals(stored.Buyer_Owner, USERS.buyerA, 'owner unchanged');
    assertEquals(stored.Status, 'INTAKE', 'status unchanged');
  });
});

test('items get sequential line numbers and appear in the Case bundle', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    var first = addItem(USERS.buyerA, caseId, { Item_Description: 'โครงสร้างเหล็ก' });
    var second = addItem(USERS.buyerA, caseId, { Item_Description: 'งานติดตั้ง', Quantity: 1, Unit: 'JOB' });

    assertEquals(first.Line_No, 1, 'first line');
    assertEquals(second.Line_No, 2, 'second line');

    var bundle = asUser(USERS.buyerA, function () { return assertApiOk(api_getCase(caseId)); });
    assertEquals(bundle.items.length, 2, 'both items returned');
    assertEquals(bundle.items[0].Item_Description, 'โครงสร้างเหล็ก', 'ordered by line number');
    assertEquals(bundle.caseRecord.Case_ID, caseId, 'the case itself');
    assert(!!bundle.driveFolderUrl, 'folder link for the UI');
  });
});

test('item quantity must be greater than zero', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    asUser(USERS.buyerA, function () {
      assertApiError(api_saveItem(caseId, { Item_Description: 'ของ', Quantity: 0, Unit: 'PCS' }),
        'VALIDATION', 'zero quantity');
      assertApiError(api_saveItem(caseId, { Item_Description: 'ของ', Quantity: -5, Unit: 'PCS' }),
        'VALIDATION', 'negative quantity');
      assertApiError(api_saveItem(caseId, { Item_Description: 'ของ', Quantity: 1, Unit: 'BOX' }),
        'VALIDATION', 'unit not in the list');
    });
  });
});

test('editing an item stores a new version and honours optimistic locking', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    var item = addItem(USERS.buyerA, caseId);

    asUser(USERS.buyerA, function () {
      assertApiOk(api_saveItem(caseId, { Item_Row_ID: item.Item_Row_ID, Quantity: 5 }, 1));
      assertApiError(api_saveItem(caseId, { Item_Row_ID: item.Item_Row_ID, Quantity: 9 }, 1),
        'CONFLICT', 'stale version rejected');
    });
    assertEquals(Repository.requireById('Case_Items', item.Item_Row_ID).Quantity, 5, 'first save won');
  });
});

test('an item whose Media_Site is already on an open Case produces a warning', function () {
  withUsers(function () {
    var first = createCaseAs(USERS.buyerA);
    addItem(USERS.buyerA, first, { Media_Site: 'RAMA9-001' });

    var second = createCaseAs(USERS.buyerA, { Request_Ref: 'MEMO-2026-002' });
    var result = asUser(USERS.buyerA, function () {
      return assertApiOk(api_saveItem(second, {
        Item_Description: 'งานซ่อมป้ายเดิม', Quantity: 1, Unit: 'JOB', Media_Site: 'RAMA9-001'
      }));
    });
    assertEquals(result.warnings.length, 1, 'one warning');
    assertContains(result.warnings[0], first, 'names the other Case');
  });
});

test('T13 deleting an item soft-deletes its quote lines and logs every removal', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    var item = addItem(USERS.buyerA, caseId);
    var keep = addItem(USERS.buyerA, caseId, { Item_Description: 'รายการที่เก็บไว้' });

    // Two vendors priced the item that is about to be deleted.
    ['CV-000001', 'CV-000002'].forEach(function (cv) {
      Repository.insert('Quote_Lines', {
        Case_ID: caseId, Case_Vendor_ID: cv, Item_Row_ID: item.Item_Row_ID,
        Vendor_Unit: 'SET', Vendor_Unit_Price: 1000
      }, { actor: USERS.buyerA, caseId: caseId });
    });
    Repository.insert('Quote_Lines', {
      Case_ID: caseId, Case_Vendor_ID: 'CV-000001', Item_Row_ID: keep.Item_Row_ID,
      Vendor_Unit: 'SET', Vendor_Unit_Price: 500
    }, { actor: USERS.buyerA, caseId: caseId });

    var result = asUser(USERS.buyerA, function () {
      return assertApiOk(api_deleteRecord('Case_Items', item.Item_Row_ID, 1, 'ผู้ขอยกเลิกรายการนี้'));
    });

    assertEquals(result.deletedQuoteLines, 2, 'both quote lines cascaded');
    assertEquals(Repository.findById('Case_Items', item.Item_Row_ID), null, 'item hidden');
    assertEquals(Repository.queryByCase('Quote_Lines', caseId).length, 1, 'only the untouched line remains');

    // Nothing was physically removed.
    assert(!!Repository.findById('Case_Items', item.Item_Row_ID, { includeDeleted: true }), 'item row still there');

    var deletes = Repository.readAll('Change_Log').filter(function (l) { return l.Action === 'DELETE'; });
    assertEquals(deletes.length, 3, 'one DELETE entry per removed row');
    deletes.forEach(function (d) { assertEquals(d.Case_ID, caseId, 'every delete is attributed to the Case'); });
  });
});

test('deleting an item without a reason is rejected', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    var item = addItem(USERS.buyerA, caseId);
    asUser(USERS.buyerA, function () {
      assertApiError(api_deleteRecord('Case_Items', item.Item_Row_ID, 1, '  '), 'VALIDATION', 'reason required');
      assertApiError(api_deleteRecord('Cases', caseId, 1, 'ไม่เอาแล้ว'), 'VALIDATION', 'Cases are cancelled, not deleted');
    });
    assert(!!Repository.findById('Case_Items', item.Item_Row_ID), 'item untouched');
  });
});

test('My Cases lists only what the caller may see and flags overdue next actions', function () {
  withUsers(function () {
    var mine = createCaseAs(USERS.buyerA, { Description: 'งานของเอ' });
    createCaseAs(USERS.buyerB, { Request_Ref: 'MEMO-B', Description: 'งานของบี' });

    Repository.insert('Activities', {
      Case_ID: mine, Module: 'M1', Activity_Date: new Date(), Activity_Type: 'EMAIL_RFQ',
      Activity_Description: 'ส่ง RFQ ให้ผู้ขาย', Performed_By: USERS.buyerA,
      Next_Action: 'ตามใบเสนอราคา', Next_Action_Date: '2020-01-01', Next_Action_Done: false
    }, { actor: USERS.buyerA, caseId: mine });

    var own = asUser(USERS.buyerA, function () { return assertApiOk(api_listCases({ scope: 'mine' })); });
    assertEquals(own.cases.length, 1, 'only my own Cases by default');
    assertEquals(own.cases[0].Case_ID, mine, 'the right one');
    assertEquals(own.cases[0].nextAction.overdue, true, 'the overdue next action is flagged');
    assertEquals(own.cases[0].nextAction.text, 'ตามใบเสนอราคา', 'next action text');

    var all = asUser(USERS.buyerA, function () { return assertApiOk(api_listCases({ scope: 'all' })); });
    assertEquals(all.cases.length, 2, 'both Cases when asking for all');

    var filtered = asUser(USERS.buyerA, function () {
      return assertApiOk(api_listCases({ scope: 'all', q: 'งานของบี' }));
    });
    assertEquals(filtered.cases.length, 1, 'text search');
    assertEquals(filtered.cases[0].canEdit, false, 'buyer A cannot edit buyer B\'s Case');

    var byStatus = asUser(USERS.buyerA, function () {
      return assertApiOk(api_listCases({ scope: 'all', status: 'SOURCING_DONE' }));
    });
    assertEquals(byStatus.cases.length, 0, 'status filter');
  });
});

/* ============================================================================
 * Phase 5 — Vendor master, vendors on a Case, the price matrix
 * ==========================================================================*/

function vendorPayload(overrides) {
  return Object.assign({
    Vendor_Name: 'บริษัท ป้ายไทย จำกัด',
    Tax_ID: '0105500000001',
    Address: '99 ถนนพระราม 9 กรุงเทพฯ',
    Contact_Name: 'คุณมานี',
    Contact_Phone: '021112222',
    Contact_Email: 'sales@paithai.example',
    Categories: 'BILLBOARD,STEEL'
  }, overrides || {});
}

function createVendorAs(email, overrides) {
  return asUser(email, function () {
    return assertApiOk(api_createVendor(vendorPayload(overrides)));
  });
}

/** A Case with two items, ready for vendors to be priced against. */
function caseWithItems(email) {
  var caseId = createCaseAs(email);
  var a = addItem(email, caseId, { Item_Description: 'โครงสร้างเหล็ก', Quantity: 2, Unit: 'SET' });
  var b = addItem(email, caseId, { Item_Description: 'งานติดตั้ง', Quantity: 1, Unit: 'JOB' });
  return { caseId: caseId, items: [a, b] };
}

/** Invites a vendor and prices every item, i.e. produces a valid quotation. */
function inviteAndQuote(email, caseId, items, vendorId, prices, quoteNo) {
  return asUser(email, function () {
    var cv = assertApiOk(api_addVendorToCase(caseId, vendorId, {
      Invited_Date: '2026-01-20',
      Invite_Channel: 'EMAIL',
      Response_Status: 'QUOTED',
      Quote_No: quoteNo || 'QT-001',
      Quote_Date: '2026-01-25'
    })).caseVendor;

    assertApiOk(api_saveQuoteLines(cv.Case_Vendor_ID, items.map(function (item, i) {
      return { Item_Row_ID: item.Item_Row_ID, Vendor_Unit: item.Unit, Vendor_Unit_Price: prices[i] };
    })));
    return cv;
  });
}

test('T9 a duplicate Tax_ID is blocked and a duplicate phone only warns', function () {
  withUsers(function () {
    var first = createVendorAs(USERS.buyerA);
    assertDeepEquals(first.warnings, [], 'the first vendor is clean');
    assertEquals(first.vendor.Vendor_Status, 'NEW', 'buyers create vendors as NEW');

    asUser(USERS.buyerA, function () {
      var error = assertApiError(api_createVendor(vendorPayload({ Vendor_Name: 'ชื่ออื่น' })),
        'DUPLICATE', 'same Tax_ID is blocked');
      assertEquals(error.details.existing.Vendor_ID, first.vendor.Vendor_ID, 'the existing vendor is offered');
    });

    // Same phone, different Tax_ID: a red flag the buyer must see, not a block.
    var second = createVendorAs(USERS.buyerA, {
      Vendor_Name: 'บริษัท ป้ายไทย 2 จำกัด',
      Tax_ID: '0105500000002',
      Address: 'ที่อยู่อื่น',
      Contact_Email: 'other@paithai.example'
    });
    assertEquals(second.warnings.length, 1, 'one warning');
    assertContains(second.warnings[0], 'เบอร์โทรศัพท์', 'about the phone number');
    assertContains(second.warnings[0], 'บริษัท ป้ายไทย จำกัด', 'naming the other vendor');
    assert(!!second.vendor.Vendor_ID, 'but the vendor was created');

    asUser(USERS.buyerA, function () {
      assertApiError(api_createVendor(vendorPayload({ Tax_ID: '123' })), 'VALIDATION', 'Tax_ID must be 13 digits');
    });
    // Formatting characters are stripped before the uniqueness check.
    asUser(USERS.buyerA, function () {
      assertApiError(api_createVendor(vendorPayload({ Tax_ID: '0-105-500-000001' })),
        'DUPLICATE', 'dashes do not create a new vendor');
    });
  });
});

test('only an administrator may approve or blacklist a vendor', function () {
  withUsers(function () {
    var vendor = createVendorAs(USERS.buyerA).vendor;

    asUser(USERS.buyerA, function () {
      assertApiError(api_updateVendor(vendor.Vendor_ID, { Vendor_Status: 'APPROVED' }, 1), 'FORBIDDEN', 'buyer');
    });
    asUser(USERS.head, function () {
      assertApiError(api_updateVendor(vendor.Vendor_ID, { Vendor_Status: 'BLACKLIST' }, 1), 'FORBIDDEN', 'head');
    });
    asUser(USERS.admin, function () {
      assertApiOk(api_updateVendor(vendor.Vendor_ID, { Vendor_Status: 'APPROVED' }, 1, 'ตรวจเอกสารครบ'));
    });
    assertEquals(Repository.requireById('Vendors', vendor.Vendor_ID).Vendor_Status, 'APPROVED', 'applied');

    // A buyer may still correct ordinary master data.
    asUser(USERS.buyerA, function () {
      assertApiOk(api_updateVendor(vendor.Vendor_ID, { Contact_Name: 'คุณสมหญิง' }, 2));
    });
  });
});

test('a blacklisted vendor cannot be invited, and no vendor twice', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    var vendor = createVendorAs(USERS.buyerA).vendor;
    asUser(USERS.admin, function () {
      assertApiOk(api_updateVendor(vendor.Vendor_ID, { Vendor_Status: 'BLACKLIST' }, 1, 'สมยอมราคา'));
    });

    asUser(USERS.buyerA, function () {
      assertApiError(api_addVendorToCase(caseId, vendor.Vendor_ID, {}), 'RULE_VIOLATION', 'blacklisted');
    });

    var ok = createVendorAs(USERS.buyerA, { Tax_ID: '0105500000009', Vendor_Name: 'ผู้ขายปกติ',
      Contact_Phone: '029990000', Contact_Email: 'a@b.example', Address: 'ที่อยู่ ก' }).vendor;
    asUser(USERS.buyerA, function () {
      assertApiOk(api_addVendorToCase(caseId, ok.Vendor_ID, {}));
      assertApiError(api_addVendorToCase(caseId, ok.Vendor_ID, {}), 'DUPLICATE', 'same vendor twice');
    });
  });
});

test('marking a vendor QUOTED requires the quotation number and date', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    var vendor = createVendorAs(USERS.buyerA).vendor;

    asUser(USERS.buyerA, function () {
      assertApiError(api_addVendorToCase(caseId, vendor.Vendor_ID, { Response_Status: 'QUOTED' }),
        'VALIDATION', 'quote number required');

      var cv = assertApiOk(api_addVendorToCase(caseId, vendor.Vendor_ID, {
        Response_Status: 'INVITED', Invite_Channel: 'EMAIL'
      })).caseVendor;
      assertEquals(cv.Qualification_Status, 'NOT_CHECKED', 'qualification starts unchecked (M6 reserved)');

      assertApiError(api_updateCaseVendor(cv.Case_Vendor_ID, { Response_Status: 'QUOTED' }, 1, 'ได้รับใบเสนอราคา'),
        'VALIDATION', 'still needs the quote number');

      assertApiOk(api_updateCaseVendor(cv.Case_Vendor_ID, {
        Response_Status: 'QUOTED', Quote_No: 'QT-2026-1', Quote_Date: '2026-01-25'
      }, 1, 'ได้รับใบเสนอราคาทางอีเมล'));
    });
  });
});

test('T8 changing Response_Status needs a reason and is logged as STATUS_CHANGE', function () {
  withUsers(function () {
    var c = caseWithItems(USERS.buyerA);
    var vendor = createVendorAs(USERS.buyerA).vendor;
    var cv = inviteAndQuote(USERS.buyerA, c.caseId, c.items, vendor.Vendor_ID, [1000, 2000]);

    asUser(USERS.buyerA, function () {
      assertApiError(api_updateCaseVendor(cv.Case_Vendor_ID, { Response_Status: 'WITHDRAWN' }, 1),
        'VALIDATION', 'a reason is mandatory');
      assertApiOk(api_updateCaseVendor(cv.Case_Vendor_ID, { Response_Status: 'WITHDRAWN' }, 1,
        'ผู้ขายแจ้งถอนตัวทางโทรศัพท์'));
    });

    var logs = logsFor('Case_Vendors', cv.Case_Vendor_ID);
    var change = logs.filter(function (l) { return l.Field === 'Response_Status'; })[0];
    assertEquals(change.Action, 'STATUS_CHANGE', 'labelled as a status change');
    assertEquals(change.Old_Value, 'QUOTED', 'old value');
    assertEquals(change.New_Value, 'WITHDRAWN', 'new value');
    assertEquals(change.Reason, 'ผู้ขายแจ้งถอนตัวทางโทรศัพท์', 'reason kept');
  });
});

test('the price matrix saves a whole column, computes totals and marks the cheapest', function () {
  withUsers(function () {
    var c = caseWithItems(USERS.buyerA);
    var v1 = createVendorAs(USERS.buyerA, { Vendor_Name: 'ผู้ขาย 1', Tax_ID: '0105500000001' }).vendor;
    var v2 = createVendorAs(USERS.buyerA, {
      Vendor_Name: 'ผู้ขาย 2', Tax_ID: '0105500000002',
      Contact_Phone: '022220000', Contact_Email: 'v2@x.example', Address: 'ที่อยู่ 2'
    }).vendor;

    inviteAndQuote(USERS.buyerA, c.caseId, c.items, v1.Vendor_ID, [1000, 5000], 'QT-1');
    inviteAndQuote(USERS.buyerA, c.caseId, c.items, v2.Vendor_ID, [1200, 4000], 'QT-2');

    var bundle = asUser(USERS.buyerA, function () { return assertApiOk(api_getCase(c.caseId)); });
    assertEquals(bundle.vendors.length, 2, 'both vendors on the Case');

    // Quantity 2 x 1000 + quantity 1 x 5000
    assertEquals(bundle.vendors[0].grandTotal, 7000, 'vendor 1 total');
    assertEquals(bundle.vendors[1].grandTotal, 6400, 'vendor 2 total');
    assertEquals(bundle.vendors[0].lines[0].lineTotal, 2000, 'line total is quantity x unit price');

    assertEquals(bundle.lowestPricePerItem[c.items[0].Item_Row_ID], 1000, 'cheapest on item 1');
    assertEquals(bundle.lowestPricePerItem[c.items[1].Item_Row_ID], 4000, 'cheapest on item 2');

    // Nothing computed is stored.
    var stored = Repository.queryByCase('Quote_Lines', c.caseId)[0];
    assertEquals(stored.lineTotal, undefined, 'no total column in the sheet');
  });
});

test('T12b editing a saved price requires a reason; adding a new one does not', function () {
  withUsers(function () {
    var c = caseWithItems(USERS.buyerA);
    var vendor = createVendorAs(USERS.buyerA).vendor;

    var cv = asUser(USERS.buyerA, function () {
      return assertApiOk(api_addVendorToCase(c.caseId, vendor.Vendor_ID, {
        Response_Status: 'QUOTED', Quote_No: 'QT-1', Quote_Date: '2026-01-25'
      })).caseVendor;
    });

    // First entry of a price is not an edit, so no reason is needed.
    asUser(USERS.buyerA, function () {
      assertApiOk(api_saveQuoteLines(cv.Case_Vendor_ID, [
        { Item_Row_ID: c.items[0].Item_Row_ID, Vendor_Unit: 'SET', Vendor_Unit_Price: 1000 }
      ]));
    });

    var line = Repository.query('Quote_Lines', { indexColumn: 'Case_Vendor_ID', indexValue: cv.Case_Vendor_ID })[0];

    asUser(USERS.buyerA, function () {
      assertApiError(api_saveQuoteLines(cv.Case_Vendor_ID, [
        { Item_Row_ID: c.items[0].Item_Row_ID, Vendor_Unit: 'SET', Vendor_Unit_Price: 1500, Version: line.Version }
      ]), 'VALIDATION', 'changing a price needs a reason');

      assertApiOk(api_saveQuoteLines(cv.Case_Vendor_ID, [
        { Item_Row_ID: c.items[0].Item_Row_ID, Vendor_Unit: 'SET', Vendor_Unit_Price: 1500, Version: line.Version }
      ], 'ผู้ขายส่งใบเสนอราคาฉบับแก้ไข'));
    });

    var logs = logsFor('Quote_Lines', line.Quote_Line_ID)
      .filter(function (l) { return l.Field === 'Vendor_Unit_Price'; });
    assertEquals(logs.length, 1, 'one price change logged');
    assertEquals(logs[0].Old_Value, '1000', 'old price');
    assertEquals(logs[0].New_Value, '1500', 'new price');
    assertEquals(logs[0].Reason, 'ผู้ขายส่งใบเสนอราคาฉบับแก้ไข', 'reason kept');
  });
});

test('a vendor quoting in a different unit produces a warning but saves', function () {
  withUsers(function () {
    var c = caseWithItems(USERS.buyerA);
    var vendor = createVendorAs(USERS.buyerA).vendor;
    var cv = asUser(USERS.buyerA, function () {
      return assertApiOk(api_addVendorToCase(c.caseId, vendor.Vendor_ID, {})).caseVendor;
    });

    var result = asUser(USERS.buyerA, function () {
      return assertApiOk(api_saveQuoteLines(cv.Case_Vendor_ID, [
        { Item_Row_ID: c.items[0].Item_Row_ID, Vendor_Unit: 'SQM', Vendor_Unit_Price: 800 }
      ]));
    });
    assert(result.warnings.some(function (w) { return w.indexOf('หน่วย') !== -1; }), 'unit mismatch warned');
    assertEquals(Repository.query('Quote_Lines', { indexColumn: 'Case_Vendor_ID', indexValue: cv.Case_Vendor_ID }).length,
      1, 'the line was still saved');
  });
});

test('clearing a price removes the quote line, with a reason', function () {
  withUsers(function () {
    var c = caseWithItems(USERS.buyerA);
    var vendor = createVendorAs(USERS.buyerA).vendor;
    var cv = inviteAndQuote(USERS.buyerA, c.caseId, c.items, vendor.Vendor_ID, [1000, 2000]);

    asUser(USERS.buyerA, function () {
      assertApiError(api_saveQuoteLines(cv.Case_Vendor_ID, [
        { Item_Row_ID: c.items[0].Item_Row_ID, Vendor_Unit_Price: '' }
      ]), 'VALIDATION', 'removing a price needs a reason');

      var result = assertApiOk(api_saveQuoteLines(cv.Case_Vendor_ID, [
        { Item_Row_ID: c.items[0].Item_Row_ID, Vendor_Unit_Price: '' }
      ], 'ผู้ขายแจ้งว่าไม่เสนอรายการนี้'));
      assertEquals(result.removed, 1, 'one line removed');
    });
    assertEquals(Repository.query('Quote_Lines', { indexColumn: 'Case_Vendor_ID', indexValue: cv.Case_Vendor_ID }).length,
      1, 'the other line is untouched');
  });
});

test('removing a vendor from a Case takes its prices with it', function () {
  withUsers(function () {
    var c = caseWithItems(USERS.buyerA);
    var vendor = createVendorAs(USERS.buyerA).vendor;
    var cv = inviteAndQuote(USERS.buyerA, c.caseId, c.items, vendor.Vendor_ID, [1000, 2000]);

    var result = asUser(USERS.buyerA, function () {
      return assertApiOk(api_deleteRecord('Case_Vendors', cv.Case_Vendor_ID, 1, 'เพิ่มผิดงาน'));
    });
    assertEquals(result.deletedQuoteLines, 2, 'both prices cascaded');
    assertEquals(Repository.queryByCase('Case_Vendors', c.caseId).length, 0, 'vendor gone from the Case');
    assertEquals(Repository.queryByCase('Quote_Lines', c.caseId).length, 0, 'prices gone too');
    // The vendor master record is untouched.
    assert(!!Repository.findById('Vendors', vendor.Vendor_ID), 'the vendor still exists in the master');
  });
});

test('vendor search and history', function () {
  withUsers(function () {
    var c = caseWithItems(USERS.buyerA);
    var vendor = createVendorAs(USERS.buyerA, { Vendor_Name: 'บริษัท เมกะไซน์ จำกัด' }).vendor;
    inviteAndQuote(USERS.buyerA, c.caseId, c.items, vendor.Vendor_ID, [100, 200], 'QT-7');

    asUser(USERS.buyerA, function () {
      assertEquals(assertApiOk(api_searchVendors('เมกะ')).vendors.length, 1, 'by name');
      assertEquals(assertApiOk(api_searchVendors('0105500000001')).vendors.length, 1, 'by tax id');
      assertEquals(assertApiOk(api_searchVendors('ไม่มีอยู่จริง')).vendors.length, 0, 'no match');

      var history = assertApiOk(api_getVendorHistory(vendor.Vendor_ID)).history;
      assertEquals(history.length, 1, 'one Case in the history');
      assertEquals(history[0].Case_ID, c.caseId, 'the right Case');
      assertEquals(history[0].Quote_No, 'QT-7', 'with its quotation number');
    });
  });
});

test('an upload lands in the Case folder and is shared inside the domain only', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    var base64 = Utilities.base64Encode([80, 68, 70]);

    var file = asUser(USERS.buyerA, function () {
      return assertApiOk(api_uploadFile(caseId, 'ใบเสนอราคา QT-1.pdf', 'application/pdf', base64));
    });
    assert(!!file.url, 'a URL comes back for Quote_File_URL');
    assertEquals(DriveApp.getFileById(file.fileId).sharing.access, 'DOMAIN', 'domain sharing');

    asUser(USERS.buyerB, function () {
      assertApiError(api_uploadFile(caseId, 'x.pdf', 'application/pdf', base64),
        'FORBIDDEN', 'not the owner');
    });
  });
});

/* ============================================================================
 * Phase 6 — Activities
 * ==========================================================================*/

function activityPayload(overrides) {
  return Object.assign({
    Activity_Type: 'EMAIL_RFQ',
    Channel: 'EMAIL',
    Activity_Description: 'ส่งอีเมลขอใบเสนอราคาไปยังผู้ขาย 3 ราย',
    Activity_Date: '2026-01-20T09:30:00.000Z'
  }, overrides || {});
}

test('T10b a buyer may record an activity on a colleague\'s Case, as themselves', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);

    var saved = asUser(USERS.buyerB, function () {
      return assertApiOk(api_saveActivity(caseId, activityPayload())).activity;
    });

    assertEquals(saved.Performed_By, USERS.buyerB, 'recorded against the person who did it');
    assertEquals(saved.Module, 'M1', 'tagged with the module');
    assertEquals(saved.Created_By, USERS.buyerB, 'and in the audit columns');

    // Buyer B still cannot edit the Case itself.
    asUser(USERS.buyerB, function () {
      assertApiError(api_updateCase(caseId, { Description: 'แก้' }, 1), 'FORBIDDEN', 'still no case edit');
    });
  });
});

test('Performed_By cannot be spoofed from the client', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    var saved = asUser(USERS.buyerB, function () {
      return assertApiOk(api_saveActivity(caseId, activityPayload({
        Performed_By: USERS.head, Module: 'M6', Case_ID: 'SRC-9999-0001'
      }))).activity;
    });
    assertEquals(saved.Performed_By, USERS.buyerB, 'the client value is ignored');
    assertEquals(saved.Module, 'M1', 'module is set by the server');
    assertEquals(saved.Case_ID, caseId, 'the Case comes from the URL, not the payload');
  });
});

test('a next action without a due date is rejected', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    asUser(USERS.buyerA, function () {
      assertApiError(api_saveActivity(caseId, activityPayload({ Next_Action: 'โทรตามใบเสนอราคา' })),
        'VALIDATION', 'due date required');
      assertApiOk(api_saveActivity(caseId, activityPayload({
        Next_Action: 'โทรตามใบเสนอราคา', Next_Action_Date: '2026-02-01'
      })));
      assertApiError(api_saveActivity(caseId, activityPayload({ Activity_Type: 'NOT_A_TYPE' })),
        'VALIDATION', 'activity type must be in Config_Lists');
    });
  });
});

test('an activity may only name a vendor that was invited to the Case', function () {
  withUsers(function () {
    var c = caseWithItems(USERS.buyerA);
    var invited = createVendorAs(USERS.buyerA).vendor;
    var stranger = createVendorAs(USERS.buyerA, {
      Tax_ID: '0105500000077', Vendor_Name: 'ผู้ขายที่ไม่ได้เชิญ',
      Contact_Phone: '027770000', Contact_Email: 'z@z.example', Address: 'ที่อยู่ ซี'
    }).vendor;
    inviteAndQuote(USERS.buyerA, c.caseId, c.items, invited.Vendor_ID, [100, 200]);

    asUser(USERS.buyerA, function () {
      assertApiOk(api_saveActivity(c.caseId, activityPayload({
        Vendor_ID: invited.Vendor_ID, Activity_Type: 'CALL'
      })));
      assertApiError(api_saveActivity(c.caseId, activityPayload({ Vendor_ID: stranger.Vendor_ID })),
        'VALIDATION', 'vendor is not on this Case');
    });
  });
});

test('the timeline is newest first and next actions can be ticked off', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);

    asUser(USERS.buyerA, function () {
      assertApiOk(api_saveActivity(caseId, activityPayload({
        Activity_Date: '2026-01-10T03:00:00.000Z', Activity_Description: 'กิจกรรมแรก'
      })));
      assertApiOk(api_saveActivity(caseId, activityPayload({
        Activity_Date: '2026-01-22T03:00:00.000Z', Activity_Description: 'กิจกรรมล่าสุด',
        Next_Action: 'ตามใบเสนอราคา', Next_Action_Date: '2026-02-05'
      })));
    });

    var bundle = asUser(USERS.buyerA, function () { return assertApiOk(api_getCase(caseId)); });
    assertEquals(bundle.activities.length, 2, 'both activities');
    assertEquals(bundle.activities[0].Activity_Description, 'กิจกรรมล่าสุด', 'newest first');

    var latest = bundle.activities[0];
    asUser(USERS.buyerA, function () {
      var done = assertApiOk(api_setNextActionDone(latest.Activity_ID, true, latest.Version)).activity;
      assertEquals(done.Next_Action_Done, true, 'ticked');
    });

    // A completed next action no longer appears on My Cases.
    var list = asUser(USERS.buyerA, function () { return assertApiOk(api_listCases({ scope: 'mine' })); });
    assertEquals(list.cases[0].nextAction, null, 'nothing outstanding');
  });
});

test('a buyer may correct their own activity but not someone else\'s', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    var byB = asUser(USERS.buyerB, function () {
      return assertApiOk(api_saveActivity(caseId, activityPayload())).activity;
    });
    var byA = asUser(USERS.buyerA, function () {
      return assertApiOk(api_saveActivity(caseId, activityPayload({ Activity_Description: 'ของเอ' }))).activity;
    });

    // B fixes their own typo, on someone else's Case.
    asUser(USERS.buyerB, function () {
      assertApiOk(api_saveActivity(caseId, {
        Activity_ID: byB.Activity_ID, Activity_Description: 'แก้คำผิด'
      }, byB.Version));
      assertApiError(api_saveActivity(caseId, {
        Activity_ID: byA.Activity_ID, Activity_Description: 'แก้ของคนอื่น'
      }, byA.Version), 'FORBIDDEN', 'not B\'s entry and not B\'s Case');
    });

    // The Case owner may edit anything on their own Case.
    asUser(USERS.buyerA, function () {
      assertApiOk(api_saveActivity(caseId, {
        Activity_ID: byB.Activity_ID, Channel: 'PHONE'
      }, byB.Version + 1));
    });
    assertEquals(Repository.requireById('Activities', byB.Activity_ID).Performed_By, USERS.buyerB,
      'editing never rewrites who performed it');
  });
});

test('deleting an activity is a soft delete with a reason', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    var activity = asUser(USERS.buyerA, function () {
      return assertApiOk(api_saveActivity(caseId, activityPayload())).activity;
    });

    asUser(USERS.buyerA, function () {
      assertApiError(api_deleteRecord('Activities', activity.Activity_ID, activity.Version, ''),
        'VALIDATION', 'reason required');
      assertApiOk(api_deleteRecord('Activities', activity.Activity_ID, activity.Version, 'บันทึกผิดงาน'));
    });

    assertEquals(Repository.queryByCase('Activities', caseId).length, 0, 'hidden');
    assert(!!Repository.findById('Activities', activity.Activity_ID, { includeDeleted: true }),
      'but still in the sheet for audit');
  });
});

/* ============================================================================
 * Phase 7 — StatusEngine, the three-quote rule, exceptions, reopen, PR numbers
 * ==========================================================================*/

function currentCase(caseId) {
  return Repository.requireById('Cases', caseId);
}

/** Moves a Case, always sending the version the sheet currently holds. */
function moveTo(email, caseId, toStatus, reason) {
  return asUser(email, function () {
    return api_changeStatus(caseId, toStatus, currentCase(caseId).Version, reason);
  });
}

/** Keeps every fixture vendor distinct, so no test trips the Tax_ID rule by accident. */
var vendorSeq = 0;

/** n vendors, each invited, QUOTED and priced on every item of the Case. */
function quoteVendors(email, caseId, items, count, pricesPerVendor) {
  var created = [];
  for (var i = 0; i < count; i++) {
    var n = ++vendorSeq;
    var vendor = createVendorAs(email, {
      Vendor_Name: 'ผู้ขายที่ ' + n,
      Tax_ID: '010550000' + (1000 + n),
      Contact_Phone: '02000' + (1000 + n),
      Contact_Email: 'v' + n + '@example.com',
      Address: 'ที่อยู่ ' + n
    }).vendor;
    var prices = (pricesPerVendor && pricesPerVendor[i]) || items.map(function (_, j) { return 1000 + i * 100 + j; });
    created.push(inviteAndQuote(email, caseId, items, vendor.Vendor_ID, prices, 'QT-' + (i + 1)));
  }
  return created;
}

/** A Case in SOURCING with `count` complete quotations. */
function sourcingCase(email, count) {
  var c = caseWithItems(email);
  var vendors = quoteVendors(email, c.caseId, c.items, count);
  assertApiOk(moveTo(email, c.caseId, 'SOURCING'), 'move to SOURCING');
  return { caseId: c.caseId, items: c.items, caseVendors: vendors };
}

test('T3 three complete quotations allow sourcing to be declared finished', function () {
  withUsers(function () {
    var c = sourcingCase(USERS.buyerA, 3);

    var bundle = asUser(USERS.buyerA, function () { return assertApiOk(api_getCase(c.caseId)); });
    assertEquals(bundle.rules.quotes.valid, 3, 'three usable quotations');
    assertEquals(bundle.rules.quotes.required, 3, 'the configured minimum');
    assertEquals(bundle.rules.blockers.length, 0, 'nothing blocking');
    assert(bundle.nextStatuses.some(function (s) { return s.code === 'SOURCING_DONE'; }),
      'the button is offered');

    var result = assertApiOk(moveTo(USERS.buyerA, c.caseId, 'SOURCING_DONE'));
    assertEquals(result.caseRecord.Status, 'SOURCING_DONE', 'moved');

    var logs = logsFor('Cases', c.caseId).filter(function (l) { return l.Action === 'STATUS_CHANGE'; });
    assertEquals(logs[logs.length - 1].New_Value, 'SOURCING_DONE', 'logged as a status change');
  });
});

test('T4 two quotations without an approved exception cannot finish sourcing', function () {
  withUsers(function () {
    var c = sourcingCase(USERS.buyerA, 2);

    var error = assertApiError(moveTo(USERS.buyerA, c.caseId, 'SOURCING_DONE'), 'RULE_VIOLATION', 'blocked');
    assertContains(error.message, '2', 'the message states how many were found');
    assertEquals(error.details.quotes.valid, 2, 'the count comes back for the UI');
    assertEquals(currentCase(c.caseId).Status, 'SOURCING', 'the Case did not move');
  });
});

test('T5 two quotations plus an exception approved by HEAD are enough', function () {
  withUsers(function () {
    var c = sourcingCase(USERS.buyerA, 2);

    asUser(USERS.buyerA, function () {
      assertApiError(api_requestException(c.caseId, 'SOLE_AGENT', ''), 'VALIDATION', 'a reason is required');
      assertApiError(api_requestException(c.caseId, 'NOT_A_REASON', 'เหตุผล'), 'VALIDATION', 'code must be in the list');
      assertApiOk(api_requestException(c.caseId, 'LIMITED_MARKET', 'ผู้ผลิตป้ายขนาดนี้ในประเทศมีเพียง 2 ราย'));
    });
    assertEquals(currentCase(c.caseId).Exception_Status, 'PENDING', 'awaiting a decision');

    // Still blocked while the request is merely pending.
    assertApiError(moveTo(USERS.buyerA, c.caseId, 'SOURCING_DONE'), 'RULE_VIOLATION', 'pending is not approval');

    asUser(USERS.head, function () {
      assertApiOk(api_decideException(c.caseId, true, 'ตรวจสอบแล้วตลาดมีผู้ขายจำกัดจริง'));
    });
    var approved = currentCase(c.caseId);
    assertEquals(approved.Exception_Status, 'APPROVED', 'approved');
    assertEquals(approved.Exception_Approved_By, USERS.head, 'by the head');
    assert(!!approved.Exception_Approved_At, 'with a timestamp');

    assertEquals(assertApiOk(moveTo(USERS.buyerA, c.caseId, 'SOURCING_DONE')).caseRecord.Status,
      'SOURCING_DONE', 'now it moves');

    var exceptions = logsFor('Cases', c.caseId).filter(function (l) { return l.Action === 'EXCEPTION'; });
    assert(exceptions.length >= 2, 'both the request and the decision are logged');
  });
});

test('T6 a head cannot approve an exception on a Case they own', function () {
  withUsers(function () {
    var c = sourcingCase(USERS.head, 2);

    asUser(USERS.head, function () {
      assertApiOk(api_requestException(c.caseId, 'URGENT', 'งานเร่งด่วนตามคำสั่งผู้บริหาร'));
      var error = assertApiError(api_decideException(c.caseId, true, 'อนุมัติเอง'), 'FORBIDDEN', 'self approval');
      assertEquals(error.details.owner, USERS.head, 'the error names the owner');
    });
    assertEquals(currentCase(c.caseId).Exception_Status, 'PENDING', 'still pending');

    // A buyer cannot decide at all.
    asUser(USERS.buyerA, function () {
      assertApiError(api_decideException(c.caseId, true, 'อนุมัติ'), 'FORBIDDEN', 'buyers do not approve');
    });
  });
});

test('a rejected exception leaves the Case blocked and says so', function () {
  withUsers(function () {
    var c = sourcingCase(USERS.buyerA, 2);
    asUser(USERS.buyerA, function () {
      assertApiOk(api_requestException(c.caseId, 'URGENT', 'ต้องติดตั้งก่อนสิ้นเดือน'));
    });
    asUser(USERS.head, function () {
      assertApiOk(api_decideException(c.caseId, false, 'ยังพอมีเวลาหาผู้ขายเพิ่ม'));
    });

    assertApiError(moveTo(USERS.buyerA, c.caseId, 'SOURCING_DONE'), 'RULE_VIOLATION', 'still blocked');
    var bundle = asUser(USERS.buyerA, function () { return assertApiOk(api_getCase(c.caseId)); });
    assert(bundle.rules.warnings.some(function (w) { return w.indexOf('ถูกปฏิเสธ') !== -1; }),
      'the rejection is explained on the page');
  });
});

test('zero usable quotations is blocked even with an approved exception', function () {
  withUsers(function () {
    var c = caseWithItems(USERS.buyerA);
    assertApiOk(moveTo(USERS.buyerA, c.caseId, 'SOURCING'));

    asUser(USERS.buyerA, function () {
      assertApiOk(api_requestException(c.caseId, 'SOLE_AGENT', 'ตัวแทนจำหน่ายรายเดียวในประเทศ'));
    });
    asUser(USERS.head, function () {
      assertApiOk(api_decideException(c.caseId, true, 'ยืนยันเป็นตัวแทนรายเดียว'));
    });

    var error = assertApiError(moveTo(USERS.buyerA, c.caseId, 'SOURCING_DONE'), 'RULE_VIOLATION', 'nothing to compare');
    assertContains(error.message, 'ยังไม่มีใบเสนอราคาที่ใช้ได้เลย', 'the specific reason');
  });
});

test('an incomplete price column does not count as a usable quotation', function () {
  withUsers(function () {
    var c = caseWithItems(USERS.buyerA);
    quoteVendors(USERS.buyerA, c.caseId, c.items, 2);

    // A third vendor quotes only one of the two items.
    var partial = createVendorAs(USERS.buyerA, {
      Vendor_Name: 'ผู้ขายเสนอไม่ครบ', Tax_ID: '0105500009999',
      Contact_Phone: '029999999', Contact_Email: 'p@example.com', Address: 'ที่อยู่ พี'
    }).vendor;
    var cv = asUser(USERS.buyerA, function () {
      return assertApiOk(api_addVendorToCase(c.caseId, partial.Vendor_ID, {
        Response_Status: 'QUOTED', Quote_No: 'QT-3', Quote_Date: '2026-01-25'
      })).caseVendor;
    });
    asUser(USERS.buyerA, function () {
      assertApiOk(api_saveQuoteLines(cv.Case_Vendor_ID, [
        { Item_Row_ID: c.items[0].Item_Row_ID, Vendor_Unit: 'SET', Vendor_Unit_Price: 900 }
      ]));
    });
    assertApiOk(moveTo(USERS.buyerA, c.caseId, 'SOURCING'));

    var bundle = asUser(USERS.buyerA, function () { return assertApiOk(api_getCase(c.caseId)); });
    assertEquals(bundle.rules.quotes.valid, 2, 'the partial quotation does not count');
    assert(bundle.rules.quotes.rejectedVendors.some(function (r) {
      return r.reason === Rules.REJECTION_REASONS.INCOMPLETE_PRICING;
    }), 'and the reason is spelled out');

    // Turning the setting off makes it count.
    Config.setSetting('REQUIRE_ALL_ITEMS_PRICED', 'FALSE');
    var relaxed = asUser(USERS.buyerA, function () { return assertApiOk(api_getCase(c.caseId)); });
    assertEquals(relaxed.rules.quotes.valid, 3, 'now it counts');
    assertApiOk(moveTo(USERS.buyerA, c.caseId, 'SOURCING_DONE'), 'and sourcing can finish');
  });
});

test('T7 an expiring quotation reverts a finished Case back to sourcing', function () {
  withUsers(function () {
    var c = sourcingCase(USERS.buyerA, 3);
    assertApiOk(moveTo(USERS.buyerA, c.caseId, 'SOURCING_DONE'));

    // One quotation is given an expiry date in the past.
    var cv = c.caseVendors[0];
    asUser(USERS.buyerA, function () {
      assertApiOk(api_updateCaseVendor(cv.Case_Vendor_ID, { Quote_Valid_Until: '2020-12-31' },
        Repository.requireById('Case_Vendors', cv.Case_Vendor_ID).Version, 'ผู้ขายยืนราคาถึงสิ้นปีเท่านั้น'));
    });

    var after = currentCase(c.caseId);
    assertEquals(after.Status, 'SOURCING', 'the Case fell back automatically');

    var reverts = logsFor('Cases', c.caseId).filter(function (l) {
      return l.Action === 'STATUS_CHANGE' && l.New_Value === 'SOURCING' && l.User === 'SYSTEM';
    });
    assertEquals(reverts.length, 1, 'logged once, attributed to SYSTEM');
    assertContains(reverts[0].Reason, 'ย้อนสถานะ', 'and says why');

    var bundle = asUser(USERS.buyerA, function () { return assertApiOk(api_getCase(c.caseId)); });
    assertEquals(bundle.rules.quotes.valid, 2, 'the expired quotation no longer counts');
    assert(bundle.rules.quotes.rejectedVendors.some(function (r) {
      return r.reason === Rules.REJECTION_REASONS.EXPIRED;
    }), 'and it is listed as expired');
  });
});

test('T8b a vendor withdrawing reverts a finished Case back to sourcing', function () {
  withUsers(function () {
    var c = sourcingCase(USERS.buyerA, 3);
    assertApiOk(moveTo(USERS.buyerA, c.caseId, 'SOURCING_DONE'));

    var cv = c.caseVendors[2];
    var result = asUser(USERS.buyerA, function () {
      return assertApiOk(api_updateCaseVendor(cv.Case_Vendor_ID, { Response_Status: 'WITHDRAWN' },
        Repository.requireById('Case_Vendors', cv.Case_Vendor_ID).Version, 'ผู้ขายแจ้งถอนตัว'));
    });

    assertEquals(currentCase(c.caseId).Status, 'SOURCING', 'reverted');
    assert(result.warnings.some(function (w) { return w.indexOf('ย้อนสถานะ') !== -1; }),
      'the buyer is told on the spot');
  });
});

test('deleting an item can also trigger the revert', function () {
  withUsers(function () {
    var c = sourcingCase(USERS.buyerA, 3);
    assertApiOk(moveTo(USERS.buyerA, c.caseId, 'SOURCING_DONE'));

    // Adding an unpriced item makes every quotation incomplete.
    addItem(USERS.buyerA, c.caseId, { Item_Description: 'รายการที่เพิ่งเพิ่ม', Quantity: 1, Unit: 'JOB' });
    assertEquals(currentCase(c.caseId).Status, 'SOURCING', 'reverted after the item was added');
  });
});

test('a buyer may only cancel their own Case while it is still in INTAKE', function () {
  withUsers(function () {
    var early = createCaseAs(USERS.buyerA);
    var later = createCaseAs(USERS.buyerA, { Request_Ref: 'MEMO-2' });
    assertApiOk(moveTo(USERS.buyerA, later, 'SOURCING'));

    assertApiError(moveTo(USERS.buyerA, early, 'CANCELLED'), 'VALIDATION', 'a reason is required');
    assertApiOk(moveTo(USERS.buyerA, early, 'CANCELLED', 'ผู้ขอยกเลิกคำขอ'));
    assertEquals(currentCase(early).Status, 'CANCELLED', 'cancelled');

    assertApiError(moveTo(USERS.buyerA, later, 'CANCELLED', 'ไม่เอาแล้ว'), 'FORBIDDEN',
      'past INTAKE only HEAD may cancel');
    assertApiOk(moveTo(USERS.head, later, 'CANCELLED', 'หน่วยงานถอนคำขอ'));

    // A buyer may never close a Case, even from a status that allows CLOSED.
    var third = sourcingCase(USERS.buyerA, 3);
    assertApiOk(moveTo(USERS.buyerA, third.caseId, 'SOURCING_DONE'));
    assertApiError(moveTo(USERS.buyerA, third.caseId, 'CLOSED'), 'FORBIDDEN', 'closing belongs to HEAD');
    assertApiOk(moveTo(USERS.head, third.caseId, 'CLOSED', 'ส่งมอบครบถ้วน'));
  });
});

test('an illegal transition is refused even for HEAD', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    var error = assertApiError(moveTo(USERS.head, caseId, 'SOURCING_DONE'), 'RULE_VIOLATION',
      'INTAKE does not lead straight to SOURCING_DONE');
    assertDeepEquals(error.details.allowed, ['SOURCING', 'CANCELLED'], 'the legal moves come back');
    assertApiError(moveTo(USERS.head, caseId, 'NEGOTIATION'), 'RULE_VIOLATION', 'a reserved M5 status');
  });
});

test('going backwards requires a reason', function () {
  withUsers(function () {
    var c = sourcingCase(USERS.buyerA, 3);
    assertApiOk(moveTo(USERS.buyerA, c.caseId, 'SOURCING_DONE'));
    assertApiError(moveTo(USERS.buyerA, c.caseId, 'SOURCING'), 'VALIDATION', 'reason required');
    assertApiOk(moveTo(USERS.buyerA, c.caseId, 'SOURCING', 'ต้องหาผู้ขายเพิ่มตามที่หัวหน้าสั่ง'));
    assertEquals(currentCase(c.caseId).Status, 'SOURCING', 'moved back');
  });
});

test('T14 a closed Case is frozen until HEAD reopens it', function () {
  withUsers(function () {
    var c = sourcingCase(USERS.buyerA, 3);
    assertApiOk(moveTo(USERS.buyerA, c.caseId, 'SOURCING_DONE'));
    assertApiOk(moveTo(USERS.head, c.caseId, 'CLOSED', 'ส่งมอบเรียบร้อย'));
    assert(!!currentCase(c.caseId).Closed_At, 'Closed_At is stamped');

    asUser(USERS.buyerA, function () {
      assertApiError(api_updateCase(c.caseId, { Description: 'แก้หลังปิดงาน' },
        currentCase(c.caseId).Version), 'FORBIDDEN', 'no edits');
      assertApiError(api_saveActivity(c.caseId, activityPayload()), 'FORBIDDEN', 'no activities either');
      assertApiError(api_reopenCase(c.caseId, 'ขอเปิดใหม่'), 'FORBIDDEN', 'buyers cannot reopen');
    });

    asUser(USERS.head, function () {
      assertApiError(api_reopenCase(c.caseId, ''), 'VALIDATION', 'reopen needs a reason');
      var result = assertApiOk(api_reopenCase(c.caseId, 'หน่วยงานขอแก้ไขรายการเพิ่ม'));
      assertEquals(result.restoredTo, 'SOURCING_DONE', 'restored to the status it held before closing');
    });

    assertEquals(currentCase(c.caseId).Status, 'SOURCING_DONE', 'back where it was');
    assertEquals(currentCase(c.caseId).Closed_At, null, 'Closed_At cleared');

    var reopens = logsFor('Cases', c.caseId).filter(function (l) { return l.Action === 'REOPEN'; });
    assertEquals(reopens.length, 1, 'logged as REOPEN');
    assertEquals(reopens[0].Reason, 'หน่วยงานขอแก้ไขรายการเพิ่ม', 'with the reason');

    // And it is editable again.
    asUser(USERS.buyerA, function () {
      assertApiOk(api_updateCase(c.caseId, { Description: 'แก้ไขหลัง reopen' }, currentCase(c.caseId).Version));
    });
  });
});

test('reopening a cancelled Case that never moved returns it to INTAKE', function () {
  withUsers(function () {
    var caseId = createCaseAs(USERS.buyerA);
    assertApiOk(moveTo(USERS.buyerA, caseId, 'CANCELLED', 'ผู้ขอยกเลิก'));
    asUser(USERS.head, function () {
      assertEquals(assertApiOk(api_reopenCase(caseId, 'ผู้ขอกลับมายืนยันว่าต้องการ')).restoredTo,
        'INTAKE', 'back to the start');
    });
    asUser(USERS.head, function () {
      assertApiError(api_reopenCase(caseId, 'อีกครั้ง'), 'VALIDATION', 'an open Case needs no reopen');
    });
  });
});

test('T16 a PR number can only be recorded once sourcing is finished, and only once', function () {
  withUsers(function () {
    var c = sourcingCase(USERS.buyerA, 3);
    var other = sourcingCase(USERS.buyerB, 3);

    asUser(USERS.buyerA, function () {
      assertApiError(api_addReference(c.caseId, { Ref_Type: 'PR', Ref_No: 'PR-2026-0001' }),
        'RULE_VIOLATION', 'too early');
    });

    assertApiOk(moveTo(USERS.buyerA, c.caseId, 'SOURCING_DONE'));

    asUser(USERS.buyerA, function () {
      var saved = assertApiOk(api_addReference(c.caseId, {
        Ref_Type: 'PR', Ref_No: 'PR-2026-0001', Ref_Date: '2026-02-01', Amount: 250000
      })).reference;
      assertEquals(saved.Ref_Type, 'PR', 'stored as a PR');

      // One Case may carry several PR numbers (SPEC §14.3).
      assertApiOk(api_addReference(c.caseId, { Ref_Type: 'PR', Ref_No: 'PR-2026-0002' }));

      // PO and GR are reserved for later modules.
      assertApiError(api_addReference(c.caseId, { Ref_Type: 'PO', Ref_No: 'PO-1' }),
        'RULE_VIOLATION', 'PO is reserved');
    });

    assertApiOk(moveTo(USERS.buyerB, other.caseId, 'SOURCING_DONE'));
    asUser(USERS.buyerB, function () {
      var error = assertApiError(api_addReference(other.caseId, { Ref_Type: 'PR', Ref_No: 'PR-2026-0001' }),
        'DUPLICATE', 'the same PR number on two Cases');
      assertEquals(error.details.caseId, c.caseId, 'and it names the Case already using it');
    });

    var bundle = asUser(USERS.buyerA, function () { return assertApiOk(api_getCase(c.caseId)); });
    assertEquals(bundle.references.length, 2, 'both references come back with the Case');
  });
});

test('the Change_Log of a Case is readable by anyone who may read the Case', function () {
  withUsers(function () {
    var c = sourcingCase(USERS.buyerA, 3);
    assertApiOk(moveTo(USERS.buyerA, c.caseId, 'SOURCING_DONE'));

    var entries = asUser(USERS.auditor, function () {
      return assertApiOk(api_getChangeLog(c.caseId)).entries;
    });
    assert(entries.length > 5, 'a full history is there');
    assertEquals(entries[0].Timestamp > entries[entries.length - 1].Timestamp, true, 'newest first');
    assert(entries.every(function (e) { return !!e.Action && !!e.User; }), 'every entry is attributed');

    Config.setSetting('BUYER_CAN_VIEW_ALL', 'FALSE');
    asUser(USERS.buyerB, function () {
      assertApiError(api_getChangeLog(c.caseId), 'FORBIDDEN', 'not readable if the Case is not');
    });
  });
});

test('a module can register its own transition rule without touching Rules.js', function () {
  withUsers(function () {
    var calls = [];
    StatusEngine.registerRule('INTAKE', 'SOURCING', function (ctx) {
      calls.push(ctx.to);
      throw Err.ruleViolation('กฎของโมดูลสมมติ: ยังเริ่มหา Vendor ไม่ได้');
    });
    try {
      var caseId = createCaseAs(USERS.buyerA);
      var error = assertApiError(moveTo(USERS.buyerA, caseId, 'SOURCING'), 'RULE_VIOLATION', 'the new rule ran');
      assertContains(error.message, 'โมดูลสมมติ', 'and its message is what the user sees');
      assertEquals(calls.length, 1, 'called once');
      assertEquals(currentCase(caseId).Status, 'INTAKE', 'the Case did not move');
    } finally {
      // Put the registry back the way Rules.js left it.
      StatusEngine.__resetRegistry();
      StatusEngine.registerRule('SOURCING', 'SOURCING_DONE', Rules.minQuotes);
      StatusEngine.registerRecheck(Rules.recheckMinQuotes);
    }
  });
});
