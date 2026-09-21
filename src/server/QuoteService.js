/**
 * QuoteService.js — the price matrix: one row per item, one column per vendor.
 *
 * Prices are saved a whole column at a time so the matrix behaves like a
 * spreadsheet, and so a batch of edits costs one lock, one pass and one block of
 * Change_Log rows rather than one of each per cell (SPEC §9 api_saveQuoteLines).
 */
var QuoteService = (function () {

  var EDITABLE_FIELDS = ['Vendor_Unit', 'Vendor_Unit_Price', 'Remark'];

  /**
   * Saves every line of one vendor's quotation.
   * lines: [{ Quote_Line_ID?, Item_Row_ID, Vendor_Unit, Vendor_Unit_Price, Remark, Version? }]
   * A line whose price is blank is removed, which is how a buyer says "this vendor
   * did not price this item".
   */
  function saveLines(user, caseVendorId, lines, reason) {
    var caseVendor = Repository.requireById('Case_Vendors', caseVendorId);
    var caseRecord = CaseService.getForEdit(user, caseVendor.Case_ID);

    var items = indexBy(Repository.queryByCase('Case_Items', caseRecord.Case_ID), 'Item_Row_ID');
    var existing = indexBy(
      Repository.query('Quote_Lines', { indexColumn: 'Case_Vendor_ID', indexValue: caseVendorId }),
      'Item_Row_ID'
    );

    var toInsert = [];
    var toUpdate = [];
    var toRemove = [];
    var warnings = [];

    (lines || []).forEach(function (line) {
      var item = items[line.Item_Row_ID];
      if (!item) {
        throw Err.validation('ไม่พบรายการ ' + line.Item_Row_ID + ' ในงานนี้', { field: 'Item_Row_ID' });
      }
      var current = existing[line.Item_Row_ID] || null;

      if (Utils.isBlank(line.Vendor_Unit_Price)) {
        if (current) toRemove.push(current);
        return;
      }

      var values = {
        Vendor_Unit: Utils.isBlank(line.Vendor_Unit) ? item.Unit : line.Vendor_Unit,
        Vendor_Unit_Price: line.Vendor_Unit_Price,
        Remark: line.Remark
      };
      // SPEC §6.2 — a different unit does not block the save, it asks for a look.
      if (values.Vendor_Unit !== item.Unit) {
        warnings.push('รายการ "' + item.Item_Description + '": ผู้ขายเสนอเป็นหน่วย ' +
          values.Vendor_Unit + ' แต่งานระบุ ' + item.Unit + ' กรุณาแปลงหน่วยก่อนเปรียบเทียบ');
      }

      if (current) {
        toUpdate.push({ id: current.Quote_Line_ID, patch: values, version: line.Version, current: current });
      } else {
        toInsert.push(Object.assign({
          Case_ID: caseRecord.Case_ID,
          Case_Vendor_ID: caseVendorId,
          Item_Row_ID: line.Item_Row_ID
        }, values));
      }
    });

    // SPEC §6.3 — changing a price that already exists always needs a reason.
    var priceChanges = toUpdate.filter(function (u) {
      return Utils.normalizeForCompare(u.current.Vendor_Unit_Price) !==
        Utils.normalizeForCompare(Repository.coerceWrite('Quote_Lines',
          Schema.getColumn('Quote_Lines', 'Vendor_Unit_Price'), u.patch.Vendor_Unit_Price));
    });
    var explained = '';
    if (priceChanges.length > 0 || toRemove.length > 0) {
      explained = Validation.requireReason(reason, 'การแก้ไขราคาที่ผู้ขายเสนอ');
    }

    toInsert.forEach(function (values) { Validation.validate('Quote_Lines', values, { partial: false }); });
    toUpdate.forEach(function (u) {
      Validation.validate('Quote_Lines', u.patch, { partial: true, existing: u.current });
    });

    if (toInsert.length) {
      Repository.insertMany('Quote_Lines', toInsert, {
        actor: user.email, caseId: caseRecord.Case_ID, reason: explained
      });
    }
    if (toUpdate.length) {
      Repository.updateMany('Quote_Lines', toUpdate.map(function (u) {
        return { id: u.id, patch: u.patch, version: u.version };
      }), { actor: user.email, caseId: caseRecord.Case_ID, reason: explained });
    }
    toRemove.forEach(function (line) {
      Repository.softDelete('Quote_Lines', line.Quote_Line_ID, null, {
        actor: user.email, caseId: caseRecord.Case_ID, reason: explained || 'ผู้ขายไม่ได้เสนอราคารายการนี้'
      });
    });

    if (typeof Rules !== 'undefined') {
      warnings = warnings.concat(Rules.recheckCaseRules(caseRecord.Case_ID).messages);
    }

    return {
      inserted: toInsert.length,
      updated: toUpdate.length,
      removed: toRemove.length,
      warnings: warnings
    };
  }

  /**
   * Whether this vendor priced every live item of the Case, which is what
   * REQUIRE_ALL_ITEMS_PRICED turns into a condition for a valid quotation (SPEC §6.1).
   */
  function hasPricedAllItems(items, quoteLines, caseVendorId) {
    if (items.length === 0) return false;
    var priced = {};
    quoteLines.forEach(function (line) {
      if (line.Case_Vendor_ID !== caseVendorId) return;
      if (Utils.isBlank(line.Vendor_Unit_Price)) return;
      priced[line.Item_Row_ID] = true;
    });
    return items.every(function (item) { return priced[item.Item_Row_ID] === true; });
  }

  /** Σ (quantity × unit price) for one vendor. Never stored (SPEC §2.4). */
  function grandTotal(items, quoteLines, caseVendorId) {
    var quantity = {};
    items.forEach(function (item) { quantity[item.Item_Row_ID] = Number(item.Quantity) || 0; });
    return quoteLines.reduce(function (sum, line) {
      if (line.Case_Vendor_ID !== caseVendorId) return sum;
      var q = quantity[line.Item_Row_ID];
      if (q === undefined) return sum;
      return sum + q * (Number(line.Vendor_Unit_Price) || 0);
    }, 0);
  }

  function indexBy(rows, key) {
    var out = {};
    rows.forEach(function (r) { out[r[key]] = r; });
    return out;
  }

  return {
    EDITABLE_FIELDS: EDITABLE_FIELDS,
    saveLines: saveLines,
    hasPricedAllItems: hasPricedAllItems,
    grandTotal: grandTotal
  };
})();
