import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

let dir: string;
vi.mock('@/lib/data-paths', async () => ({
  DataPaths: {
    get dashboardAuth() { return path.join(dir, 'dashboard-auth.json'); },
    get apiTokens() { return path.join(dir, 'api-tokens.json'); },
    get memoryWizard() { return path.join(dir, 'memory-wizard.json'); },
  },
}));

const lib = () => import('@/lib/wizards/memory');
type Deps = import('@/lib/wizards/memory').Deps;
type Rec = import('@/lib/wizards/memory').MemoryRecord;
type Facts = import('@/lib/wizards/memory').MemoryFacts;

const ROOT = '/data/app';

function world(over: Partial<{
  dockerInstalled: boolean; dockerRunning: boolean; containers: Map<string, boolean>; pullFails: string; runFails: string; startFails: string; rmFails: boolean;
  pyVersion: string | null; uv: boolean; files: Set<string>; availableMB: number; diskMB: number; healthy: boolean; healthAfterRun: boolean;
  venvFails: string; pipFails: string; uvVenvFails: string; proof: string; external: { address: string; family: 4 | 6 }[]; open: Set<string>;
}> = {}) {
  const w = {
    dockerInstalled: true, dockerRunning: true, containers: new Map<string, boolean>(), pullFails: '', runFails: '', startFails: '', rmFails: false,
    pyVersion: '3.12' as string | null, uv: false, files: new Set<string>(), availableMB: 8000, diskMB: 50000, healthy: false, healthAfterRun: true,
    venvFails: '', pipFails: '', uvVenvFails: '', proof: '{"ok": true, "top": "garden", "expected": "garden", "detail": "The right memory came back first."}',
    external: [{ address: '192.168.1.20', family: 4 as const }], open: new Set<string>(),
    userSpec: null as string | null, removeFails: null as null | { code: string; untilCleaned: boolean }, cleanFails: false, cleaned: false,
    cmds: [] as string[], violations: [] as string[], record: { enabled: false } as Rec, mcpAdds: [] as unknown[], mcpRemoves: 0, mcpOk: true, removed: [] as string[], made: [] as string[], sleeps: 0, dropStatus: undefined as number | undefined,
    ...over,
  };
  return w;
}
type W = ReturnType<typeof world>;

function deps(w: W, over: Partial<Deps> = {}): Deps {
  const { allowedCommand } = require_('@/lib/wizards/memory');
  return {
    env: {}, now: () => '2026-10-22T12:00:00.000Z', sleep: async () => { w.sleeps++; }, root: ROOT, proofScript: '/repo/scripts/memory-wizard-proof.py',
    exec: async (file, args) => {
      const line = `${file} ${args.join(' ')}`; w.cmds.push(line);
      if (!allowedCommand(file, args, ROOT)) { w.violations.push(line); return { code: 126, stdout: '', stderr: 'not allowed' }; }
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      const bad = (stderr: string, code = 1) => ({ code, stdout: '', stderr });
      if (file === 'docker') {
        if (!w.dockerInstalled) return bad('not found', 127);
        if (args[0] === 'info') return w.dockerRunning ? ok('29.1.3\n') : bad('Cannot connect to the Docker daemon');
        if (args[0] === 'ps') return ok([...w.containers].map(([n, up]) => `${n}|${up ? 'Up 2 hours' : 'Exited (0) 3 minutes ago'}`).join('\n') + '\n');
        if (args[0] === 'pull') return w.pullFails ? bad(w.pullFails) : ok();
        if (args[0] === 'logs') return { code: 0, stdout: 'INFO starting\n', stderr: 'ERROR qdrant: Failed to create snapshots temp directory at ./snapshots/tmp: Permission denied\n' };
        if (args[0] === 'run' && args[1] === '--rm') { if (w.cleanFails) return bad('permission denied while mounting'); w.cleaned = true; return ok(); }
        if (args[0] === 'run') { if (w.runFails) return bad(w.runFails); w.containers.set('openflow-qdrant', true); if (w.healthAfterRun) w.healthy = true; return ok('abc123\n'); }
        if (args[0] === 'start') { if (w.startFails) return bad(w.startFails); w.containers.set('openflow-qdrant', true); w.healthy = true; return ok(); }
        if (args[0] === 'stop') { w.containers.set('openflow-qdrant', false); w.healthy = false; return ok(); }
        if (args[0] === 'rm') { if (w.rmFails) return bad('in use'); w.containers.delete('openflow-qdrant'); return ok(); }
      }
      if (file === 'python3') {
        if (args[0] === '-c') return w.pyVersion ? ok(`${w.pyVersion.replace('.', ' ')}\n`) : bad('No module named ensurepip');
        if (args[0] === '-m') { if (w.venvFails) return bad(w.venvFails); w.files.add(`${args[2]}/bin/pip`); w.files.add(`${args[2]}/bin/python`); return ok(); }
      }
      if (file === 'uv') {
        if (!w.uv) return bad('not found', 127);
        if (args[0] === '--version') return ok('uv 0.9\n');
        if (args[0] === 'venv') { if (w.uvVenvFails) return bad(w.uvVenvFails); w.files.add(`${args[3]}/bin/python`); return ok(); }
        if (args[0] === 'pip') { if (w.pipFails) return bad(w.pipFails); w.files.add(args[3].replace('/python', '/mcp-server-qdrant')); return ok(); }
      }
      if (file.endsWith('/bin/pip')) { if (w.pipFails) return bad(w.pipFails); w.files.add(file.replace('/pip', '/mcp-server-qdrant')); return ok(); }
      if (file.endsWith('/bin/python')) return ok(w.proof + '\n');
      return bad('unexpected', 127);
    },
    readRecord: async () => JSON.parse(JSON.stringify(w.record)), writeRecord: async (r) => { w.record = JSON.parse(JSON.stringify(r)); },
    availableMB: async () => w.availableMB, diskFreeMB: async () => w.diskMB, healthz: async () => w.healthy, dropOwnCollection: async () => { w.cmds.push('drop openflow-memory'); return w.dropStatus === undefined ? { ok: true, status: 200 } : { ok: w.dropStatus === 404, status: w.dropStatus }; },
    exists: (p) => w.files.has(p), removeDir: async (p) => { if (w.removeFails && !(w.removeFails.untilCleaned && w.cleaned)) throw Object.assign(new Error(`${w.removeFails.code}: permission denied, unlink '${p}/aliases/data.json'`), { code: w.removeFails.code }); w.removed.push(p); }, mkdir: async (p) => { w.made.push(p); },
    externalAddresses: () => w.external, canConnect: async (h) => w.open.has(h),
    userSpec: () => w.userSpec, mcp: { add: async (bin, model) => { w.mcpAdds.push([bin, model]); return { ok: w.mcpOk, message: w.mcpOk ? 'Added.' : 'refused' }; }, remove: async () => { w.mcpRemoves++; return { ok: true, message: 'Removed.' }; } },
    ...over,
  };
}

