/**
 * Computer Use Setup Wizard API
 *
 * GET  /api/computer-use/wizard — Run all dependency checks, return grouped results
 * POST /api/computer-use/wizard — Run an automatable install/verify action
 *
 * Per spec: Team/an agent/plan-setup-wizard.md
 *
 * Checks are grouped into 3 groups:
 *   1. WSL / Linux Side  (python3, packages, API key or Claude CLI based on backend)
 *   2. Windows Side      (python.exe, all required pip packages)
 *   3. Bridge Connectivity (reachable, screen valid, DPI warning)
 *
 * Within each group, checks that depend on a prerequisite run sequentially.
 * The 3 groups run in parallel (Promise.all) for speed.
 * Each individual check has a 10s timeout.
 * Total endpoint timeout: 60s (handled by Next.js route config).
 */

import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { release } from 'os';
import { readSettings } from '@/lib/computer-use-settings';
import { DataPaths } from '@/lib/data-paths';
import { writeJsonFile, withFileLock } from '@/lib/data-io';
import { checkBridgeHealth, getBridgeUrl, startBridge } from '@/lib/computer-use-bridge';
import { requireAuthOrLocal } from '@/lib/api-auth';
import type { DevFlowSettings } from '@/lib/types';
import { tracked } from '@/lib/api-tracking';
import { validateBodySize } from '@/lib/fetch-utils';

import { getDevflowHome } from '@/lib/home-dir';
const execAsync = promisify(exec);
const desktopSetupSupported = () => process.platform === 'linux' && /microsoft/i.test(release());
const unsupportedReason = 'This wizard configures a Windows desktop through WSL. It cannot install desktop control on this server. You can continue using OpenFlow without it.';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WizardFix {
  instructions: string;
  commands: string[];
  automatable?: string; // POST action name if we can run it automatically
}

export interface WizardCheckResult {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail: string;
  fix: WizardFix | null;
}

interface WizardGroup {
  id: string;
  label: string;
  items: WizardCheckResult[];
}

