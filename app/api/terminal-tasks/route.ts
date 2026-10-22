/**
 * Terminal Tasks API - Multi-Engine AI Terminal Sessions
 *
 * Spawns one-off interactive AI sessions in tmux across multiple engines:
 *   - Claude CLI (uses MAX subscription, no API credits)
 *   - Gemini CLI (Google's AI agent)
 *   - Ollama (local models like qwen3-vl)
 *
 * Flow:
 *   1. Spawn the appropriate CLI in tmux based on engine
 *   2. Wait for initialization
 *   3. Send prompt via tmux load-buffer/paste-buffer (shell-safe)
 *   4. Poll for completion via output stability (idle = done)
 *   5. Capture output, gracefully exit, kill tmux session
 *
 * Actions:
 *   - submit: Spawn a new AI session (any engine)
 *   - list: List all tasks (with optional status/engine filter)
 *   - get: Get a specific task by ID
 *   - cancel: Cancel a running task
 *   - models: List available models across all engines
 */

import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
// Note: 'path' import removed — path.join for grok script is in lib/terminal-task-engine.ts
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { resolveApiIdForModel } from '@/lib/model-registry';
import { eventBus } from '@/lib/event-bus';
import {
  ENGINE_TIMING,
  buildEngineCommand,
  approveClaudeTrust,
  getExitCommand,
  validateEngineModel,
} from '@/lib/terminal-task-engine';
import type {
  TerminalTask,
  TerminalTaskModel,
  TerminalTaskEngine,
  TerminalTasksData,
  TerminalTaskActionRequest,
  TerminalTaskActionResponse,
  TerminalTaskStatus,
  TerminalModelInfo,
  TerminalLaunchSession,
} from '@/lib/types';
import { PRODUCT_NAME } from '@/lib/brand';

const execAsync = promisify(exec);

const DATA_PATH = DataPaths.terminalTasks;
const TMUX_PREFIX = 'terminal-task-';

// Claude model mapping: tier name -> claude CLI model flag value.
// The short tier keywords are what users pick; the actual CLI flag resolves
// to the canonical apiId from models.json so spawns route to the 1M-context
// variants (sonnet → claude-sonnet-4-6[1m], opus → claude-opus-4-7[1m]).
const CLAUDE_MODEL_MAP: Record<TerminalTaskModel, string> = {
  haiku: resolveApiIdForModel('haiku'),
  sonnet: resolveApiIdForModel('sonnet'),
  opus: resolveApiIdForModel('opus'),
};

const DEFAULT_DATA: TerminalTasksData = {
  tasks: [],
  lastUpdated: new Date().toISOString(),
};

// Output files directory
const OUTPUT_DIR = '/tmp/terminal-tasks';

// Default timeout: 5 minutes
const DEFAULT_TIMEOUT = 300;
// Max timeout: 30 minutes
const MAX_TIMEOUT = 1800;
// Max history to keep
const MAX_HISTORY = 50;

// ENGINE_TIMING, buildEngineCommand, getExitCommand, validateEngineModel
// are imported from @/lib/terminal-task-engine

const SCROLLBACK_LINES = 5000; // tmux capture depth for long responses

// ============================================================================
// Subscription Auth Provider Config
// ============================================================================

interface ProviderLaunchConfig {
  displayName: string;
  cliCommand: string;       // Shell command to run in the tmux pane
  startupWaitMs: number;    // Time to wait before declaring session ready
  instructions: string;     // User-facing instructions shown after launch
}

// Providers that use a CLI-based subscription auth flow
const SUBSCRIPTION_PROVIDERS: Record<string, ProviderLaunchConfig> = {
  anthropic: {
    displayName: 'Anthropic (Claude)',
    cliCommand: 'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; claude',
    startupWaitMs: 2000,
    instructions: 'Sign in with your Anthropic account or Claude MAX subscription to complete authentication. The browser will open automatically.',
  },
  google: {
    displayName: 'Google (Gemini)',
    cliCommand: 'npx --yes @google/gemini-cli',
    startupWaitMs: 4000,
    instructions: 'Follow the prompts to authenticate with your Google account. A browser window will open for OAuth.',
  },
};

const AUTH_TMUX_PREFIX = 'auth-';

// ============================================================================
// In-memory tracking of active task timers and pollers
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activePollers = new Map<string, ReturnType<typeof setInterval>>();

