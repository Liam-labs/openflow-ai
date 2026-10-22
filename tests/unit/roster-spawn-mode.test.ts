/**
 * Tests for roster-spawn-mode helpers.
 * Written TDD — RED first (lib/roster-spawn-mode.ts does not exist yet), then GREEN.
 * Covers: UNC path detection, default PS working directory, spawn mode resolution.
 */

import { describe, it, expect } from 'vitest';
import {
  isUncPath,
  getDefaultPsWorkingDirectory,
  resolveSpawnMode,
  supportsPowerShellSpawn,
  isWindowsPerMessageAgent,
} from '@/lib/roster-spawn-mode';

// ─── isUncPath ────────────────────────────────────────────────────────────────

describe('isUncPath', () => {
  it('detects double-backslash UNC path', () => {
    expect(isUncPath('\\\\wsl.localhost\\Ubuntu\\home\\user')).toBe(true);
  });

  it('detects UNC path starting with //server/share', () => {
    // Some Windows tools use forward-slash UNC equivalents
    expect(isUncPath('//server/share')).toBe(true);
  });

  it('returns false for a normal Windows drive path', () => {
    expect(isUncPath('C:\\Users\\winuser\\Team\\Builder')).toBe(false);
  });

  it('returns false for a WSL/Linux absolute path', () => {
    expect(isUncPath('/home/user/SG-1/Team/Builder')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isUncPath('')).toBe(false);
  });

  it('returns false for a relative path', () => {
    expect(isUncPath('Team\\Builder')).toBe(false);
  });
});

// ─── getDefaultPsWorkingDirectory ─────────────────────────────────────────────

describe('getDefaultPsWorkingDirectory', () => {
  it('returns the expected default pattern for an agent name', () => {
    expect(getDefaultPsWorkingDirectory('Builder')).toBe('C:\\Users\\winuser\\Team\\Builder');
  });

  it('uses the provided agent name as the final path segment', () => {
    const result = getDefaultPsWorkingDirectory('Architect');
    expect(result.endsWith('\\Architect')).toBe(true);
  });

  it('base path is always C:\\Users\\winuser\\Team', () => {
    const result = getDefaultPsWorkingDirectory('TestAgent');
    expect(result.startsWith('C:\\Users\\winuser\\Team\\')).toBe(true);
  });
});

// ─── resolveSpawnMode ─────────────────────────────────────────────────────────

describe('resolveSpawnMode', () => {
  it('defaults to wsl when undefined', () => {
    expect(resolveSpawnMode(undefined)).toBe('wsl');
  });

  it('returns wsl when passed wsl', () => {
    expect(resolveSpawnMode('wsl')).toBe('wsl');
  });

  it('returns powershell when passed powershell', () => {
    expect(resolveSpawnMode('powershell')).toBe('powershell');
  });
});

describe('runtime-aware PowerShell classification', () => {
  it('allows PowerShell per-message mode for Claude and legacy unset agentType', () => {
    expect(supportsPowerShellSpawn('claude')).toBe(true);
    expect(supportsPowerShellSpawn(undefined)).toBe(true);
    expect(isWindowsPerMessageAgent({ spawnMode: 'powershell', agentType: 'claude' })).toBe(true);
  });

  it.each(['codex', 'gemini', 'grok', 'antigravity'])(
    'treats stale PowerShell mode on %s as a WSL/tmux runtime',
    (agentType) => {
      expect(supportsPowerShellSpawn(agentType)).toBe(false);
      expect(isWindowsPerMessageAgent({ spawnMode: 'powershell', agentType })).toBe(false);
    },
  );
});
