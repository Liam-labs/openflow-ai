/**
 * Memory wizard (stage 4 of the setup wizards): shared memory your agents can store to and search, kept on this computer.
 *
 * Do      Qdrant (a vector database) in Docker, offered to this computer only, plus a Python environment with the pinned
 *         `mcp-server-qdrant` (it embeds text with a small local model) and an MCP entry so agents get qdrant-store / qdrant-find.
 * Prove   Qdrant answers and refuses every other address; then a real search: three memories are embedded, stored in a throwaway
 *         collection and the right one must come back first for a question that shares no words with it.
 * Skip    is a normal answer: nothing is installed, nothing complains, and the wizard says it can be set up later.
 * Undo    removes the MCP entry and the container this wizard made. The stored memories stay unless asked to delete.
 *
 * Every program is run with an argument list (never a shell) and only the exact commands below.
 */

import { execFile } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DataPaths } from '../data-paths';
import { readJsonFileStrict, writeJsonFile } from '../data-io';
import { realCanConnect, realExternalAddresses } from './browser-core';

type Env = Record<string, string | undefined>;

// Pinned so a fresh install is the one that was tested.
/** Snapshots inside the storage folder: the app's user may not write the image's working folder, and Qdrant stops when it cannot. */
export const SNAPSHOTS_ENV = 'QDRANT__STORAGE__SNAPSHOTS_PATH=/qdrant/storage/snapshots';
export const QDRANT_IMAGE = 'qdrant/qdrant@sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10';   // Qdrant 1.19.1
export const MCP_PACKAGE = 'mcp-server-qdrant==0.8.1';
export const CONTAINER = 'openflow-qdrant';
export const QDRANT_PORT = 6333;
export const COLLECTION = 'openflow-memory';
export const MCP_NAME = 'openflow-memory';

export type ModelId = 'light' | 'better';
export const MODELS: Record<ModelId, { id: string; label: string; needMB: number; downloadMB: number }> = {
  light: { id: 'sentence-transformers/all-MiniLM-L6-v2', label: 'Light (small, fast, good for most notes)', needMB: 1200, downloadMB: 90 },
  better: { id: 'BAAI/bge-base-en-v1.5', label: 'Better (finds more, needs about 1.5 GB of free memory)', needMB: 4000, downloadMB: 440 },
};
const MIN_DISK_MB = 4000;

export interface MemoryRecord {
  enabled: boolean;
  skipped?: boolean;
  stage?: 'none' | 'qdrant' | 'venv' | 'ready';
  adopted?: boolean;                 // an existing Qdrant on this computer was used; undo leaves it alone
  model?: ModelId;
  mcp?: boolean;
  at?: string;
}

// ─── Commands that may run ───────────────────────────────────────────────────────────────────────────

// Python for the pip route must be one the packages ship wheels for; uv fetches this one itself when needed.
const PY_CHECK = 'import venv, ensurepip, sys; print(sys.version_info[0], sys.version_info[1])';
export const UV_PYTHON = '3.12';
const SAFE_DIR = /^\/[A-Za-z0-9._\/ -]{1,300}$/;
const NO_DOTDOT = (p: string) => !p.split('/').includes('..');

