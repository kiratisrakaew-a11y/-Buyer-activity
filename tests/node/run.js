#!/usr/bin/env node
/**
 * run.js — runs tests/Tests.js under Node against the Apps Script mocks.
 *
 * Every file in src/server is evaluated into ONE shared vm context, which is exactly
 * how Apps Script loads a project: no module system, one global scope. The code under
 * test is therefore byte-for-byte the code that gets deployed.
 *
 * Usage:
 *   node tests/node/run.js              run every test
 *   node tests/node/run.js --case 18    run acceptance test 18 only
 *   node tests/node/run.js --grep quote run tests whose name contains "quote"
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGasEnvironment } = require('./mocks/GasMocks');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_DIR = path.join(ROOT, 'src', 'server');

/** Explicit order keeps stack traces readable; the code itself is order-independent. */
const LOAD_ORDER = [
  'Errors.js',
  'Schema.js',
  'Utils.js',
  'Config.js',
  'IdGenerator.js',
  'ChangeLog.js',
  'Repository.js',
  'Validation.js',
  'Auth.js',
  'DriveService.js',
  'StatusEngine.js',
  'Rules.js',
  'CaseService.js',
  'CaseWorkflow.js',
  'ItemService.js',
  'VendorService.js',
  'QuoteService.js',
  'ActivityService.js',
  'ReferenceService.js',
  'TeamService.js',
  'Notification.js',
  'Setup.js',
  'Api.js',
  'Main.js'
];

function serverFiles() {
  const present = fs.readdirSync(SERVER_DIR).filter((f) => f.endsWith('.js'));
  const ordered = LOAD_ORDER.filter((f) => present.includes(f));
  const extras = present.filter((f) => !LOAD_ORDER.includes(f)).sort();
  if (extras.length) {
    console.warn(`note: ${extras.join(', ')} not listed in LOAD_ORDER, appended`);
  }
  return ordered.concat(extras).map((f) => path.join(SERVER_DIR, f));
}

function buildContext() {
  const env = createGasEnvironment();
  const sandbox = Object.assign({}, env);
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  serverFiles().forEach((file) => {
    const code = fs.readFileSync(file, 'utf8');
    try {
      vm.runInContext(code, context, { filename: path.relative(ROOT, file) });
    } catch (e) {
      console.error(`Failed loading ${path.relative(ROOT, file)}: ${e.message}`);
      throw e;
    }
  });

  const testFile = path.join(ROOT, 'tests', 'Tests.js');
  vm.runInContext(fs.readFileSync(testFile, 'utf8'), context, { filename: 'tests/Tests.js' });

  return { context, sandbox, env };
}

function parseArgs(argv) {
  const opts = { case: null, grep: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--case') opts.case = argv[++i];
    else if (argv[i] === '--grep') opts.grep = argv[++i];
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv);
  const { sandbox } = buildContext();

  if (typeof sandbox.runAllTests !== 'function') {
    console.error('tests/Tests.js did not define runAllTests()');
    process.exit(1);
  }

  const summary = sandbox.runAllTests({ caseNumber: opts.case, grep: opts.grep });

  const width = summary.results.reduce((m, r) => Math.max(m, r.name.length), 0);
  summary.results.forEach((r) => {
    const mark = r.ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`${mark}  ${r.name.padEnd(width)}  ${r.ms}ms`);
    if (!r.ok) {
      console.log(`      ${r.error}`);
      if (r.stack) console.log(r.stack.split('\n').slice(1, 6).map((l) => '      ' + l.trim()).join('\n'));
    }
  });

  console.log('');
  console.log(`${summary.passed} passed, ${summary.failed} failed, ${summary.results.length} total`);
  process.exit(summary.failed === 0 ? 0 : 1);
}

main();