interface WizardSummary {
  total: number;
  passed: number;
  failed: number;
  warnings: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CHECK_TIMEOUT_MS = 10_000;

function skip(id: string, label: string, detail: string): WizardCheckResult {
  return { id, label, status: 'skip', detail, fix: null };
}

// ─── WSL Group ────────────────────────────────────────────────────────────────

async function checkPython3(): Promise<WizardCheckResult> {
  try {
    // python3 --version may write to stderr on some versions
    const { stdout, stderr } = await execAsync('python3 --version', { timeout: CHECK_TIMEOUT_MS });
    const raw = (stdout || stderr).trim();
    const match = raw.match(/Python (\d+)\.(\d+)\.(\d+)/);
    if (!match) throw new Error(`Unexpected output: ${raw}`);

    const major = parseInt(match[1]);
    const minor = parseInt(match[2]);

    if (major < 3 || (major === 3 && minor < 8)) {
      return {
        id: 'python3', label: 'Python 3.8+', status: 'fail',
        detail: `${raw} (need 3.8+)`,
        fix: { instructions: 'Upgrade Python 3 in WSL:', commands: ['sudo apt-get install python3'] },
      };
    }
    return { id: 'python3', label: 'Python 3.8+', status: 'pass', detail: raw, fix: null };
  } catch {
    return {
      id: 'python3', label: 'Python 3.8+', status: 'fail',
      detail: 'Not found',
      fix: { instructions: 'Install Python 3 in WSL:', commands: ['sudo apt-get install python3 python3-pip'] },
    };
  }
}

async function checkWslPackage(pkg: string, importName: string, label: string): Promise<WizardCheckResult> {
  try {
    const { stdout } = await execAsync(
      `python3 -c "import ${importName}; print(${importName}.__version__)"`,
      { timeout: CHECK_TIMEOUT_MS }
    );
    return { id: pkg, label, status: 'pass', detail: stdout.trim(), fix: null };
  } catch {
    return {
      id: pkg, label, status: 'fail',
      detail: 'Not installed',
      fix: {
        instructions: `Install ${label} in WSL:`,
        commands: [`pip install ${pkg}`],
        automatable: 'install_wsl_deps',
      },
    };
  }
}

async function checkApiKey(): Promise<WizardCheckResult> {
  const key = process.env.ANTHROPIC_API_KEY ?? '';
  if (!key) {
    return {
      id: 'api_key', label: 'ANTHROPIC_API_KEY', status: 'fail',
      detail: 'Not set',
      fix: {
        instructions: 'Add your Anthropic API key to your shell environment:',
        commands: ["echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.secrets"],
      },
    };
  }
  if (!key.startsWith('sk-ant-')) {
    return {
      id: 'api_key', label: 'ANTHROPIC_API_KEY', status: 'fail',
      detail: 'Set but invalid format (expected sk-ant-...)',
      fix: {
        instructions: 'Update your ANTHROPIC_API_KEY — get a valid key from console.anthropic.com:',
        commands: ["echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.secrets"],
      },
    };
  }
  // Show last 6 chars only
  return {
    id: 'api_key', label: 'ANTHROPIC_API_KEY', status: 'pass',
    detail: `••••••${key.slice(-6)}`,
    fix: null,
  };
}

async function checkClaudeCli(): Promise<WizardCheckResult> {
  try {
    const { stdout } = await execAsync('which claude 2>/dev/null && claude --version', { timeout: CHECK_TIMEOUT_MS });
    const version = stdout.trim().split('\n').pop() ?? 'available';
    return { id: 'claude_cli', label: 'Claude CLI', status: 'pass', detail: version, fix: null };
  } catch {
    return {
      id: 'claude_cli', label: 'Claude CLI', status: 'fail',
      detail: 'Not found in PATH',
      fix: {
        instructions: 'Install Claude Code CLI:',
        commands: ['npm install -g @anthropic-ai/claude-code'],
      },
    };
  }
}

async function checkClaudeCliAuth(): Promise<WizardCheckResult> {
  // Check auth by reading ~/.claude.json credentials file — much faster and more reliable
  // than making a live inference call, and doesn't consume API credits.
  try {
    const homedir = process.env.HOME ?? '/root';
    const { stdout } = await execAsync(`cat "${homedir}/.claude.json"`, { timeout: 5_000 });
    const config = JSON.parse(stdout) as Record<string, unknown>;
    const oauth = config.oauthAccount as Record<string, unknown> | null | undefined;
    if (oauth && typeof oauth.accountUuid === 'string' && oauth.accountUuid.length > 0) {
      const email = typeof oauth.emailAddress === 'string' ? oauth.emailAddress : 'unknown';
      return {
        id: 'claude_cli_auth', label: 'Claude CLI Auth', status: 'pass',
        detail: `Authenticated as ${email}`,
        fix: null,
      };
    }
    throw new Error('No OAuth account in credentials');
  } catch {
    return {
      id: 'claude_cli_auth', label: 'Claude CLI Auth', status: 'fail',
      detail: 'Not authenticated',
      fix: {
        instructions: 'Log in to Claude Code CLI by running it interactively:',
        commands: ['claude'],
        automatable: 'verify_claude_cli',
      },
    };
  }
}

async function runWslGroup(backend: 'api' | 'max'): Promise<WizardCheckResult[]> {
  // python3 must pass before package checks
  const python3Result = await checkPython3();

  let packageResults: WizardCheckResult[];
  if (python3Result.status === 'pass') {
    packageResults = await Promise.all([
      checkWslPackage('anthropic', 'anthropic', 'anthropic package'),
      checkWslPackage('httpx', 'httpx', 'httpx package'),
    ]);
  } else {
    packageResults = [
      skip('anthropic', 'anthropic package', 'Python 3 required'),
      skip('httpx', 'httpx package', 'Python 3 required'),
    ];
  }

  // Backend-specific auth checks (run in parallel with package checks above conceptually,
  // but we wait for python3 result first which is fast)
  let apiKeyResult: WizardCheckResult;
  let claudeCliResult: WizardCheckResult;
  let claudeCliAuthResult: WizardCheckResult;

  if (backend === 'api') {
    apiKeyResult = await checkApiKey();
    claudeCliResult = skip('claude_cli', 'Claude CLI', 'Using API backend');
    claudeCliAuthResult = skip('claude_cli_auth', 'Claude CLI Auth', 'Using API backend');
  } else {
    // MAX backend
    apiKeyResult = skip('api_key', 'ANTHROPIC_API_KEY', 'Using MAX backend');
    claudeCliResult = await checkClaudeCli();
    if (claudeCliResult.status === 'pass') {
      claudeCliAuthResult = await checkClaudeCliAuth();
    } else {
      claudeCliAuthResult = skip('claude_cli_auth', 'Claude CLI Auth', 'Claude CLI not found');
    }
  }

  return [python3Result, ...packageResults, apiKeyResult, claudeCliResult, claudeCliAuthResult];
}

// ─── Windows Group ────────────────────────────────────────────────────────────

async function checkWindowsPython(): Promise<WizardCheckResult> {
  for (const py of ['python.exe', 'python3.exe']) {
    try {
      const { stdout, stderr } = await execAsync(`${py} --version`, { timeout: CHECK_TIMEOUT_MS });
      const version = (stdout || stderr).trim();
      return { id: 'python_exe', label: 'python.exe accessible', status: 'pass', detail: version, fix: null };
    } catch {
      continue;
    }
  }
  return {
    id: 'python_exe', label: 'python.exe accessible', status: 'fail',
    detail: 'Not found',
    fix: {
      instructions: 'Install Python on Windows from python.org. Tick "Add Python to PATH" during setup.',
      commands: ['https://www.python.org/downloads/'],
    },
  };
}

async function checkWindowsPackage(pkg: string, importName: string, label: string): Promise<WizardCheckResult> {
  try {
    const { stdout } = await execAsync(
      `python.exe -c "import ${importName}; print(${importName}.__version__)"`,
      { timeout: CHECK_TIMEOUT_MS }
    );
    return { id: pkg.toLowerCase(), label, status: 'pass', detail: stdout.trim(), fix: null };
  } catch {
    return {
      id: pkg.toLowerCase(), label, status: 'fail',
      detail: 'Not installed',
      fix: {
        instructions: 'Install all Windows Python dependencies in PowerShell:',
        commands: ['pip install fastapi uvicorn mss Pillow pyautogui'],
        automatable: 'install_windows_deps',
      },
    };
  }
}

async function runWindowsGroup(): Promise<WizardCheckResult[]> {
  const winPythonResult = await checkWindowsPython();

  let winPackageResults: WizardCheckResult[];
  if (winPythonResult.status === 'pass') {
    winPackageResults = await Promise.all([
      checkWindowsPackage('fastapi', 'fastapi', 'fastapi'),
      checkWindowsPackage('uvicorn', 'uvicorn', 'uvicorn'),
      checkWindowsPackage('mss', 'mss', 'mss'),
      checkWindowsPackage('Pillow', 'PIL', 'Pillow'),
      checkWindowsPackage('pyautogui', 'pyautogui', 'pyautogui'),
    ]);
  } else {
    winPackageResults = ['fastapi', 'uvicorn', 'mss', 'Pillow', 'pyautogui'].map(pkg =>
      skip(pkg.toLowerCase(), pkg, 'python.exe required')
    );
  }

  return [winPythonResult, ...winPackageResults];
}

// ─── Bridge Group ─────────────────────────────────────────────────────────────

async function runBridgeGroup(): Promise<WizardCheckResult[]> {
  const health = await checkBridgeHealth();
  const bridgeUrl = getBridgeUrl();

  if (!health.ok) {
    return [
      {
        id: 'bridge_reachable', label: 'Bridge at port 2150', status: 'fail',
        detail: 'Connection refused',
        fix: {
          instructions: 'Start the computer use bridge on Windows. In PowerShell, run:',
          commands: [
            `python.exe \\\\wsl.localhost\\Ubuntu${getDevflowHome().replace(/\//g, '\\')}\\scripts\\computer_use_bridge.py --port 2150`,
          ],
          automatable: 'start_bridge',
        },
      },
      skip('screen_valid', 'Screen info valid', 'Bridge unreachable'),
      skip('dpi_scale', 'DPI scaling', 'Bridge unreachable'),
    ];
  }

  const bridgeResult: WizardCheckResult = {
    id: 'bridge_reachable', label: 'Bridge at port 2150', status: 'pass',
    detail: `Reachable at ${bridgeUrl}`,
    fix: null,
  };

  const screenResult: WizardCheckResult = (health.screen && health.screen.width > 0 && health.screen.height > 0)
    ? { id: 'screen_valid', label: 'Screen info valid', status: 'pass', detail: `${health.screen.width} × ${health.screen.height}`, fix: null }
    : { id: 'screen_valid', label: 'Screen info valid', status: 'fail', detail: 'No screen info in /health response', fix: null };

  const dpiScale = health.dpiScale ?? 1.0;
  const dpiResult: WizardCheckResult = (dpiScale === 1.0)
    ? { id: 'dpi_scale', label: 'DPI scaling', status: 'pass', detail: '100% (no scaling)', fix: null }
    : {
        id: 'dpi_scale', label: 'DPI scaling', status: 'warn',
        detail: `DPI is ${Math.round(dpiScale * 100)}% — mouse coordinates may be offset`,
        fix: {
          instructions: 'Set Windows display scaling to 100% for accurate coordinate mapping:',
          commands: ['Settings → System → Display → Scale → 100%'],
        },
      };

  return [bridgeResult, screenResult, dpiResult];
}

// ─── Record wizard pass timestamp ─────────────────────────────────────────────

async function recordWizardPassed(): Promise<void> {
  try {
    await withFileLock(DataPaths.settings, async () => {
      const settings = await import('@/lib/computer-use-settings').then(m => m.readSettings());
      (settings as DevFlowSettings).computerUse.wizardPassedAt = new Date().toISOString();
      await writeJsonFile(DataPaths.settings, settings);
    });
  } catch {
    // Non-critical — don't fail the wizard response if timestamp write fails
  }
}

// ─── GET Handler ──────────────────────────────────────────────────────────────

export const GET = tracked('/api/computer-use/wizard', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const settings = await readSettings();
  const backend: 'api' | 'max' = settings.computerUse.backend ?? 'api';
  if (!desktopSetupSupported()) {
    return NextResponse.json({ success: true, supported: false, unsupportedReason, backend, groups: [], allPassed: false, summary: { total: 0, passed: 0, failed: 0, warnings: 0 } });
  }

  // Run the 3 groups in parallel
  const [wslItems, windowsItems, bridgeItems] = await Promise.all([
    runWslGroup(backend),
    runWindowsGroup(),
    runBridgeGroup(),
  ]);

  const groups: WizardGroup[] = [
    { id: 'wsl', label: 'WSL / Linux Side', items: wslItems },
    { id: 'windows', label: 'Windows Side', items: windowsItems },
    { id: 'bridge', label: 'Bridge Connectivity', items: bridgeItems },
  ];

  // Summary excludes 'skip' items
  const allItems = [...wslItems, ...windowsItems, ...bridgeItems].filter(i => i.status !== 'skip');
  const summary: WizardSummary = {
    total: allItems.length,
    passed: allItems.filter(i => i.status === 'pass').length,
    failed: allItems.filter(i => i.status === 'fail').length,
    warnings: allItems.filter(i => i.status === 'warn').length,
  };

  const allPassed = summary.failed === 0;

  // Record timestamp if wizard passed (fire-and-forget, non-critical)
  if (allPassed) {
    void recordWizardPassed();
  }

  return NextResponse.json({
    success: true,
    backend,
    groups,
    allPassed,
    summary,
  });
});

