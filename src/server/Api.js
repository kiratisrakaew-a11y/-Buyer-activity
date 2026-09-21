/**
 * Api.js — every function the client may call, and nothing else.
 *
 * Contract (SPEC §9):
 *   success -> { ok: true,  data }
 *   failure -> { ok: false, error: { code, message, details } }
 * Non-blocking warnings travel inside data.warnings (SPEC §6.2).
 *
 * handle() resolves the caller, enforces the role list and converts any thrown
 * error into the envelope, so no api_* function can accidentally skip the check
 * or leak a stack trace to the browser.
 */

/** Roles are named here rather than inline so the permission table stays readable. */
var API_ROLES = {
  ANY: null,
  BUYER_HEAD: ['BUYER', 'HEAD'],
  HEAD_ONLY: ['HEAD'],
  ADMIN_ONLY: ['ADMIN'],
  VENDOR_EDITORS: ['BUYER', 'HEAD', 'ADMIN'],
  TEAM_VIEWERS: ['HEAD', 'AUDITOR', 'ADMIN']
};

function handle(name, allowedRoles, fn) {
  try {
    var user = Auth.getCurrentUser();
    if (allowedRoles) Auth.requireRole(user, allowedRoles);
    return { ok: true, data: fn(user) };
  } catch (e) {
    return toErrorResponse(name, e);
  }
}

/** Logs the detail for the developer, returns only what is safe for the user. */
function toErrorResponse(name, e) {
  if (isAppError(e)) {
    if (e.code === ERROR_CODES.INTERNAL) {
      console.error(name + ' failed: ' + e.message + '\n' + (e.stack || ''));
    }
    return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
  }
  console.error(name + ' failed unexpectedly: ' + ((e && e.message) || e) + '\n' + ((e && e.stack) || ''));
  return {
    ok: false,
    error: { code: ERROR_CODES.INTERNAL, message: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง', details: null }
  };
}

/* ------------------------------------------------------------------ bootstrap */

/**
 * Everything the single-page client needs before it can render anything:
 * the current user, their permissions, all dropdown lists and the status graph.
 */
function api_bootstrap() {
  return handle('api_bootstrap', API_ROLES.ANY, function (user) {
    return {
      user: { email: user.email, name: user.name, role: user.role, scope: user.scope },
      permissions: Auth.permissions(user),
      lists: Config.getAllLists(),
      statuses: Config.getStatusMaster(),
      settings: {
        MIN_QUOTES: Config.getNumber('MIN_QUOTES', 3),
        REQUIRE_ALL_ITEMS_PRICED: Config.getBool('REQUIRE_ALL_ITEMS_PRICED', true),
        SPECIAL_REQUIRES_EXCEPTION: Config.getBool('SPECIAL_REQUIRES_EXCEPTION', true),
        BUYER_CAN_VIEW_ALL: Config.getBool('BUYER_CAN_VIEW_ALL', true),
        APP_TIMEZONE: Config.getTimezone()
      },
      buyers: Auth.listBuyers()
    };
  });
}

/** Admins clear the config cache after editing the Config sheets (SPEC §11). */
function api_clearCache() {
  return handle('api_clearCache', API_ROLES.ADMIN_ONLY, function () {
    Config.clearCache();
    Repository.resetCache();
    return { cleared: true };
  });
}

/* ----------------------------------------------------------------- cases */

function api_listCases(filter) {
  return handle('api_listCases', API_ROLES.ANY, function (user) {
    return CaseService.list(user, filter || {});
  });
}

function api_getCase(caseId) {
  return handle('api_getCase', API_ROLES.ANY, function (user) {
    return CaseService.getBundle(user, caseId);
  });
}

function api_createCase(payload) {
  return handle('api_createCase', API_ROLES.BUYER_HEAD, function (user) {
    return CaseService.create(user, payload || {});
  });
}

function api_updateCase(caseId, patch, version, reason) {
  return handle('api_updateCase', API_ROLES.BUYER_HEAD, function (user) {
    return CaseService.update(user, caseId, patch || {}, version, reason);
  });
}

/* ----------------------------------------------------------------- items */

function api_saveItem(caseId, item, version, reason) {
  return handle('api_saveItem', API_ROLES.BUYER_HEAD, function (user) {
    return ItemService.save(user, caseId, item || {}, version, reason);
  });
}

/* ---------------------------------------------------------------- delete */

/**
 * One delete entry point for every table (SPEC §9). The handler for a table owns
 * its cascade, so a caller cannot delete a parent and orphan its children.
 * A reason is always required (SPEC §6.3).
 */
var DELETE_HANDLERS = {
  Case_Items: function (user, record, version, reason) {
    return ItemService.remove(user, record.Case_ID, record.Item_Row_ID, version, reason);
  }
};

function api_deleteRecord(tableName, recordId, version, reason) {
  return handle('api_deleteRecord', API_ROLES.BUYER_HEAD, function (user) {
    var deleter = DELETE_HANDLERS[tableName];
    if (!deleter) {
      throw Err.validation('ไม่รองรับการลบข้อมูลในตาราง ' + tableName, { table: tableName });
    }
    var record = Repository.requireById(tableName, recordId);
    return deleter(user, record, version, reason);
  });
}
