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

  /**
   * A paste larger than this is almost always the wrong range copied out of a
   * spreadsheet. Refusing it costs a buyer one retry; accepting it costs everyone
   * a Case with hundreds of junk lines that must be deleted one at a time.
   */
  var MAX_BULK_ROWS = 200;

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
   * Inserts many items in one pass — what the "วางจาก Excel" button sends.
   *
   * All or nothing. One unusable row and nothing is written, so a buyer never has
   * to work out which half of a paste landed and edit around it. Every row is
   * validated first, and the reply names each bad row by its position in the paste.
   *
   * Runs under one lock so the Line_No block it hands out cannot interleave with
   * another execution adding items to the same Case.
   */
  function saveMany(user, caseId, rows) {
    var caseRecord = CaseService.getForEdit(user, caseId);
    var list = rows || [];
    if (!list.length) throw Err.validation('ไม่มีรายการให้บันทึก');
    if (list.length > MAX_BULK_ROWS) {
      throw Err.validation('วางได้ครั้งละไม่เกิน ' + MAX_BULK_ROWS +
        ' รายการ (วางมา ' + list.length + ' รายการ)');
    }

    return Utils.withScriptLock(function () {
      var startLineNo = nextLineNo(caseId);
      var problems = [];
      var payloads = [];

      list.forEach(function (raw, i) {
        var values = pick(raw, EDITABLE_FIELDS);
        values.Quantity = normalizeNumber(values.Quantity);
        values.Unit = resolveCode('UNIT', values.Unit);
        values.Media_Type = resolveCode('MEDIA_TYPE', values.Media_Type);
        values.Case_ID = caseRecord.Case_ID;
        values.Line_No = startLineNo + payloads.length;
        try {
          Validation.validate('Case_Items', values, { partial: false });
        } catch (e) {
          problems.push('แถวที่ ' + (i + 1) + ': ' + ((e && e.message) || e));
          return;
        }
        payloads.push(values);
      });

      if (problems.length) {
        // A toast that lists 200 broken rows is unreadable, and the client shows
        // the same problems row by row in its preview anyway. `details.rows` still
        // carries every one of them for a caller that wants the full list.
        var shown = problems.slice(0, 5).join(' · ');
        if (problems.length > 5) shown += ' · และอีก ' + (problems.length - 5) + ' แถว';
        throw Err.validation('ยังไม่ได้บันทึกรายการใดเลย — ' + shown, { rows: problems });
      }

      var saved = Repository.insertMany('Case_Items', payloads, {
        actor: user.email, caseId: caseId
      });

      var warnings = [];
      Utils.unique(payloads
        .map(function (v) { return v.Media_Site; })
        .filter(function (site) { return !Utils.isBlank(site); })
      ).forEach(function (site) {
        warnings = warnings.concat(CaseService.duplicateMediaSiteWarnings(caseId, site));
      });
      // unitMismatchWarnings is deliberately not called here. It compares an item's
      // unit against the quote lines priced against it, and an item born in this
      // call has none — so it would be one indexed query per pasted row, every one
      // of them returning nothing.
      if (typeof Rules !== 'undefined') {
        warnings = warnings.concat(Rules.recheckCaseRules(caseId).messages);
      }

      return {
        items: saved.map(function (item) { return Repository.toClient(item); }),
        inserted: saved.length,
        warnings: warnings
      };
    });
  }

  /**
   * Accepts either the stored code or the Thai label a buyer sees in the dropdown,
   * because a BOQ column holds "ตารางเมตร", not "SQM". An unrecognised value is handed
   * back untouched so Validation is the one that reports it, in its usual wording.
   */
  function resolveCode(listName, raw) {
    if (Utils.isBlank(raw)) return raw;
    var wanted = String(raw).trim();
    var folded = wanted.toUpperCase();
    var items = Config.getList(listName);
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].code).toUpperCase() === folded) return items[i].code;
    }
    for (var j = 0; j < items.length; j++) {
      if (String(items[j].label).trim() === wanted) return items[j].code;
    }
    return wanted;
  }

  /** "1,250.00" is what a spreadsheet copies; Validation only understands 1250.00. */
  function normalizeNumber(raw) {
    if (Utils.isBlank(raw)) return raw;
    if (typeof raw === 'number') return raw;
    return String(raw).replace(/[,\s\u00a0]/g, '');
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
    MAX_BULK_ROWS: MAX_BULK_ROWS,
    listForCase: listForCase,
    save: save,
    saveMany: saveMany,
    remove: remove,
    nextLineNo: nextLineNo
  };
})();
