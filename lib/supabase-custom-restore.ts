import { execFile, spawn } from 'child_process';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { withFileLock } from '@/lib/data-io';
import {
  isSafeCustomBackupSlug,
  resolveCustomBackupFile,
} from '@/lib/supabase-local-backups';
import { PRODUCT_NAME } from '@/lib/brand';

export type CustomRestoreState = 'pending' | 'running' | 'success' | 'error';

export const CUSTOM_PG_RESTORE_ARGS = [
  '-U', 'postgres',
  '-d', 'postgres',
  '--clean',
  '--if-exists',
  '--no-owner',
  '--no-acl',
  '--exit-on-error',
  '--single-transaction',
] as const;

export interface CustomRestoreStatus {
  id: string;
  projectSlug: string;
  filename: string;
  containerName: string;
  status: CustomRestoreState;
  phase: 'queued' | 'validating' | 'quiescing' | 'safety-backup' | 'restoring' | 'verifying' | 'complete' | 'failed';
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  safetyBackupFilename?: string;
  error?: string;
}

interface RestoreJobsFile {
  version: 1;
  jobs: CustomRestoreStatus[];
}

interface InitiateOptions {
  backupsRoot: string;
  projectSlug: string;
  filename: string;
}

export interface CustomRestoreRuntime {
  verifyArchive: (containerName: string, filePath: string) => Promise<void>;
  listComposeContainers: (containerName: string) => Promise<string[]>;
  runDocker: (args: string[], timeout?: number) => Promise<string>;
  createSafetyDump: (containerName: string, outputFile: string) => Promise<void>;
  restoreArchive: (containerName: string, sourcePath: string) => Promise<void>;
  verifyContainerRecovered: (containerName: string) => Promise<void>;
}

export interface CustomRestoreInitiationRuntime {
  isContainerRunning: (containerName: string) => Promise<boolean>;
  schedule: (task: () => void) => void;
}

const MAX_JOBS = 50;
const ACTIVE_JOB_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const activeRestoreIds = new Set<string>();

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function jobsPath(backupsRoot: string): string {
  return path.join(backupsRoot, 'restore-jobs.json');
}

async function readJobs(backupsRoot: string): Promise<RestoreJobsFile> {
  try {
    const parsed = JSON.parse(await readFile(jobsPath(backupsRoot), 'utf8')) as RestoreJobsFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.jobs)) {
      throw new Error('invalid restore job state schema');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, jobs: [] };
    throw httpError(
      `Unable to read persisted restore job state: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
}

async function writeJobsUnlocked(backupsRoot: string, data: RestoreJobsFile): Promise<void> {
  await mkdir(backupsRoot, { recursive: true });
  const target = jobsPath(backupsRoot);
  const temporary = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function updateJob(
  backupsRoot: string,
  restoreId: string,
  patch: Partial<CustomRestoreStatus>,
): Promise<CustomRestoreStatus> {
  const target = jobsPath(backupsRoot);
  return withFileLock(target, async () => {
    const data = await readJobs(backupsRoot);
    const index = data.jobs.findIndex(job => job.id === restoreId);
    if (index < 0) throw new Error(`Restore job not found: ${restoreId}`);
    data.jobs[index] = {
      ...data.jobs[index],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await writeJobsUnlocked(backupsRoot, data);
    return data.jobs[index];
  });
}

function execFileAsync(command: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${String(stderr || error.message).trim()}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}

async function exactRunningContainer(containerName: string): Promise<boolean> {
  const output = await execFileAsync('docker', ['ps', '--format', '{{.Names}}']);
  return output.split('\n').map(line => line.trim()).includes(containerName);
}

async function runWithInput(
  command: string,
  args: string[],
  inputFile: string,
  timeout = 10 * 60 * 1000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const input = createReadStream(inputFile);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeout);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
    };
    input.on('error', fail);
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', chunk => { if (stdout.length < 4 * 1024 * 1024) stdout += String(chunk); });
    child.stderr.on('data', chunk => { if (stderr.length < 4 * 1024 * 1024) stderr += String(chunk); });
    input.pipe(child.stdin);
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.trim() || 'no error output'}`));
    });
  });
}

