/**
 * terminal-task-engine.ts — Pure engine dispatch helpers for terminal-tasks.
 *
 * Extracted from app/api/terminal-tasks/route.ts so these functions can be
 * unit-tested without importing the full Next.js route module.
 *
 * Sprint 47 / T1.1: Added grok engine (xAI API via terminal-task-grok.py).
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { TerminalTaskEngine, TerminalTaskModel } from '@/lib/types';
import { appPath } from '@/lib/app-paths';

// ─── Engine-specific timing constants ─────────────────────────────────────────

export const ENGINE_TIMING: Record<
  TerminalTaskEngine,
  { startupWaitMs: number; idleThresholdMs: number; minResponseTimeMs: number }
> = {
  claude: {
    startupWaitMs: 4000,      // Claude CLI takes ~4s to initialize TUI
    idleThresholdMs: 8000,    // 8s idle = response complete
    minResponseTimeMs: 5000,  // Min time before checking idle
  },
  gemini: {
    startupWaitMs: 3000,      // Gemini CLI starts faster
    idleThresholdMs: 6000,    // 6s idle = response complete
    minResponseTimeMs: 4000,
  },
  ollama: {
    startupWaitMs: 2000,      // Ollama is local, starts fast
    idleThresholdMs: 5000,    // 5s idle = response complete
    minResponseTimeMs: 3000,
  },
  grok: {
    startupWaitMs: 1000,      // Python script starts fast; no CLI TUI init
    idleThresholdMs: 4000,    // 4s idle = API response complete
    minResponseTimeMs: 2000,  // Min time before checking idle
  },
};

// ─── Build the CLI command for a given engine ─────────────────────────────────

// Claude model mapping: tier name -> claude CLI model flag value.
export type ClaudeModelMap = Record<TerminalTaskModel, string>;

/**
 * Build the array of command-line parts used to spawn a new engine session.
 * The parts are joined with spaces and run inside a tmux session.
 */
export function buildEngineCommand(
  engine: TerminalTaskEngine,
  model: TerminalTaskModel,
  ollamaModel: string | undefined,
  systemPromptFile: string | undefined,
  claudeModelMap: ClaudeModelMap,
): string[] {
  switch (engine) {
    case 'claude': {
      const parts = [
        'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT;',
        'claude',
        '--dangerously-skip-permissions',
        '--model', claudeModelMap[model],
        // The output is read with `tmux capture-pane`. The fullscreen renderer (settings "tui": "fullscreen") draws on the alternate
        // screen, which has no scrollback: a long answer then comes back as only its last screenful. The default renderer keeps all of it.
        '--settings', `'{"tui":"default"}'`,
      ];
      if (systemPromptFile) {
        parts.push('--append-system-prompt', `"$(cat ${systemPromptFile})"`);
      }
      return parts;
    }

    case 'gemini': {
      // Gemini CLI: interactive mode with --yolo for auto-accepting actions.
      // System prompt passed via initial message, not CLI flag.
      return ['npx', 'gemini', '--yolo'];
    }

    case 'ollama': {
      // Default model: gemma4:26b — approved 2026-04-13 (Sprint 42 P5-T5).
      const modelName = ollamaModel || 'gemma4:26b';
      const parts = ['ollama', 'run', modelName];
      if (systemPromptFile) {
        parts.push('--system', `"$(cat ${systemPromptFile})"`);
      }
      return parts;
    }

    case 'grok': {
      // Grok: calls xAI API directly via a Python script.
      // Reads prompt from stdin (sent via tmux paste-buffer), exits after response.
      // XAI_API_KEY is sourced from ~/.secrets before the script runs.
      const grokModel = ollamaModel || 'grok-4.7';
      const scriptPath = appPath('scripts', 'terminal-task-grok.py');
      const parts = [
        'source', '~/.secrets', '&&',
        'python3', scriptPath,
        '--model', grokModel,
      ];
      if (systemPromptFile) {
        parts.push('--system-prompt-file', systemPromptFile);
      }
      return parts;
    }

    default:
      throw new Error(`Unknown engine: ${engine}`);
  }
}

// ─── Get graceful exit command for an engine ──────────────────────────────────

/**
 * Returns the exit command to send to the engine when finalizing a task.
 */
export function getExitCommand(engine: TerminalTaskEngine): string {
  switch (engine) {
    case 'claude':
      return '/exit';
    case 'gemini':
      return '/quit';
    case 'ollama':
      return '/bye';
    case 'grok':
      // The grok Python script exits automatically after the API responds.
      // 'exit' is sent as a fallback (no-op when session is already gone).
      return 'exit';
    default:
      return '/exit';
  }
}

// ─── Validate engine + model combination ─────────────────────────────────────

/**
 * Validate that the given engine / model combination is acceptable.
 */
export function validateEngineModel(
  engine: TerminalTaskEngine,
  model: TerminalTaskModel | undefined,
  ollamaModel: string | undefined,
  claudeModelMap: ClaudeModelMap,
): { valid: boolean; error?: string } {
  switch (engine) {
    case 'claude':
      if (model && !claudeModelMap[model]) {
        return { valid: false, error: `Invalid Claude model: ${model}. Use haiku, sonnet, or opus` };
      }
      return { valid: true };

    case 'gemini':
      // Gemini uses its default model, no tier selection needed.
      return { valid: true };

    case 'ollama':
      if (!ollamaModel) {
        return { valid: false, error: 'ollamaModel is required when engine is "ollama" (e.g. "gemma4:26b")' };
      }
      return { valid: true };

    case 'grok':
      // ollamaModel is reused as the free-form grok model name (optional, defaults to grok-4.7).
      return { valid: true };

    default:
      return { valid: false, error: `Unknown engine: ${engine}. Use claude, gemini, ollama, or grok` };
  }
}

// ─── Folder trust ─────────────────────────────────────────────────────────────

/**
 * Mark a folder as trusted in Claude Code's user config, so an unattended `claude` session started there does not stop at
 * "Do you trust this folder?". Without this the pasted task prompt lands on that dialog, its Enter picks the default "No, exit",
 * and the task "completes" in two seconds with no output. Folders under an already trusted parent were fine, which hid this on the
 * machine where the weekly changelog job used to run; on a machine whose config trusts only its agent folders it fails every time.
 * Writes only when something changes (atomic temp + rename). Returns true when it wrote.
 */
export async function approveClaudeTrust(dir: string, configPath: string = path.join(os.homedir(), '.claude.json')): Promise<boolean> {
  let config: { projects?: Record<string, Record<string, unknown>> };
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') config = {};
    else throw error;                                  // unreadable or corrupt: never overwrite the user's config
  }
  const projects = (config.projects ??= {});
  const entry = (projects[dir] ??= {});
  if (entry.hasTrustDialogAccepted === true && entry.hasClaudeMdExternalIncludesApproved === true) return false;
  Object.assign(entry, {
    hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: true,
    hasClaudeMdExternalIncludesWarningShown: true,
  });
  const tmp = `${configPath}.devflow-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.rename(tmp, configPath);
  return true;
}
