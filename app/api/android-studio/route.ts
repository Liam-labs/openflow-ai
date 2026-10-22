/**
 * Android Studio App API
 *
 * Manage Android/Capacitor projects and run build/reload/emulator commands.
 *
 * GET  /api/android-studio          — List configured projects
 * POST /api/android-studio          — CRUD + execute commands
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { exec, spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import type {
  AndroidProject,
  AndroidStudioData,
  AndroidStudioActionRequest,
  AndroidStudioActionResponse,
  AndroidCommand,
} from '@/lib/types';
import { getWindowsHome } from '@/lib/home-dir';

const DATA_PATH = DataPaths.androidStudio;

const DEFAULT_DATA: AndroidStudioData = {
  projects: [],
  lastUpdated: '',
};

// Track live reload / dev server processes by project id
const liveProcesses = new Map<string, { devServer?: ChildProcess; capRun?: ChildProcess }>();

// ─── Helpers ──────────────────────────────────────────────────────

/** Resolve the Android SDK emulator path on Windows */
function emulatorExe(): string {
  const sdkPath = process.env.ANDROID_SDK_ROOT ||
    `${getWindowsHome()}/AppData/Local/Android/Sdk`;
  return path.join(sdkPath, 'emulator', 'emulator.exe');
}

/** Resolve adb path on Windows */
function adbExe(): string {
  const sdkPath = process.env.ANDROID_SDK_ROOT ||
    `${getWindowsHome()}/AppData/Local/Android/Sdk`;
  return path.join(sdkPath, 'platform-tools', 'adb.exe');
}

/** Validate a WSL path exists and is a directory */
async function validateDir(raw: string, mustExist = true): Promise<string> {
  if (!raw || typeof raw !== 'string') throw new Error('Path must be a non-empty string');
  if (raw.includes('..')) throw new Error('Path traversal not allowed');
  try {
    const resolved = await fs.realpath(raw);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error('Path is not a directory');
    return resolved;
  } catch (err) {
    if (err instanceof Error && err.message.includes('Path')) throw err;
    if (!mustExist && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(raw, { recursive: true });
      return await fs.realpath(raw);
    }
    throw new Error(`Path does not exist or is not accessible: ${raw}`);
  }
}

