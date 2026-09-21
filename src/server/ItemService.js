/**
 * ItemService.js — the lines a Case is asking to buy.
 *
 * Deleting an item cascades to every quote line priced against it (SPEC §6.3),
 * and any change to the item list can invalidate the "at least three quotes"
 * rule, so a recheck runs after every write (SPEC §6.1).
 */
var ItemService = (function () {

  var EDITABLE_FIELDS = [
    'Item_Code', 'Item_Description', 'Quantity', 'Unit',
    'Media_Site', 'Media_Type', 'Asset_No', 'Remark'
  ];

  function listForCase(caseId) {
    return Repository.queryByCase('Case_Items', caseId).sort(function (a, b) {
      return (Number(a.Line_No) || 0) - (Number(b.Line_No) || 0);
    });
  }

  /** Insert when the payload has no Item_Row_ID, update when it does (SPEC §9). */
  function save(user, caseId, payload, version, reason) {
    var caseRecord = CaseService.getForEdit(user, caseId);
    var values = pick(payload, EDITABLE_FIELDS);
    var warnings = CaseService.duplicateMediaSiteWarnings(caseId, values.Media_Site);

    var saved;
    if (Utils.isBlank(payload.Item_Row_ID)) {
      values.Case_ID = caseRecord.Case_ID;
      values.Line_No = nextLineNo(caseId);
      Validation.validate('Case_Items', values, { partial: false });
      saved = Repository.insert('Case_Items', values, { actor: user.email, caseId: caseId });
    } else {
      var existing = Repository.requireById('Case_Items', payload.Item_Row_ID);
      if (existing.Case_ID !== caseRecord.Case_ID) {
        throw Err.validation('รายการนี้ไม่ได้อยู่ในงาน ' + caseId);
      }
      Validation.validate('Case_Items', values, { partial: true, existing: existing });
      saved = Repository.update('Case_Items', payload.Item_Row_ID, values, version, {
        actor: user.email,
        reason: Utils.isBlank(reason) ? '' : String(reason).trim(),
        caseId: caseId
      });
    }

    warnings = warnings.concat(unitMismatchWarnings(caseId, saved));
    if (typeof Rules !== 'undefined') {
      warnings = warnings.concat(Rules.recheckCaseRules(caseId).messages);
    }
    return { item: Repository.toClient(saved), warnings: warnings };
  }

  /**
   * Soft-deletes the item and, in the same breath, every quote line that priced it.
   * Leaving those lines behind would make vendor totals silently wrong.
   */
  function remove(user, caseId, itemRowId, version, reason) {
    CaseService.getForEdit(user, caseId);
    var explained = Validation.requireReason(reason, 'การลบรายการ');
    var item = Repository.requireById('Case_Items', itemRowId);
    if (item.Case_ID !== caseId) throw Err.validation('รายการนี้ไม่ได้อยู่ในงาน ' + caseId);

    var cascaded = Repository.softDeleteWhere('Quote_Lines', 'Item_Row_ID', itemRowId, {
      actor: user.email,
      reason: 'ลบตามรายการ ' + itemRowId + ': ' + explained,
      caseId: caseId
    });
    Repository.softDelete('Case_Items', itemRowId, version, {
      actor: user.email, reason: explained, caseId: caseId
    });

    var warnings = [];
    if (cascaded > 0) {
      warnings.push('ลบราคาที่ผู้ขายเสนอสำหรับรายการนี้ออกด้วย ' + cascaded + ' รายการ');
    }
    if (typeof Rules !== 'undefined') {
      warnings = warnings.concat(Rules.recheckCaseRules(caseId).messages);
    }
    return { deletedQuoteLines: cascaded, warnings: warnings };
  }

  /** SPEC §6.2 — a vendor quoting in a different unit is a warning, not a block. */
  function unitMismatchWarnings(caseId, item) {
    var lines = Repository.query('Quote_Lines', { indexColumn: 'Item_Row_ID', indexValue: item.Item_Row_ID });
    var mismatched = lines.filter(function (line) { return line.Vendor_Unit !== item.Unit; });
    if (mismatched.length === 0) return [];
    return ['รายการ "' + item.Item_Description + '" มีผู้ขาย ' + mismatched.length +
      ' รายเสนอราคาด้วยหน่วยที่ต่างจาก ' + item.Unit + ' กรุณาตรวจสอบก่อนเปรียบเทียบ'];
  }

  function nextLineNo(caseId) {
    var existing = Repository.queryByCase('Case_Items', caseId, { includeDeleted: true });
    var max = 0;
    existing.forEach(function (item) { max = Math.max(max, Number(item.Line_No) || 0); });
    return max + 1;
  }

  function pick(source, fields) {
    var out = {};
    fields.forEach(function (field) {
      if (source && Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field];
    });
    return out;
  }

  return {
    EDITABLE_FIELDS: EDITABLE_FIELDS,
    listForCase: listForCase,
    save: save,
    remove: remove,
    nextLineNo: nextLineNo
  };
})();