// vitest hoists vi.mock; a synchronous handle to the module for the fake exec
import * as memoryModule from '@/lib/wizards/memory';
const require_ = (_: string) => memoryModule;

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memwiz-')); });
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(dir, { recursive: true, force: true }); });

describe('which commands may run', () => {
  const m = memoryModule;
  const IMG = m.QDRANT_IMAGE;
  const run = (over: Record<number, string> = {}) => { const a = ['run', '-d', '--name', 'openflow-qdrant', '--restart', 'unless-stopped', '-p', '127.0.0.1:6333:6333', '-v', `${ROOT}/qdrant-storage:/qdrant/storage`, '-e', m.SNAPSHOTS_ENV, IMG]; for (const [i, v] of Object.entries(over)) a[Number(i)] = v; return a; };
  const run0u = (user = '1001:1001') => { const a = run(); a.splice(12, 0, '--user', user); return a; };
  const clean = (over: Record<number, string> = {}) => { const a = ['run', '--rm', '-v', `${ROOT}/qdrant-storage:/qdrant/storage`, '--entrypoint', 'find', IMG, '/qdrant/storage', '-mindepth', '1', '-delete']; for (const [i, v] of Object.entries(over)) a[Number(i)] = v; return a; };
  it('allows the run with the app\'s own user and the emptying helper, and nothing looser', () => {
    const allowed = (a: string[]) => m.allowedCommand('docker', a, ROOT);
    expect(allowed(run0u())).toBe(true);
    expect(allowed(run0u('root'))).toBe(false);
    expect(allowed(run0u('0:0; rm'))).toBe(false);
    const sneaky = run0u(); sneaky[12] = '--privileged';
    expect(allowed(sneaky)).toBe(false);                                           // 15 arguments, but not a --user
    expect(allowed(clean())).toBe(true);
    expect(allowed(clean({ 5: 'sh' }))).toBe(false);                               // another entrypoint
    expect(allowed(clean({ 7: '/' }))).toBe(false);                                // another folder inside
    expect(allowed(clean({ 10: '-print' }))).toBe(false);
    expect(allowed(clean({ 3: '/etc:/qdrant/storage' }))).toBe(false);             // storage outside the app folder
    expect(allowed(clean({ 6: 'evil/image' }))).toBe(false);
  });
  it('allows exactly the commands the wizard uses', () => {
    const ok = (f: string, a: string[]) => expect(m.allowedCommand(f, a, ROOT), `${f} ${a.join(' ')}`).toBe(true);
    ok('docker', ['info', '--format', '{{.ServerVersion}}']);
    ok('docker', ['ps', '-a', '--filter', 'name=^openflow-qdrant$', '--format', '{{.Names}}|{{.Status}}']);
    ok('docker', ['pull', IMG]); ok('docker', ['logs', '--tail', '20', 'openflow-qdrant']); ok('docker', ['start', 'openflow-qdrant']); ok('docker', ['stop', 'openflow-qdrant']); ok('docker', ['rm', 'openflow-qdrant']);
    ok('docker', run());
    ok('docker', run0u());
    ok('docker', clean());
    ok('python3', ['-c', 'import venv, ensurepip, sys; print(sys.version_info[0], sys.version_info[1])']); ok('python3', ['-m', 'venv', `${ROOT}/memory-venv`]);
    ok('uv', ['--version']); ok('uv', ['venv', '--python', '3.12', `${ROOT}/memory-venv`]); ok('uv', ['pip', 'install', '--python', `${ROOT}/memory-venv/bin/python`, m.MCP_PACKAGE]);
    ok(`${ROOT}/memory-venv/bin/pip`, ['install', '--disable-pip-version-check', m.MCP_PACKAGE]);
    ok(`${ROOT}/memory-venv/bin/python`, ['/repo/scripts/memory-wizard-proof.py', 'http://127.0.0.1:6333', 'sentence-transformers/all-MiniLM-L6-v2', 'proof-abc123def456']);
  });
  it.each([
    ['published to every address', 'docker', () => run({ 7: '0.0.0.0:6333:6333' })],
    ['published with no address', 'docker', () => run({ 7: '6333:6333' })],
    ['published on another loopback port', 'docker', () => run({ 7: '127.0.0.1:6334:6333' })],
    ['another image', 'docker', () => run({ 12: 'qdrant/qdrant:latest' })],
    ['an unpinned look-alike image', 'docker', () => run({ 12: 'evil/qdrant@sha256:abc' })],
    ['another environment setting', 'docker', () => run({ 11: 'QDRANT__SERVICE__API_KEY=x' })],
    ['a second flag in place of -e', 'docker', () => run({ 10: '--network' })],
    ['the old form without the snapshot setting', 'docker', () => ['run', '-d', '--name', 'openflow-qdrant', '--restart', 'unless-stopped', '-p', '127.0.0.1:6333:6333', '-v', `${ROOT}/qdrant-storage:/qdrant/storage`, IMG]],
    ['logs of another container', 'docker', () => ['logs', '--tail', '20', 'postgres']],
    ['another container name', 'docker', () => run({ 3: 'other' })],
    ['a restart policy of always', 'docker', () => run({ 5: 'always' })],
    ['storage outside the app folder', 'docker', () => run({ 9: '/:/qdrant/storage' })],
    ['storage in a sibling folder', 'docker', () => run({ 9: '/data/appx/qdrant-storage:/qdrant/storage' })],
    ['storage with ..', 'docker', () => run({ 9: `${ROOT}/../etc:/qdrant/storage` })],
    ['storage mounted elsewhere in the container', 'docker', () => run({ 9: `${ROOT}/s:/etc` })],
    ['an extra privileged flag', 'docker', () => [...run(), '--privileged']],
    ['the privileged flag in the middle', 'docker', () => ['run', '-d', '--privileged', '--name', 'openflow-qdrant', '--restart', 'unless-stopped', '-p', '127.0.0.1:6333:6333', '-v', `${ROOT}/s:/qdrant/storage`, IMG]],
    ['stopping some other container', 'docker', () => ['stop', 'postgres']],
    ['removing some other container', 'docker', () => ['rm', '-f', 'openflow-qdrant']],
    ['docker exec', 'docker', () => ['exec', 'openflow-qdrant', 'sh']],
    ['docker compose', 'docker', () => ['compose', 'up']],
    ['pulling another image', 'docker', () => ['pull', 'ubuntu']],
    ['listing every container', 'docker', () => ['ps', '-a']],
    ['venv outside the app folder', 'python3', () => ['-m', 'venv', '/tmp/x']],
    ['venv with ..', 'python3', () => ['-m', 'venv', `${ROOT}/../x`]],
    ['arbitrary python code', 'python3', () => ['-c', 'import os; os.system("id")']],
    ['uv with another python', 'uv', () => ['venv', '--python', '3.9', `${ROOT}/memory-venv`]],
    ['uv venv outside the folder', 'uv', () => ['venv', '--python', '3.12', '/tmp/v']],
    ['uv installing another package', 'uv', () => ['pip', 'install', '--python', `${ROOT}/memory-venv/bin/python`, 'evil']],
    ['uv installing another version', 'uv', () => ['pip', 'install', '--python', `${ROOT}/memory-venv/bin/python`, 'mcp-server-qdrant']],
    ['uv installing into another python', 'uv', () => ['pip', 'install', '--python', '/usr/bin/python', 'mcp-server-qdrant==0.8.1']],
    ['uv self update', 'uv', () => ['self', 'update']],
    ['uv version with extras', 'uv', () => ['--version', 'x']],
    ['docker info with another format', 'docker', () => ['info', '--format', '{{json .}}']],
    ['docker info with no format', 'docker', () => ['info']],
    ['docker run attached or removing', 'docker', () => run({ 1: '--rm' })],
    ['pip outside the app folder', `/usr/bin/pip`, () => ['install', '--disable-pip-version-check', memoryModule.MCP_PACKAGE]],
    ['the python proof outside the app folder', `/usr/bin/python`, () => ['/repo/scripts/memory-wizard-proof.py', 'http://127.0.0.1:6333', 'sentence-transformers/all-MiniLM-L6-v2', 'proof-abc123']],
  ])('refuses %s', (_n, file, args) => expect(m.allowedCommand(file, args(), ROOT)).toBe(false));
  it('refuses pip with another package or index, and the proof script with a bad URL, model, nonce or script', () => {
    const pip = `${ROOT}/memory-venv/bin/pip`; const py = `${ROOT}/memory-venv/bin/python`;
    for (const a of [['install', 'evil'], ['install', '--index-url', 'https://evil.example', m.MCP_PACKAGE], ['install', m.MCP_PACKAGE, 'evil'], ['uninstall', m.MCP_PACKAGE]]) expect(m.allowedCommand(pip, a, ROOT), a.join(' ')).toBe(false);
    const good = ['/repo/scripts/memory-wizard-proof.py', 'http://127.0.0.1:6333', 'sentence-transformers/all-MiniLM-L6-v2', 'proof-abc123'];
    expect(m.allowedCommand(py, good, ROOT)).toBe(true);
    for (const [i, v] of [[0, '/repo/other.py'], [0, '/repo/../etc/memory-wizard-proof.py'], [1, 'http://192.168.1.5:6333'], [1, 'http://127.0.0.1:6333/x'], [1, 'https://127.0.0.1:6333'], [2, 'evil/model'], [3, 'a b'], [3, '../x'], [3, 'a']] as [number, string][]) {
      const a = [...good]; a[i] = v; expect(m.allowedCommand(py, a, ROOT), `${i} ${v}`).toBe(false);
    }
    expect(m.allowedCommand('/usr/bin/python', good, ROOT)).toBe(false);
    expect(m.allowedCommand('sh', ['-c', 'id'], ROOT)).toBe(false);
  });
  it('the real runner never starts a program for a refused command', async () => {
    const r = await m.realExec(ROOT)('docker', ['run', '--privileged', 'ubuntu'], 1000);
    expect(r).toEqual({ code: 126, stdout: '', stderr: 'command not allowed' });
  });
  it('findUv looks in the usual places, including ones a service PATH lacks', () => {
    expect(m.findUv((p) => p === '/h/.local/bin/uv', { PATH: '/usr/bin' }, '/h')).toBe('/h/.local/bin/uv');
    expect(m.findUv((p) => p === '/usr/bin/uv', { PATH: '/usr/bin' }, '/h')).toBe('/usr/bin/uv');
    expect(m.findUv(() => false, {}, '/h')).toBeNull();
  });
});

