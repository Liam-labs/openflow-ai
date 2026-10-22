/**
 * POST /api/collab/recall-interrupt
 *
 * Up-arrow message recall (the owner directive, 12 Jun 2026; ESC per the owner 28 Sep
 * 2026): when the user recalls their last sent message for editing, stop the
 * @mentioned agents from processing it.
 *
 * One ESC interrupts a working Claude Code / Codex turn. Interrupting puts the
 * interrupted prompt back into the agent's input box (verified on Claude Code
 * 2.1.280), where the wrapper's next injected message would be appended to it,
 * so after ESC we clear any restored text with C-u. Never a second ESC: two
 * ESCs on an empty input open Claude Code's rewind menu and jam injection.
 *
 * Gates per agent:
 *  - No tmux session (powershell/persistent agents like Edge) → skipped.
 *  - Recalled message younger than RECENT_MS → interrupt unconditionally
 *    (the agent is processing it, or it's queued in their input box — C-c
 *    clears both). Respawned agents read activityStatus=None even while
 *    busy, so recency is the primary gate, not activity.
 *  - Older message → require a fresh busy signal (working/typing < 15s)
 *    before C-c; a single C-c on a truly idle TUI only shows the exit hint
 *    but there's no reason to poke idle agents about stale messages.
 *
 * Body: { channelId, participantIds: string[], messageTimestamp?: string }
 * Returns: { success, results: [{ name, status: 'interrupted'|'skipped', reason? }] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readData } from '../_collab-shared';

import { inputHasText } from '@/lib/tui-input';

const execFileAsync = promisify(execFile);
import { tmuxRun } from '@/lib/host-executor';
import { requireAuthOrLocal } from '@/lib/api-auth';

const CLEAR_DELAY_MS = 1_500;


async function interruptAgent(session: string): Promise<void> {
  await tmuxRun(['send-keys', '-t', session, 'Escape']);
  await new Promise(r => setTimeout(r, CLEAR_DELAY_MS));
  const { stdout } = await tmuxRun(['capture-pane', '-p', '-t', session]);
  if (inputHasText(stdout)) await tmuxRun(['send-keys', '-t', session, 'C-u']);
}

const RECENT_MS = 180_000;
const BUSY_FRESH_MS = 15_000;

export async function POST(req: NextRequest) {
  const denied = await requireAuthOrLocal(req, 'write');
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => null);
    const channelId = typeof body?.channelId === 'string' ? body.channelId : '';
    const participantIds: string[] = Array.isArray(body?.participantIds)
      ? body.participantIds.filter((p: unknown): p is string => typeof p === 'string')
      : [];
    if (!channelId || participantIds.length === 0) {
      return NextResponse.json(
        { success: false, error: 'channelId and participantIds are required' },
        { status: 400 },
      );
    }

    const data = await readData();
    const channel = data.channels.find(c => c.id === channelId);
    if (!channel) {
      return NextResponse.json({ success: false, error: 'Channel not found' }, { status: 404 });
    }

    const msgAge = body?.messageTimestamp ? Date.now() - Date.parse(body.messageTimestamp) : Infinity;
    const isRecent = Number.isFinite(msgAge) && msgAge >= 0 && msgAge < RECENT_MS;

    const results: Array<{ name: string; status: 'interrupted' | 'skipped'; reason?: string }> = [];

    for (const pid of new Set(participantIds)) {
      const agent = channel.roster?.agents?.find(a => a.participantId === pid);
      const participant = channel.participants.find(p => p.id === pid);
      const name = agent?.name || participant?.name || pid.slice(0, 8);

      if (participant?.type === 'user') continue; // never interrupt the human

      if (!agent?.tmuxSessionName) {
        results.push({ name, status: 'skipped', reason: 'no tmux session (persistent/remote agent)' });
        continue;
      }

      let busy = false;
      if (participant?.activityUpdatedAt) {
        const fresh = Date.now() - Date.parse(participant.activityUpdatedAt) < BUSY_FRESH_MS;
        busy = fresh && (participant.activityStatus === 'working' || participant.activityStatus === 'typing');
      }

      if (!isRecent && !busy) {
        results.push({ name, status: 'skipped', reason: 'message not recent and agent not busy' });
        continue;
      }

      try {
        await interruptAgent(agent.tmuxSessionName);
        results.push({ name, status: 'interrupted' });
      } catch (e) {
        results.push({
          name,
          status: 'skipped',
          reason: `tmux send failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
