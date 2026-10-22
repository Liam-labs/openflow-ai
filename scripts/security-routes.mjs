#!/usr/bin/env node
// Which API route handlers check who is calling, and which do not.
//
//   node scripts/security-routes.mjs [ROOT] [--json] [--fail-on-open]   list every handler (METHOD /route) and its guard
//   node scripts/security-routes.mjs [ROOT] --fix                       add requireAuthOrLocal to handlers that have none
//
// A handler is GUARDED when it is wrapped in a guard (withApiAuth(...)), or its leading statements call one of GUARDS and refuse
// (if (denied) return denied) before any other await. A guard that is only named, ignored, called late or not acted on is OPEN.
// Handlers exported by name, by `export { h as POST }`, by re-export or by destructuring are all seen; the last two are always OPEN
// (the tool cannot follow them) and need a reviewed-open entry.
// Handlers listed in scripts/security-open-routes.txt (METHOD /route  # reason) are reviewed as open on purpose.
// --fail-on-open exits 1 when any other handler is open, so a new unguarded route fails the check.
// Names and paths only. Needs `typescript` from the project's node_modules.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const root = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');

export const GUARDS = ['requireAuthOrLocal', 'requireTokenOrLocal', 'validateApiToken', 'withApiAuth', 'requireAuth', 'isLocalRequest', 'requireOwnerSession', 'requireRileyVoiceCompanion'];
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function* routeFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* routeFiles(full);
    else if (entry.name === 'route.ts') yield full;
  }
}

function handlerFunction(expr) {
  // export const GET = async (...) => {}   or   tracked('/x', async (...) => {})   or   withApiAuth(async ...)
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return expr;
  if (ts.isCallExpression(expr)) for (const a of expr.arguments) { const f = handlerFunction(a); if (f) return f; }
  return null;
}

const calleeName = (call, source) => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
};

/** Guard calls (real call expressions, never comments or strings) anywhere under a node. */
function guardCallsIn(node, source) {
  const found = [];
  const walk = (n) => {
    if (ts.isCallExpression(n)) { const name = calleeName(n, source); if (name && GUARDS.includes(name)) found.push(n); }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

const containsAwait = (node) => {
  let found = false;
  const walk = (n) => { if (ts.isAwaitExpression(n)) found = true; if (!found) ts.forEachChild(n, walk); };
  walk(node);
  return found;
};

const returnsOrThrows = (node) => {
  let found = false;
  const walk = (n) => { if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) found = true; if (!found && !ts.isFunctionLike(n)) ts.forEachChild(n, walk); };
  walk(node);
  return found;
};

const strip = (e) => {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    else if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) e = e.operand;
    else return e;
  }
};
/** The condition refuses whenever the guard says no: `v`, `!v`, `v !== null`, `!v.valid`, or those joined by || (never by &&). */
const conditionIs = (cond, name) => {
  const e = strip(cond);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) return conditionIs(e.left, name) || conditionIs(e.right, name);     // any refusing branch of an || is enough
  if (ts.isIdentifier(e)) return e.text === name;
  if (ts.isPropertyAccessExpression(e)) return ts.isIdentifier(e.expression) && e.expression.text === name && ['valid', 'ok', 'authorized', 'allowed'].includes(e.name.text);     // if (!auth.valid) return ...
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(e.operatorToken.kind)) {
    return ts.isIdentifier(e.left) && e.left.text === name && (e.right.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e.right) && e.right.text === 'undefined'));
  }
  return false;
};
const referencesName = (node, name) => {
  let found = false;
  const walk = (n) => { if (ts.isIdentifier(n) && n.text === name) found = true; if (!found) ts.forEachChild(n, walk); };
  walk(node);
  return found;
};

/**
 * Does this handler body REFUSE an unauthorised caller before it does any work?
 * Yes when, among its leading statements (or those of its first try block), a guard call's result is tested by an `if` that
 * returns/throws, and no earlier statement awaits anything. A guard that is only named, called and ignored, called after the
 * work, or called but not acted on does not count.
 */