describe('choices', () => {
  const facts = (over: Partial<Facts> = {}): Facts => ({ docker: { installed: true, running: true }, python: { ok: true, version: '3.12' }, uv: false, availableMB: 8000, diskFreeMB: 50000, qdrantUp: false, container: { exists: false, running: false }, ...over });
  it('chooseModel follows the free memory', () => {
    const { chooseModel } = memoryModule;
    expect(chooseModel(8000)).toBe('better'); expect(chooseModel(4000)).toBe('better'); expect(chooseModel(3999)).toBe('light'); expect(chooseModel(1200)).toBe('light'); expect(chooseModel(1199)).toBeNull(); expect(chooseModel(0)).toBeNull();
  });
  it('plans a model that fits and honours a choice only if it fits', () => {
    const { planMemory } = memoryModule;
    expect(planMemory(facts())).toEqual({ ok: true, model: 'better', adopt: false });
    expect(planMemory(facts(), 'light')).toEqual({ ok: true, model: 'light', adopt: false });
    expect(planMemory(facts({ availableMB: 2000 }), 'better')).toEqual({ ok: true, model: 'light', adopt: false });
    expect(planMemory(facts({ diskFreeMB: 4000 }))).toMatchObject({ ok: true });
  });
  it.each([
    ['no Python and no uv', { python: { ok: false, version: null } }, 'python', /Python 3.9 to 3.13/],
    ['an unsupported Python and no uv', { python: { ok: false, version: '3.14' } }, 'python', /Python/],
    ['too little memory', { availableMB: 900 }, 'memory', /skip memory/],
    ['too little disk', { diskFreeMB: 3999 }, 'disk', /disk/],
    ['no Docker', { docker: { installed: false, running: false } }, 'docker', /not installed/],
    ['Docker not running', { docker: { installed: true, running: false } }, 'docker-start', /not running/],
  ] as [string, Partial<Facts>, string, RegExp][])('refuses %s with the fix', (_n, over, fix, why) => {
    const r = memoryModule.planMemory(facts(over));
    expect(r).toMatchObject({ ok: false, fix }); expect(r.ok === false && r.reason).toMatch(why);
  });
  it('uv makes up for a missing or unsupported Python', () => {
    expect(memoryModule.planMemory(facts({ python: { ok: false, version: null }, uv: true }))).toMatchObject({ ok: true });
  });
  it('uses a Qdrant that is already running instead of needing Docker, but not when it is our own container', () => {
    const { planMemory } = memoryModule;
    expect(planMemory(facts({ qdrantUp: true, docker: { installed: false, running: false } }))).toEqual({ ok: true, model: 'better', adopt: true });
    expect(planMemory(facts({ qdrantUp: true, container: { exists: true, running: true } }))).toEqual({ ok: true, model: 'better', adopt: false });
    expect(planMemory(facts({ qdrantUp: true, container: { exists: true, running: true }, docker: { installed: false, running: false } }))).toMatchObject({ ok: false, fix: 'docker' });
  });
  it('memory and disk are checked before Docker, so the answer is "skip", not "install Docker", on a small machine', () => {
    expect(memoryModule.planMemory(facts({ availableMB: 500, docker: { installed: false, running: false } }))).toMatchObject({ fix: 'memory' });
  });
});

