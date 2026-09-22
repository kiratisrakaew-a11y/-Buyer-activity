/**
 * TeamService.js — the head's and the auditor's view of the whole department
 * (SPEC §8.4): who is carrying what, what has slipped, and what is waiting on a
 * decision.
 */
var TeamService = (function () {

  function overview(user) {
    Auth.requireRole(user, [Auth.ROLES.HEAD, Auth.ROLES.AUDITOR, Auth.ROLES.ADMIN]);

    var openCases = Repository.query('Cases', {
      where: function (c) { return !Auth.isTerminal(c.Status); }
    });
    var nextActions = CaseService.nextActionByCase(openCases.map(function (c) { return c.Case_ID; }));
    var quotes = Rules.summarizeCases(openCases);

    var buyers = {};
    Auth.listBuyers().forEach(function (b) {
      buyers[b.email] = {
        email: b.email, name: b.name, role: b.role,
        openCases: 0, overdueActions: 0, pendingExceptions: 0, readyToFinish: 0, cases: []
      };
    });

    openCases.forEach(function (c) {
      var owner = String(c.Buyer_Owner).trim().toLowerCase();
      if (!buyers[owner]) {
        // A Case whose owner has since left or been deactivated still has to be visible.
        buyers[owner] = {
          email: owner, name: owner, role: '—',
          openCases: 0, overdueActions: 0, pendingExceptions: 0, readyToFinish: 0, cases: [], inactive: true
        };
      }
      var bucket = buyers[owner];
      var next = nextActions[c.Case_ID] || null;
      var quote = quotes[c.Case_ID] || null;

      bucket.openCases++;
      if (next && next.overdue) bucket.overdueActions++;
      if (c.Exception_Status === 'PENDING') bucket.pendingExceptions++;
      if (c.Status === 'SOURCING' && quote && quote.valid >= quote.required) bucket.readyToFinish++;

      bucket.cases.push(Object.assign(Repository.toClient(c), { nextAction: next, quotes: quote }));
    });

    var rows = Object.keys(buyers).map(function (email) { return buyers[email]; });
    rows.sort(function (a, b) { return b.openCases - a.openCases; });
    rows.forEach(function (row) {
      row.cases.sort(function (a, b) { return String(a.Case_ID).localeCompare(String(b.Case_ID)); });
    });

    return {
      buyers: rows,
      totals: {
        openCases: openCases.length,
        overdueActions: rows.reduce(function (n, r) { return n + r.overdueActions; }, 0),
        pendingExceptions: rows.reduce(function (n, r) { return n + r.pendingExceptions; }, 0)
      },
      canReassign: Auth.isHead(user)
    };
  }

  return { overview: overview };
})();
