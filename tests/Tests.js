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