describe('gatherFacts', () => {
  it('reads Docker, Python, uv, the container and the resources', async () => {
    const { gatherFacts } = memoryModule; const w = world({ uv: true, containers: new Map([['openflow-qdrant', true]]), healthy: true, availableMB: 5000, diskMB: 9000 });
    expect(await gatherFacts(deps(w))).toEqual({ docker: { installed: true, running: true }, python: { ok: true, version: '3.12' }, uv: true, availableMB: 5000, diskFreeMB: 9000, qdrantUp: true, container: { exists: true, running: true } });
  });
  it('tells a missing Docker from a stopped one, a stopped container from a running one, and rejects Python 3.14 and 3.8', async () => {
    const { gatherFacts } = memoryModule;
    expect((await gatherFacts(deps(world({ dockerInstalled: false })))).docker).toEqual({ installed: false, running: false });
    expect((await gatherFacts(deps(world({ dockerRunning: false })))).docker).toEqual({ installed: true, running: false });
    expect((await gatherFacts(deps(world({ containers: new Map([['openflow-qdrant', false]]) })))).container).toEqual({ exists: true, running: false });
    expect((await gatherFacts(deps(world({ containers: new Map([['old-openflow-qdrant', true]]) })))).container).toEqual({ exists: false, running: false });
    expect((await gatherFacts(deps(world({ pyVersion: '3.14' })))).python).toEqual({ ok: false, version: '3.14' });
    expect((await gatherFacts(deps(world({ pyVersion: '3.8' })))).python.ok).toBe(false);
    expect((await gatherFacts(deps(world({ pyVersion: '4.10' })))).python.ok).toBe(false);
    expect((await gatherFacts(deps(world({ pyVersion: '2.10' })))).python.ok).toBe(false);
    expect((await gatherFacts(deps(world({ pyVersion: '3.9' })))).python.ok).toBe(true);
    expect((await gatherFacts(deps(world({ pyVersion: '3.13' })))).python.ok).toBe(true);
    expect((await gatherFacts(deps(world({ pyVersion: null })))).python).toEqual({ ok: false, version: null });
  });
});

