/**
 * Rules.js — the Module 1 business rule: at least three usable quotations
 * before sourcing can be declared finished (SPEC §6.1).
 *
 * One function decides what counts as a usable quotation, and everything else
 * reads from it: the badge on My Cases, the badge on Case Detail, the check that
 * guards the transition, and the recheck that pulls a Case back when the ground
 * shifts under it. That is deliberate — if those four ever disagreed, the audit
 * trail would be worthless.
 */
var Rules = (function () {

  var SOURCING = 'SOURCING';
  var SOURCING_DONE = 'SOURCING_DONE';

  /** Why one particular vendor's quotation does not count. */
  var REJECTION_REASONS = {
    NOT_QUOTED: 'ยังไม่ได้เสนอราคา',
    FAILED_QUALIFICATION: 'ไม่ผ่านการตรวจคุณสมบัติ',
    EXPIRED: 'ใบเสนอราคาหมดอายุแล้ว',
    BLACKLISTED: 'ผู้ขายอยู่ในบัญชีดำ',
    INCOMPLETE_PRICING: 'เสนอราคาไม่ครบทุกรายการ'
  };

  /* ------------------------------------------------------------ evaluation */

  function loadData(caseId) {
    return {
      items: Repository.queryByCase('Case_Items', caseId),
      caseVendors: Repository.queryByCase('Case_Vendors', caseId),
      quoteLines: Repository.queryByCase('Quote_Lines', caseId)
    };
  }

  /**
   * Splits the vendors on a Case into those whose quotation counts and those
   * whose does not, with the reason. SPEC §6.1 lists six conditions; all must hold.
   */
  function assessQuotes(caseRecord, data, vendorMaster) {
    var requireAllItemsPriced = Config.getBool('REQUIRE_ALL_ITEMS_PRICED', true);
    var today = Utils.today();
    var master = vendorMaster || vendorsById(data.caseVendors);

    var valid = [];
    var rejected = [];

    data.caseVendors.forEach(function (cv) {
      var vendor = master[cv.Vendor_ID] || null;
      var name = vendor ? vendor.Vendor_Name : cv.Vendor_ID;
      var reason = null;

      if (cv.Response_Status !== 'QUOTED') {
        reason = REJECTION_REASONS.NOT_QUOTED;
      } else if (cv.Qualification_Status === 'FAILED') {
        reason = REJECTION_REASONS.FAILED_QUALIFICATION;
      } else if (isExpired(cv.Quote_Valid_Until, today)) {
        reason = REJECTION_REASONS.EXPIRED;
      } else if (vendor && vendor.Vendor_Status === 'BLACKLIST') {
        reason = REJECTION_REASONS.BLACKLISTED;
      } else if (requireAllItemsPriced &&
                 !QuoteService.hasPricedAllItems(data.items, data.quoteLines, cv.Case_Vendor_ID)) {
        reason = REJECTION_REASONS.INCOMPLETE_PRICING;
      }

      var entry = { caseVendorId: cv.Case_Vendor_ID, vendorId: cv.Vendor_ID, vendorName: name, reason: reason };
      if (reason) rejected.push(entry); else valid.push(entry);
    });

    return { valid: valid, rejected: rejected };
  }

  function isExpired(validUntil, today) {
    var until = Utils.startOfDay(validUntil);
    if (!until) return false;                       // blank means "no expiry stated"
    return until.getTime() < today.getTime();
  }

  function vendorsById(caseVendors) {
    var wanted = {};
    caseVendors.forEach(function (cv) { wanted[cv.Vendor_ID] = true; });
    var out = {};
    Repository.query('Vendors', { includeDeleted: true }).forEach(function (v) {
      if (wanted[v.Vendor_ID]) out[v.Vendor_ID] = v;
    });
    return out;
  }

  function minQuotesRequired() {
    return Config.getNumber('MIN_QUOTES', 3);
  }

  /** TRUE when this Case has an exception that HEAD has actually approved. */
  function hasApprovedException(caseRecord) {
    return !Utils.isBlank(caseRecord.Exception_Reason_Code) && caseRecord.Exception_Status === 'APPROVED';
  }

  /**
   * Everything the UI needs to explain the rule, and the single place that decides
   * whether sourcing may be declared finished.
   */
  function evaluate(caseRecord, data) {
    var loaded = data || loadData(caseRecord.Case_ID);
    var assessment = assessQuotes(caseRecord, loaded);
    var required = minQuotesRequired();
    var count = assessment.valid.length;

    var blockers = [];
    var warnings = [];

    if (loaded.items.length === 0) {
      warnings.push('ยังไม่มีรายการในงานนี้ จึงยังตรวจความครบถ้วนของราคาไม่ได้');
    }
    assessment.rejected.forEach(function (r) {
      warnings.push('ใบเสนอราคาของ ' + r.vendorName + ' ยังใช้ไม่ได้: ' + r.reason);
    });

    var exceptionApproved = hasApprovedException(caseRecord);
    var exemptBySpecial = caseRecord.Method === 'SPECIAL' &&
      !Config.getBool('SPECIAL_REQUIRES_EXCEPTION', true);

    // SPEC §6.1 — zero usable quotations blocks the move in every case, with or
    // without an exception. There is nothing to compare.
    if (count === 0) {
      blockers.push('ยังไม่มีใบเสนอราคาที่ใช้ได้เลย จึงปิดขั้นตอนหา Vendor ไม่ได้');
    } else if (count < required && !exceptionApproved && !exemptBySpecial) {
      blockers.push('มีใบเสนอราคาที่ใช้ได้ ' + count + ' ราย จากที่กำหนด ' + required +
        ' ราย — ต้องขอยกเว้นและได้รับอนุมัติจากหัวหน้าฝ่ายจัดซื้อก่อน');
    }

    if (caseRecord.Exception_Status === 'PENDING') {
      warnings.push('คำขอยกเว้นยังรอการอนุมัติจากหัวหน้าฝ่ายจัดซื้อ');
    }
    if (caseRecord.Exception_Status === 'REJECTED') {
      warnings.push('คำขอยกเว้นถูกปฏิเสธ — กรุณาหาผู้ขายเพิ่มหรือขอยกเว้นใหม่พร้อมเหตุผลเพิ่มเติม');
    }

    return {
      quotes: {
        valid: count,
        required: required,
        satisfied: blockers.length === 0,
        validVendors: assessment.valid,
        rejectedVendors: assessment.rejected,
        exceptionApproved: exceptionApproved,
        exemptBySpecial: exemptBySpecial
      },
      blockers: blockers,
      warnings: warnings
    };
  }

  /** Cheap per-Case counts for the My Cases badge. */
  function summarizeCases(cases) {
    if (!cases.length) return {};
    var required = minQuotesRequired();
    var byCase = {};
    cases.forEach(function (c) { byCase[c.Case_ID] = { items: [], caseVendors: [], quoteLines: [] }; });

    collectInto(byCase, 'Case_Items', 'items');
    collectInto(byCase, 'Case_Vendors', 'caseVendors');
    collectInto(byCase, 'Quote_Lines', 'quoteLines');

    var out = {};
    cases.forEach(function (c) {
      var assessment = assessQuotes(c, byCase[c.Case_ID]);
      out[c.Case_ID] = { valid: assessment.valid.length, required: required };
    });
    return out;
  }

  function collectInto(byCase, tableName, key) {
    Repository.query(tableName, {
      where: function (row) { return Object.prototype.hasOwnProperty.call(byCase, row.Case_ID); }
    }).forEach(function (row) { byCase[row.Case_ID][key].push(row); });
  }

  /* -------------------------------------------- registered with StatusEngine */

  /** Guards SOURCING -> SOURCING_DONE. */
  function minQuotes(ctx) {
    var verdict = evaluate(ctx.caseRecord);
    if (verdict.blockers.length === 0) return;
    throw Err.ruleViolation(verdict.blockers[0], {
      quotes: verdict.quotes,
      blockers: verdict.blockers
    });
  }

  /**
   * SPEC §6.1 auto-revert — a Case already in SOURCING_DONE that no longer meets
   * the rule falls back to SOURCING. This runs after every write that could
   * change the answer, and daily for the quotations that simply expired.
   */
  function recheckMinQuotes(caseRecord) {
    if (caseRecord.Status !== SOURCING_DONE) return null;
    var verdict = evaluate(caseRecord);
    if (verdict.blockers.length === 0) return null;
    return {
      revertTo: SOURCING,
      message: 'ระบบย้อนสถานะกลับเป็น "กำลังหา Vendor" อัตโนมัติ เนื่องจาก ' + verdict.blockers[0]
    };
  }

  /**
   * The single entry point every service calls after a write (SPEC §6.1).
   * Returns the messages to surface to the user, and the reverted Case if any.
   */
  function recheckCaseRules(caseId) {
    var caseRecord = Repository.findById('Cases', caseId);
    if (!caseRecord) return { reverted: null, messages: [] };
    return StatusEngine.runRechecks(caseRecord);
  }

  StatusEngine.registerRule(SOURCING, SOURCING_DONE, minQuotes);
  StatusEngine.registerRecheck(recheckMinQuotes);

  return {
    REJECTION_REASONS: REJECTION_REASONS,
    loadData: loadData,
    assessQuotes: assessQuotes,
    minQuotesRequired: minQuotesRequired,
    hasApprovedException: hasApprovedException,
    evaluate: evaluate,
    summarizeCases: summarizeCases,
    minQuotes: minQuotes,
    recheckMinQuotes: recheckMinQuotes,
    recheckCaseRules: recheckCaseRules
  };
})();
