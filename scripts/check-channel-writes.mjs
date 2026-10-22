#!/usr/bin/env node
/**
 * Channel write guard: fails when code other than lib/collab-channel-store.ts can write
 * collab-channels.json.
 *
 * Every change to that file goes through mutateChannels/saveChannels, which lock the file,
 * read it fresh and log what changed on each seat. A second write path is how a stale copy
 * overwrote a newer change (Jack, 15 Oct 2026), so this check parses app/, lib/, components/,
 * services/, the integration folders and the root-level .ts files, and reports any of:
 *   write   a file write/rename/delete whose first argument is the channels path
 *   lock    withFileLock() on the channels path
 *   passed  the channels path handed to any other function that is not a plain read
 * Reads (readJsonFile, readFile, stat, ...) are allowed.
 *
 * Run by scripts/safe-build.sh before the compile, by `npm test` (tests/unit/channel-write-guard.test.ts),
 * and by hand: node scripts/check-channel-writes.mjs
 * Manual tools in scripts/ (Python backfills, rollouts) are outside the scan.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

export const STORE_FILE = 'lib/collab-channel-store.ts';
// Server code lives in these folders and in the TypeScript files at the repository root
// (instrumentation, middleware, config).
export const SCAN_DIRS = ['app', 'lib', 'components', 'services', 'slack-integration', 'teams-integration'];

const WRITE_CALLEES = new Set([
  'writeJsonFile', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'rename', 'renameSync', 'copyFile', 'copyFileSync', 'truncate', 'truncateSync',
  'rm', 'rmSync', 'unlink', 'unlinkSync', 'createWriteStream', 'cp', 'cpSync',
]);

// Calls whose second argument is the destination file.
const TWO_PATH_CALLEES = new Set(['rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync']);

const READ_CALLEES = new Set([
  'readJsonFile', 'readFile', 'readFileSync', 'stat', 'statSync', 'lstat', 'lstatSync',
  'access', 'accessSync', 'existsSync', 'exists', 'fileExists', 'watch', 'watchFile',
  'createReadStream', 'resolve', 'join', 'dirname', 'basename', 'relative', 'normalize', 'appPath', 'appRoot',
]);

const CHANNELS_FILE_NAME = 'collab-channels.json';

function calleeName(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return '';
}

function stringText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map(span => span.literal.text).join('');
  }
  return null;
}

/** Whether `node` IS the channels file path (not merely something computed from the file). */
function isChannelsPath(node, ids) {
  if (!node) return false;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    return isChannelsPath(node.expression, ids);
  }
  if (ts.isIdentifier(node)) return ids.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'collabChannels';
  const text = stringText(node);
  if (text !== null) return text.trim().endsWith(CHANNELS_FILE_NAME);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isChannelsPath(node.left, ids) || isChannelsPath(node.right, ids);
  }
  if (ts.isCallExpression(node) && ['join', 'resolve', 'appPath'].includes(calleeName(node))) {
    return node.arguments.some(arg => isChannelsPath(arg, ids));
  }
  return false;
}

/** Names in this file that hold the channels path, found by following declarations to a fixpoint. */
function channelsPathNames(sf) {
  const ids = new Set();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const from = statement.moduleSpecifier.text;
    for (const element of bindings.elements) {
      const original = (element.propertyName ?? element.name).text;
      if (/_collab-shared$/.test(from) && original === 'DATA_PATH') ids.add(element.name.text);
      if (/_pty-shared$/.test(from) && original === 'CHANNELS_PATH') ids.add(element.name.text);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    const visit = node => {
      const named = (ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name);
      if (named && node.initializer && !ids.has(node.name.text) && isChannelsPath(node.initializer, ids)) {
        ids.add(node.name.text);
        grew = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return ids;
}

/** Violations in one source file. `fileName` is only used for reporting and the store exemption. */
export function scanSource(fileName, text) {
  if (fileName.replace(/\\/g, '/').endsWith(STORE_FILE)) return [];
  if (!/collabChannels|collab-channels|DATA_PATH|CHANNELS_PATH/.test(text)) return [];

  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, kind);
  const ids = channelsPathNames(sf);
  const violations = [];

  const visit = node => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const [first, second] = node.arguments;
      let rule = null;
      if (name === 'withFileLock' && isChannelsPath(first, ids)) rule = 'lock';
      else if (WRITE_CALLEES.has(name)
        && (isChannelsPath(first, ids) || (TWO_PATH_CALLEES.has(name) && isChannelsPath(second, ids)))) rule = 'write';
      else if (!READ_CALLEES.has(name) && name !== 'withFileLock' && !WRITE_CALLEES.has(name)
        && node.arguments.some(arg => isChannelsPath(arg, ids))) rule = 'passed';
      if (rule) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const snippet = node.getText(sf).replace(/\s+/g, ' ').slice(0, 90);
        violations.push({ file: fileName, line: line + 1, rule, snippet });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

const MESSAGES = {
  write: 'writes collab-channels.json',
  lock: 'takes the lock on collab-channels.json',
  passed: 'passes the collab-channels.json path to a function that is not a plain read',
};

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) files.push(full);
  }
}

/** Scan the source tree under `root`. Returns the violations; an empty array means the guard passes. */
export function scanChannelWrites(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const full = path.join(root, dir);
    if (fs.existsSync(full)) walk(full, files);
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) files.push(path.join(root, entry.name));
  }
  const violations = [];
  for (const file of files) {
    const relative = path.relative(root, file).replace(/\\/g, '/');
    violations.push(...scanSource(relative, fs.readFileSync(file, 'utf8')));
  }
  return violations;
}

function main() {
  let violations;
  try {
    violations = scanChannelWrites();
  } catch (error) {
    console.error(`[channel-write-guard] could not scan the source tree: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
  if (violations.length === 0) {
    console.log(`[channel-write-guard] ok: only ${STORE_FILE} writes collab-channels.json`);
    return;
  }
  console.error(`[channel-write-guard] FAILED: ${violations.length} place(s) outside ${STORE_FILE} can write collab-channels.json`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}] ${MESSAGES[v.rule]}: ${v.snippet}`);
  }
  console.error('Change the file through mutateChannels(caller, fn) and saveChannels(data) from lib/collab-channel-store.ts.');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