describe('enableMemory', () => {
  const BIN = `${ROOT}/memory-venv/bin`;
  it('starts the database, waits for it, builds the environment with uv and records each stage', async () => {
    const { enableMemory } = memoryModule; const w = world({ uv: true }); const stages: (string | undefined)[] = [];
    const d = deps(w, { writeRecord: async (r) => { stages.push(r.stage); w.record = r; } });
    expect(await enableMemory(d)).toEqual({ ok: true, model: 'better', adopted: false });
    expect(w.cmds.filter((c) => !c.startsWith('docker info') && !c.startsWith('docker ps') && !c.startsWith('python3 -c') && !c.startsWith('uv --version'))).toEqual([
      `docker pull ${memoryModule.QDRANT_IMAGE}`,
      `docker run -d --name openflow-qdrant --restart unless-stopped -p 127.0.0.1:6333:6333 -v ${ROOT}/qdrant-storage:/qdrant/storage -e ${memoryModule.SNAPSHOTS_ENV} ${memoryModule.QDRANT_IMAGE}`,
      `uv venv --python 3.12 ${ROOT}/memory-venv`,
      `uv pip install --python ${BIN}/python ${memoryModule.MCP_PACKAGE}`,
    ]);
    expect(stages).toEqual(['qdrant', 'venv', 'ready']);
    expect(w.record).toMatchObject({ enabled: true, skipped: false, stage: 'ready', model: 'better', adopted: false, at: '2026-10-22T12:00:00.000Z' });
    expect(w.made).toEqual([`${ROOT}/qdrant-storage`]); expect(w.violations).toEqual([]);
  });
  it('uses python3 -m venv and pip when uv is not there', async () => {
    const { enableMemory } = memoryModule; const w = world();
    expect((await enableMemory(deps(w))).ok).toBe(true);
    expect(w.cmds).toContain(`python3 -m venv ${ROOT}/memory-venv`);
    expect(w.cmds).toContain(`${BIN}/pip install --disable-pip-version-check ${memoryModule.MCP_PACKAGE}`);
    expect(w.violations).toEqual([]);
  });
  it('uses an existing Qdrant without touching Docker, and remembers it is not ours', async () => {
    const { enableMemory } = memoryModule; const w = world({ healthy: true, dockerInstalled: false, uv: true });
    expect(await enableMemory(deps(w))).toEqual({ ok: true, model: 'better', adopted: true });
    expect(w.cmds.some((c) => /^docker (pull|run|start)/.test(c))).toBe(false);
    expect(w.record.adopted).toBe(true); expect(w.made).toEqual([]);
  });
  it('starts a stopped container of ours instead of making a second one', async () => {
    const { enableMemory } = memoryModule; const w = world({ containers: new Map([['openflow-qdrant', false]]), uv: true });
    expect((await enableMemory(deps(w))).ok).toBe(true);
    expect(w.cmds).toContain('docker start openflow-qdrant'); expect(w.cmds.some((c) => c.startsWith('docker run') || c.startsWith('docker pull'))).toBe(false);
  });
  it('leaves a healthy running container alone', async () => {
    const { enableMemory } = memoryModule; const w = world({ containers: new Map([['openflow-qdrant', true]]), healthy: true, uv: true });
    expect((await enableMemory(deps(w))).ok).toBe(true);
    expect(w.cmds.some((c) => /^docker (pull|run|start)/.test(c))).toBe(false);
  });
  it('restarts a container that exists and is "running" but is not answering', async () => {
    const { enableMemory } = memoryModule; const w = world({ containers: new Map([['openflow-qdrant', true]]), healthy: false, uv: true });
    // the fake's start makes it healthy
    expect((await enableMemory(deps(w))).ok).toBe(true); expect(w.cmds).toContain('docker start openflow-qdrant');
  });
  it('does not rebuild the environment that is already there', async () => {
    const { enableMemory } = memoryModule; const w = world({ uv: true, files: new Set([`${BIN}/mcp-server-qdrant`]) });
    expect((await enableMemory(deps(w))).ok).toBe(true);
    expect(w.cmds.some((c) => c.startsWith('uv venv') || c.includes('pip install'))).toBe(false);
  });
  it('reuses an existing venv without remaking it', async () => {
    const { enableMemory } = memoryModule; const w = world({ uv: true, files: new Set([`${BIN}/python`]) });
    await enableMemory(deps(w)); expect(w.cmds.some((c) => c.startsWith('uv venv'))).toBe(false); expect(w.cmds.some((c) => c.startsWith('uv pip install'))).toBe(true);
    const w2 = world({ files: new Set([`${BIN}/pip`]) });
    await enableMemory(deps(w2)); expect(w2.cmds.some((c) => c.startsWith('python3 -m venv'))).toBe(false); expect(w2.cmds.some((c) => c.includes('/bin/pip install'))).toBe(true);
  });
  it.each([
    ['the plan fails (no memory)', { availableMB: 100 }, /skip memory/, undefined, 'memory'],
    ['the image cannot be downloaded', { pullFails: 'network is unreachable' }, /could not download the database: network is unreachable/, undefined, undefined],
    ['the container cannot start (port taken)', { runFails: 'port is already allocated' }, /could not start the database: port is already allocated.*port 6333/, undefined, undefined],
    ['a stopped container cannot start', { containers: new Map([['openflow-qdrant', false]]), startFails: 'boom' }, /could not start the database: boom/, undefined, undefined],
    ['the database never answers', { healthAfterRun: false }, /did not answer in 40 seconds/, undefined, undefined],
    ['pip fails', { uv: true, pipFails: 'No matching distribution' }, /memory packages failed: No matching distribution/, undefined, undefined],
    ['pip fails without uv', { pipFails: 'No matching distribution' }, /memory packages failed/, undefined, undefined],
    ['uv cannot make the environment', { uv: true, uvVenvFails: 'no python' }, /uv could not make the Python environment: no python/, 'python', undefined],
    ['python cannot make the environment', { venvFails: 'ensurepip is not available' }, /Python could not make its environment: ensurepip/, 'python', undefined],
  ] as [string, Partial<W>, RegExp, string | undefined, string | undefined][])('says so when %s, and does not mark it ready', async (_n, over, why, fix, planFix) => {
    const { enableMemory } = memoryModule; const w = world(over as Partial<W>);
    const r = await enableMemory(deps(w));
    expect(r.ok).toBe(false); expect(r.ok === false && r.error).toMatch(why); expect(r.ok === false && r.fix).toBe(fix ?? planFix);
    expect(w.record.stage).not.toBe('ready');
  });
  it('removes a container that never answers, and passes on its last error line', async () => {
    const { enableMemory } = memoryModule; const w = world({ healthAfterRun: false, uv: true });
    const r = await enableMemory(deps(w));
    expect(r.ok === false && r.error).toMatch(/did not answer in 40 seconds: ERROR qdrant: Failed to create snapshots temp directory.*Permission denied\. The container was removed/);
    expect(w.cmds.slice(-3)).toEqual(['docker logs --tail 20 openflow-qdrant', 'docker stop openflow-qdrant', 'docker rm openflow-qdrant']);
    expect(w.containers.has('openflow-qdrant')).toBe(false); expect(w.violations).toEqual([]);
  });
  it('names the leftover container when it cannot be removed', async () => {
    const { enableMemory } = memoryModule; const w = world({ healthAfterRun: false, uv: true, rmFails: true });
    const r = await enableMemory(deps(w));
    expect(r.ok === false && r.error).toMatch(/could not be removed; remove it with `docker rm -f openflow-qdrant`/);
  });
  it('starts the database with its snapshots inside the storage folder (the app user cannot write the image folder)', async () => {
    const { enableMemory } = memoryModule; const w = world({ userSpec: '1001:1001', uv: true });
    await enableMemory(deps(w));
    expect(w.cmds.find((c) => c.startsWith('docker run -d'))).toContain(`-e ${memoryModule.SNAPSHOTS_ENV} --user 1001:1001`);
  });
  it('waits up to 40 seconds for the database', async () => {
    const { enableMemory } = memoryModule; const w = world({ healthAfterRun: false, uv: true });
    await enableMemory(deps(w)); expect(w.sleeps).toBe(40);
  });
  it('clears an earlier "skipped" when set up', async () => {
    const { enableMemory } = memoryModule; const w = world({ uv: true }); w.record = { enabled: false, skipped: true };
    await enableMemory(deps(w)); expect(w.record.skipped).toBe(false); expect(w.record.enabled).toBe(true);
  });
  it('honours a model choice that fits', async () => {
    const { enableMemory } = memoryModule; const w = world({ uv: true });
    expect(await enableMemory(deps(w), 'light')).toMatchObject({ ok: true, model: 'light' });
  });
});