export function allowedCommand(file: string, args: string[], root: string): boolean {
  const dir = (p: string) => SAFE_DIR.test(p) && NO_DOTDOT(p);
  if (file === 'docker') {
    const k = args.join('\u0000');
    if (k === ['info', '--format', '{{.ServerVersion}}'].join('\u0000')) return true;
    if (k === ['ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{.Names}}|{{.Status}}'].join('\u0000')) return true;
    if (k === ['pull', QDRANT_IMAGE].join('\u0000')) return true;
    if (k === ['start', CONTAINER].join('\u0000') || k === ['stop', CONTAINER].join('\u0000') || k === ['rm', CONTAINER].join('\u0000')) return true;
    if (k === ['logs', '--tail', '20', CONTAINER].join('\u0000')) return true;
    // The database runs as the app's own user (--user) so the files it writes belong to the app and "delete my memories" can remove them.
    // That user cannot write the image's own folder (/qdrant, owned by root), so snapshots go inside the storage folder (SNAPSHOTS_ENV).
    const withUser = args.length === 15 && args[12] === '--user' && /^\d{1,10}:\d{1,10}$/.test(args[13]);
    if ((args.length === 13 || withUser) && args[0] === 'run' && args[1] === '-d' && args[2] === '--name' && args[3] === CONTAINER && args[4] === '--restart' && args[5] === 'unless-stopped'
      && args[6] === '-p' && args[7] === `127.0.0.1:${QDRANT_PORT}:6333` && args[8] === '-v' && /^(.+):\/qdrant\/storage$/.test(args[9])
      && args[10] === '-e' && args[11] === SNAPSHOTS_ENV && args[args.length - 1] === QDRANT_IMAGE) {
      const host = /^(.+):\/qdrant\/storage$/.exec(args[9])![1];
      return dir(host) && host.startsWith(root + '/');
    }
    // Storage made by an older run is owned by root. The same pinned image empties it, so the app can then remove the folder itself.
    if (args.length === 11 && args[0] === 'run' && args[1] === '--rm' && args[2] === '-v' && /^(.+):\/qdrant\/storage$/.test(args[3]) && args[4] === '--entrypoint' && args[5] === 'find'
      && args[6] === QDRANT_IMAGE && args[7] === '/qdrant/storage' && args[8] === '-mindepth' && args[9] === '1' && args[10] === '-delete') {
      const host = /^(.+):\/qdrant\/storage$/.exec(args[3])![1];
      return dir(host) && host.startsWith(root + '/');
    }
    return false;
  }
  if (file === 'python3' && args[0] === '-m' && args[1] === 'venv' && args.length === 3) return dir(args[2]) && args[2].startsWith(root + '/');
  if (file === 'python3' && args.length === 2 && args[0] === '-c' && args[1] === PY_CHECK) return true;
  if (file === 'uv') {
    if (args.join('\u0000') === '--version') return true;
    if (args.length === 4 && args[0] === 'venv' && args[1] === '--python' && args[2] === UV_PYTHON) return dir(args[3]) && args[3].startsWith(root + '/');
    if (args.length === 5 && args[0] === 'pip' && args[1] === 'install' && args[2] === '--python' && args[3].endsWith('/bin/python') && args[4] === MCP_PACKAGE) return dir(args[3]) && args[3].startsWith(root + '/');
    return false;
  }
  if (file.startsWith(root + '/') && dir(file) && file.endsWith('/bin/pip')) return args.length === 3 && args[0] === 'install' && args[1] === '--disable-pip-version-check' && args[2] === MCP_PACKAGE;
  if (file.startsWith(root + '/') && dir(file) && file.endsWith('/bin/python')) {
    return args.length === 4 && /\/memory-wizard-proof\.py$/.test(args[0]) && dir(args[0]) && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(args[1]) && Object.values(MODELS).some((m) => m.id === args[2]) && /^[A-Za-z0-9-]{4,40}$/.test(args[3]);
  }
  return false;
}

