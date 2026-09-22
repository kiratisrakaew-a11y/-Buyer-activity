/**
 * Bootstrap.js — the one place that wires modules together.
 *
 * Apps Script chooses the order in which it evaluates the files of a project,
 * and that order is not something this codebase controls. A module that calls
 * into another module while it is being loaded therefore works only by luck:
 * the day the order changes, the whole script fails to load with a
 * ReferenceError and every screen goes down at once, not just the feature
 * that module owned.
 *
 * So nothing registers anything at load time. Each module exposes install(),
 * and this file calls them at run time, after every file is certainly in memory.
 *
 * A future module joins by adding one line to install().
 */
var Bootstrap = (function () {

  function install() {
    Rules.install();            // M1 — the minimum-quotations rule and its recheck
    // M2..M6 add their install() here, e.g. Benchmark.install();
  }

  return { install: install };
})();
