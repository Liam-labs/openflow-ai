#!/usr/bin/env node
/**
 * Ownership check. Reads ownership.json (which side owns each path) and fails when a change breaks it.
 *
 *   node scripts/check-ownership.mjs --all
 *       every tracked file must be labelled
 *   node scripts/check-ownership.mjs --changed <base> <head> [--branch <name>]
 *       every changed file must be labelled; an export/* branch may not touch an openflow-only path;
 *       nothing may touch a devflow-only path (those never leave DevFlow)
 *
 * The most specific matching rule wins: an exact path beats `dir/**`, and a longer `dir/**` beats a shorter one.
 * Runs from the pull-request and push events in .github/workflows/checks.yml. No polling.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const KINDS = ['core', 'openflow-only', 'devflow-only'];

export function validateManifest(manifest) {
  const problems = [];
  if (!manifest || !Array.isArray(manifest.rules)) return ['ownership.json has no rules list'];
  const seen = new Set();
  for (const r of manifest.rules) {
    if (!r || typeof r.path !== 'string' || !r.path) { problems.push('a rule has no path'); continue; }
    if (!KINDS.includes(r.kind)) problems.push(`${r.path}: kind must be one of ${KINDS.join(', ')}`);
    if (r.path.includes('*') && !r.path.endsWith('/**')) problems.push(`${r.path}: only a trailing /** is supported`);
    if (seen.has(r.path)) problems.push(`${r.path}: listed twice`);
    seen.add(r.path);
  }
  return problems;
}

/** Kind for one repo-relative path, or null when nothing matches. */
export function classify(manifest, file) {
  let best = null;
  let bestScore = -1;
  for (const r of manifest.rules) {
    let score = -1;
    if (r.path.endsWith('/**')) {
      const dir = r.path.slice(0, -3);
      if (file.startsWith(dir + '/')) score = dir.length;
    } else if (r.path === file) {
      score = Number.MAX_SAFE_INTEGER;
    }
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best ? best.kind : null;
}

/** Problems for a list of changed files. `branch` is the pull request's head branch, if any. */
export function checkFiles(manifest, files, branch = '') {
  const problems = [];
  const isExport = branch.startsWith('export/');
  for (const file of files) {
    const kind = classify(manifest, file);
    if (kind === null) problems.push(`${file}: no ownership label. Add it to ownership.json as core, openflow-only or devflow-only.`);
    else if (kind === 'devflow-only') problems.push(`${file}: marked devflow-only, so it must not be in this repository.`);
    else if (kind === 'openflow-only' && isExport) problems.push(`${file}: openflow-only, but this export branch changes it. An export may not write OpenFlow-only paths.`);
  }
  return problems;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(readFileSync(path.join(root, 'ownership.json'), 'utf8'));
  const problems = validateManifest(manifest);
  let files = [];
  let branch = '';
  const bi = argv.indexOf('--branch');
  if (bi >= 0) branch = argv[bi + 1] || '';
  if (argv.includes('--all')) {
    files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  } else if (argv.includes('--changed')) {
    const i = argv.indexOf('--changed');
    const base = argv[i + 1];
    const head = argv[i + 2];
    if (!base || !head) { console.error('usage: --changed <base> <head>'); return 2; }
    files = git(['diff', '--name-only', '-z', '--no-renames', `${base}...${head}`]).split('\0').filter(Boolean);
  } else {
    console.error('usage: check-ownership.mjs --all | --changed <base> <head> [--branch <name>]');
    return 2;
  }
  problems.push(...checkFiles(manifest, files, branch));
  if (problems.length) {
    console.error(`Ownership check failed (${problems.length}):`);
    for (const p of problems.slice(0, 50)) console.error(`  - ${p}`);
    if (problems.length > 50) console.error(`  ... and ${problems.length - 50} more`);
    return 1;
  }
  console.log(`Ownership check passed (${files.length} file${files.length === 1 ? '' : 's'} checked).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