async function dumpContainerDatabase(containerName: string, outputFile: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', [
      'exec', containerName,
      'pg_dump', '-U', 'postgres', '-Fc', '-d', 'postgres',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = createWriteStream(outputFile, { flags: 'wx', mode: 0o600 });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('Safety backup timed out'));
    }, 120_000);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
    };
    child.on('error', fail);
    output.on('error', fail);
    child.stderr.on('data', chunk => { if (stderr.length < 1024 * 1024) stderr += String(chunk); });
    child.stdout.pipe(output);
    child.on('close', code => {
      if (settled) return;
      output.end(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Safety backup failed (${code}): ${stderr.trim() || 'no error output'}`));
      });
    });
  });
}

async function verifyCustomDump(containerName: string, filePath: string): Promise<void> {
  const catalog = await runWithInput(
    'docker',
    ['exec', '-i', containerName, 'pg_restore', '-l'],
    filePath,
    60_000,
  );
  validateCustomArchiveCatalog(catalog);
}

export function validateCustomArchiveCatalog(catalog: string): void {
  const tableDataLines = catalog
    .split('\n')
    .filter(line => /\bTABLE DATA\b/.test(line));
  if (tableDataLines.length === 0) {
    throw new Error('Custom archive has no TABLE DATA entries');
  }
  const nonSystemData = tableDataLines.some(line => {
    const match = line.match(/\bTABLE DATA\s+(\S+)\s+\S+/);
    if (!match) return false;
    const schema = match[1].replace(/^"|"$/g, '');
    return schema !== 'pg_catalog' && schema !== 'information_schema';
  });
  if (!nonSystemData) {
    throw new Error('Custom archive has no TABLE DATA in a non-system schema');
  }
}

async function runningComposeContainers(containerName: string): Promise<string[]> {
  const composeProject = (await execFileAsync('docker', [
    'inspect', containerName,
    '--format', '{{ index .Config.Labels "com.docker.compose.project" }}',
  ])).trim();
  if (!composeProject) throw new Error(`Container ${containerName} has no Docker Compose project label`);
  const output = await execFileAsync('docker', [
    'ps',
    '--filter', `label=com.docker.compose.project=${composeProject}`,
    '--format', '{{.Names}}',
  ]);
  return output.split('\n').map(name => name.trim()).filter(Boolean).sort();
}

async function restoreCustomArchive(containerName: string, sourcePath: string): Promise<void> {
  await runWithInput('docker', [
    'exec', '-i', containerName,
    'pg_restore',
    ...CUSTOM_PG_RESTORE_ARGS,
  ], sourcePath);
}

async function verifyContainerRecovered(containerName: string): Promise<void> {
  let lastState = 'unknown';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const output = await execFileAsync('docker', [
      'inspect', containerName,
      '--format', '{{json .State}}',
    ], 15_000);
    const state = JSON.parse(output) as { Running?: boolean; Health?: { Status?: string } };
    lastState = state.Health?.Status ?? (state.Running ? 'running' : 'stopped');
    if (state.Running && (!state.Health || state.Health.Status === 'healthy')) return;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`Container ${containerName} did not recover (state: ${lastState})`);
}

const defaultRestoreRuntime: CustomRestoreRuntime = {
  verifyArchive: verifyCustomDump,
  listComposeContainers: runningComposeContainers,
  runDocker: (args, timeout) => execFileAsync('docker', args, timeout),
  createSafetyDump: dumpContainerDatabase,
  restoreArchive: restoreCustomArchive,
  verifyContainerRecovered,
};

export async function runCustomRestoreJob(
  options: InitiateOptions,
  job: CustomRestoreStatus,
  sourcePath: string,
  runtime: CustomRestoreRuntime = defaultRestoreRuntime,
): Promise<void> {
  const { backupsRoot, projectSlug } = options;
  const containerName = job.containerName;
  const stoppedContainers: string[] = [];
  let restoreError: Error | null = null;
  activeRestoreIds.add(job.id);
  try {
    await updateJob(backupsRoot, job.id, { status: 'running', phase: 'validating' });
    // Validate the selected archive before disrupting any sibling service.
    await runtime.verifyArchive(containerName, sourcePath);
    await updateJob(backupsRoot, job.id, { phase: 'quiescing' });
    const composeContainers = await runtime.listComposeContainers(containerName);
    for (const name of composeContainers.filter(name => name !== containerName).sort()) {
      await runtime.runDocker(['stop', name], 60_000);
      stoppedContainers.push(name);
    }

    await updateJob(backupsRoot, job.id, { phase: 'safety-backup' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safetyFilename = `${projectSlug}-daily-pre-restore-${stamp}.dump`;
    const dailyDir = path.join(backupsRoot, projectSlug, 'daily');
    await mkdir(dailyDir, { recursive: true });
    const safetyFinal = path.join(dailyDir, safetyFilename);
    const safetyTemporary = `${safetyFinal}.tmp.${process.pid}`;
    try {
      await runtime.createSafetyDump(containerName, safetyTemporary);
      await runtime.verifyArchive(containerName, safetyTemporary);
      await rename(safetyTemporary, safetyFinal);
    } catch (error) {
      await unlink(safetyTemporary).catch(() => undefined);
      throw error;
    }
    await updateJob(backupsRoot, job.id, { safetyBackupFilename: safetyFilename });

    await updateJob(backupsRoot, job.id, { phase: 'restoring' });
    await runtime.restoreArchive(containerName, sourcePath);

    await updateJob(backupsRoot, job.id, { phase: 'verifying' });
    const verification = await runtime.runDocker([
      'exec', containerName,
      'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', 'SELECT 1',
    ]);
    if (verification.trim() !== '1') throw new Error('Post-restore database verification failed');

  } catch (error) {
    restoreError = error instanceof Error ? error : new Error(String(error));
  } finally {
    for (const name of stoppedContainers) {
      try {
        await runtime.runDocker(['start', name], 60_000);
        await runtime.verifyContainerRecovered(name);
      } catch (error) {
        const restartError = error instanceof Error ? error : new Error(String(error));
        restoreError = new Error([
          restoreError?.message,
          `Failed to restart ${name}: ${restartError.message}`,
        ].filter(Boolean).join('; '));
      }
    }
    const completedAt = new Date().toISOString();
    await updateJob(backupsRoot, job.id, restoreError ? {
      status: 'error',
      phase: 'failed',
      completedAt,
      error: restoreError.message,
    } : {
      status: 'success',
      phase: 'complete',
      completedAt,
    }).catch(console.error);
    activeRestoreIds.delete(job.id);
  }
}

const defaultInitiationRuntime: CustomRestoreInitiationRuntime = {
  isContainerRunning: exactRunningContainer,
  schedule: task => setImmediate(task),
};

export async function initiateCustomRestore(
  options: InitiateOptions,
  runtime: CustomRestoreInitiationRuntime = defaultInitiationRuntime,
): Promise<CustomRestoreStatus> {
  const { backupsRoot, projectSlug, filename } = options;
  if (!isSafeCustomBackupSlug(projectSlug)) throw httpError('Invalid projectSlug', 400);
  const resolved = await resolveCustomBackupFile(backupsRoot, projectSlug, filename);
  if (resolved.sizeBytes < 1000) throw httpError('Backup file is too small to be a valid database dump', 400);

  const containerName = `supabase_db_${projectSlug}`;
  if (!await runtime.isContainerRunning(containerName)) {
    throw httpError(`Matching database container is not running: ${containerName}`, 409);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const job: CustomRestoreStatus = {
    id: randomUUID(),
    projectSlug,
    filename,
    containerName,
    status: 'pending',
    phase: 'queued',
    startedAt: nowIso,
    updatedAt: nowIso,
  };

  activeRestoreIds.add(job.id);
  try {
    await withFileLock(jobsPath(backupsRoot), async () => {
    const data = await readJobs(backupsRoot);
    for (const existing of data.jobs) {
      if (existing.projectSlug !== projectSlug || !['pending', 'running'].includes(existing.status)) continue;
      if (now.getTime() - new Date(existing.updatedAt).getTime() <= ACTIVE_JOB_MAX_AGE_MS) {
        throw httpError(`A restore is already active for ${projectSlug}`, 409);
      }
      existing.status = 'error';
      existing.phase = 'failed';
      existing.completedAt = nowIso;
      existing.updatedAt = nowIso;
      existing.error = `Restore was abandoned after ${PRODUCT_NAME} stopped reporting progress`;
    }
    data.jobs.unshift(job);
    data.jobs = data.jobs.slice(0, MAX_JOBS);
    await writeJobsUnlocked(backupsRoot, data);
    });
  } catch (error) {
    activeRestoreIds.delete(job.id);
    throw error;
  }

  runtime.schedule(() => {
    void runCustomRestoreJob(options, job, resolved.filePath).catch(error => {
      console.error('[Supabase restore] Unhandled background failure:', error);
      activeRestoreIds.delete(job.id);
    });
  });
  return job;
}

export async function getCustomRestoreStatus(
  backupsRoot: string,
  restoreId: string,
): Promise<CustomRestoreStatus | null> {
  if (!restoreId || restoreId.length > 100 || !/^[A-Za-z0-9-]+$/.test(restoreId)) {
    throw httpError('Invalid restoreId', 400);
  }
  const data = await reconcileAbandonedJobs(backupsRoot);
  return data.jobs.find(job => job.id === restoreId) ?? null;
}

async function reconcileAbandonedJobs(backupsRoot: string): Promise<RestoreJobsFile> {
  const target = jobsPath(backupsRoot);
  return withFileLock(target, async () => {
    const data = await readJobs(backupsRoot);
    const now = new Date();
    let changed = false;
    for (const job of data.jobs) {
      if (!['pending', 'running'].includes(job.status) || activeRestoreIds.has(job.id)) continue;
      job.status = 'error';
      job.phase = 'failed';
      job.updatedAt = now.toISOString();
      job.completedAt = now.toISOString();
      job.error = `Restore was abandoned when the ${PRODUCT_NAME} restore worker stopped`;
      changed = true;
    }
    if (changed) await writeJobsUnlocked(backupsRoot, data);
    return data;
  });
}

export async function getActiveCustomRestore(
  backupsRoot: string,
): Promise<CustomRestoreStatus | null> {
  const data = await reconcileAbandonedJobs(backupsRoot);
  return data.jobs.find(job => job.status === 'pending' || job.status === 'running') ?? null;
}
