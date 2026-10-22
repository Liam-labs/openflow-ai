/**
 * Write a slow monitor pass's roster changes without clobbering other writers.
 *
 * The crash and orphan monitors read the whole channel file once, spend seconds
 * on async checks (tmux, crash reports), then used to write that whole snapshot
 * back. Anything another handler saved in between was reverted, for example a
 * Codex seat's join arriving while the pass was still checking other agents.
 *
 * Instead the pass keeps a copy of what it read, and inside `mutateChannels`
 * (lib/collab-channel-store.ts, the only write path) its changes are replayed
 * onto the current file: only the roster fields it changed, only if nobody else
 * changed those fields meanwhile. An agent whose fields moved is left for the next
 * pass to re-evaluate. Inline messages are not replayed: the store never persists them.
 */

import { mutateChannels, saveChannels } from './collab-channel-store';
import type { CollabChannelsData } from './types';

export interface MonitorMergeReport {
  /** Roster entries whose changes were written. */
  applied: number;
  /** Roster entries left alone because another writer changed the same fields. */
  skipped: Array<{ channelId: string; agentId: string; fields: string[] }>;
}

type Fields = Record<string, unknown>;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Replay the roster changes `changed` made relative to `baseline` onto `fresh`, in place. */
export function applyMonitorChanges(
  baseline: CollabChannelsData,
  changed: CollabChannelsData,
  fresh: CollabChannelsData,
): MonitorMergeReport {
  const report: MonitorMergeReport = { applied: 0, skipped: [] };

  for (const channel of changed.channels) {
    const before = baseline.channels.find(candidate => candidate.id === channel.id);
    const current = fresh.channels.find(candidate => candidate.id === channel.id);
    if (!before || !current) continue;
    let touched = false;

    for (const agent of channel.roster?.agents ?? []) {
      const was = before.roster?.agents.find(candidate => candidate.id === agent.id) as unknown as Fields | undefined;
      const now = current.roster?.agents.find(candidate => candidate.id === agent.id) as unknown as Fields | undefined;
      if (!was || !now) continue;
      const mine = agent as unknown as Fields;

      const fields = [...new Set([...Object.keys(mine), ...Object.keys(was)])];
      const delta = fields.filter(field => !same(mine[field], was[field]));
      if (delta.length === 0) continue;

      const contested = delta.filter(field => !same(now[field], was[field]));
      if (contested.length > 0) {
        report.skipped.push({ channelId: channel.id, agentId: agent.id, fields: contested });
        continue;
      }
      for (const field of delta) {
        if (mine[field] === undefined) delete now[field];
        else now[field] = mine[field];
      }
      report.applied++;
      touched = true;
    }

    if (touched && current.roster) {
      current.roster.lastUpdated = channel.roster?.lastUpdated ?? new Date().toISOString();
    }
  }
  return report;
}

/**
 * Persist a monitor pass. `baseline` is a copy of the data taken before the pass
 * mutated it; `changed` is the mutated snapshot. Nothing is written when there is
 * nothing to apply. `caller` names the pass in the seat log.
 */
export async function commitMonitorChanges(
  caller: string,
  baseline: CollabChannelsData,
  changed: CollabChannelsData,
): Promise<MonitorMergeReport> {
  return mutateChannels(caller, async fresh => {
    const report = applyMonitorChanges(baseline, changed, fresh);
    if (report.applied > 0) await saveChannels(fresh);
    return report;
  });
}