function refusesBeforeWork(body, source) {
  const levels = [body.statements];
  const firstTry = body.statements.find((st) => ts.isTryStatement(st));
  if (firstTry) levels.push(firstTry.tryBlock.statements);
  for (const statements of levels) {
    for (let i = 0; i < statements.length; i++) {
      const st = statements[i];
      const guards = guardCallsIn(st, source);
      if (!guards.length) { if (containsAwait(st)) break; else continue; }
      let ok = false;
      if (ts.isIfStatement(st)) { const e = strip(st.expression); ok = returnsOrThrows(st.thenStatement) && ts.isCallExpression(e) && guardCallsIn(e, source).length > 0 && GUARDS.includes(calleeName(e, source) || ''); }
      else if (ts.isVariableStatement(st)) {
        const names = st.declarationList.declarations.filter((d) => ts.isIdentifier(d.name) && d.initializer && guardCallsIn(d.initializer, source).length).map((d) => d.name.text);
        ok = names.some((name) => statements.slice(i + 1).some((later, k) => {
          if (!(ts.isIfStatement(later) && conditionIs(later.expression, name) && returnsOrThrows(later.thenStatement))) return false;
          return !statements.slice(i + 1, i + 1 + k).some(containsAwait);          // nothing awaited between the guard and the refusal
        }));
      }
      if (ok) return true;
      break;                                                                      // the first statement that mentions a guard decides
    }
  }
  return false;
}

export function analyse(file) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const handlers = [];
  // top-level functions and consts by name, so `export const GET = withTiming('/x', _getHandler)` can be followed to _getHandler
  const declared = new Map();
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) declared.set(stmt.name.text, stmt);
    else if (ts.isVariableStatement(stmt)) for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) declared.set(d.name.text, d);
  }
  const functionOf = (node) => {
    if (!node) return null;
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
    if (ts.isVariableDeclaration(node)) return functionOf(node.initializer);
    if (ts.isCallExpression(node)) { for (const a of node.arguments) { const f = functionOf(a); if (f) return f; } }
    if (ts.isIdentifier(node) && declared.has(node.text)) return functionOf(declared.get(node.text));
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return functionOf(node.expression);
    return null;
  };
  // wrappers named in the initializer, e.g. withApiAuth(handler) or tracked('/x', withApiAuth(handler)): the wrapper does the refusing
  const wrapperGuards = (node) => {
    if (!node) return [];
    const names = [];
    const walk = (n) => {
      if (ts.isCallExpression(n)) { const name = calleeName(n, source); if (name && GUARDS.includes(name) && n.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a) || (ts.isIdentifier(a) && declared.has(a.text) && functionOf(declared.get(a.text))))) names.push(name); }
      ts.forEachChild(n, walk);
    };
    walk(node);
    return names;
  };
  const add = (method, node, how) => {
    const fn = functionOf(node);
    const wrappers = ts.isVariableDeclaration(node) ? wrapperGuards(node.initializer) : [];
    const inline = fn && fn.body && ts.isBlock(fn.body) && refusesBeforeWork(fn.body, source);
    const present = fn ? guardCallsIn(fn, source).map((c) => calleeName(c, source)) : [];
    handlers.push({ method, fn, guards: wrappers.length || inline ? [...new Set([...wrappers, ...present])] : [], mentioned: [...new Set(present)], how });
  };
  for (const stmt of source.statements) {
    const exported = ts.getModifiers?.(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isExportDeclaration(stmt)) {                                      // export { h as POST } / export { POST } / export { POST } from './x'
      if (stmt.moduleSpecifier) { for (const el of stmt.exportClause && ts.isNamedExports(stmt.exportClause) ? stmt.exportClause.elements : []) if (METHODS.has(el.name.text)) handlers.push({ method: el.name.text, fn: null, guards: [], mentioned: [], how: 're-export from another file' }); continue; }
      for (const el of stmt.exportClause && ts.isNamedExports(stmt.exportClause) ? stmt.exportClause.elements : []) {
        if (!METHODS.has(el.name.text)) continue;
        const local = (el.propertyName || el.name).text;
        if (declared.has(local)) add(el.name.text, declared.get(local), 'export list'); else handlers.push({ method: el.name.text, fn: null, guards: [], mentioned: [], how: 'export list of something not declared here' });
      }
      continue;
    }
    if (!exported) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name && METHODS.has(stmt.name.text)) add(stmt.name.text, stmt, 'function');
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isObjectBindingPattern(d.name)) {                              // export const { GET, POST } = something
          for (const el of d.name.elements) if (ts.isIdentifier(el.name) && METHODS.has(el.name.text)) handlers.push({ method: el.name.text, fn: null, guards: [], mentioned: [], how: 'destructured export' });
          continue;
        }
        if (!ts.isIdentifier(d.name) || !METHODS.has(d.name.text) || !d.initializer) continue;
        add(d.name.text, d, 'const');
      }
    }
  }
  return { text, source, handlers };
}

const route = (file) => '/' + path.relative(path.join(root, 'app'), path.dirname(file)).split(path.sep).join('/');