// Track interactive completion state per task
interface InteractiveTaskState {
  phase: 'waiting' | 'receiving';
  lastOutputChange: number;
  lastOutput: string;
  baselineLength: number;
  promptSentAt: number;
  engine: TerminalTaskEngine;
}
const interactiveStates = new Map<string, InteractiveTaskState>();

/**
 * Strip ANSI escape codes from terminal output
 */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\[\?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
    .replace(/\x1B\[[<>=?!]*[0-9;]*[a-zA-Z@`]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * Check if a tmux session exists
 */
async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await execAsync(`tmux has-session -t ${sessionName} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get output from tmux pane
 */
async function getTmuxOutput(sessionName: string, lines: number = SCROLLBACK_LINES): Promise<string> {
  try {
    const { stdout } = await execAsync(`tmux capture-pane -t ${sessionName} -p -S -${lines}`);
    return stripAnsi(stdout).trim();
  } catch {
    return '';
  }
}

/**
 * Get output file path for a task
 */
function getOutputPath(taskId: string): string {
  return `${OUTPUT_DIR}/${taskId}.out`;
}

/**
 * Read output from file (works even after tmux exits)
 */
async function readOutputFile(taskId: string): Promise<string> {
  try {
    const content = await fs.readFile(getOutputPath(taskId), 'utf-8');
    return content.trim();
  } catch {
    return '';
  }
}

/**
 * Get task output - tries file first, then tmux pane
 */
async function getTaskOutput(taskId: string, tmuxSessionName?: string): Promise<string> {
  const fileOutput = await readOutputFile(taskId);
  if (fileOutput) return fileOutput;

  if (tmuxSessionName) {
    return getTmuxOutput(tmuxSessionName, SCROLLBACK_LINES);
  }
  return '';
}

/**
 * Ensure output directory exists
 */
async function ensureOutputDir(): Promise<void> {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.error('[TerminalTasks] Failed to create output dir:', error);
    }
  }
}

/**
 * Kill a tmux session
 */
async function killTmuxSession(sessionName: string): Promise<void> {
  try {
    await execAsync(`tmux kill-session -t ${sessionName} 2>/dev/null`);
  } catch {
    // Already gone
  }
}

// ============================================================================
// Engine-Specific Spawn Logic
// (ENGINE_TIMING, buildEngineCommand, getExitCommand, validateEngineModel
//  are imported from @/lib/terminal-task-engine)

// ============================================================================
// Model Registry
// ============================================================================

/**
 * Check if a command exists on the system
 */
async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execAsync(`which ${cmd} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get list of installed Ollama models
 */
async function getOllamaModels(): Promise<Array<{ name: string; size: string }>> {
  try {
    const { stdout } = await execAsync('ollama list 2>/dev/null');
    const lines = stdout.trim().split('\n').slice(1); // Skip header
    return lines.map(line => {
      const parts = line.split(/\s+/);
      return {
        name: parts[0] || '',
        size: parts[2] || '',
      };
    }).filter(m => m.name);
  } catch {
    return [];
  }
}

/**
 * Build the full model registry
 */
async function getModelRegistry(): Promise<TerminalModelInfo[]> {
  const models: TerminalModelInfo[] = [];

  // Claude models (check if claude CLI exists)
  const claudeAvailable = await commandExists('claude');
  for (const [tier, description] of [
    ['haiku', 'Fast & efficient for simple tasks'],
    ['sonnet', 'Balanced performance for general use'],
    ['opus', 'Most capable for complex reasoning'],
  ] as const) {
    models.push({
      engine: 'claude',
      model: tier,
      displayName: `Claude ${tier.charAt(0).toUpperCase() + tier.slice(1)}`,
      description,
      available: claudeAvailable,
    });
  }

  // Gemini models (check if gemini CLI exists via npx)
  let geminiAvailable = false;
  try {
    const { stdout } = await execAsync('npx gemini --version 2>/dev/null');
    geminiAvailable = !!stdout.trim();
  } catch {
    // Expected when gemini CLI is not installed — geminiAvailable stays false
  }

  models.push({
    engine: 'gemini',
    model: 'gemini',
    displayName: 'Gemini',
    description: 'Google AI agent with tool use and sandbox support',
    available: geminiAvailable,
  });

  // Grok models (xAI API — available when XAI_API_KEY is set)
  const xaiKeyAvailable = !!(process.env.XAI_API_KEY);
  for (const [modelId, description] of [
    ['grok-4.7', 'xAI flagship — reasoning, tool use and image input (default)'],
  ] as const) {
    models.push({
      engine: 'grok',
      model: modelId,
      displayName: `Grok ${modelId.replace('grok-', '')}`,
      description,
      available: xaiKeyAvailable,
    });
  }

  // Ollama models (list installed models)
  const ollamaModels = await getOllamaModels();
  const ollamaAvailable = ollamaModels.length > 0;

  if (ollamaAvailable) {
    for (const m of ollamaModels) {
      models.push({
        engine: 'ollama',
        model: m.name,
        displayName: m.name,
        description: `Local model (${m.size})`,
        available: true,
        size: m.size,
      });
    }
  } else {
    // Show ollama as unavailable if no models installed
    const ollamaCli = await commandExists('ollama');
    models.push({
      engine: 'ollama',
      model: 'ollama',
      displayName: 'Ollama (no models installed)',
      description: ollamaCli
        ? 'Ollama CLI found but no models installed. Run: ollama pull <model>'
        : 'Ollama CLI not found. Install from https://ollama.ai',
      available: false,
    });
  }

  return models;
}

// ============================================================================
// Interactive Task Polling
// ============================================================================

/**
 * Build `-e KEY=VALUE` flag sequence for `tmux new-session`. Keys are restricted
 * to ASCII alphanumerics + underscore; values are single-quoted and any literal
 * single-quote in the value is shell-escaped. Returns empty string when no env
 * is provided.
 */
function buildTmuxEnvFlags(env: Record<string, string> | undefined): string {
  if (!env) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      // Ignore invalid shell identifiers — logged but not fatal
      console.warn(`[TerminalTasks] skipping env var with invalid key: ${key}`);
      continue;
    }
    const escaped = String(value).replace(/'/g, "'\\''");
    parts.push(`-e ${key}='${escaped}'`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

/**
 * Start polling an interactive task for completion.
 * Detects when the AI finishes responding by monitoring output stability.
 */
function startInteractiveTaskPoller(
  taskId: string,
  tmuxSessionName: string,
  timeout: number,
  baselineLength: number,
  engine: TerminalTaskEngine,
  idleThresholdOverrideMs?: number,
): void {
  const timing = ENGINE_TIMING[engine];
  // Per-submit override for the idle-output threshold. Tool-use loops
  // (computer-use, long reasoning) pause >8s between curl calls and would be
  // falsely completed by the default. Clamp to a sane range (2s..120s).
  const effectiveIdleMs =
    typeof idleThresholdOverrideMs === 'number' && idleThresholdOverrideMs > 0
      ? Math.max(2000, Math.min(120_000, idleThresholdOverrideMs))
      : timing.idleThresholdMs;
  const state: InteractiveTaskState = {
    phase: 'waiting',
    lastOutputChange: Date.now(),
    lastOutput: '',
    baselineLength,
    promptSentAt: Date.now(),
    engine,
  };
  interactiveStates.set(taskId, state);

  // Never leave an earlier poller running for the same task (a re-attach racing the original start would otherwise double up).
  const oldTimer = activeTimers.get(taskId);
  if (oldTimer) clearTimeout(oldTimer);
  const oldPoller = activePollers.get(taskId);
  if (oldPoller) clearInterval(oldPoller);

  // Set up timeout
  const timer = setTimeout(async () => {
    await finalizeTask(taskId, 'timeout');
  }, timeout * 1000);
  activeTimers.set(taskId, timer);

  // Poll every 2 seconds
  const poller = setInterval(async () => {
    try {
      const exists = await tmuxSessionExists(tmuxSessionName);
      if (!exists) {
        // Session ended unexpectedly - capture what we have
        await finalizeTask(taskId, 'completed');
        return;
      }

      const currentOutput = await getTmuxOutput(tmuxSessionName, SCROLLBACK_LINES);

      // Persist output to file for live monitoring and crash recovery
      try {
        await fs.writeFile(getOutputPath(taskId), currentOutput);
      } catch (error) {
        console.error('[TerminalTasks] Failed to persist output for task', taskId, ':', error instanceof Error ? error.message : error);
      }

      // Detect phase transitions: waiting -> receiving
      if (state.phase === 'waiting' && currentOutput.length > state.baselineLength + 20) {
        state.phase = 'receiving';
      }

      // Track output changes
      if (currentOutput !== state.lastOutput) {
        state.lastOutput = currentOutput;
        state.lastOutputChange = Date.now();
      }

      // Check for completion: output stable + in receiving phase + min time elapsed
      if (state.phase === 'receiving') {
        const idleMs = Date.now() - state.lastOutputChange;
        const minTimeElapsed = Date.now() - state.promptSentAt > timing.minResponseTimeMs;

        if (idleMs >= effectiveIdleMs && minTimeElapsed) {
          await finalizeTask(taskId, 'completed');
        }
      }
    } catch (err) {
      console.error(`[TerminalTasks] Poller error for ${taskId}:`, err);
    }
  }, 2000);
  activePollers.set(taskId, poller);
}

/**
 * A DevFlow restart loses every poller and timer, so a task that was running keeps the status "running" for ever (a build restarted DevFlow
 * seven seconds after a task finished, and the caller polled a finished task until it gave up). Called on every request: for each running task
 * with no poller in this process, either settle it (its session is gone) or watch it again with the time it has left.
 * The caller's idle-threshold override is not stored with the task, so a re-attached task uses the engine default.
 */
const reattaching = new Set<string>();
async function recoverOrphanedTasks(): Promise<void> {
  const data = await readJsonFile<TerminalTasksData>(DATA_PATH, DEFAULT_DATA);
  for (const task of data.tasks) {
    if (task.status !== 'running' || activePollers.has(task.id) || reattaching.has(task.id)) continue;
    reattaching.add(task.id);
    try {
      const alive = !!task.tmuxSessionName && await tmuxSessionExists(task.tmuxSessionName);
      if (!alive) {
        await finalizeTask(task.id, 'completed');            // the output file the poller kept is what getTaskOutput returns
        continue;
      }
      const started = task.startedAt ? new Date(task.startedAt).getTime() : Date.now();
      const leftSec = task.timeout - (Date.now() - started) / 1000;
      if (leftSec <= 0) {
        await finalizeTask(task.id, 'timeout');
        continue;
      }
      startInteractiveTaskPoller(task.id, task.tmuxSessionName!, Math.max(10, Math.ceil(leftSec)), 0, task.engine || 'claude');
    } catch (error) {
      console.error('[TerminalTasks] recovery failed for', task.id, error);
    } finally {
      reattaching.delete(task.id);
    }
  }
}

/**
 * Finalize a task: capture output, gracefully exit, update status, clean up
 */
async function finalizeTask(taskId: string, status: TerminalTaskStatus): Promise<void> {
  // Clear timers
  const timer = activeTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(taskId);
  }
  const poller = activePollers.get(taskId);
  if (poller) {
    clearInterval(poller);
    activePollers.delete(taskId);
  }
  const taskState = interactiveStates.get(taskId);
  interactiveStates.delete(taskId);

  await withFileLock(DATA_PATH, async () => {
    const data = await readJsonFile<TerminalTasksData>(DATA_PATH, DEFAULT_DATA);
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return;

    // Capture final output
    const output = await getTaskOutput(taskId, task.tmuxSessionName);
    task.output = output;

    // Gracefully exit and clean up tmux session
    const engine = taskState?.engine || task.engine || 'claude';
    const exitCmd = getExitCommand(engine);

    if (task.tmuxSessionName) {
      if (status === 'completed') {
        // Try graceful exit first
        try {
          await execAsync(`tmux send-keys -t ${task.tmuxSessionName} "${exitCmd}" Enter`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
        }
      } else if (status === 'cancelled') {
        // Send Ctrl+C to interrupt, then exit
        try {
          await execAsync(`tmux send-keys -t ${task.tmuxSessionName} C-c`);
          await new Promise(resolve => setTimeout(resolve, 500));
          await execAsync(`tmux send-keys -t ${task.tmuxSessionName} "${exitCmd}" Enter`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
        }
      }
      // Force kill if still alive
      await killTmuxSession(task.tmuxSessionName);
    }

    task.status = status;
    task.completedAt = new Date().toISOString();
    if (task.startedAt) {
      task.durationMs = new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime();
    }

    data.lastUpdated = new Date().toISOString();
    await writeJsonFile(DATA_PATH, data);
  });

  // Clean up temp files
  try {
    await fs.unlink(`${OUTPUT_DIR}/${taskId}.prompt`).catch(() => {});
    await fs.unlink(`${OUTPUT_DIR}/${taskId}.system`).catch(() => {});
  } catch (error) {
  }

  // Notify subscribers that this task hit a terminal state. The computer-use
  // dispatcher (lib/cu-task-listener) watches this event to fire callbackUrls
  // and update cross-references.
  try {
    const data = await readJsonFile<TerminalTasksData>(DATA_PATH, DEFAULT_DATA);
    const finalTask = data.tasks.find(t => t.id === taskId);
    if (finalTask) {
      eventBus.emitEvent('terminal:done', finalTask);
    }
  } catch (err) {
    console.error(`[TerminalTasks] failed to emit terminal:done for ${taskId}:`, err);
  }
}

// (validateEngineModel imported from @/lib/terminal-task-engine)

// ============================================================================
// HTTP Handlers
// ============================================================================

/**
 * GET /api/terminal-tasks - List tasks
 */
export const GET = tracked('/api/terminal-tasks', async (request: NextRequest) => {
  try {
    const authDenied = await requireAuthOrLocal(request, 'read');
    if (authDenied) return authDenied;

    await recoverOrphanedTasks();
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') as TerminalTaskStatus | null;
    const engine = searchParams.get('engine') as TerminalTaskEngine | null;

    const data = await readJsonFile<TerminalTasksData>(DATA_PATH, DEFAULT_DATA);
    let tasks = data.tasks;

    if (status) {
      tasks = tasks.filter(t => t.status === status);
    }
    if (engine) {
      tasks = tasks.filter(t => (t.engine || 'claude') === engine);
    }

    // Sort by newest first
    tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // For running tasks, capture live output. A task whose poller was lost
    // with a DevFlow restart and whose tmux session is gone can never finish;
    // settle it once instead of spawning a tmux capture for it on every poll.
    for (const task of tasks) {
      if (task.status !== 'running') continue;
      const orphaned = !activePollers.has(task.id)
        && !(task.tmuxSessionName && await tmuxSessionExists(task.tmuxSessionName));
      if (orphaned) {
        await finalizeTask(task.id, 'failed');
        task.status = 'failed';
        continue;
      }
      const liveOutput = await getTaskOutput(task.id, task.tmuxSessionName);
      if (liveOutput) {
        task.output = liveOutput;
      }
    }

    return NextResponse.json<TerminalTaskActionResponse>({
      success: true,
      tasks,
    });
  } catch (error) {
    console.error('[TerminalTasks] GET error:', error);
    return NextResponse.json<TerminalTaskActionResponse>(
      { success: false, error: 'Failed to load tasks' },
      { status: 500 }
    );
  }
});

/**
 * POST /api/terminal-tasks - Actions: submit, list, get, cancel, models
 */
export const POST = tracked('/api/terminal-tasks', async (request: NextRequest) => {
  try {
    const authDenied = await requireAuthOrLocal(request, 'write');
    if (authDenied) return authDenied;

    let body: TerminalTaskActionRequest;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json<TerminalTaskActionResponse>(
        { success: false, error: 'Invalid JSON body' },
        { status: 400 }
      );
    }
    const { action } = body;
    if (action !== 'models') await recoverOrphanedTasks();

    switch (action) {
      case 'models': {
        const models = await getModelRegistry();
        return NextResponse.json<TerminalTaskActionResponse>({
          success: true,
          models,
        });
      }

      case 'submit': {
        if (!body.prompt?.trim()) {
          return NextResponse.json<TerminalTaskActionResponse>(
            { success: false, error: 'prompt is required' },
            { status: 400 }
          );
        }

        const engine: TerminalTaskEngine = body.engine || 'claude';
        const model: TerminalTaskModel = body.model || 'sonnet';
        const ollamaModel = body.ollamaModel;

        // Validate engine + model combination
        const validation = validateEngineModel(engine, model, ollamaModel, CLAUDE_MODEL_MAP);
        if (!validation.valid) {
          return NextResponse.json<TerminalTaskActionResponse>(
            { success: false, error: validation.error },
            { status: 400 }
          );
        }

        const timeout = Math.min(Math.max(body.timeout || DEFAULT_TIMEOUT, 10), MAX_TIMEOUT);
        const taskId = randomUUID();
        const tmuxSessionName = `${TMUX_PREFIX}${taskId.slice(0, 8)}`;
        const now = new Date().toISOString();

        const task: TerminalTask = {
          id: taskId,
          status: 'pending',
          prompt: body.prompt.trim(),
          model,
          engine,
          ollamaModel,
          systemPrompt: body.systemPrompt?.trim(),
          tmuxSessionName,
          output: '',
          createdAt: now,
          timeout,
          createdBy: 'devflow-ui',
          workingDirectory: body.workingDirectory,
        };

        // Save task
        await withFileLock(DATA_PATH, async () => {
          const data = await readJsonFile<TerminalTasksData>(DATA_PATH, DEFAULT_DATA);
          data.tasks.unshift(task);

          // Trim history
          if (data.tasks.length > MAX_HISTORY) {
            const active = data.tasks.filter(t => t.status === 'running' || t.status === 'pending');
            const done = data.tasks.filter(t => t.status !== 'running' && t.status !== 'pending');
            data.tasks = [...active, ...done.slice(0, MAX_HISTORY - active.length)];
          }

          data.lastUpdated = now;
          await writeJsonFile(DATA_PATH, data);
        });

        // Spawn interactive session in tmux
        try {
          await ensureOutputDir();

          // Write prompt to file for shell-safe delivery via tmux buffer
          const promptFile = `${OUTPUT_DIR}/${taskId}.prompt`;
          await fs.writeFile(promptFile, body.prompt.trim());

          // Build system prompt file if provided
          let systemPromptFile: string | undefined;
          if (body.systemPrompt?.trim()) {
            systemPromptFile = `${OUTPUT_DIR}/${taskId}.system`;
            await fs.writeFile(systemPromptFile, body.systemPrompt.trim());
          }

          // Build engine-specific command
          const cliParts = buildEngineCommand(engine, model, ollamaModel, systemPromptFile, CLAUDE_MODEL_MAP);
          const fullCommand = cliParts.join(' ');
          // The folder must exist on THIS machine. A caller on another machine (the desktop's cron jobs) can name a path that only exists there;
          // `cd` would fail inside tmux, the session would die at once, and the task would fail with only "failed to start".
          if (body.workingDirectory) {
            const stat = await fs.stat(body.workingDirectory).catch(() => null);
            if (!stat?.isDirectory()) {
              throw new Error(`working folder ${body.workingDirectory} does not exist on ${os.hostname()}; use a folder on the machine that runs ${PRODUCT_NAME} (for example ${OUTPUT_DIR})`);
            }
          }
          if (engine === 'claude' && body.workingDirectory) await approveClaudeTrust(path.resolve(body.workingDirectory));
          const cdPrefix = body.workingDirectory ? `cd "${body.workingDirectory}" && ` : '';

          // `tmux -e KEY=VALUE` sets env on the new session — inherits through
          // claude into its bash tool calls. Used by the computer-use
          // dispatcher to pass CU_BRIDGE_URL / CU_SESSION_ID / CU_TASK_ID.
          const envFlags = buildTmuxEnvFlags(body.env);

          // DevFlow runs under PM2 with a minimal PATH that lacks the user's tool folders, where `claude` and `codex` are installed.
          // A session that auto-updates itself while starting restarts and loses the pasted prompt (seen on the first run after a new release).
          const pathPrefix = 'export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$PATH" DISABLE_AUTOUPDATER=1; ';
          const tmuxCmd = `tmux new-session -d -s ${tmuxSessionName}${envFlags} '${pathPrefix}${cdPrefix}${fullCommand.replace(/'/g, "'\\''")}'`;

          await execAsync(tmuxCmd);

          // Wait for engine to initialize (engine-specific timing)
          const timing = ENGINE_TIMING[engine];
          await new Promise(resolve => setTimeout(resolve, timing.startupWaitMs));
          const exists = await tmuxSessionExists(tmuxSessionName);

          if (!exists) {
            throw new Error(`${engine} tmux session failed to start`);
          }

          // Capture baseline output (before sending prompt)
          const baselineOutput = await getTmuxOutput(tmuxSessionName, SCROLLBACK_LINES);
          const baselineLength = baselineOutput.length;

          // Send prompt via tmux load-buffer + paste-buffer (reliable for any length/content)
          const bufferName = `tt${taskId.replace(/-/g, '').slice(0, 8)}`;
          await execAsync(`tmux load-buffer -b "${bufferName}" "${promptFile}"`);
          await execAsync(`tmux paste-buffer -t ${tmuxSessionName} -b "${bufferName}"`);
          await new Promise(resolve => setTimeout(resolve, 300));
          await execAsync(`tmux send-keys -t ${tmuxSessionName} Enter`);

          // Clean up the named buffer
          try {
            await execAsync(`tmux delete-buffer -b "${bufferName}" 2>/dev/null`);
          } catch {
            // Best-effort buffer cleanup — not critical
          }

          // Get PID
          let pid: number | undefined;
          try {
            const { stdout } = await execAsync(`tmux list-panes -t ${tmuxSessionName} -F "#{pane_pid}"`);
            pid = parseInt(stdout.trim(), 10) || undefined;
          } catch (error) {
          }

          // Update task to running
          await withFileLock(DATA_PATH, async () => {
            const data = await readJsonFile<TerminalTasksData>(DATA_PATH, DEFAULT_DATA);
            const t = data.tasks.find(x => x.id === taskId);
            if (t) {
              t.status = 'running';
              t.startedAt = new Date().toISOString();
              t.pid = pid;
            }
            data.lastUpdated = new Date().toISOString();
            await writeJsonFile(DATA_PATH, data);
          });

          task.status = 'running';
          task.startedAt = new Date().toISOString();
          task.pid = pid;

          // Start interactive completion detection with engine-specific timing
          startInteractiveTaskPoller(
            taskId, tmuxSessionName, timeout, baselineLength, engine,
            body.idleThresholdMs,
          );

          return NextResponse.json<TerminalTaskActionResponse>({
            success: true,
            task,
          });

        } catch (spawnError) {
          console.error(`[TerminalTasks] ${engine} spawn error:`, spawnError);

          // Update task to failed
          await withFileLock(DATA_PATH, async () => {
            const data = await readJsonFile<TerminalTasksData>(DATA_PATH, DEFAULT_DATA);
            const t = data.tasks.find(x => x.id === taskId);
            if (t) {
              t.status = 'failed';
              t.error = spawnError instanceof Error ? spawnError.message : 'Failed to spawn';
              t.completedAt = new Date().toISOString();
            }
            data.lastUpdated = new Date().toISOString();
            await writeJsonFile(DATA_PATH, data);
          });

          return NextResponse.json<TerminalTaskActionResponse>(
            { success: false, error: `Failed to spawn ${engine} session: ${spawnError instanceof Error ? spawnError.message : 'unknown error'}` },
            { status: 500 }
          );
        }
      }

      case 'list': {
        const data = await readJsonFile<TerminalTasksData>(DATA_PATH, DEFAULT_DATA);
        const tasks = data.tasks.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        // Refresh live output for running tasks
        for (const task of tasks) {
          if (task.status === 'running' && task.tmuxSessionName) {
            const liveOutput = await getTaskOutput(task.id, task.tmuxSessionName);
            if (liveOutput) {
              task.output = liveOutput;
            }
          }
        }

        return NextResponse.json<TerminalTaskActionResponse>({
          success: true,
          tasks,
        });
      }

      case 'get': {
        if (!body.taskId) {
          return NextResponse.json<TerminalTaskActionResponse>(
            { success: false, error: 'taskId is required' },
            { status: 400 }
          );
        }

        const data = await readJsonFile<TerminalTasksData>(DATA_PATH, DEFAULT_DATA);
        const task = data.tasks.find(t => t.id === body.taskId);
        if (!task) {
          return NextResponse.json<TerminalTaskActionResponse>(
            { success: false, error: 'Task not found' },
            { status: 404 }
          );
        }

        // Refresh live output for running tasks
        if (task.status === 'running') {
          const liveOutput = await getTaskOutput(task.id, task.tmuxSessionName);
          if (liveOutput) {
            task.output = liveOutput;
          }
        }

        return NextResponse.json<TerminalTaskActionResponse>({
          success: true,
          task,
        });
      }

      case 'cancel': {
        if (!body.taskId) {
          return NextResponse.json<TerminalTaskActionResponse>(
            { success: false, error: 'taskId is required' },
            { status: 400 }
          );
        }

        const data = await readJsonFile<TerminalTasksData>(DATA_PATH, DEFAULT_DATA);
        const task = data.tasks.find(t => t.id === body.taskId);
        if (!task) {
          return NextResponse.json<TerminalTaskActionResponse>(
            { success: false, error: 'Task not found' },
            { status: 404 }
          );
        }

        if (task.status !== 'running' && task.status !== 'pending') {
          return NextResponse.json<TerminalTaskActionResponse>(
            { success: false, error: `Cannot cancel task with status: ${task.status}` },
            { status: 400 }
          );
        }

        await finalizeTask(body.taskId, 'cancelled');

        // Re-read to get updated task
        const updated = await readJsonFile<TerminalTasksData>(DATA_PATH, DEFAULT_DATA);
        const updatedTask = updated.tasks.find(t => t.id === body.taskId);

        return NextResponse.json<TerminalTaskActionResponse>({
          success: true,
          task: updatedTask,
        });
      }

      case 'launch': {
        const provider = (body.provider as string | undefined)?.toLowerCase();
        if (!provider) {
          return NextResponse.json<TerminalTaskActionResponse>(
            { success: false, error: 'provider is required (e.g. "anthropic", "google")' },
            { status: 400 }
          );
        }

        const config = SUBSCRIPTION_PROVIDERS[provider];
        if (!config) {
          return NextResponse.json<TerminalTaskActionResponse>(
            {
              success: false,
              error: `Unknown provider: ${provider}. Supported: ${Object.keys(SUBSCRIPTION_PROVIDERS).join(', ')}`,
            },
            { status: 400 }
          );
        }

        // Kill any existing auth sessions for this provider (one at a time)
        try {
          const { stdout: existingSessions } = await execAsync(
            `tmux list-sessions -F "#{session_name}" 2>/dev/null || true`
          );
          const prefix = `${AUTH_TMUX_PREFIX}${provider}-`;
          for (const name of existingSessions.split('\n').filter(s => s.startsWith(prefix))) {
            await killTmuxSession(name);
          }
        } catch { /* no existing sessions */ }

        const sessionId = randomUUID().slice(0, 8);
        const sessionName = `${AUTH_TMUX_PREFIX}${provider}-${sessionId}`;

        // Spawn the CLI in a new tmux session
        try {
          const tmuxCmd = `tmux new-session -d -s ${sessionName} '${config.cliCommand}'`;
          await execAsync(tmuxCmd);

          // Wait for CLI to initialize
          await new Promise(resolve => setTimeout(resolve, config.startupWaitMs));

          const exists = await tmuxSessionExists(sessionName);
          if (!exists) {
            throw new Error(`${config.displayName} CLI failed to start`);
          }
        } catch (spawnErr) {
          console.error(`[TerminalTasks] Auth launch failed for ${provider}:`, spawnErr);
          return NextResponse.json<TerminalTaskActionResponse>(
            {
              success: false,
              error: `Failed to launch ${config.displayName} CLI: ${spawnErr instanceof Error ? spawnErr.message : 'Unknown error'}`,
            },
            { status: 500 }
          );
        }

        // Open Windows Terminal tab attached to the session (best-effort — WSL env may not have wt.exe)
        let wtOpened = false;
        try {
          await execAsync(`wt.exe -w 0 new-tab --title "${config.displayName} Auth" -- wsl.exe -d Ubuntu tmux attach -t ${sessionName}`);
          wtOpened = true;
        } catch {
          // wt.exe not available or not in WSL PATH — caller can use attachCommand instead
        }

        const launchSession: TerminalLaunchSession = {
          sessionName,
          provider,
          displayName: config.displayName,
          instructions: config.instructions,
          attachCommand: `tmux attach -t ${sessionName}`,
          createdAt: new Date().toISOString(),
        };

        return NextResponse.json<TerminalTaskActionResponse>({
          success: true,
          launchSession,
        });
      }

      default:
        return NextResponse.json<TerminalTaskActionResponse>(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('[TerminalTasks] POST error:', error);
    return NextResponse.json<TerminalTaskActionResponse>(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
});
