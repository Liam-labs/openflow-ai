import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_CHANNEL_TABS,
  filterParentsByTab,
  getChannelTabId,
  prepareNewChannelTab,
  resolveChannelTabs,
  unreadByTab,
} from '@/lib/collab-sidebar-logic';

const ch = (id: string, category?: string) => ({
  id,
  name: id,
  createdAt: '2026-09-23T00:00:00Z',
  ...(category ? { settings: { category } } : {}),
});

describe('channel tabs', () => {
  const tabs = resolveChannelTabs([{ id: 'games', name: 'Games' }]);

  it('always offers Work/Life/Fun first, then user tabs, without duplicates', () => {
    expect(resolveChannelTabs(undefined)).toEqual(BUILT_IN_CHANNEL_TABS);
    expect(resolveChannelTabs([{ id: 'games', name: 'Games' }, { id: 'work', name: 'Dup' }]).map(t => t.id))
      .toEqual(['work', 'life', 'fun', 'games']);
  });

  it('puts unassigned and unknown-tab channels under Work', () => {
    expect(getChannelTabId(ch('a'), tabs)).toBe('work');
    expect(getChannelTabId(ch('b', 'deleted-tab'), tabs)).toBe('work');
    expect(getChannelTabId(ch('c', 'games'), tabs)).toBe('games');
  });

  it('filters parents by tab', () => {
    const parents = [ch('w1'), ch('l1', 'life'), ch('g1', 'games'), ch('w2', 'work')];
    expect(filterParentsByTab(parents, 'work', tabs).map(p => p.id)).toEqual(['w1', 'w2']);
    expect(filterParentsByTab(parents, 'games', tabs).map(p => p.id)).toEqual(['g1']);
    expect(filterParentsByTab(parents, 'fun', tabs)).toEqual([]);
  });

  it('totals unread per tab including sub-channels', () => {
    const parents = [ch('w1'), ch('g1', 'games')];
    const subs = { g1: [{ ...ch('g1-sub'), parentChannelId: 'g1' }] };
    expect(unreadByTab(parents, subs, { w1: 2, g1: 1, 'g1-sub': 4 }, tabs))
      .toEqual({ work: 2, life: 0, fun: 0, games: 5 });
  });

  it('validates new tab names and derives unique ids', () => {
    expect(prepareNewChannelTab('  Side   Projects ', tabs)).toEqual({ tab: { id: 'side-projects', name: 'Side Projects' } });
    expect(prepareNewChannelTab('games', tabs)).toEqual({ error: 'A "games" tab already exists' });
    expect(prepareNewChannelTab('   ', tabs)).toHaveProperty('error');
    expect(prepareNewChannelTab('x'.repeat(25), tabs)).toHaveProperty('error');
    expect(prepareNewChannelTab('!!!', tabs)).toEqual({ tab: { id: 'tab', name: '!!!' } });
    const withGamesId = resolveChannelTabs([{ id: 'games', name: 'Old name' }]);
    expect(prepareNewChannelTab('Games!', withGamesId)).toEqual({ tab: { id: 'games-2', name: 'Games!' } });
  });
});
