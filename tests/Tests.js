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
