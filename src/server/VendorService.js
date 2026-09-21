/**
 * VendorService.js — the vendor master and the vendors invited to a Case.
 *
 * The duplicate rules in SPEC §6.2 exist to catch two different problems:
 * a Tax_ID already on file is a data-entry mistake and is blocked, while a shared
 * phone number, e-mail or address between two "competing" vendors is a bid-rigging
 * red flag that a buyer must see but may legitimately override.
 */
var VendorService = (function () {

  var RESPONSE_STATUSES = ['INVITED', 'QUOTED', 'DECLINED', 'NO_RESPONSE', 'WITHDRAWN'];
  var VENDOR_STATUSES = ['NEW', 'APPROVED', 'BLACKLIST', 'INACTIVE'];
  var QUALIFICATION_DEFAULT = 'NOT_CHECKED';

  /** Only an administrator may move a vendor into or out of these (SPEC §7). */
  var ADMIN_ONLY_STATUSES = ['APPROVED', 'BLACKLIST'];

  var MASTER_FIELDS = [
    'Vendor_No', 'Vendor_Name', 'Tax_ID', 'Address',
    'Contact_Name', 'Contact_Phone', 'Contact_Email', 'Categories', 'Remark'
  ];

  var CASE_VENDOR_FIELDS = [
    'Invited_Date', 'Invite_Channel', 'Response_Status', 'Quote_No', 'Quote_Date',
    'Quote_Valid_Until', 'Quote_Revision', 'Quote_File_URL', 'Remark'
  ];

  /* ------------------------------------------------------------ master data */

  function search(query) {
    var q = Utils.isBlank(query) ? '' : String(query).trim().toLowerCase();
    var vendors = Repository.query('Vendors', {
      where: function (v) {
        if (!q) return true;
        return [v.Vendor_Name, v.Tax_ID, v.Vendor_No, v.Categories]
          .some(function (field) { return String(field || '').toLowerCase().indexOf(q) !== -1; });
      }
    });
    vendors.sort(function (a, b) { return String(a.Vendor_Name).localeCompare(String(b.Vendor_Name), 'th'); });
    return vendors.slice(0, 200).map(Repository.toClient);
  }

  function create(user, payload) {
    Auth.requireRole(user, [Auth.ROLES.BUYER, Auth.ROLES.HEAD, Auth.ROLES.ADMIN]);

    var values = pick(payload, MASTER_FIELDS);
    values.Tax_ID = normalizeTaxId(values.Tax_ID);
    // A buyer adding a vendor mid-sourcing creates it as NEW; approval is the
    // administrator's decision, not the buyer's (SPEC §7).
    values.Vendor_Status = 'NEW';
    Validation.validate('Vendors', values, { partial: false });
    assertTaxIdFormat(values.Tax_ID);

    var clash = findByTaxId(values.Tax_ID);
    if (clash) {
      throw Err.duplicate('เลขประจำตัวผู้เสียภาษีนี้มีอยู่แล้วในระบบ: ' + clash.Vendor_Name, {
        existing: Repository.toClient(clash)
      });
    }

    var warnings = contactCollisionWarnings(values, null);
    var created = Repository.insert('Vendors', values, { actor: user.email });
    return { vendor: Repository.toClient(created), warnings: warnings };
  }

  function update(user, vendorId, patch, version, reason) {
    Auth.requireRole(user, [Auth.ROLES.BUYER, Auth.ROLES.HEAD, Auth.ROLES.ADMIN]);
    var existing = Repository.requireById('Vendors', vendorId);

    var values = pick(patch, MASTER_FIELDS);
    if (Object.prototype.hasOwnProperty.call(patch, 'Vendor_Status')) {
      values.Vendor_Status = assertStatusChangeAllowed(user, existing, patch.Vendor_Status);
    }
    if (Object.prototype.hasOwnProperty.call(values, 'Tax_ID')) {
      values.Tax_ID = normalizeTaxId(values.Tax_ID);
      assertTaxIdFormat(values.Tax_ID);
      var clash = findByTaxId(values.Tax_ID);
      if (clash && clash.Vendor_ID !== vendorId) {
        throw Err.duplicate('เลขประจำตัวผู้เสียภาษีนี้เป็นของ ' + clash.Vendor_Name + ' อยู่แล้ว', {
          existing: Repository.toClient(clash)
        });
      }
    }
    Validation.validate('Vendors', values, { partial: true, existing: existing });

    var warnings = contactCollisionWarnings(Object.assign({}, existing, values), vendorId);
    var updated = Repository.update('Vendors', vendorId, values, version, {
      actor: user.email,
      reason: Utils.isBlank(reason) ? '' : String(reason).trim(),
      fieldActions: { Vendor_Status: ChangeLog.ACTIONS.STATUS_CHANGE }
    });
    return { vendor: Repository.toClient(updated), warnings: warnings };
  }

  function assertStatusChangeAllowed(user, existing, nextStatus) {
    Validation.assertOneOf('Vendor_Status', nextStatus, VENDOR_STATUSES);
    if (nextStatus === existing.Vendor_Status) return nextStatus;
    var touchesRestricted = ADMIN_ONLY_STATUSES.indexOf(nextStatus) !== -1 ||
      ADMIN_ONLY_STATUSES.indexOf(existing.Vendor_Status) !== -1;
    if (touchesRestricted && !Auth.isAdmin(user)) {
      throw Err.forbidden('เฉพาะผู้ดูแลระบบเท่านั้นที่เปลี่ยนสถานะผู้ขายเป็น APPROVED หรือ BLACKLIST ได้',
        { role: user.role });
    }
    return nextStatus;
  }

  function normalizeTaxId(value) {
    return Utils.isBlank(value) ? '' : String(value).replace(/[\s-]/g, '');
  }

  function assertTaxIdFormat(taxId) {
    if (!/^\d{13}$/.test(taxId)) {
      throw Err.validation('เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก', { field: 'Tax_ID' });
    }
  }

  function findByTaxId(taxId) {
    if (Utils.isBlank(taxId)) return null;
    var matches = Repository.query('Vendors', {
      where: function (v) { return normalizeTaxId(v.Tax_ID) === taxId; }
    });
    return matches.length ? matches[0] : null;
  }

  /**
   * SPEC §6.2 — a phone, e-mail or address shared with another vendor is the
   * classic sign of related bidders. Warn loudly, but let the buyer proceed.
   */
  function contactCollisionWarnings(values, selfVendorId) {
    var checks = [
      { field: 'Contact_Phone', label: 'เบอร์โทรศัพท์' },
      { field: 'Contact_Email', label: 'อีเมลผู้ติดต่อ' },
      { field: 'Address', label: 'ที่อยู่' }
    ];
    var warnings = [];
    var all = Repository.query('Vendors');

    checks.forEach(function (check) {
      var value = Utils.normalizeForCompare(values[check.field]);
      if (!value) return;
      var others = all.filter(function (v) {
        return v.Vendor_ID !== selfVendorId && Utils.normalizeForCompare(v[check.field]) === value;
      });
      if (others.length === 0) return;
      warnings.push(check.label + 'ตรงกับผู้ขายรายอื่น: ' +
        others.map(function (v) { return v.Vendor_Name; }).join(', ') +
        ' — โปรดตรวจสอบความเกี่ยวข้องกันก่อนเปรียบเทียบราคา');
    });
    return warnings;
  }

  /** Every Case a vendor has been invited to, for the vendor history screen. */
  function history(vendorId) {
    var rows = Repository.query('Case_Vendors', { indexColumn: 'Vendor_ID', indexValue: vendorId });
    var cases = {};
    Repository.readAll('Cases').forEach(function (c) { cases[c.Case_ID] = c; });
    return rows.map(function (cv) {
      var c = cases[cv.Case_ID];
      return {
        Case_ID: cv.Case_ID,
        Case_Vendor_ID: cv.Case_Vendor_ID,
        Description: c ? c.Description : '',
        Status: c ? c.Status : '',
        Invited_Date: Utils.toIso(cv.Invited_Date),
        Response_Status: cv.Response_Status,
        Quote_No: cv.Quote_No
      };
    }).sort(function (a, b) { return String(b.Invited_Date).localeCompare(String(a.Invited_Date)); });
  }

  /* -------------------------------------------------------- vendors on a Case */

  function addToCase(user, caseId, vendorId, payload) {
    var caseRecord = CaseService.getForEdit(user, caseId);
    var vendor = Repository.requireById('Vendors', vendorId);

    // SPEC §6.2 — a blacklisted vendor may not be invited at all.
    if (vendor.Vendor_Status === 'BLACKLIST') {
      throw Err.ruleViolation('ผู้ขาย ' + vendor.Vendor_Name + ' อยู่ในบัญชีดำ จึงเชิญเข้าร่วมงานไม่ได้',
        { vendorId: vendorId });
    }
    // SPEC §6.2 — the same vendor twice on one Case is always a mistake.
    var already = Repository.queryByCase('Case_Vendors', caseId).filter(function (cv) {
      return cv.Vendor_ID === vendorId;
    });
    if (already.length) {
      throw Err.duplicate('ผู้ขาย ' + vendor.Vendor_Name + ' ถูกเพิ่มในงานนี้อยู่แล้ว',
        { caseVendorId: already[0].Case_Vendor_ID });
    }

    var values = pick(payload || {}, CASE_VENDOR_FIELDS);
    values.Case_ID = caseRecord.Case_ID;
    values.Vendor_ID = vendorId;
    if (Utils.isBlank(values.Invited_Date)) values.Invited_Date = Utils.today();
    if (Utils.isBlank(values.Response_Status)) values.Response_Status = 'INVITED';
    values.Qualification_Status = QUALIFICATION_DEFAULT;
    Validation.assertOneOf('Response_Status', values.Response_Status, RESPONSE_STATUSES);
    assertQuoteFieldsPresent(values);
    Validation.validate('Case_Vendors', values, { partial: false });

    var created = Repository.insert('Case_Vendors', values, { actor: user.email, caseId: caseId });

    var warnings = vendor.Vendor_Status === 'NEW'
      ? ['ผู้ขาย ' + vendor.Vendor_Name + ' ยังมีสถานะ NEW — ผู้ดูแลระบบยังไม่ได้อนุมัติเข้าทะเบียน']
      : [];
    if (typeof Rules !== 'undefined') {
      warnings = warnings.concat(Rules.recheckCaseRules(caseId).messages);
    }
    return { caseVendor: Repository.toClient(created), warnings: warnings };
  }

  function updateCaseVendor(user, caseVendorId, patch, version, reason) {
    var caseVendor = Repository.requireById('Case_Vendors', caseVendorId);
    CaseService.getForEdit(user, caseVendor.Case_ID);

    var values = pick(patch, CASE_VENDOR_FIELDS);
    if (Object.prototype.hasOwnProperty.call(values, 'Response_Status')) {
      Validation.assertOneOf('Response_Status', values.Response_Status, RESPONSE_STATUSES);
    }
    // SPEC §6.3 — changing Response_Status always needs a written reason.
    var explained = Validation.assertReasonForPatch('Case_Vendors', caseVendor, values, reason);
    assertQuoteFieldsPresent(Object.assign({}, caseVendor, values));
    Validation.validate('Case_Vendors', values, { partial: true, existing: caseVendor });

    var updated = Repository.update('Case_Vendors', caseVendorId, values, version, {
      actor: user.email,
      reason: explained || (Utils.isBlank(reason) ? '' : String(reason).trim()),
      caseId: caseVendor.Case_ID,
      fieldActions: { Response_Status: ChangeLog.ACTIONS.STATUS_CHANGE }
    });

    var warnings = [];
    if (typeof Rules !== 'undefined') {
      warnings = warnings.concat(Rules.recheckCaseRules(caseVendor.Case_ID).messages);
    }
    return { caseVendor: Repository.toClient(updated), warnings: warnings };
  }

  /** SPEC §5.1 — a vendor marked QUOTED must say which quotation, and when. */
  function assertQuoteFieldsPresent(values) {
    if (values.Response_Status !== 'QUOTED') return;
    if (Utils.isBlank(values.Quote_No)) {
      throw Err.validation('เมื่อสถานะเป็น "เสนอราคาแล้ว" ต้องระบุเลขที่ใบเสนอราคา', { field: 'Quote_No' });
    }
    if (Utils.isBlank(values.Quote_Date)) {
      throw Err.validation('เมื่อสถานะเป็น "เสนอราคาแล้ว" ต้องระบุวันที่ใบเสนอราคา', { field: 'Quote_Date' });
    }
  }

  /** Removing a vendor from a Case takes its quoted prices with it. */
  function removeFromCase(user, caseVendorId, version, reason) {
    var caseVendor = Repository.requireById('Case_Vendors', caseVendorId);
    CaseService.getForEdit(user, caseVendor.Case_ID);
    var explained = Validation.requireReason(reason, 'การลบผู้ขายออกจากงาน');

    var cascaded = Repository.softDeleteWhere('Quote_Lines', 'Case_Vendor_ID', caseVendorId, {
      actor: user.email,
      reason: 'ลบตามผู้ขาย ' + caseVendorId + ': ' + explained,
      caseId: caseVendor.Case_ID
    });
    Repository.softDelete('Case_Vendors', caseVendorId, version, {
      actor: user.email, reason: explained, caseId: caseVendor.Case_ID
    });

    var warnings = cascaded > 0 ? ['ลบราคาที่ผู้ขายรายนี้เสนอออกด้วย ' + cascaded + ' รายการ'] : [];
    if (typeof Rules !== 'undefined') {
      warnings = warnings.concat(Rules.recheckCaseRules(caseVendor.Case_ID).messages);
    }
    return { deletedQuoteLines: cascaded, warnings: warnings };
  }

  function pick(source, fields) {
    var out = {};
    fields.forEach(function (field) {
      if (source && Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field];
    });
    return out;
  }

  return {
    RESPONSE_STATUSES: RESPONSE_STATUSES,
    VENDOR_STATUSES: VENDOR_STATUSES,
    MASTER_FIELDS: MASTER_FIELDS,
    CASE_VENDOR_FIELDS: CASE_VENDOR_FIELDS,
    search: search,
    create: create,
    update: update,
    findByTaxId: findByTaxId,
    normalizeTaxId: normalizeTaxId,
    contactCollisionWarnings: contactCollisionWarnings,
    history: history,
    addToCase: addToCase,
    updateCaseVendor: updateCaseVendor,
    removeFromCase: removeFromCase
  };
})();
