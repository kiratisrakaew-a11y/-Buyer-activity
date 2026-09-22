/**
 * ReferenceService.js — PR, PO and GR numbers, which arrive after the work
 * described by the Case has already been done (SPEC §5.1, §6.4).
 *
 * One Case can produce several of them, which is why they live in their own
 * table rather than in a column on Cases (SPEC §14.3).
 */
var ReferenceService = (function () {

  var PR = 'PR';

  /** PO and GR are [RESERVED] for later modules; M1 only records the PR. */
  var ACTIVE_TYPES = [PR];

  /** SPEC §6.4 — a PR number cannot exist before a vendor has been settled on. */
  var MIN_STATUS_FOR_PR = 'SOURCING_DONE';

  function listForCase(caseId) {
    return Repository.queryByCase('Case_References', caseId);
  }

  function add(user, caseId, payload) {
    var caseRecord = CaseService.getForEdit(user, caseId);
    var refType = String(payload.Ref_Type || PR).trim().toUpperCase();

    if (ACTIVE_TYPES.indexOf(refType) === -1) {
      throw Err.ruleViolation('Module 1 บันทึกได้เฉพาะเลข PR เท่านั้น (' + refType +
        ' สงวนไว้สำหรับโมดูลถัดไป)', { refType: refType });
    }
    assertStatusAllowsPr(caseRecord);

    var refNo = String(payload.Ref_No || '').trim();
    if (Utils.isBlank(refNo)) {
      throw Err.validation('กรุณากรอกเลขที่เอกสาร', { field: 'Ref_No' });
    }
    assertRefNoUnique(refType, refNo, null);

    var values = {
      Case_ID: caseRecord.Case_ID,
      Ref_Type: refType,
      Ref_No: refNo,
      Ref_Date: payload.Ref_Date,
      Amount: payload.Amount,
      Note: payload.Note
    };
    Validation.validate('Case_References', values, { partial: false });

    var created = Repository.insert('Case_References', values, { actor: user.email, caseId: caseId });
    return { reference: Repository.toClient(created) };
  }

  function remove(user, caseId, refId, version, reason) {
    CaseService.getForEdit(user, caseId);
    var explained = Validation.requireReason(reason, 'การลบเลขที่เอกสาร');
    var reference = Repository.requireById('Case_References', refId);
    if (reference.Case_ID !== caseId) {
      throw Err.validation('เอกสารนี้ไม่ได้อยู่ในงาน ' + caseId);
    }
    Repository.softDelete('Case_References', refId, version, {
      actor: user.email, reason: explained, caseId: caseId
    });
    return { deleted: true };
  }

  function assertStatusAllowsPr(caseRecord) {
    var current = StatusEngine.sequenceOf(caseRecord.Status);
    var minimum = StatusEngine.sequenceOf(MIN_STATUS_FOR_PR);
    if (current < minimum) {
      throw Err.ruleViolation('กรอกเลข PR ได้เมื่องานอยู่ในสถานะ "' +
        Auth.statusLabel(MIN_STATUS_FOR_PR) + '" ขึ้นไปเท่านั้น (ขณะนี้: ' +
        Auth.statusLabel(caseRecord.Status) + ')', { status: caseRecord.Status });
    }
  }

  /** SPEC §6.4 — the same PR number must not appear on two live Cases. */
  function assertRefNoUnique(refType, refNo, selfRefId) {
    var clash = Repository.query('Case_References', {
      where: function (r) {
        return r.Ref_Type === refType &&
          Utils.normalizeForCompare(r.Ref_No) === Utils.normalizeForCompare(refNo) &&
          r.Ref_ID !== selfRefId;
      }
    });
    if (clash.length) {
      throw Err.duplicate('เลขที่ ' + refType + ' "' + refNo + '" ถูกใช้ในงาน ' +
        clash[0].Case_ID + ' แล้ว', { caseId: clash[0].Case_ID, refId: clash[0].Ref_ID });
    }
  }

  return {
    PR: PR,
    ACTIVE_TYPES: ACTIVE_TYPES,
    MIN_STATUS_FOR_PR: MIN_STATUS_FOR_PR,
    listForCase: listForCase,
    add: add,
    remove: remove
  };
})();
