import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';
import {
  buildClaudeDesignLaunchPlan,
  isClaudeDesignPromptReady,
  type ClaudeDesignLaunchAction,
} from '@/lib/claude-design-launch';
import { validateAndCanonicalize } from '@/lib/path-linker-validate';
import { resolveWorkingWslInterop } from '@/lib/windows-interop';
import { appRoot } from '@/lib/app-paths';

const execFileAsync = promisify(execFile);
const CLAUDE_STARTUP_TIMEOUT_MS = 15_000;
const CLAUDE_STARTUP_POLL_MS = 250;

function isLaunchAction(value: unknown): value is ClaudeDesignLaunchAction {
  return value === 'login' || value === 'sync';
}

async function killSession(sessionName: string): Promise<void> {
  await execFileAsync('tmux', ['kill-session', '-t', sessionName], {
    timeout: 5_000,
  }).catch(() => undefined);
}

async function waitForClaudePrompt(sessionName: string): Promise<void> {
  const deadline = Date.now() + CLAUDE_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { stdout } = await execFileAsync(
      'tmux',
      ['capture-pane', '-t', sessionName, '-p', '-S', '-120'],
      { timeout: 5_000, encoding: 'utf-8' },
    );
    if (isClaudeDesignPromptReady(stdout)) return;
    await new Promise(resolve => setTimeout(resolve, CLAUDE_STARTUP_POLL_MS));
  }
  throw new Error('Claude Code did not reach its interactive prompt');
}

export async function POST(request: NextRequest) {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  const body = await request.json().catch(() => null) as {
    action?: unknown;
    cwd?: unknown;
  } | null;

  if (!body || !isLaunchAction(body.action)) {
    return NextResponse.json(
      { success: false, error: 'action must be login or sync' },
      { status: 400 },
    );
  }

  if (body.cwd !== undefined && typeof body.cwd !== 'string') {
    return NextResponse.json(
      { success: false, error: 'cwd must be an absolute project directory' },
      { status: 400 },
    );
  }

  const requestedCwd = body.cwd?.trim() || appRoot();
  const validation = await validateAndCanonicalize(requestedCwd);
  if (!validation.allowed || !validation.canonicalPath || !validation.isDirectory) {
    return NextResponse.json(
      {
        success: false,
        error: validation.isDirectory === false
          ? 'Claude Design must be launched from a project directory'
          : `Project directory is not allowed: ${validation.reason ?? 'invalid path'}`,
      },
      { status: 400 },
    );
  }

  const plan = buildClaudeDesignLaunchPlan(body.action, validation.canonicalPath);
  let sessionCreated = false;

  try {
    // Start a plain shell first. Sending the fixed launch command through tmux
    // avoids interpolating the user-selected cwd into a shell command.
    await execFileAsync('tmux', [
      'new-session',
      '-d',
      '-s', plan.sessionName,
      '-c', plan.cwd,
    ], { timeout: 5_000 });
    sessionCreated = true;

    // Match every other DevFlow Claude spawn: nested-session markers and the
    // API key must be absent so Claude Design uses the owner's claude.ai account.
    const launchClaude = 'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT ANTHROPIC_API_KEY; exec claude';
    await execFileAsync('tmux', ['send-keys', '-t', plan.sessionName, '-l', launchClaude]);
    await execFileAsync('tmux', ['send-keys', '-t', plan.sessionName, 'Enter']);

    await waitForClaudePrompt(plan.sessionName);

    // This is deliberately terminal input, not a prompt asking Claude to run a
    // slash command. Claude Code itself receives and owns the invocation.
    await execFileAsync('tmux', ['send-keys', '-t', plan.sessionName, '-l', plan.slashCommand]);
    await execFileAsync('tmux', ['send-keys', '-t', plan.sessionName, 'Enter']);

    let terminalOpened = false;
    let terminalError: string | undefined;
    try {
      const wslInterop = await resolveWorkingWslInterop();
      await execFileAsync(plan.terminalLaunch.file, plan.terminalLaunch.args, {
        cwd: '/mnt/c',
        env: { ...process.env, WSL_INTEROP: wslInterop },
        timeout: 5_000,
      });
      terminalOpened = true;
    } catch (error) {
      terminalError = error instanceof Error ? error.message : 'Windows Terminal did not open';
    }

    return NextResponse.json({
      success: true,
      action: plan.action,
      cwd: plan.cwd,
      sessionName: plan.sessionName,
      attachCommand: plan.attachCommand,
      terminalOpened,
      terminalError,
      message: terminalOpened
        ? `${plan.slashCommand} opened in Claude Code`
        : `${plan.slashCommand} is running; attach with: ${plan.attachCommand}`,
    });
  } catch (error) {
    if (sessionCreated) await killSession(plan.sessionName);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to launch Claude Design',
      },
      { status: 500 },
    );
  }
}