describe('proveMemory', () => {
  const ready = (w: W) => { w.record = { enabled: true, stage: 'ready', model: 'light' }; w.healthy = true; };
  it('passes: the database answers, refuses other addresses, and a real search finds the right memory', async () => {
    const { proveMemory } = memoryModule; const w = world(); ready(w);
    const r = await proveMemory(deps(w), 'proof-abc123');
    expect(r.ok).toBe(true); expect(r.exposed).toBe(false);
    expect(r.steps.map((s) => s.name)).toEqual(['The database answers', 'Only this computer can reach the database', 'A real search finds the right memory']);
    expect(w.cmds.at(-1)).toBe(`${ROOT}/memory-venv/bin/python /repo/scripts/memory-wizard-proof.py http://127.0.0.1:6333 sentence-transformers/all-MiniLM-L6-v2 proof-abc123`);
  });
  it('passes the recorded model to the search', async () => {
    const { proveMemory } = memoryModule; const w = world(); ready(w); w.record.model = 'better';
    await proveMemory(deps(w), 'proof-abc123'); expect(w.cmds.at(-1)).toContain('BAAI/bge-base-en-v1.5');
  });
  it('says to switch it on first when it is not ready', async () => {
    const { proveMemory } = memoryModule; const w = world();
    expect(await proveMemory(deps(w), 'n')).toMatchObject({ ok: false, exposed: false, steps: [{ name: 'Memory is set up', ok: false }] });
    w.healthy = true; w.record = { enabled: true, stage: 'venv', model: 'light' };
    expect((await proveMemory(deps(w), 'n')).steps[0].name).toBe('Memory is set up');
    expect((await proveMemory(deps(w), 'n')).ok).toBe(false);
    w.record = { enabled: true, stage: 'ready' };
    expect((await proveMemory(deps(w), 'n')).ok).toBe(false);
    expect(w.cmds).toEqual([]);
  });
  it('fails when the database does not answer, without running the search', async () => {
    const { proveMemory } = memoryModule; const w = world(); ready(w); w.healthy = false;
    expect(await proveMemory(deps(w), 'n')).toMatchObject({ ok: false, exposed: false });
    expect(w.cmds).toEqual([]);
  });
  it('stops our own database at once when another address can connect', async () => {
    const { proveMemory } = memoryModule; const w = world({ containers: new Map([['openflow-qdrant', true]]) }); ready(w); w.open.add('192.168.1.20');
    const r = await proveMemory(deps(w), 'n');
    expect(r).toMatchObject({ ok: false, exposed: true }); expect(r.steps.at(-1)!.detail).toMatch(/192\.168\.1\.20.*stopped/);
    expect(w.cmds).toContain('docker stop openflow-qdrant'); expect(w.cmds.some((c) => c.includes('memory-wizard-proof'))).toBe(false);
  });
  it('tells the user to fix their own Qdrant, and does not stop it', async () => {
    const { proveMemory } = memoryModule; const w = world(); ready(w); w.record.adopted = true; w.open.add('192.168.1.20');
    const r = await proveMemory(deps(w), 'proof-abc123');
    expect(r.exposed).toBe(true); expect(r.ok).toBe(false);
    expect(r.steps.map((s) => [s.name.slice(0, 10), s.ok])).toEqual([['The databa', true], ['Only this ', false], ['A real sea', true]]);   // the search still ran
    expect(r.steps[1].detail).toMatch(/your own Qdrant/); expect(w.cmds.some((c) => c.startsWith('docker stop'))).toBe(false);
  });
  it('checks every other address', async () => {
    const { proveMemory } = memoryModule; const w = world({ external: [{ address: '10.0.0.5', family: 4 }, { address: '100.64.1.2', family: 4 }] }); ready(w); w.open.add('100.64.1.2');
    expect((await proveMemory(deps(w), 'n')).steps.at(-1)!.detail).toContain('100.64.1.2');
  });
  it.each([
    ['a wrong answer', '{"ok": false, "detail": "The wrong memory came back first."}', /wrong memory/],
    ['garbage output', 'Traceback...', /did not finish/],
    ['no output', '', /did not finish/],
    ['ok but not true', '{"ok": "yes"}', /did not finish/],
  ])('fails the search on %s', async (_n, proof, why) => {
    const { proveMemory } = memoryModule; const w = world({ proof }); ready(w);
    const r = await proveMemory(deps(w), 'proof-abc123');
    expect(r.ok).toBe(false); expect(r.exposed).toBe(false); expect(r.steps.at(-1)!.ok).toBe(false); expect(r.steps.at(-1)!.detail).toMatch(why);
    expect(w.violations).toEqual([]);
  });
});

