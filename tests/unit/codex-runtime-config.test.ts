import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findActiveCodexProfileName,
  parseCodexRuntimeState,
  parseCodexModelMenu,
  restoreManagedCodexProfileSettings,
  restoreSharedCodexProfileAfterAction,
} from '@/lib/codex-runtime-config';

describe('Codex live runtime state parsing', () => {
  it('reads effort and Fast mode from the compact footer', () => {
    const state = parseCodexRuntimeState(`
• Model changed to gpt-5.6-sol medium

› Ask Codex to do anything

  gpt-5.6-sol max fast · /home/user/project
`);
    expect(state).toEqual({ model: 'gpt-5.6-sol', effort: 'max', fastMode: true, promptReady: true });
  });

  it('recognises Fast off when the footer omits the fast label', () => {
    const state = parseCodexRuntimeState(`
• Service tier set to priority

› Ask Codex to do anything

  gpt-5.6-sol ultra · /home/user/project
`);
    expect(state).toEqual({ model: 'gpt-5.6-sol', effort: 'ultra', fastMode: false, promptReady: true });
  });

  it('does not call a popup or active pane prompt-ready', () => {
    const state = parseCodexRuntimeState(`
› Ask Codex to do anything
Select Reasoning Level for gpt-5.6-sol
1. Low
2. Medium
Press enter to select
`);
    expect(state.promptReady).toBe(false);
  });
});

describe('Codex model picker parsing', () => {
  it('maps the live numbered menu without depending on registry order', () => {
    const menu = parseCodexModelMenu(`
  Select Model and Effort

  1. gpt-6-astra (default)  Our most capable model.
› 2. gpt-5.6-sol (current)  Reliable agentic workhorse.
  3. gpt-5.6-terra          Balanced coding model.
  4. gpt-5.6-luna           Fast and affordable coding model.
`);
    expect(Object.fromEntries(menu)).toEqual({
      'gpt-6-astra': '1',
      'gpt-5.6-sol': '2',
      'gpt-5.6-terra': '3',
      'gpt-5.6-luna': '4',
    });
  });
});

describe('shared AgentChat profile restoration', () => {
  it('restores only TUI-managed root settings and preserves unrelated writes', () => {
    const before = `model = "gpt-5.6-sol"
model_reasoning_effort = "medium"
service_tier = "fast"

[features]
hooks = true
`;
    const after = `model = "gpt-5.6-sol"
model_reasoning_effort = "ultra"
service_tier = "default"
new_root_setting = true

[features]
hooks = true
new_feature = true
`;

    const restored = restoreManagedCodexProfileSettings(before, after);
    expect(restored).toContain('model_reasoning_effort = "medium"');
    expect(restored).toContain('service_tier = "fast"');
    expect(restored).toContain('new_root_setting = true');
    expect(restored).toContain('new_feature = true');
  });

  it('removes a managed key that was absent before the command', () => {
    const restored = restoreManagedCodexProfileSettings(
      'model = "gpt-5.6-sol"\n',
      'model = "gpt-5.6-sol"\nservice_tier = "fast"\n',
    );
    expect(restored).not.toContain('service_tier');
  });

  it('finds the profile on a Codex child when the roster PID is the wrapper', async () => {
    const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-proc-tree-'));
    try {
      await fs.mkdir(path.join(procRoot, '100', 'task', '100'), { recursive: true });
      await fs.mkdir(path.join(procRoot, '101', 'task', '101'), { recursive: true });
      await fs.writeFile(path.join(procRoot, '100', 'cmdline'), 'python3\0collab-codex.py\0');
      await fs.writeFile(path.join(procRoot, '100', 'task', '100', 'children'), '101\n');
      await fs.writeFile(path.join(procRoot, '101', 'cmdline'), 'node\0codex\0--profile\0agentchat\0');
      await fs.writeFile(path.join(procRoot, '101', 'task', '101', 'children'), '');

      await expect(findActiveCodexProfileName(100, procRoot)).resolves.toBe('agentchat');
    } finally {
      await fs.rm(procRoot, { recursive: true, force: true });
    }
  });

  it('reverses a delayed Codex persistence write within the restoration window', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-profile-restore-'));
    const profilePath = path.join(directory, 'agentchat.config.toml');
    const before = 'model = "gpt-5.6-sol"\nservice_tier = "default"\n\n[features]\nhooks = true\n';
    try {
      await fs.writeFile(profilePath, before);

      const delayedWrite = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          void fs.writeFile(
            profilePath,
            'model = "gpt-5.6-terra"\nservice_tier = "fast"\n\n[features]\nhooks = true\nnew_feature = true\n',
          ).then(() => resolve(), reject);
        }, 120);
      });

      await restoreSharedCodexProfileAfterAction(profilePath, before, 350, 25);
      await delayedWrite;
      const restored = await fs.readFile(profilePath, 'utf8');
      expect(restored).toContain('model = "gpt-5.6-sol"');
      expect(restored).toContain('service_tier = "default"');
      expect(restored).toContain('new_feature = true');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