export interface Exec { (file: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> }

export function findUv(exists: (p: string) => boolean = existsSync, env: Env = process.env, home: string = os.homedir()): string | null {
  const dirs = [...(env.PATH || '').split(path.delimiter).filter(Boolean), path.join(home, '.local/bin'), path.join(home, '.cargo/bin'), '/usr/local/bin', '/opt/homebrew/bin'];
  return dirs.map((d) => path.join(d, 'uv')).find((p) => exists(p)) ?? null;
}

export const realExec = (root: string): Exec => (file, args, timeoutMs) => new Promise((resolve) => {
  if (!allowedCommand(file, args, root)) { resolve({ code: 126, stdout: '', stderr: 'command not allowed' }); return; }
  const program = file === 'uv' ? findUv() : file;
  if (!program) { resolve({ code: 127, stdout: '', stderr: 'uv not found' }); return; }
  execFile(program, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as unknown as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 127) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

// ─── Facts and choices ───────────────────────────────────────────────────────────────────────────────

export interface MemoryFacts {
  managedDatabase?: boolean;
  docker: { installed: boolean; running: boolean };
  python: { ok: boolean; version: string | null };
  uv: boolean;                       // uv can make the Python environment even when python3-venv is missing
  availableMB: number;
  diskFreeMB: number;
  qdrantUp: boolean;                 // something answers on 127.0.0.1:6333
  container: { exists: boolean; running: boolean };
}

/** The best model that fits the free memory, or null when even the light one does not. */
export function chooseModel(availableMB: number): ModelId | null {
  if (availableMB >= MODELS.better.needMB) return 'better';
  if (availableMB >= MODELS.light.needMB) return 'light';
  return null;
}

export type Plan = { ok: true; model: ModelId; adopt: boolean } | { ok: false; reason: string; fix?: 'docker' | 'docker-start' | 'python' | 'memory' | 'disk' };

export function planMemory(f: MemoryFacts, wanted?: ModelId): Plan {
  if (!f.python.ok && !f.uv) return { ok: false, reason: 'The embedding model needs Python 3.9 to 3.13 with its venv module (or the uv tool, which brings its own Python).', fix: 'python' };
  const model = wanted && f.availableMB >= MODELS[wanted].needMB ? wanted : chooseModel(f.availableMB);
  if (!model) return { ok: false, reason: `Only about ${Math.round(f.availableMB / 100) / 10} GB of memory is free and the smallest model needs ${MODELS.light.needMB / 1000} GB. You can skip memory for now and set it up later.`, fix: 'memory' };
  if (f.diskFreeMB < MIN_DISK_MB) return { ok: false, reason: `About ${Math.round(f.diskFreeMB / 100) / 10} GB of disk is free and memory needs about ${MIN_DISK_MB / 1000} GB (database image, Python packages, model).`, fix: 'disk' };
  const adopt = f.qdrantUp && !f.container.exists && !f.managedDatabase;
  if (!adopt && !f.managedDatabase) {
    if (!f.docker.installed) return { ok: false, reason: 'Docker is not installed. Qdrant runs in Docker.', fix: 'docker' };
    if (!f.docker.running) return { ok: false, reason: 'Docker is installed but not running.', fix: 'docker-start' };
  }
  return { ok: true, model, adopt };
}

// ─── Dependencies ────────────────────────────────────────────────────────────────────────────────────

export interface Deps {
  database?: { start: () => Promise<void>; stop: () => Promise<void> };
  env: Env;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  root: string;                                          // the app data folder: storage and the Python environment live inside it
  exec: Exec;
  readRecord: () => Promise<MemoryRecord>;
  writeRecord: (r: MemoryRecord) => Promise<void>;
  availableMB: () => Promise<number>;
  diskFreeMB: () => Promise<number>;
  healthz: () => Promise<boolean>;
  /** Deletes the wizard's own collection (COLLECTION) and nothing else. Used for an adopted Qdrant, whose storage is not ours. */
  dropOwnCollection: () => Promise<{ ok: boolean; status: number }>;
  exists: (p: string) => boolean;
  removeDir: (p: string) => Promise<void>;
  mkdir: (p: string) => Promise<void>;
  externalAddresses: () => { address: string; family: 4 | 6 }[];
  canConnect: (host: string, port: number) => Promise<boolean>;
  mcp: { add: (venvBin: string, model: ModelId) => Promise<{ ok: boolean; message: string }>; remove: () => Promise<{ ok: boolean; message: string }> };
  proofScript: string;
  /** `uid:gid` of the app on Linux (the database container runs as it); null elsewhere. */
  userSpec: () => string | null;
}

export const storageDir = (d: Pick<Deps, 'root'>) => `${d.root}/qdrant-storage`;
export const venvDir = (d: Pick<Deps, 'root'>) => `${d.root}/memory-venv`;

export async function gatherFacts(d: Deps): Promise<MemoryFacts> {
  const [info, ps, py, uv, qdrantUp, availableMB, diskFreeMB] = await Promise.all([
    d.exec('docker', ['info', '--format', '{{.ServerVersion}}'], 8000),
    d.exec('docker', ['ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{.Names}}|{{.Status}}'], 8000),
    d.exec('python3', ['-c', PY_CHECK], 8000),
    d.exec('uv', ['--version'], 8000),
    d.healthz(), d.availableMB(), d.diskFreeMB(),
  ]);
  const installed = info.code !== 127;                    // 127: program not found
  const line = ps.stdout.split('\n').find((l) => l.startsWith(`${CONTAINER}|`));
  const [maj, min] = py.stdout.trim().split(' ').map(Number);
  return {
    managedDatabase: !!d.database,
    docker: { installed, running: info.code === 0 },
    python: { ok: py.code === 0 && maj === 3 && min >= 9 && min <= 13, version: py.code === 0 ? `${maj}.${min}` : null },
    uv: uv.code === 0,
    availableMB, diskFreeMB, qdrantUp,
    container: { exists: !!line, running: !!line && /^Up/.test(line.split('|')[1] ?? '') },
  };
}

// ─── Enable ──────────────────────────────────────────────────────────────────────────────────────────

export type StepResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; fix?: string };

const first = (s: string) => s.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? '';

export async function enableMemory(d: Deps, wanted?: ModelId): Promise<StepResult<{ model: ModelId; adopted: boolean }>> {
  const facts = await gatherFacts(d);
  const plan = planMemory(facts, wanted);
  if (!plan.ok) return { ok: false, error: plan.reason, fix: plan.fix };
  let rec: MemoryRecord = { ...(await d.readRecord()), enabled: true, skipped: false, model: plan.model, adopted: plan.adopt };
  const save = async (stage: MemoryRecord['stage']) => { rec = { ...rec, stage }; await d.writeRecord(rec); };

  // 1. Qdrant.
  if (!plan.adopt && !(facts.container.running && (await d.healthz()))) {
    await d.mkdir(storageDir(d));
    if (d.database) {
      try { await d.database.start(); } catch (error) { return { ok: false, error: `The database could not start: ${String(error).slice(0, 200)}` }; }
    } else if (facts.container.exists) {
      const r = await d.exec('docker', ['start', CONTAINER], 30000);
      if (r.code !== 0) return { ok: false, error: `Docker could not start the database: ${first(r.stderr)}` };
    } else {
      const pull = await d.exec('docker', ['pull', QDRANT_IMAGE], 600000);
      if (pull.code !== 0) return { ok: false, error: `Docker could not download the database: ${first(pull.stderr)}` };
      const user = d.userSpec();
      const run = await d.exec('docker', ['run', '-d', '--name', CONTAINER, '--restart', 'unless-stopped', '-p', `127.0.0.1:${QDRANT_PORT}:6333`, '-v', `${storageDir(d)}:/qdrant/storage`, '-e', SNAPSHOTS_ENV, ...(user ? ['--user', user] : []), QDRANT_IMAGE], 60000);
      if (run.code !== 0) return { ok: false, error: `Docker could not start the database: ${first(run.stderr)}. If port ${QDRANT_PORT} is taken by something else, stop that first.` };
    }
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { up = await d.healthz(); if (!up) await d.sleep(1000); }
    if (!up) {
      // Do not leave a container behind that restarts forever: keep its last words for the message, then remove it.
      if (d.database) { await d.database.stop(); return { ok: false, error: 'The database did not answer in 40 seconds. It was stopped; retry setup.' }; }
      const logs = await d.exec('docker', ['logs', '--tail', '20', CONTAINER], 15000);
      const why = `${logs.stdout}\n${logs.stderr}`.split('\n').map((l) => l.trim()).filter((l) => /error|panic|denied/i.test(l)).pop();
      await d.exec('docker', ['stop', CONTAINER], 60000);
      const rm = await d.exec('docker', ['rm', CONTAINER], 30000);
      return { ok: false, error: `The database started but did not answer in 40 seconds${why ? `: ${why.slice(0, 240)}` : ''}. ${rm.code === 0 ? 'The container was removed, so pressing Set up memory again starts clean.' : 'The container openflow-qdrant could not be removed; remove it with `docker rm -f openflow-qdrant`.'}` };
    }
  }
  await save('qdrant');

  // 2. The Python environment with the pinned package.
  const bin = `${venvDir(d)}/bin`;
  if (!d.exists(`${bin}/mcp-server-qdrant`)) {
    if (facts.uv) {
      if (!d.exists(`${bin}/python`)) {
        const v = await d.exec('uv', ['venv', '--python', UV_PYTHON, venvDir(d)], 300000);
        if (v.code !== 0) return { ok: false, error: `uv could not make the Python environment: ${first(v.stderr)}`, fix: 'python' };
      }
      const pip = await d.exec('uv', ['pip', 'install', '--python', `${bin}/python`, MCP_PACKAGE], 900000);
      if (pip.code !== 0) return { ok: false, error: `Installing the memory packages failed: ${first(pip.stderr)}` };
    } else {
      if (!d.exists(`${bin}/pip`)) {
        const v = await d.exec('python3', ['-m', 'venv', venvDir(d)], 120000);
        if (v.code !== 0) return { ok: false, error: `Python could not make its environment: ${first(v.stderr)}`, fix: 'python' };
      }
      const pip = await d.exec(`${bin}/pip`, ['install', '--disable-pip-version-check', MCP_PACKAGE], 900000);
      if (pip.code !== 0) return { ok: false, error: `Installing the memory packages failed: ${first(pip.stderr)}` };
    }
  }
  await save('venv');
  await d.writeRecord({ ...rec, stage: 'ready', at: rec.at ?? d.now() });
  return { ok: true, model: plan.model, adopted: plan.adopt };
}

// ─── Prove ───────────────────────────────────────────────────────────────────────────────────────────

export interface ProofStep { name: string; ok: boolean; detail: string }

export async function proveMemory(d: Deps, nonce: string): Promise<{ ok: boolean; exposed: boolean; steps: ProofStep[] }> {
  const rec = await d.readRecord();
  const steps: ProofStep[] = [];
  if (!rec.enabled || rec.stage !== 'ready' || !rec.model) return { ok: false, exposed: false, steps: [{ name: 'Memory is set up', ok: false, detail: 'Switch it on first.' }] };

  if (!(await d.healthz())) return { ok: false, exposed: false, steps: [{ name: 'The database answers', ok: false, detail: `Nothing answered on port ${QDRANT_PORT}.` }] };
  steps.push({ name: 'The database answers', ok: true, detail: `Qdrant answers on 127.0.0.1:${QDRANT_PORT}.` });

  const open: string[] = [];
  for (const a of d.externalAddresses()) if (await d.canConnect(a.address, QDRANT_PORT)) open.push(a.address);
  const exposed = open.length > 0;
  if (exposed) {
    if (!rec.adopted) {
      if (d.database) await d.database.stop();
      else await d.exec('docker', ['stop', CONTAINER], 30000);
      steps.push({ name: 'Only this computer can reach the database', ok: false, detail: `${open.join(', ')} could connect to port ${QDRANT_PORT}. The database was stopped.` });
      return { ok: false, exposed: true, steps };
    }
    // Your own Qdrant is yours to fix: say so, and still run the search so you know whether memory works.
    steps.push({ name: 'Only this computer can reach the database', ok: false, detail: `${open.join(', ')} could connect to port ${QDRANT_PORT}. This is your own Qdrant: bind it to 127.0.0.1 only (or keep it behind your firewall).` });
  } else {
    steps.push({ name: 'Only this computer can reach the database', ok: true, detail: 'Every other address of this computer refused a connection.' });
  }

  const r = await d.exec(`${venvDir(d)}/bin/python`, [d.proofScript, `http://127.0.0.1:${QDRANT_PORT}`, MODELS[rec.model].id, nonce], 600000);
  let parsed: { ok?: boolean; detail?: string } = {};
  try { parsed = JSON.parse(r.stdout.trim().split('\n').slice(-1)[0] ?? '{}') as typeof parsed; } catch { /* reported below */ }
  steps.push({ name: 'A real search finds the right memory', ok: parsed.ok === true, detail: parsed.detail ?? `The test did not finish (${first(r.stderr) || `exit ${r.code}`}).` });
  return { ok: steps.every((s) => s.ok), exposed, steps };
}

// ─── Agents, skip, undo ──────────────────────────────────────────────────────────────────────────────

export async function addAgentAccess(d: Deps): Promise<StepResult<{ message: string }>> {
  const rec = await d.readRecord();
  if (!rec.enabled || rec.stage !== 'ready' || !rec.model) return { ok: false, error: 'Switch memory on first.' };
  const r = await d.mcp.add(`${venvDir(d)}/bin`, rec.model);
  if (!r.ok) return { ok: false, error: r.message };
  await d.writeRecord({ ...rec, mcp: true });
  return { ok: true, message: r.message };
}

/** "Not now" is a complete answer: nothing is installed and nothing will complain about it. */
export async function skipMemory(d: Deps): Promise<StepResult> {
  const rec = await d.readRecord();
  if (rec.enabled) return { ok: false, error: 'Memory is switched on. Switch it off instead.' };
  await d.writeRecord({ enabled: false, skipped: true });
  return { ok: true };
}

/** Delete the database files. Files made by the database as root (older installs) are emptied by the same pinned image first. */
async function removeStorage(d: Deps): Promise<void> {
  try {
    await d.removeDir(storageDir(d));
    return;
  } catch (error) {
    if ((error as { code?: string }).code !== 'EACCES' && (error as { code?: string }).code !== 'EPERM') throw error;
  }
  const clean = await d.exec('docker', ['run', '--rm', '-v', `${storageDir(d)}:/qdrant/storage`, '--entrypoint', 'find', QDRANT_IMAGE, '/qdrant/storage', '-mindepth', '1', '-delete'], 120000);
  if (clean.code !== 0) throw new Error(`Docker could not empty the folder: ${first(clean.stderr)}`);
  await d.removeDir(storageDir(d));
}

export async function disableMemory(d: Deps, opts: { deleteData?: boolean } = {}): Promise<StepResult<{ note: string }>> {
  const rec = await d.readRecord();
  if (!rec.enabled && !rec.mcp && !opts.deleteData) return { ok: true, note: 'Nothing was set up here.' };
  let note = 'Memory switched off.';
  if (rec.mcp) {
    const r = await d.mcp.remove();
    note += r.ok ? ' Agent access removed.' : ` Agent access could not be removed (${r.message}).`;
  }
  if (!rec.adopted) {
    const facts = await gatherFacts(d);
    if (d.database) await d.database.stop();
    else if (facts.container.exists) {
      await d.exec('docker', ['stop', CONTAINER], 60000);
      const rm = await d.exec('docker', ['rm', CONTAINER], 30000);
      if (rm.code !== 0) return { ok: false, error: `Docker could not remove the database container: ${first(rm.stderr)}` };
    }
  } else note += ' Your own Qdrant was left running.';
  // The database is gone from here on, so the record must say so even if deleting the files fails below.
  await d.writeRecord({ enabled: false });
  if (opts.deleteData) {
    if (rec.adopted) {
      // Not our database, so its storage stays. Our memories are the one collection we made in it.
      const dropped = await d.dropOwnCollection();
      if (!dropped.ok) return { ok: false, error: `Memory is switched off, but the stored memories could not be deleted from your Qdrant (answer ${dropped.status}). Delete the collection "${COLLECTION}" yourself.` };
    }
    try {
      if (!rec.adopted) await removeStorage(d);
      await d.removeDir(venvDir(d));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Memory is switched off, but the stored memories could not be deleted (${why.slice(0, 200)}). Delete the folder ${storageDir(d)} yourself.` };
    }
    note += ' Stored memories and the Python environment were deleted.';
  } else note += ' Your stored memories are kept.';
  return { ok: true, note };
}

// ─── Real implementations ────────────────────────────────────────────────────────────────────────────

export async function realAvailableMB(): Promise<number> {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(await fs.readFile('/proc/meminfo', 'utf8'));
    if (m) return Math.floor(Number(m[1]) / 1024);
  } catch { /* not Linux */ }
  return Math.floor(os.freemem() / 1048576);
}

export async function realDiskFreeMB(dir: string): Promise<number> {
  try {
    const s = await fs.statfs(dir);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / 1048576);
  } catch {
    return 0;
  }
}

export async function realHealthz(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${QDRANT_PORT}/healthz`, { signal: AbortSignal.timeout(2500), cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function realDropOwnCollection(): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(`http://127.0.0.1:${QDRANT_PORT}/collections/${COLLECTION}`, { method: 'DELETE', signal: AbortSignal.timeout(10000), cache: 'no-store' });
    return { ok: res.ok || res.status === 404, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export function mcpConnector(venvBin: string, model: ModelId) {
  return {
    id: 'wizard-memory', name: 'Shared memory', category: 'mcp', kind: 'mcp', summary: '', costKind: 'free', cost: 'Free.', detect: { mcp: MCP_NAME },
    setup: { steps: [], mcp: { name: MCP_NAME, transport: 'stdio' as const, command: `${venvBin}/mcp-server-qdrant`, args: [], fixedEnv: { QDRANT_URL: `http://127.0.0.1:${QDRANT_PORT}`, COLLECTION_NAME: COLLECTION, EMBEDDING_MODEL: MODELS[model].id } } },
  } as unknown as import('../connectors/catalog').Connector;
}

export async function realMcp(): Promise<Deps['mcp']> {
  const apply = await import('../connectors/mcp-apply');
  return {
    add: async (venvBin, model) => { const r = await apply.addMcp(mcpConnector(venvBin, model), {}, new Set()); return { ok: r.ok, message: r.results.map((x) => x.message).join(' ') }; },
    remove: async () => { const r = await apply.removeMcp(mcpConnector('', 'light')); return { ok: r.ok || r.results.length === 0, message: r.results.map((x) => x.message).join(' ') }; },
  };
}

export async function realDeps(env: Env = process.env): Promise<Deps> {
  const root = path.resolve(path.dirname(DataPaths.memoryWizard));
  return {
    database: env.OPENFLOW_MANAGED_QDRANT === '1' ? (await import('./memory-runtime')).managedDatabase(root) : undefined,
    env, now: () => new Date().toISOString(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), root, exec: realExec(root),
    readRecord: async () => readJsonFileStrict<MemoryRecord>(DataPaths.memoryWizard, { enabled: false }).catch(() => ({ enabled: false } as MemoryRecord)),
    writeRecord: (r) => writeJsonFile(DataPaths.memoryWizard, r),
    availableMB: realAvailableMB, diskFreeMB: () => realDiskFreeMB(root), healthz: realHealthz, dropOwnCollection: realDropOwnCollection,
    exists: existsSync, removeDir: (p) => fs.rm(p, { recursive: true, force: true }), mkdir: (p) => fs.mkdir(p, { recursive: true }).then(() => undefined),
    externalAddresses: realExternalAddresses, canConnect: realCanConnect, mcp: await realMcp(),
    proofScript: path.resolve(process.cwd(), 'scripts/memory-wizard-proof.py'),
    userSpec: () => (process.platform === 'linux' && typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : null),
  };
}