describe('agent access, skipping and switching off', () => {
  it('adds the MCP server with the environment\'s own program and the chosen model, only when ready', async () => {
    const { addAgentAccess } = memoryModule; const w = world();
    expect(await addAgentAccess(deps(w))).toMatchObject({ ok: false }); expect(w.mcpAdds).toEqual([]);
    w.record = { enabled: true, stage: 'ready', model: 'better' };
    expect(await addAgentAccess(deps(w))).toEqual({ ok: true, message: 'Added.' });
    expect(w.mcpAdds).toEqual([[`${ROOT}/memory-venv/bin`, 'better']]); expect(w.record.mcp).toBe(true);
    const f = world({ mcpOk: false }); f.record = { enabled: true, stage: 'ready', model: 'light' };
    expect(await addAgentAccess(deps(f))).toEqual({ ok: false, error: 'refused' }); expect(f.record.mcp).toBeUndefined();
  });
  it('mcpConnector points at loopback Qdrant, its own collection and the chosen model', () => {
    const c = memoryModule.mcpConnector('/v/bin', 'light');
    expect(c.setup.mcp).toMatchObject({ name: 'openflow-memory', transport: 'stdio', command: '/v/bin/mcp-server-qdrant', args: [], fixedEnv: { QDRANT_URL: 'http://127.0.0.1:6333', COLLECTION_NAME: 'openflow-memory', EMBEDDING_MODEL: 'sentence-transformers/all-MiniLM-L6-v2' } });
    expect(memoryModule.mcpConnector('/v/bin', 'better').setup.mcp!.fixedEnv!.EMBEDDING_MODEL).toBe('BAAI/bge-base-en-v1.5');
  });
  it('skipping installs nothing and runs nothing, and is a complete answer', async () => {
    const { skipMemory, gatherFacts } = memoryModule; const w = world({ dockerInstalled: false, pyVersion: null });
    expect(await skipMemory(deps(w))).toEqual({ ok: true });
    expect(w.record).toEqual({ enabled: false, skipped: true });
    expect(w.cmds).toEqual([]); expect(w.mcpAdds).toEqual([]);
    const facts = await gatherFacts(deps(w));                                   // asking afterwards stays quiet and does not throw
    expect(facts.docker.installed).toBe(false);
    expect(w.violations).toEqual([]);
  });
  it('will not skip while memory is switched on', async () => {
    const w = world(); w.record = { enabled: true, stage: 'ready' };
    expect(await memoryModule.skipMemory(deps(w))).toMatchObject({ ok: false }); expect(w.record.skipped).toBeUndefined();
  });
  it('switching off removes agent access and our container and keeps the memories', async () => {
    const { disableMemory } = memoryModule; const w = world({ containers: new Map([['openflow-qdrant', true]]) }); w.record = { enabled: true, stage: 'ready', model: 'light', mcp: true };
    const r = await disableMemory(deps(w));
    expect(r).toMatchObject({ ok: true }); expect(r.ok && r.note).toMatch(/Agent access removed.*memories are kept/);
    expect(w.mcpRemoves).toBe(1); expect(w.cmds).toContain('docker stop openflow-qdrant'); expect(w.cmds).toContain('docker rm openflow-qdrant'); expect(w.removed).toEqual([]);
    expect(w.record).toEqual({ enabled: false });
  });
  it('leaves an adopted Qdrant running and untouched', async () => {
    const { disableMemory } = memoryModule; const w = world({ containers: new Map([['openflow-qdrant', true]]) }); w.record = { enabled: true, stage: 'ready', adopted: true, mcp: true };
    const r = await disableMemory(deps(w), { deleteData: true });
    expect(r.ok && r.note).toMatch(/Your own Qdrant was left running/);
    expect(w.cmds.some((c) => c.startsWith('docker stop') || c.startsWith('docker rm'))).toBe(false);
    expect(w.removed).toEqual([`${ROOT}/memory-venv`]);                           // never Qdrant's storage when it is not ours
    expect(w.cmds).toContain('drop openflow-memory');                            // but our own collection in it goes
  });
  it('keeps the collection in an adopted Qdrant unless asked to delete, and says so when it cannot delete it', async () => {
    const { disableMemory } = memoryModule;
    const keep = world(); keep.record = { enabled: true, stage: 'ready', adopted: true };
    expect((await disableMemory(deps(keep))).ok).toBe(true); expect(keep.cmds).not.toContain('drop openflow-memory');
    const gone = world(); gone.record = { enabled: true, stage: 'ready', adopted: true }; gone.dropStatus = 404;
    expect(await disableMemory(deps(gone), { deleteData: true })).toMatchObject({ ok: true });
    const fails = world(); fails.record = { enabled: true, stage: 'ready', adopted: true }; fails.dropStatus = 500;
    const r = await disableMemory(deps(fails), { deleteData: true });
    expect(r.ok === false && r.error).toMatch(/could not be deleted from your Qdrant \(answer 500\).*openflow-memory/); expect(fails.removed).toEqual([]);
    expect(fails.record).toEqual({ enabled: false });
  });
  it('never drops the collection of a Qdrant that is ours (its storage folder goes instead)', async () => {
    const { disableMemory } = memoryModule; const w = world(); w.record = { enabled: true, stage: 'ready' };
    await disableMemory(deps(w), { deleteData: true }); expect(w.cmds).not.toContain('drop openflow-memory');
  });
  it('deleting removes the storage and the environment', async () => {
    const { disableMemory } = memoryModule; const w = world({ containers: new Map([['openflow-qdrant', true]]) }); w.record = { enabled: true, stage: 'ready' };
    const r = await disableMemory(deps(w), { deleteData: true });
    expect(w.removed).toEqual([`${ROOT}/qdrant-storage`, `${ROOT}/memory-venv`]); expect(r.ok && r.note).toMatch(/deleted/);
  });
  it('does not touch the MCP list when it never added the entry', async () => {
    const { disableMemory } = memoryModule; const w = world(); w.record = { enabled: true, stage: 'ready' };
    await disableMemory(deps(w)); expect(w.mcpRemoves).toBe(0);
  });
  it('reports a container that will not go and keeps the record', async () => {
    const { disableMemory } = memoryModule; const w = world({ containers: new Map([['openflow-qdrant', true]]), rmFails: true }); w.record = { enabled: true, stage: 'ready' };
    const r = await disableMemory(deps(w));
    expect(r.ok === false && r.error).toMatch(/could not remove the database container: in use/); expect(w.record.enabled).toBe(true);
  });
  it('says nothing was set up when nothing was', async () => {
    const w = world();
    expect(await memoryModule.disableMemory(deps(w))).toEqual({ ok: true, note: 'Nothing was set up here.' }); expect(w.cmds).toEqual([]);
  });
  it('can delete leftovers of a switched-off setup', async () => {
    const w = world(); w.record = { enabled: false };
    expect(await memoryModule.disableMemory(deps(w), { deleteData: true })).toMatchObject({ ok: true }); expect(w.removed).toHaveLength(2);
  });
});

describe('the machine we run on', () => {
  it('reads free memory and disk', async () => {
    const { realAvailableMB, realDiskFreeMB } = memoryModule;
    const avail = await realAvailableMB();
    expect(avail).toBeGreaterThan(0); expect(avail).toBeLessThanOrEqual(Math.ceil(os.totalmem() / 1048576));      // megabytes, not kilobytes
    const disk = await realDiskFreeMB(os.tmpdir());
    const { execFileSync } = await import('child_process');
    const df = Number(execFileSync('df', ['-Pm', os.tmpdir()], { encoding: 'utf8' }).trim().split('\n').pop()!.split(/\s+/)[3]);
    expect(Math.abs(disk - df)).toBeLessThanOrEqual(Math.max(50, df * 0.02));
    expect(await realDiskFreeMB('/nonexistent/x')).toBe(0);
  });
  it('the proof script refuses bad arguments without importing anything', async () => {
    const { execFile } = await import('child_process');
    const run = (args: string[]) => new Promise<{ code: number; out: string }>((resolve) => execFile('python3', [path.join(process.cwd(), 'scripts/memory-wizard-proof.py'), ...args], (e, out) => resolve({ code: e ? (e as unknown as { code: number }).code : 0, out })));
    expect((await run([])).code).toBe(2);
    const bad = await run(['http://127.0.0.1:1', 'm', '../x']);
    expect(bad.code).toBe(2); expect(JSON.parse(bad.out)).toMatchObject({ ok: false, detail: 'bad nonce' });
  });
});

