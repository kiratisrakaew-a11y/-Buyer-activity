/**
 * CaseService.js — the Case is the spine of the system (SPEC §2.1).
 *
 * Every other table hangs off Case_ID, which the system issues itself, because a
 * PR number only exists after a vendor has been chosen and so cannot identify the
 * work while it is being done.
 */
var CaseService = (function () {

  var INITIAL_STATUS = 'INTAKE';

  /** Fields a buyer fills in. Status, owner and the exception fields move through
   *  their own operations so each one can carry its own rule and audit action. */
  var EDITABLE_FIELDS = [
    'Request_Date', 'Request_Ref', 'Requester_Name', 'Requester_Email',
    'Department_Code', 'Method', 'Budget_Type', 'Sub_Type', 'Description',
    'Required_Date', 'Intake_Complete', 'Intake_Note'
  ];

  var DEFAULT_LIST_LIMIT = 300;

  /* ----------------------------------------------------------------- create */

  function create(user, payload) {
    Auth.requireRole(user, [Auth.ROLES.BUYER, Auth.ROLES.HEAD]);

    var values = pick(payload, EDITABLE_FIELDS);
    values.Buyer_Owner = user.email;
    values.Status = INITIAL_STATUS;
    values.Intake_Complete = Utils.toBool(values.Intake_Complete);
    Validation.validate('Cases', values, { partial: false });

    var warnings = duplicateCaseWarnings(values.Request_Ref);

    // The folder is named after the Case, so the id is reserved first and the
    // record is then written once: one version, one CREATE entry in the log.
    var caseId = IdGenerator.next('Cases');
    // SPEC §3 — a Drive folder per Case, created at the moment the Case is opened.
    var folderId = DriveService.createCaseFolder(caseId, values.Description);
    if (!folderId) {
      warnings.push('สร้างโฟลเดอร์ใน Google Drive ไม่สำเร็จ ระบบจะสร้างให้อีกครั้งเมื่อมีการอัปโหลดไฟล์');
    }
    values.Drive_Folder_ID = folderId || '';

    var created = Repository.insert('Cases', values, { actor: user.email, id: caseId });
    return { caseRecord: Repository.toClient(created), warnings: warnings };
  }

  /** SPEC §6.2 — opening a Case whose Request_Ref matches a live one is a warning,
   *  never a block: the same memo legitimately spawns more than one purchase. */
  function duplicateCaseWarnings(requestRef) {
    if (Utils.isBlank(requestRef)) return [];
    var matches = Repository.query('Cases', {
      where: function (c) {
        return Utils.normalizeForCompare(c.Request_Ref) === Utils.normalizeForCompare(requestRef) &&
          !Auth.isTerminal(c.Status);
      }
    });
    if (matches.length === 0) return [];
    return ['มีงานที่ยังเปิดอยู่และใช้เอกสารอ้างอิงเดียวกัน: ' +
      matches.map(function (c) { return c.Case_ID; }).join(', ')];
  }

  /** SPEC §6.2 — the same check for Media_Site, run when items are saved. */
  function duplicateMediaSiteWarnings(caseId, mediaSite) {
    if (Utils.isBlank(mediaSite)) return [];
    var openCases = {};
    Repository.query('Cases', {
      where: function (c) { return !Auth.isTerminal(c.Status) && c.Case_ID !== caseId; }
    }).forEach(function (c) { openCases[c.Case_ID] = true; });

    var hits = Repository.query('Case_Items', {
      where: function (item) {
        return openCases[item.Case_ID] === true &&
          Utils.normalizeForCompare(item.Media_Site) === Utils.normalizeForCompare(mediaSite);
      }
    });
    if (hits.length === 0) return [];
    return ['ป้าย/จุดติดตั้ง "' + mediaSite + '" ปรากฏในงานที่ยังเปิดอยู่: ' +
      Utils.unique(hits.map(function (h) { return h.Case_ID; })).join(', ')];
  }

  /* ------------------------------------------------------------------- read */

  function requireCase(caseId) {
    return Repository.requireById('Cases', caseId);
  }

  function getForView(user, caseId) {
    return Auth.assertCanViewCase(user, requireCase(caseId));
  }

  function getForEdit(user, caseId) {
    return Auth.assertCanEditCase(user, requireCase(caseId));
  }

  /**
   * Everything Case Detail needs in one round trip (SPEC §9 api_getCase):
   * the Case, its items, the vendors invited with their quote lines, activities,
   * document references, and the totals computed from quantity x unit price.
   */
  function getBundle(user, caseId) {
    var caseRecord = getForView(user, caseId);

    var items = sortBy(Repository.queryByCase('Case_Items', caseId), 'Line_No');
    var caseVendors = Repository.queryByCase('Case_Vendors', caseId);
    var quoteLines = Repository.queryByCase('Quote_Lines', caseId);
    var activities = Repository.queryByCase('Activities', caseId);
    var references = Repository.queryByCase('Case_References', caseId);

    var vendorMaster = vendorsById(caseVendors.map(function (cv) { return cv.Vendor_ID; }));
    var quantityByItem = {};
    items.forEach(function (item) { quantityByItem[item.Item_Row_ID] = Number(item.Quantity) || 0; });

    var vendors = caseVendors.map(function (cv) {
      var master = vendorMaster[cv.Vendor_ID] || null;
      var lines = quoteLines.filter(function (q) { return q.Case_Vendor_ID === cv.Case_Vendor_ID; });
      return {
        caseVendor: Repository.toClient(cv),
        vendor: master ? Repository.toClient(master) : null,
        lines: lines.map(function (line) {
          return Object.assign(Repository.toClient(line), {
            lineTotal: lineTotal(line, quantityByItem)
          });
        }),
        grandTotal: lines.reduce(function (sum, line) { return sum + lineTotal(line, quantityByItem); }, 0)
      };
    });

    activities.sort(function (a, b) {
      return Utils.toDate(b.Activity_Date).getTime() - Utils.toDate(a.Activity_Date).getTime();
    });

    return {
      caseRecord: Repository.toClient(caseRecord),
      items: items.map(Repository.toClient),
      vendors: vendors,
      activities: activities.map(Repository.toClient),
      references: sortBy(references, 'Ref_Date').map(Repository.toClient),
      lowestPricePerItem: lowestPricePerItem(items, vendors),
      driveFolderUrl: DriveService.folderUrl(caseRecord.Drive_Folder_ID),
      permissions: {
        canEdit: Auth.canEditCase(user, caseRecord),
        canLogActivity: Auth.canLogActivity(user, caseRecord),
        isOwner: Auth.isOwner(user, caseRecord)
      },
      rules: typeof Rules === 'undefined' ? null : Rules.evaluate(caseRecord, {
        items: items, caseVendors: caseVendors, quoteLines: quoteLines
      }),
      nextStatuses: typeof StatusEngine === 'undefined' ? [] : StatusEngine.allowedNextFor(user, caseRecord)
    };
  }

  /** SPEC §2.4 — totals are never stored, always computed from quantity x price. */
  function lineTotal(line, quantityByItem) {
    var quantity = quantityByItem[line.Item_Row_ID];
    if (quantity === undefined) return 0;
    return quantity * (Number(line.Vendor_Unit_Price) || 0);
  }

  /** Cheapest unit price per item, so the matrix can highlight it (SPEC §8.2). */
  function lowestPricePerItem(items, vendors) {
    var lowest = {};
    items.forEach(function (item) { lowest[item.Item_Row_ID] = null; });
    vendors.forEach(function (v) {
      v.lines.forEach(function (line) {
        var price = Number(line.Vendor_Unit_Price);
        if (isNaN(price)) return;
        if (lowest[line.Item_Row_ID] === null || price < lowest[line.Item_Row_ID]) {
          lowest[line.Item_Row_ID] = price;
        }
      });
    });
    return lowest;
  }

  function vendorsById(vendorIds) {
    var wanted = {};
    Utils.unique(vendorIds).forEach(function (id) { wanted[id] = true; });
    var out = {};
    Repository.query('Vendors', { includeDeleted: true }).forEach(function (v) {
      if (wanted[v.Vendor_ID]) out[v.Vendor_ID] = v;
    });
    return out;
  }

  /* ----------------------------------------------------------------- update */

  function update(user, caseId, patch, version, reason) {
    var caseRecord = getForEdit(user, caseId);
    var clean = pick(patch, EDITABLE_FIELDS);
    if (Object.keys(clean).length === 0) {
      throw Err.validation('ไม่มีข้อมูลที่แก้ไขได้ในคำขอนี้');
    }
    if (Object.prototype.hasOwnProperty.call(clean, 'Intake_Complete')) {
      clean.Intake_Complete = Utils.toBool(clean.Intake_Complete);
    }
    Validation.validate('Cases', clean, { partial: true, existing: caseRecord });

    var updated = Repository.update('Cases', caseId, clean, version, {
      actor: user.email,
      reason: Utils.isBlank(reason) ? '' : String(reason).trim(),
      caseId: caseId
    });

    var warnings = [];
    if (typeof Rules !== 'undefined') {
      warnings = warnings.concat(Rules.recheckCaseRules(caseId).messages);
    }
    return { caseRecord: Repository.toClient(updated), warnings: warnings };
  }

  /* ------------------------------------------------------------------- list */

  /**
   * The Case list, filtered and scoped by what the caller is allowed to see.
   * filter: { scope: 'mine'|'all', status, budgetType, from, to, q, owner, limit }
   */
  function list(user, filter) {
    var f = filter || {};
    var scope = f.scope || 'mine';
    var from = Utils.startOfDay(f.from);
    var to = Utils.startOfDay(f.to);
    var q = Utils.isBlank(f.q) ? '' : String(f.q).trim().toLowerCase();

    var cases = Repository.query('Cases', {
      where: function (c) {
        if (scope === 'mine' && String(c.Buyer_Owner).toLowerCase() !== user.email) return false;
        if (!Utils.isBlank(f.owner) && String(c.Buyer_Owner).toLowerCase() !== String(f.owner).toLowerCase()) return false;
        if (!Utils.isBlank(f.status) && c.Status !== f.status) return false;
        if (!Utils.isBlank(f.budgetType) && c.Budget_Type !== f.budgetType) return false;
        var requested = Utils.startOfDay(c.Request_Date);
        if (from && (!requested || requested.getTime() < from.getTime())) return false;
        if (to && (!requested || requested.getTime() > to.getTime())) return false;
        if (q && !matchesText(c, q)) return false;
        return Auth.canViewCase(user, c);
      }
    });

    cases.sort(function (a, b) {
      var left = Utils.toDate(a.Created_At);
      var right = Utils.toDate(b.Created_At);
      return (right ? right.getTime() : 0) - (left ? left.getTime() : 0);
    });

    var limit = Number(f.limit) > 0 ? Number(f.limit) : DEFAULT_LIST_LIMIT;
    var truncated = cases.length > limit;
    var page = cases.slice(0, limit);
    var nextActions = nextActionByCase(page.map(function (c) { return c.Case_ID; }));
    var quoteCounts = typeof Rules === 'undefined' ? {} : Rules.summarizeCases(page);

    return {
      total: cases.length,
      truncated: truncated,
      cases: page.map(function (c) {
        return Object.assign(Repository.toClient(c), {
          nextAction: nextActions[c.Case_ID] || null,
          quotes: quoteCounts[c.Case_ID] || null,
          canEdit: Auth.canEditCase(user, c)
        });
      })
    };
  }

  function matchesText(c, q) {
    return [c.Case_ID, c.Description, c.Request_Ref, c.Requester_Name, c.Buyer_Owner]
      .some(function (v) { return String(v || '').toLowerCase().indexOf(q) !== -1; });
  }

  /**
   * The earliest outstanding Next_Action per Case, which is what My Cases
   * highlights when it is overdue (SPEC §8.1).
   */
  function nextActionByCase(caseIds) {
    if (caseIds.length === 0) return {};
    var wanted = {};
    caseIds.forEach(function (id) { wanted[id] = true; });

    var out = {};
    var today = Utils.today();
    Repository.query('Activities', {
      where: function (a) {
        return wanted[a.Case_ID] === true && !Utils.isBlank(a.Next_Action) && a.Next_Action_Done !== true;
      }
    }).forEach(function (a) {
      var due = Utils.startOfDay(a.Next_Action_Date);
      var current = out[a.Case_ID];
      if (current && current.dueTime !== null && due && due.getTime() >= current.dueTime) return;
      out[a.Case_ID] = {
        activityId: a.Activity_ID,
        text: a.Next_Action,
        date: due ? due.toISOString() : '',
        dueTime: due ? due.getTime() : null,
        overdue: !!due && due.getTime() < today.getTime()
      };
    });
    return out;
  }

  /* ---------------------------------------------------------------- helpers */

  function pick(source, fields) {
    var out = {};
    fields.forEach(function (field) {
      if (source && Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field];
    });
    return out;
  }

  function sortBy(rows, field) {
    return rows.slice().sort(function (a, b) {
      var left = a[field];
      var right = b[field];
      if (left instanceof Date || right instanceof Date) {
        return (Utils.toDate(left) ? Utils.toDate(left).getTime() : 0) -
          (Utils.toDate(right) ? Utils.toDate(right).getTime() : 0);
      }
      return (Number(left) || 0) - (Number(right) || 0);
    });
  }

  return {
    INITIAL_STATUS: INITIAL_STATUS,
    EDITABLE_FIELDS: EDITABLE_FIELDS,
    create: create,
    requireCase: requireCase,
    getForView: getForView,
    getForEdit: getForEdit,
    getBundle: getBundle,
    update: update,
    list: list,
    duplicateCaseWarnings: duplicateCaseWarnings,
    duplicateMediaSiteWarnings: duplicateMediaSiteWarnings,
    nextActionByCase: nextActionByCase,
    lineTotal: lineTotal
  };
})();