// ─── POST Handler ─────────────────────────────────────────────────────────────

export const POST = tracked('/api/computer-use/wizard', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  if (!desktopSetupSupported()) return NextResponse.json({ success: false, code: 'UNSUPPORTED_PLATFORM', error: unsupportedReason }, { status: 409 });
  const sizeError = validateBodySize(request);
  if (sizeError) return sizeError;

  let body: { action: string };
  try {
    body = await request.json() as { action: string };
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { action } = body;
  if (!action || typeof action !== 'string') {
    return NextResponse.json({ success: false, error: 'Missing "action" field' }, { status: 400 });
  }

  switch (action) {
    case 'install_wsl_deps': {
      // Install anthropic + httpx in WSL
      try {
        const { stdout, stderr } = await execAsync(
          'pip install anthropic httpx',
          { timeout: 120_000 }
        );
        return NextResponse.json({ success: true, output: stdout || stderr });
      } catch (err) {
        return NextResponse.json(
          { success: false, error: (err as Error).message },
          { status: 500 }
        );
      }
    }

    case 'install_windows_deps': {
      // Install Windows Python deps via python.exe
      try {
        const { stdout, stderr } = await execAsync(
          'python.exe -m pip install fastapi uvicorn mss Pillow pyautogui',
          { timeout: 180_000 }
        );
        return NextResponse.json({ success: true, output: stdout || stderr });
      } catch (err) {
        return NextResponse.json(
          { success: false, error: (err as Error).message },
          { status: 500 }
        );
      }
    }

    case 'start_bridge': {
      try {
        const result = await startBridge();
        return NextResponse.json({
          success: true,
          output: result.alreadyRunning ? 'Bridge was already running' : 'Bridge started successfully',
          url: result.url,
        });
      } catch (err) {
        return NextResponse.json(
          { success: false, error: (err as Error).message },
          { status: 500 }
        );
      }
    }

    case 'verify_api_key': {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) {
        return NextResponse.json(
          { success: false, error: 'ANTHROPIC_API_KEY not set in environment' },
          { status: 400 }
        );
      }
      try {
        const res = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const errBody = await res.json() as { error?: { message?: string } };
          return NextResponse.json(
            { success: false, error: errBody.error?.message ?? `API returned ${res.status}` },
            { status: 400 }
          );
        }
        return NextResponse.json({ success: true, output: 'API key verified successfully' });
      } catch (err) {
        return NextResponse.json(
          { success: false, error: (err as Error).message },
          { status: 500 }
        );
      }
    }

    case 'verify_claude_cli': {
      // Check credentials file — avoids making a live inference call
      try {
        const homedir = process.env.HOME ?? '/root';
        const { stdout } = await execAsync(`cat "${homedir}/.claude.json"`, { timeout: 5_000 });
        const config = JSON.parse(stdout) as Record<string, unknown>;
        const oauth = config.oauthAccount as Record<string, unknown> | null | undefined;
        if (oauth && typeof oauth.accountUuid === 'string' && oauth.accountUuid.length > 0) {
          const email = typeof oauth.emailAddress === 'string' ? oauth.emailAddress : 'authenticated';
          return NextResponse.json({ success: true, output: `Authenticated as ${email}` });
        }
        return NextResponse.json(
          { success: false, error: 'Claude CLI is not authenticated. Run `claude` in a terminal to log in.' },
          { status: 500 }
        );
      } catch {
        return NextResponse.json(
          { success: false, error: 'Claude CLI is not available or not authenticated. Run `claude` in a terminal to log in.' },
          { status: 500 }
        );
      }
    }

    default:
      return NextResponse.json(
        { success: false, error: `Unknown action: "${action}". Valid actions: install_wsl_deps, install_windows_deps, start_bridge, verify_api_key, verify_claude_cli` },
        { status: 400 }
      );
  }
});
