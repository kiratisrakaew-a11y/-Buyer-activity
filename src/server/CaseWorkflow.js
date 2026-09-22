/**
 * CaseWorkflow.js — the Case operations that are decisions rather than edits:
 * asking for an exception, granting or refusing it, handing work to another
 * buyer, and reopening a Case that was already closed.
 *
 * Each one writes its own Change_Log action (EXCEPTION, REASSIGN, REOPEN) so an
 * auditor can read the history of a Case without having to interpret raw field
 * changes (SPEC §5.4).
 */
var CaseWorkflow = (function () {

  var PENDING = 'PENDING';
  var APPROVED = 'APPROVED';
  var REJECTED = 'REJECTED';

  /* ------------------------------------------------------------- exception */

  /**
   * SPEC §6.1 — the way out when fewer than MIN_QUOTES usable quotations exist.
   * Only the owner (or HEAD) may ask, and the request always carries a reason.
   */
  function requestException(user, caseId, reasonCode, note) {
    var caseRecord = CaseService.getForEdit(user, caseId);
    var explained = Validation.requireReason(note, 'การขอยกเว้นจำนวนใบเสนอราคา');

    if (!Config.isValidCode('EXCEPTION_REASON', reasonCode)) {
      throw Err.validation('เหตุผลการขอยกเว้น "' + reasonCode + '" ไม่อยู่ในรายการที่กำหนด',
        { field: 'Exception_Reason_Code' });
    }
    if (caseRecord.Exception_Status === PENDING) {
      throw Err.validation('งานนี้มีคำขอยกเว้นที่รออนุมัติอยู่แล้ว');
    }

    var updated = Repository.update('Cases', caseId, {
      Exception_Reason_Code: reasonCode,
      Exception_Note: explained,
      Exception_Status: PENDING,
      // A fresh request must not inherit the previous decision.
      Exception_Approved_By: '',
      Exception_Approved_At: ''
    }, null, {
      actor: user.email,
      reason: explained,
      caseId: caseId,
      action: ChangeLog.ACTIONS.EXCEPTION
    });

    if (typeof Notification !== 'undefined') {
      Notification.onExceptionRequested(updated, user);
    }
    return { caseRecord: Repository.toClient(updated), warnings: [] };
  }

  /**
   * SPEC §7 / Acceptance Test 6 — HEAD decides, but never on a Case they own
   * themselves. That separation is the whole point of the control.
   */
  function decideException(user, caseId, approve, note) {
    Auth.requireRole(user, [Auth.ROLES.HEAD]);
    var caseRecord = CaseService.requireCase(caseId);

    if (Auth.isOwner(user, caseRecord)) {
      throw Err.forbidden('หัวหน้าฝ่ายจัดซื้ออนุมัติคำขอยกเว้นของงานที่ตนเองเป็นเจ้าของไม่ได้',
        { caseId: caseId, owner: caseRecord.Buyer_Owner });
    }
    if (caseRecord.Exception_Status !== PENDING) {
      throw Err.validation('งานนี้ไม่มีคำขอยกเว้นที่รออนุมัติ', { status: caseRecord.Exception_Status });
    }
    var decisionNote = Validation.requireReason(note, 'การพิจารณาคำขอยกเว้น');

    var updated = Repository.update('Cases', caseId, {
      Exception_Status: approve ? APPROVED : REJECTED,
      Exception_Approved_By: user.email,
      Exception_Approved_At: Utils.now(),
      Exception_Note: caseRecord.Exception_Note + ' | ผลการพิจารณา: ' + decisionNote
    }, null, {
      actor: user.email,
      reason: decisionNote,
      caseId: caseId,
      action: ChangeLog.ACTIONS.EXCEPTION
    });

    if (typeof Notification !== 'undefined') {
      Notification.onExceptionDecided(updated, user, !!approve, decisionNote);
    }
    return { caseRecord: Repository.toClient(updated), approved: !!approve };
  }

  /* -------------------------------------------------------------- reassign */

  /** SPEC §7 — only HEAD moves work between buyers, and always with a reason. */
  function reassign(user, caseId, newOwnerEmail, reason) {
    Auth.requireRole(user, [Auth.ROLES.HEAD]);
    var caseRecord = CaseService.requireCase(caseId);
    var explained = Validation.requireReason(reason, 'การโอนงาน');

    if (Auth.isTerminal(caseRecord.Status)) {
      throw Err.forbidden('งานที่ปิดแล้วโอนให้ผู้อื่นไม่ได้', { caseId: caseId });
    }
    var target = String(newOwnerEmail || '').trim().toLowerCase();
    var newOwner = Auth.findUser(target);
    if (!newOwner || newOwner.Is_Active !== true) {
      throw Err.validation('ไม่พบผู้ใช้งานที่ใช้งานอยู่ตามอีเมล ' + newOwnerEmail, { field: 'newOwnerEmail' });
    }
    var role = String(newOwner.Role).toUpperCase();
    if (role !== Auth.ROLES.BUYER && role !== Auth.ROLES.HEAD) {
      throw Err.validation('โอนงานให้ได้เฉพาะผู้ที่มีบทบาท BUYER หรือ HEAD เท่านั้น', { role: role });
    }
    if (target === String(caseRecord.Buyer_Owner).toLowerCase()) {
      throw Err.validation('ผู้รับโอนเป็นเจ้าของงานนี้อยู่แล้ว');
    }

    var previousOwner = caseRecord.Buyer_Owner;
    var updated = Repository.update('Cases', caseId, { Buyer_Owner: target }, null, {
      actor: user.email,
      reason: explained,
      caseId: caseId,
      action: ChangeLog.ACTIONS.REASSIGN
    });

    if (typeof Notification !== 'undefined') {
      Notification.onReassigned(updated, previousOwner, target, user, explained);
    }
    return { caseRecord: Repository.toClient(updated), previousOwner: previousOwner };
  }

  /* ---------------------------------------------------------------- reopen */

  /**
   * SPEC §6.3 — a closed or cancelled Case is frozen until HEAD reopens it.
   * The status to return to is read back out of the Change_Log, so reopening
   * restores where the work actually was rather than a guess.
   */
  function reopen(user, caseId, reason) {
    Auth.requireRole(user, [Auth.ROLES.HEAD]);
    var caseRecord = CaseService.requireCase(caseId);
    var explained = Validation.requireReason(reason, 'การเปิดงานที่ปิดไปแล้ว');

    if (!Auth.isTerminal(caseRecord.Status)) {
      throw Err.validation('งานนี้ยังไม่ได้ปิด จึงไม่ต้อง Reopen', { status: caseRecord.Status });
    }

    var previous = ChangeLog.previousStatusBefore(caseId, caseRecord.Status);
    if (!previous || !Config.getStatus(previous) || Auth.isTerminal(previous)) {
      previous = CaseService.INITIAL_STATUS;
    }

    var updated = Repository.update('Cases', caseId, {
      Status: previous,
      Closed_At: ''
    }, null, {
      actor: user.email,
      reason: explained,
      caseId: caseId,
      // Only the status move is the REOPEN event; clearing Closed_At is a
      // consequence of it and reads as an ordinary field change.
      fieldActions: { Status: ChangeLog.ACTIONS.REOPEN }
    });

    var recheck = Rules.recheckCaseRules(caseId);
    if (typeof Notification !== 'undefined') {
      Notification.onReopened(updated, caseRecord.Status, previous, user, explained);
    }
    return {
      caseRecord: Repository.toClient(recheck.reverted || updated),
      restoredTo: previous,
      warnings: recheck.messages
    };
  }

  return {
    PENDING: PENDING,
    APPROVED: APPROVED,
    REJECTED: REJECTED,
    requestException: requestException,
    decideException: decideException,
    reassign: reassign,
    reopen: reopen
  };
})();
