import { describe, expect, it } from 'vitest';
import type { AgentRosterEntry } from '@/lib/types';
import { resolveRosterIdentity } from '@/lib/roster-identity';

const agent = { id: 'same-roster-id', name: 'Sheppard', personality: 'Sheppard' } as AgentRosterEntry;
describe('roster identity validation', () => {
  it('selects Jack without replacing the roster entry', () => {
    expect(resolveRosterIdentity(agent, { name: 'Jack', personality: 'Jack' }, [agent])).toEqual({ name: 'Jack', personality: 'Jack', nameChanged: true, changed: true });
  });
  it('keeps the unchanged identity', () => {
    expect(resolveRosterIdentity(agent, {}, [agent]).changed).toBe(false);
  });
  it('allows a distinct name with an existing personality', () => {
    expect(resolveRosterIdentity(agent, { name: 'Jack-2', personality: 'Jack' }, [agent]).name).toBe('Jack-2');
  });
  it.each(['', '  ', '../Jack', 'Jack;echo', 'a'.repeat(65)])('rejects unsafe/empty names: %s', name => {
    expect(() => resolveRosterIdentity(agent, { name }, [agent])).toThrow('valid agent name');
  });
  it('rejects personality path traversal', () => {
    expect(() => resolveRosterIdentity(agent, { personality: '../Jack' }, [agent])).toThrow('available personality');
  });
  it.each(['jack', 'Jack'])('rejects duplicate channel names case-insensitively: %s', name => {
    const other = { id: 'other', name: 'Jack' } as AgentRosterEntry;
    expect(() => resolveRosterIdentity(agent, { name }, [agent, other])).toThrow('already has');
  });
  it('rejects distinct display names that resolve to the same workspace', () => {
    expect(() => resolveRosterIdentity(agent, { name: 'Jack One' }, [agent, { id: 'other', name: 'Jack-One' } as AgentRosterEntry])).toThrow('already has');
  });
});
