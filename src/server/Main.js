/**
 * Main.js — the web app entry point.
 *
 * Deploy with "Execute as: Me" and "Who has access: Anyone within the domain"
 * (SPEC §3). The DB spreadsheet is never shared with buyers; all access to it
 * happens under the deploying account, which is why every request has to be
 * authorised server-side.
 */

function doGet() {
  var user = null;
  var error = null;
  try {
    user = Auth.getCurrentUser();
  } catch (e) {
    error = isAppError(e) ? e.message : 'ไม่สามารถตรวจสอบสิทธิ์การเข้าใช้งานได้';
  }

  if (!user) {
    return renderDenied(error);
  }

  var template = HtmlService.createTemplateFromFile('client/Index');
  template.userName = user.name;
  template.userEmail = user.email;
  template.userRole = user.role;
  return template.evaluate()
    .setTitle('ระบบติดตามกิจกรรมจัดซื้อ')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function renderDenied(message) {
  var safe = escapeHtml(message || 'คุณไม่มีสิทธิ์เข้าใช้งานระบบนี้');
  var email = escapeHtml(Auth.getActiveEmail() || '-');
  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html lang="th"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>ไม่มีสิทธิ์เข้าใช้งาน</title>' +
    '<style>body{font-family:"Sarabun","Noto Sans Thai",system-ui,sans-serif;background:#f4f5f7;' +
    'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}' +
    '.card{background:#fff;border-radius:12px;padding:32px;max-width:480px;box-shadow:0 2px 12px rgba(0,0,0,.08)}' +
    'h1{font-size:20px;margin:0 0 12px;color:#b3261e}p{color:#444;line-height:1.7;margin:0 0 8px}' +
    'code{background:#f0f0f0;padding:2px 6px;border-radius:4px}</style></head><body>' +
    '<div class="card"><h1>ไม่มีสิทธิ์เข้าใช้งาน</h1>' +
    '<p>' + safe + '</p>' +
    '<p>บัญชีที่ใช้เข้าระบบ: <code>' + email + '</code></p>' +
    '<p>กรุณาติดต่อผู้ดูแลระบบเพื่อขอเพิ่มสิทธิ์ในชีต <code>Users</code></p>' +
    '</div></body></html>')
    .setTitle('ไม่มีสิทธิ์เข้าใช้งาน');
}

/** Used by the templates to compose the single page from several HTML files. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Server-side escaping for the few strings Main.js injects directly. */
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
