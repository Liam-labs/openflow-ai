// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRosterEntry } from '@/lib/types';
import { RosterConfigModal } from '@/components/modals/RosterConfigModal';

let container: HTMLDivElement;
let root: Root;
let actions: Array<Record<string, unknown>>;
let restartFails: boolean;
const saved = vi.fn();
const agent: AgentRosterEntry = {
  id: 'stable-agent', channelId: 'channel', participantId: 'stable-participant', name: 'Sheppard', personality: 'Sheppard',
  workingDirectory: '/tmp/project', color: '#888', status: 'running', autoResume: true,
  useCollabWrapper: true, dangerouslySkipPermissions: true, model: 'sonnet', agentType: 'claude', createdAt: '', crashCount: 0,
};
beforeEach(() => {
  actions = []; restartFails = false; saved.mockClear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    actions.push(body);
    const result = body.action === 'personalities_list' ? { success: true, personalities: ['Jack', 'Sheppard'] }
      : body.action === 'roster_directives_read' ? { success: true, personality: 'Old Sheppard prose', directives: '', expertise: '' }
      : body.action === 'roster_identity_switch' ? { success: true, identityRestartRequired: agent.status === 'running' }
      : body.action === 'roster_spawn' && restartFails ? { success: false, error: 'Session limit reached' }
      : { success: true, systems: [], servers: [], models: [], interfaceTypes: [] };
    return { ok: result.success, json: async () => result };
  }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); agent.status = 'running';
});
async function chooseJackAndSave() {
  await act(async () => root.render(React.createElement(RosterConfigModal, { agent, channelId: 'channel', roles: [], modelRegistry: [], onClose: () => {}, onSaved: saved })));
  const selector = container.querySelector<HTMLSelectElement>('#roster-personality')!;
  expect(Array.from(selector.options).some(option => option.value === 'Jack')).toBe(true);
  await act(async () => { selector.value = 'Jack'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector<HTMLInputElement>('#roster-agent-name')!.value).toBe('Jack');
  expect(container.textContent).toContain('The Jack preset replaces this personality on Save');
  const save = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Save Changes')!;
  await act(async () => save.click());
}
describe('config identity selector', () => {
  it('selects Jack, saves against the same roster ID, and starts the prepared replacement', async () => {
    await chooseJackAndSave();
    expect(actions.find(action => action.action === 'roster_identity_switch')).toMatchObject({ agentId: 'stable-agent', name: 'Jack', personality: 'Jack', model: 'sonnet', agentType: 'claude' });
    expect(actions.find(action => action.action === 'roster_spawn')).toMatchObject({ agentId: 'stable-agent' });
    expect(actions.some(action => action.action === 'roster_directives_write' && action.file === 'personality')).toBe(false);
    expect(saved).toHaveBeenCalledOnce();
  });
  it('keeps a stopped agent stopped', async () => {
    agent.status = 'stopped'; await chooseJackAndSave();
    expect(actions.some(action => action.action === 'roster_spawn')).toBe(false); expect(saved).toHaveBeenCalledOnce();
  });
  it('shows a failed restart and never claims completion', async () => {
    restartFails = true; await chooseJackAndSave();
    expect(container.textContent).toContain('agent is stopped: Session limit reached'); expect(saved).not.toHaveBeenCalled();
  });
});