/** Run a command with a timeout, returning { stdout, stderr } */
function execWithTimeout(
  command: string,
  cwd: string,
  timeoutMs: number,
  windowsCmd = false
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const opts: Record<string, unknown> = {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    };
    if (windowsCmd) {
      opts.shell = 'cmd.exe';
    }
    exec(command, opts, (error, stdout, stderr) => {
      if (error && error.killed) {
        reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
      } else if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** Execute a build/sync command and return output */
async function runCommand(
  project: AndroidProject,
  command: AndroidCommand
): Promise<{ output: string }> {
  const timeoutMs = 300_000; // 5 min

  switch (command) {
    case 'build-web': {
      const { stdout, stderr } = await execWithTimeout(
        'npm run build',
        project.projectPath,
        timeoutMs
      );
      return { output: stdout + (stderr ? '\n' + stderr : '') };
    }

    case 'cap-sync': {
      const { stdout, stderr } = await execWithTimeout(
        'npx cap sync',
        project.projectPath,
        timeoutMs
      );
      return { output: stdout + (stderr ? '\n' + stderr : '') };
    }

    case 'build-apk': {
      // Use gradlew in the android project dir
      const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
      const { stdout, stderr } = await execWithTimeout(
        `${gradlew} assembleDebug`,
        project.androidProjectPath,
        timeoutMs
      );
      return { output: stdout + (stderr ? '\n' + stderr : '') };
    }

    case 'start-emulator': {
      if (!project.emulatorName) {
        throw new Error('No emulator AVD name configured');
      }
      // List available AVDs
      const { stdout: avdList } = await execWithTimeout(
        `"${emulatorExe()}" -list-avds`,
        '/tmp',
        10000,
        true
      );
      const avds = avdList.split('\n').map(l => l.trim()).filter(Boolean);
      if (!avds.includes(project.emulatorName)) {
        throw new Error(
          `AVD "${project.emulatorName}" not found. Available: ${avds.join(', ') || 'none'}`
        );
      }
      // Launch emulator detached
      spawn(
        emulatorExe(),
        ['-avd', project.emulatorName, '-no-snapshot-load'],
        { detached: true, stdio: 'ignore', shell: true }
      );
      return { output: `Emulator "${project.emulatorName}" launching…\nAvailable AVDs: ${avds.join(', ')}` };
    }

    case 'start-live-reload': {
      // Kill any existing processes for this project
      await runStopLiveReload(project);

      // 1. Start Vite dev server
      const devServer = spawn('npx', ['vite', '--host', '0.0.0.0'], {
        cwd: project.projectPath,
        detached: true,
        stdio: 'pipe',
        env: { ...process.env },
      });
      devServer.stdout?.on('data', () => { /* consumed by external viewer */ });
      devServer.stderr?.on('data', () => {});

      // 2. Wait a moment for dev server to start, then run cap
      await new Promise(r => setTimeout(r, 3000));

      // 3. Run cap with live reload
      const capRun = spawn('npx', ['cap', 'run', 'android', '--live-reload', '--external'], {
        cwd: project.projectPath,
        detached: true,
        stdio: 'pipe',
        env: { ...process.env },
      });
      capRun.stdout?.on('data', () => {});
      capRun.stderr?.on('data', () => {});

      liveProcesses.set(project.id, { devServer, capRun });

      // Update project state
      await updateProjectLiveReload(project.id, true, devServer.pid ?? null, capRun.pid ?? null);

      return {
        output: [
          'Live reload started.',
          `Dev server PID: ${devServer.pid}`,
          `Capacitor PID: ${capRun.pid}`,
          'Run "stop-live-reload" to stop.',
        ].join('\n'),
      };
    }

    case 'stop-live-reload': {
      return runStopLiveReload(project);
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function runStopLiveReload(project: AndroidProject): Promise<{ output: string }> {
  const procs = liveProcesses.get(project.id);
  const killed: string[] = [];

  if (procs) {
    if (procs.devServer) {
      try { process.kill(-procs.devServer.pid!, 'SIGTERM'); } catch { /* already dead */ }
      killed.push(`dev-server (${procs.devServer.pid})`);
    }
    if (procs.capRun) {
      try { process.kill(-procs.capRun.pid!, 'SIGTERM'); } catch { /* already dead */ }
      killed.push(`cap-run (${procs.capRun.pid})`);
    }
    liveProcesses.delete(project.id);
  }

  // Also kill any orphaned processes by name
  try {
    await execWithTimeout('pkill -f "vite.*--host" || true', '/tmp', 5000);
    await execWithTimeout('pkill -f "cap run android" || true', '/tmp', 5000);
  } catch { /* best-effort */ }

  await updateProjectLiveReload(project.id, false, null, null);

  return { output: killed.length > 0 ? `Stopped: ${killed.join(', ')}` : 'No live reload processes running.' };
}

async function updateProjectLiveReload(
  id: string,
  active: boolean,
  devServerPid: number | null,
  liveReloadPid: number | null
): Promise<void> {
  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<AndroidStudioData>(DATA_PATH, DEFAULT_DATA);
    const project = data.projects.find(p => p.id === id);
    if (!project) return;
    project.liveReloadActive = active;
    project.devServerPid = devServerPid;
    project.liveReloadPid = liveReloadPid;
    project.updatedAt = new Date().toISOString();
    data.lastUpdated = project.updatedAt;
    await writeJsonFile(DATA_PATH, data);
  });
}

// ═══════════════════════════════════════════════════════════════════
// GET — List projects
// ═══════════════════════════════════════════════════════════════════

export const GET = tracked('/api/android-studio', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const data = await readJsonFile<AndroidStudioData>(DATA_PATH, DEFAULT_DATA);
  return NextResponse.json({ success: true, projects: data.projects });
});

// ═══════════════════════════════════════════════════════════════════
// POST — CRUD + execute
// ═══════════════════════════════════════════════════════════════════

export const POST = tracked('/api/android-studio', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  let body: AndroidStudioActionRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { action } = body;

  switch (action) {
    case 'create': return handleCreate(body);
    case 'update': return handleUpdate(body);
    case 'delete': return handleDelete(body);
    case 'execute': return handleExecute(body);
    case 'stop-live-reload': return handleStopLiveReload(body);
    default:
      return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  }
});

// ─── Handlers ──────────────────────────────────────────────────────

async function handleCreate(
  body: AndroidStudioActionRequest
): Promise<NextResponse<AndroidStudioActionResponse>> {
  if (!body.name || !body.projectPath) {
    return NextResponse.json({ success: false, error: 'name and projectPath required' }, { status: 400 });
  }

  let resolvedProjectPath: string;
  let resolvedAndroidPath: string;
  try {
    resolvedProjectPath = await validateDir(body.projectPath, true);
    resolvedAndroidPath = body.androidProjectPath
      ? await validateDir(body.androidProjectPath, true)
      : path.join(resolvedProjectPath, 'android');
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Invalid path' },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const project: AndroidProject = {
    id: randomUUID(),
    name: body.name,
    projectPath: resolvedProjectPath,
    androidProjectPath: resolvedAndroidPath,
    emulatorName: body.emulatorName ?? '',
    enabled: true,
    liveReloadActive: false,
    liveReloadPid: null,
    devServerPid: null,
    lastBuild: null,
    lastSync: null,
    lastOutput: null,
    lastCommand: null,
    createdAt: now,
    updatedAt: now,
  };

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<AndroidStudioData>(DATA_PATH, DEFAULT_DATA);
    data.projects.push(project);
    data.lastUpdated = now;
    await writeJsonFile(DATA_PATH, data);
  });

  return NextResponse.json({ success: true, project });
}

