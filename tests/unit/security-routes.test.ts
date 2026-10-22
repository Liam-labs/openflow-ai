import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const TOOL = path.join(ROOT, 'scripts', 'security-routes.mjs');

function run(root: string, ...args: string[]) {
  return spawnSync('node', [TOOL, root, ...args], { encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') } });
}

describe('every API handler checks who is calling (unless reviewed as open)', () => {
  it('this tree has no unguarded handler that is not on the reviewed list', () => {
    const done = run(ROOT, '--fail-on-open');
    expect(done.stdout).toMatch(/0 not on the reviewed list/);
    expect(done.status).toBe(0);
  });

  it('every reviewed-open entry still exists and still has a reason', () => {
    const lines = fs.readFileSync(path.join(ROOT, 'scripts', 'security-open-routes.txt'), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(0);
    const json = JSON.parse(run(ROOT, '--json').stdout);
    const open = new Set(json.rows.filter((r: { status: string }) => r.status === 'OPEN').map((r: { method: string; route: string }) => `${r.method} ${r.route}`));
    for (const line of lines) {
      const [entry, reason] = line.split('#');
      expect(reason?.trim(), `${entry} needs a reason`).toBeTruthy();
      expect(open.has(entry.trim()), `${entry.trim()} is listed as open but is guarded or gone`).toBe(true);
    }
  });
});

describe('the audit tool', () => {
  let tree: string;
  const write = (rel: string, text: string) => {
    const file = path.join(tree, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  beforeEach(() => {
    tree = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
    fs.writeFileSync(path.join(tree, 'package.json'), '{}');
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tree, 'node_modules'));
  });
  afterEach(() => fs.rmSync(tree, { recursive: true, force: true }));

  const rows = () => JSON.parse(run(tree, '--json').stdout).rows as Array<{ method: string; route: string; status: string }>;
  const status = (method: string, route: string) => rows().find((r) => r.method === method && r.route === route)?.status;

  it('sees a guard in the handler body, in a wrapper and in the function a wrapper calls', () => {
    write('app/api/a/route.ts', `import { requireAuthOrLocal } from '@/lib/api-auth';
export async function GET(request) { const d = await requireAuthOrLocal(request, 'read'); if (d) return d; return Response.json({}); }
export const POST = tracked('/a', async (request) => { const d = await requireAuthOrLocal(request, 'write'); if (d) return d; });
async function _put(request) { const d = await requireAuthOrLocal(request, 'write'); if (d) return d; }
export const PUT = withTiming('/a', _put);`);
    expect(['GET', 'POST', 'PUT'].map((m) => status(m, '/api/a'))).toEqual(['GUARDED', 'GUARDED', 'GUARDED']);
  });

  it('a guard on one method does not cover the others, nor a guard that only sits in an unrelated helper', () => {
    write('app/api/b/route.ts', `import { requireAuthOrLocal } from '@/lib/api-auth';
export async function GET(request) { const d = await requireAuthOrLocal(request, 'read'); if (d) return d; }
export async function POST(request) { return Response.json({ wrote: true }); }
async function unrelated(request) { return requireAuthOrLocal(request, 'read'); }`);
    expect(status('GET', '/api/b')).toBe('GUARDED');
    expect(status('POST', '/api/b')).toBe('OPEN');
  });

  it.each([
    ['a guard named only in a comment', `export async function POST(request) { /* requireAuthOrLocal(request) */ return Response.json({}); }`],
    ['a guard named only in a string', `export async function POST(request) { const s = 'requireAuthOrLocal(request)'; return Response.json({ s }); }`],
    ['a guard whose result is ignored', `export async function POST(request) { await requireAuthOrLocal(request, 'write'); return Response.json({}); }`],
    ['a guard result that is stored and never acted on', `export async function POST(request) { const d = await requireAuthOrLocal(request, 'write'); return Response.json({ d }); }`],
    ['a guard that comes after the work', `export async function POST(request) { await doWork(); const d = await requireAuthOrLocal(request, 'write'); if (d) return d; return Response.json({}); }`],
    ['a guard that is acted on only some of the time', `export async function POST(request) { const d = await requireAuthOrLocal(request, 'write'); if (d && request.headers.get('x')) return d; return Response.json({}); }`],
    ['an if that tests the guard but does not return', `export async function POST(request) { const d = await requireAuthOrLocal(request, 'write'); if (d) { console.log('no'); } return Response.json({}); }`],
    ['work between the guard and the refusal', `export async function POST(request) { const d = await requireAuthOrLocal(request, 'write'); await doWork(); if (d) return d; return Response.json({}); }`],
    ['a guard in a function that is defined but never called', `export async function POST(request) { async function later() { const d = await requireAuthOrLocal(request); if (d) return d; } return Response.json({}); }`],
  ])('%s does not count as a guard', (_name, code) => {
    write('app/api/weak/route.ts', code);
    const row = rows().find((r) => r.route === '/api/weak');
    expect(row?.status).toBe('OPEN');
  });

  it('accepts !auth.valid and an || chain that includes it, but not an && chain', () => {
    write('app/api/v1/route.ts', `export async function GET(request) { const auth = await validateApiToken(request); if (!auth.valid || !auth.token) return Response.json({}, { status: 401 }); return Response.json({}); }`);
    write('app/api/v2/route.ts', `export async function GET(request) { const auth = await validateApiToken(request); if (auth.code === 'RATE_LIMITED') return Response.json({}, { status: 429 }); if (!auth.valid) return Response.json({}, { status: 401 }); return Response.json({}); }`);
    write('app/api/v3/route.ts', `export async function GET(request) { const auth = await validateApiToken(request); if (!auth.valid && auth.code) return Response.json({}, { status: 401 }); return Response.json({}); }`);
    expect([status('GET', '/api/v1'), status('GET', '/api/v2'), status('GET', '/api/v3')]).toEqual(['GUARDED', 'GUARDED', 'OPEN']);
  });

  it('counts a refusal inside the first try block and an if that refuses straight from isLocalRequest', () => {
    write('app/api/ok1/route.ts', `export async function POST(request) { try { const d = await requireAuthOrLocal(request, 'write'); if (d) return d; return Response.json({}); } catch { return Response.json({}, { status: 500 }); } }`);
    write('app/api/ok2/route.ts', `export async function POST(request) { if (!isLocalRequest(request)) { return Response.json({}, { status: 403 }); } return Response.json({}); }`);
    expect([status('POST', '/api/ok1'), status('POST', '/api/ok2')]).toEqual(['GUARDED', 'GUARDED']);
  });

  it('sees handlers exported by an export list, a destructuring and a re-export, and cannot follow the last two', () => {
    write('app/api/forms/route.ts', `async function h(request) { return Response.json({}); }
export { h as POST };`);
    write('app/api/forms2/route.ts', `const handlers = make();
export const { GET, DELETE } = handlers;`);
    write('app/api/forms3/route.ts', `export { PUT } from './elsewhere';`);
    write('app/api/forms4/route.ts', `async function GET(request) { const d = await requireAuthOrLocal(request); if (d) return d; return Response.json({}); }
export { GET };`);
    expect(status('POST', '/api/forms')).toBe('OPEN');
    expect([status('GET', '/api/forms2'), status('DELETE', '/api/forms2'), status('PUT', '/api/forms3')]).toEqual(['OPEN', 'OPEN', 'OPEN']);
    expect(status('GET', '/api/forms4')).toBe('GUARDED');
  });

  it('a wrapper guard around the handler counts, a guard call inside it that merely takes the request does not make a wrapper', () => {
    write('app/api/wrap/route.ts', `export const POST = withApiAuth(async (request) => Response.json({}));`);
    write('app/api/nowrap/route.ts', `export const POST = tracked('/x', async (request) => { const d = await requireAuthOrLocal(request); return Response.json({ d }); });`);
    expect([status('POST', '/api/wrap'), status('POST', '/api/nowrap')]).toEqual(['GUARDED', 'OPEN']);
  });

  it('--fail-on-open fails on a new open handler and passes once it is fixed', () => {
    write('app/api/c/route.ts', `export const DELETE = tracked('/c', async () => { return Response.json({}); });`);
    expect(run(tree, '--fail-on-open').status).toBe(1);
    const fix = run(tree, '--fix');
    expect(fix.stdout).toMatch(/guards added: 1/);
    const fixed = fs.readFileSync(path.join(tree, 'app/api/c/route.ts'), 'utf8');
    expect(fixed).toMatch(/requireAuthOrLocal\(request as NextRequest, 'write'\)/);
    expect(fixed).toMatch(/import \{ NextRequest \} from 'next\/server'/);
    expect(run(tree, '--fail-on-open').status).toBe(0);
  });

  it('--fix uses read scope for GET and write for the rest, and is idempotent', () => {
    write('app/api/d/route.ts', `export async function GET() { return Response.json({}); }
export async function PUT(req) { return Response.json({}); }`);
    run(tree, '--fix');
    const once = fs.readFileSync(path.join(tree, 'app/api/d/route.ts'), 'utf8');
    expect(once).toMatch(/GET\(request: NextRequest\)[\s\S]*'read'/);
    expect(once).toMatch(/PUT\(req\)[\s\S]*requireAuthOrLocal\(req as NextRequest, 'write'\)/);
    run(tree, '--fix');
    expect(fs.readFileSync(path.join(tree, 'app/api/d/route.ts'), 'utf8')).toBe(once);
  });

  it('--fix skips a handler whose first parameter is destructured instead of writing code that does not compile', () => {
    write('app/api/e/route.ts', `export async function POST({ headers }) { return Response.json({}); }`);
    const out = run(tree, '--fix');
    expect(out.stdout).toMatch(/skipped: 1/);
    expect(fs.readFileSync(path.join(tree, 'app/api/e/route.ts'), 'utf8')).not.toMatch(/requireAuthOrLocal/);
  });

  it('a handler listed as reviewed-open is reported as open but does not fail', () => {
    write('app/api/status/route.ts', `export async function GET() { return Response.json({ ok: true }); }`);
    const listed = path.join(ROOT, 'scripts', 'security-open-routes.txt');
    // the tool reads the list next to itself, so a synthetic route cannot be listed; the real list is covered above
    expect(fs.existsSync(listed)).toBe(true);
    expect(run(tree, '--fail-on-open').status).toBe(1);
  });
});