const openFile = path.join(path.dirname(new URL(import.meta.url).pathname), 'security-open-routes.txt');
const reviewedOpen = new Set(fs.existsSync(openFile) ? fs.readFileSync(openFile, 'utf8').split('\n').map((l) => l.split('#')[0].trim()).filter(Boolean) : []);

const rows = [];
for (const file of [...routeFiles(path.join(root, 'app', 'api'))].sort()) {
  const { handlers } = analyse(file);
  for (const h of handlers) {
    const status = h.guards.length ? 'GUARDED' : 'OPEN';   // a guard that is only mentioned, ignored, late or conditional does not count
    rows.push({ route: route(file), method: h.method, file: path.relative(root, file), guards: h.guards, status, ...(status === 'OPEN' && h.mentioned.length ? { note: 'calls ' + h.mentioned.join(', ') + ' but does not refuse with the result before doing work' } : {}), ...(h.how && !h.fn ? { note: h.how } : {}) });
  }
}

if (args.includes('--fix')) {
  let fixed = 0, skipped = 0;
  for (const file of [...routeFiles(path.join(root, 'app', 'api'))].sort()) {
    let { text, source, handlers } = analyse(file);
    const edits = [];
    for (const h of handlers) {
      if (h.guards.length || reviewedOpen.has(`${h.method} ${route(file)}`)) continue;
      const fn = h.fn;
      const isAsync = fn && ts.getModifiers?.(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      if (!fn || !fn.body || !ts.isBlock(fn.body) || !isAsync) { console.error(`skip ${h.method} ${route(file)}: handler is not an async function with a block body`); skipped++; continue; }
      const first = fn.parameters[0];
      if (first && !ts.isIdentifier(first.name)) { console.error(`skip ${h.method} ${route(file)}: first parameter is destructured, add the guard by hand`); skipped++; continue; }
      const name = first && ts.isIdentifier(first.name) ? first.name.text : 'request';
      if (!first) edits.push([fn.parameters.pos, fn.parameters.end, `${name}: NextRequest`]);
      const scope = h.method === 'GET' || h.method === 'HEAD' || h.method === 'OPTIONS' ? 'read' : 'write';
      const cast = first && first.type && /^NextRequest$/.test(first.type.getText(source)) ? name : `${name} as NextRequest`;
      edits.push([fn.body.getStart(source) + 1, fn.body.getStart(source) + 1, `\n  const denied = await requireAuthOrLocal(${cast}, '${scope}');\n  if (denied) return denied;\n`]);
      fixed++;
    }
    if (!edits.length) continue;
    for (const [s, e, r] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, s) + r + text.slice(e);
    const src2 = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const imports = src2.statements.filter(ts.isImportDeclaration);
    const has = (re) => imports.some((i) => re.test(i.getText(src2)));
    const add = [];
    if (!has(/\bNextRequest\b/)) add.push("import { NextRequest } from 'next/server';");
    if (!has(/\brequireAuthOrLocal\b/)) add.push("import { requireAuthOrLocal } from '@/lib/api-auth';");
    if (add.length) {
      const at = imports.length ? imports[imports.length - 1].end : 0;
      text = text.slice(0, at) + (imports.length ? '\n' : '') + add.join('\n') + (imports.length ? '' : '\n') + text.slice(at);
    }
    fs.writeFileSync(file, text);
  }
  console.log(`guards added: ${fixed}, skipped: ${skipped}`);
} else {
  const open = rows.filter((r) => r.status === 'OPEN');
  const indirect = rows.filter((r) => r.status === 'INDIRECT');
  const unreviewed = open.filter((r) => !reviewedOpen.has(`${r.method} ${r.route}`));
  if (args.includes('--json')) console.log(JSON.stringify({ handlers: rows.length, guarded: rows.filter((r) => r.status === 'GUARDED').length, indirect: indirect.length, open: open.length, openNotReviewed: unreviewed.map((r) => `${r.method} ${r.route}`), rows }, null, 1));
  else {
    console.log(`${rows.length} handlers: ${rows.length - open.length - indirect.length} guard themselves, ${indirect.length} rely on a helper in the same file (review), ${open.length} have no guard in the file (${unreviewed.length} not on the reviewed list)`);
    for (const r of open) console.log(`  OPEN${reviewedOpen.has(`${r.method} ${r.route}`) ? '' : ' (NEW)'} ${r.method} ${r.route}${r.note ? '  [' + r.note + ']' : ''}`);
    if (args.includes('--indirect')) for (const r of indirect) console.log(`  INDIRECT ${r.method} ${r.route}  (${r.guards.join(',')})`);
  }
  if (args.includes('--fail-on-open') && unreviewed.length) process.exit(1);
}