async function handleUpdate(
  body: AndroidStudioActionRequest
): Promise<NextResponse<AndroidStudioActionResponse>> {
  if (!body.id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });

  let updated: AndroidProject | undefined;
  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<AndroidStudioData>(DATA_PATH, DEFAULT_DATA);
    const project = data.projects.find(p => p.id === body.id);
    if (!project) return;

    if (body.name !== undefined) project.name = body.name;
    if (body.projectPath !== undefined) {
      project.projectPath = await validateDir(body.projectPath, true);
    }
    if (body.androidProjectPath !== undefined) {
      project.androidProjectPath = await validateDir(body.androidProjectPath, true);
    }
    if (body.emulatorName !== undefined) project.emulatorName = body.emulatorName;
    if (body.enabled !== undefined) project.enabled = body.enabled;

    project.updatedAt = new Date().toISOString();
    data.lastUpdated = project.updatedAt;
    await writeJsonFile(DATA_PATH, data);
    updated = project;
  });

  if (!updated) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
  return NextResponse.json({ success: true, project: updated });
}

async function handleDelete(
  body: AndroidStudioActionRequest
): Promise<NextResponse<AndroidStudioActionResponse>> {
  if (!body.id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });

  // Kill any live processes first
  const data = await readJsonFile<AndroidStudioData>(DATA_PATH, DEFAULT_DATA);
  const project = data.projects.find(p => p.id === body.id);
  if (project?.liveReloadActive) {
    await runStopLiveReload(project);
  }

  let deleted = false;
  await withFileLock(DATA_PATH, async () => {
    const d = await readJsonFile<AndroidStudioData>(DATA_PATH, DEFAULT_DATA);
    const idx = d.projects.findIndex(p => p.id === body.id);
    if (idx === -1) return;
    d.projects.splice(idx, 1);
    d.lastUpdated = new Date().toISOString();
    await writeJsonFile(DATA_PATH, d);
    deleted = true;
  });

  if (!deleted) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
  return NextResponse.json({ success: true });
}

async function handleExecute(
  body: AndroidStudioActionRequest
): Promise<NextResponse<AndroidStudioActionResponse>> {
  if (!body.id || !body.command) {
    return NextResponse.json({ success: false, error: 'id and command required' }, { status: 400 });
  }

  const data = await readJsonFile<AndroidStudioData>(DATA_PATH, DEFAULT_DATA);
  const project = data.projects.find(p => p.id === body.id);
  if (!project) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });

  try {
    const { output } = await runCommand(project, body.command);

    // Update lastBuild/lastSync timestamps
    await withFileLock(DATA_PATH, async () => {
      const d = await readJsonFile<AndroidStudioData>(DATA_PATH, DEFAULT_DATA);
      const p = d.projects.find(x => x.id === project.id);
      if (!p) return;
      p.lastOutput = output.slice(-4000); // keep the tail
      p.lastCommand = body.command!;
      if (body.command === 'build-web') p.lastBuild = new Date().toISOString();
      if (body.command === 'cap-sync') p.lastSync = new Date().toISOString();
      p.updatedAt = new Date().toISOString();
      d.lastUpdated = p.updatedAt;
      await writeJsonFile(DATA_PATH, d);
    });

    return NextResponse.json({ success: true, output });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Command failed', output: '' },
      { status: 500 }
    );
  }
}

async function handleStopLiveReload(
  body: AndroidStudioActionRequest
): Promise<NextResponse<AndroidStudioActionResponse>> {
  if (!body.id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });

  const data = await readJsonFile<AndroidStudioData>(DATA_PATH, DEFAULT_DATA);
  const project = data.projects.find(p => p.id === body.id);
  if (!project) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });

  try {
    const { output } = await runStopLiveReload(project);
    return NextResponse.json({ success: true, output });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Stop failed' },
      { status: 500 }
    );
  }
}