describe('/api/wizards/memory', () => {
  it('refuses a caller that is not on this machine and has no token, running no command', async () => {
    vi.resetModules();
    const ran = vi.fn();
    vi.doMock('@/lib/wizards/memory', async (orig) => ({ ...(await orig<typeof import('@/lib/wizards/memory')>()), realExec: () => ran, realDeps: ran, enableMemory: ran, disableMemory: ran, skipMemory: ran }));
    const route = await import('@/app/api/wizards/memory/route');
    const { NextRequest } = await import('next/server');
    const outside = { host: '127.0.0.1:3000', 'x-forwarded-for': '203.0.113.7' };
    expect((await route.GET(new NextRequest('http://127.0.0.1:3000/api/wizards/memory', { headers: outside }))).status).toBe(401);
    for (const action of ['enable', 'prove', 'add-agent-access', 'skip', 'disable']) expect((await route.POST(new NextRequest('http://127.0.0.1:3000/api/wizards/memory', { method: 'POST', headers: outside, body: JSON.stringify({ action }) }))).status, action).toBe(401);
    expect(ran).not.toHaveBeenCalled();
    vi.doUnmock('@/lib/wizards/memory');
  });
  it('skip answers quietly with no setup at all, and a later read stays clean', async () => {
    vi.resetModules();
    const route = await import('@/app/api/wizards/memory/route');
    const { NextRequest } = await import('next/server');
    const post = (body: unknown) => route.POST(new NextRequest('http://127.0.0.1:3000/api/wizards/memory', { method: 'POST', headers: { host: '127.0.0.1:3000' }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
    const skipped = await post({ action: 'skip' });
    expect(skipped.status).toBe(200);
    const body = await skipped.json();
    expect(body.success).toBe(true); expect(body.record).toMatchObject({ enabled: false, skipped: true, stage: 'none' });
    expect(JSON.parse(await fs.readFile(path.join(dir, 'memory-wizard.json'), 'utf8'))).toEqual({ enabled: false, skipped: true });
    const get = await route.GET(new NextRequest('http://127.0.0.1:3000/api/wizards/memory', { headers: { host: '127.0.0.1:3000' } }));
    expect(get.status).toBe(200); expect((await get.json()).record.skipped).toBe(true);
    expect((await post('nope')).status).toBe(400);
    expect((await post({ action: 'bogus' })).status).toBe(400);
  });

  it('passes only a real model name and only a real true for deleteData to the steps', async () => {
    vi.resetModules();
    const enable = vi.fn(async () => ({ ok: true as const, model: 'light' as const, adopted: false })); const disable = vi.fn(async () => ({ ok: true as const, note: 'x' }));
    vi.doMock('@/lib/wizards/memory', async (orig) => ({ ...(await orig<typeof import('@/lib/wizards/memory')>()), enableMemory: enable, disableMemory: disable }));
    const route = await import('@/app/api/wizards/memory/route');
    const { NextRequest } = await import('next/server');
    const post = (body: unknown) => route.POST(new NextRequest('http://127.0.0.1:3000/api/wizards/memory', { method: 'POST', headers: { host: '127.0.0.1:3000' }, body: JSON.stringify(body) }));
    await post({ action: 'enable', model: 'evil' }); await post({ action: 'enable', model: 'better' }); await post({ action: 'enable' });
    expect(enable.mock.calls.map((c) => c[1])).toEqual([undefined, 'better', undefined]);
    await post({ action: 'disable', deleteData: 'yes' }); await post({ action: 'disable', deleteData: true }); await post({ action: 'disable' });
    expect(disable.mock.calls.map((c) => c[1])).toEqual([{ deleteData: false }, { deleteData: true }, { deleteData: false }]);
    vi.doUnmock('@/lib/wizards/memory');
  });
});


describe('the database runs as the app and "delete my memories" always ends cleanly', () => {
  const { disableMemory, enableMemory } = memoryModule;
  it('starts the container with --user when the app has a user id, and without it otherwise', async () => {
    for (const [spec, expectUser] of [['1001:1001', true], [null, false]] as const) {
      const w = world({ userSpec: spec, availableMB: 4000, uv: true }); w.record = { enabled: false };
      await enableMemory(deps(w));
      const line = w.cmds.find((c) => c.startsWith('docker run -d')) ?? '';
      expect(line.includes('--user 1001:1001'), line).toBe(expectUser);
      expect(w.violations).toEqual([]);
    }
  });
  it('deleting root-owned files empties them with the pinned image, then removes the folder', async () => {
    const w = world({ containers: new Map([['openflow-qdrant', true]]), removeFails: { code: 'EACCES', untilCleaned: true } }); w.record = { enabled: true, stage: 'ready' };
    const r = await disableMemory(deps(w), { deleteData: true });
    expect(r.ok).toBe(true);
    expect(w.cleaned).toBe(true);
    expect(w.removed).toContain(`${ROOT}/qdrant-storage`);
    expect(w.record.enabled).toBe(false);
    expect(w.violations).toEqual([]);
  });
  it('a failed delete says so, and the record still says memory is off because the database is gone', async () => {
    const w = world({ containers: new Map([['openflow-qdrant', true]]), removeFails: { code: 'EACCES', untilCleaned: false }, cleanFails: true }); w.record = { enabled: true, stage: 'ready' };
    const r = await disableMemory(deps(w), { deleteData: true });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('could not be deleted');
    expect((r as { error: string }).error).toContain('could not empty the folder');
    expect(w.record.enabled).toBe(false);
    expect(w.containers.has('openflow-qdrant')).toBe(false);
  });
  it('any other delete error is reported too, never swallowed', async () => {
    const w = world({ containers: new Map([['openflow-qdrant', true]]), removeFails: { code: 'EIO', untilCleaned: false } }); w.record = { enabled: true, stage: 'ready' };
    const r = await disableMemory(deps(w), { deleteData: true });
    expect(r.ok).toBe(false);
    expect(w.cleaned).toBe(false);
    expect(w.record.enabled).toBe(false);
  });
});
