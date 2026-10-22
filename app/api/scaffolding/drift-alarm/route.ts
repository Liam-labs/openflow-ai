/**
 * POST /api/scaffolding/drift-alarm
 *
 * The endpoint the daily drift-alarm cron hits. Composes the fleet health
 * view, filters out snoozed agents, and posts a single structured drift
 * report to the configured alert channel.
 *
 * Behaviour:
 *   1. Read the active fleet-wide snooze first — if present, return
 *      `{posted: false, reason: 'fleet-snoozed', until: ...}` without any
 *      composition work. Cheapest possible no-op.
 *   2. Otherwise compose fleet health (composeFleetHealth — same data
 *      /api/scaffolding/health returns) and filter out any agent currently
 *      under a per-agent snooze.
 *   3. If the surviving set is empty → return `{posted: false, reason:
 *      'all-snoozed-or-healthy'}`. No channel noise on quiet days.
 *   4. Otherwise post ONE message to the target channel summarising the
 *      drift agents (count + top N), and auto-snooze each alerted agent
 *      for the default 4h cooldown so the next cron tick doesn't repeat.
 *
 * Auth: requireAuthOrLocal('write') — cron calls from localhost pass.
 *
 * Channel target: env `SCAFFOLDING_ALERT_CHANNEL_ID`. Defaults to the
 * SG-1 Commander channel (3b994a27-0a17-46a9-99eb-03e38b6832e6). The
 * alert is posted as a synthetic system participant (no roster ID needed,
 * same pattern as sprints.reminder).
 *
 * Idempotency: re-running within a few seconds is safe — the per-agent
 * 4h cooldown applied on first fire silences subsequent runs.
 *
 * Body (all optional):
 *   { dryRun?: bool, channelId?: string, includeAgentOwned?: bool }
 *   dryRun=true skips both the channel post AND the snooze writes —
 *   useful for previewing what the cron would post.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { appendSilentMessage } from '@/lib/collab-message-io';
import {
  applyFireSnooze,
  FLEET_SNOOZE_KEY,
  isSnoozedNow,
  activeSnoozeFor,
} from '@/lib/scaffolding-snooze';
import { composeFleetHealth, type FleetAgentSummary } from '@/lib/scaffolding-manifest';
import type { CollabMessage, CollabParticipant } from '@/lib/types';
import { parseJsonBody, refinements, z } from '@/lib/api-validation';

export const dynamic = 'force-dynamic';

const DEFAULT_CHANNEL_ID = '3b994a27-0a17-46a9-99eb-03e38b6832e6';

function makeDriftAlarmParticipant(): CollabParticipant {
  const now = new Date().toISOString();
  return {
    id: 'system-scaffolding-drift-alarm',
    type: 'user',
    name: 'Scaffolding Drift Alarm',
    source: 'DevFlow Cron',
    joinedAt: now,
    lastSeen: now,
  };
}

function formatAlertMessage(
  alertingAgents: FleetAgentSummary[],
  fleetSize: number,
  topN: number = 5,
): string {
  const lines: string[] = [];
  const totalDrift = alertingAgents.reduce((s, a) => s + a.summary.filesDrift, 0);
  const totalMissing = alertingAgents.reduce((s, a) => s + a.summary.filesMissing, 0);
  lines.push(
    `🚨 Scaffolding drift detected: **${alertingAgents.length}/${fleetSize}** agents off-master ` +
      `(${totalDrift} drift, ${totalMissing} missing files).`,
  );
  lines.push('');
  lines.push('Top offenders:');
  const sorted = [...alertingAgents].sort((a, b) => {
    const aBad = a.summary.filesDrift + a.summary.filesMissing;
    const bBad = b.summary.filesDrift + b.summary.filesMissing;
    return bBad - aBad;
  });
  for (const a of sorted.slice(0, topN)) {
    const s = a.summary;
    lines.push(`- **${a.name}** drift=${s.filesDrift} missing=${s.filesMissing} (${a.model ?? '?'})`);
  }
  if (sorted.length > topN) {
    lines.push(`- _…and ${sorted.length - topN} more_`);
  }
  lines.push('');
  lines.push(
    'Run `python3 data/scaffolding/sync.py` to fix, or ' +
      '`/api/scaffolding/manifest?agentId=NAME` for per-agent detail. ' +
      'Snooze: `POST /api/scaffolding/snooze {agentId, until:"+4h", reason}`.',
  );
  return lines.join('\n');
}

/**
 * Sprint Q1 T2 — Reynolds, 2026-05-27. Closes:
 *   - drift-alarm null JSON body → 500 (crit)
 *   - drift-alarm 'not-json' body silently treated as empty (info → INVALID_FIELD now)
 *   - drift-alarm silently ignored unsupported body params like `dryRun:true` typo (med)
 *
 * All fields are optional with sensible defaults; schema gives the caller a
 * proper 400 INVALID_FIELD instead of silent dryRun-fell-through-to-real-fire.
 */
const AlarmBodySchema = z.object({
  dryRun: z.boolean().optional(),
  channelId: z.string()
    .min(1, 'channelId must be non-empty')
    .max(200, 'channelId must be 200 characters or fewer')
    .refine(refinements.noControlChars, 'channelId must not contain control characters')
    .optional(),
  missingOnly: z.boolean().optional(),
  cooldownHours: z.number()
    .finite('cooldownHours must be a finite number')
    .min(0, 'cooldownHours must be >= 0')
    .max(720, 'cooldownHours must be <= 720 (30 days)')
    .optional(),
}).strict();

export const POST = tracked('/api/scaffolding/drift-alarm', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  const parsed = await parseJsonBody(request, AlarmBodySchema, { label: 'drift-alarm body' });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const dryRun = body.dryRun === true;
  const missingOnly = body.missingOnly === true;
  const channelId = (body.channelId
    ?? process.env.SCAFFOLDING_ALERT_CHANNEL_ID
    ?? DEFAULT_CHANNEL_ID).trim();

  try {
    // Cheap fleet-snooze short-circuit
    const fleet = await activeSnoozeFor(FLEET_SNOOZE_KEY);
    if (fleet) {
      return NextResponse.json({
        success: true,
        posted: false,
        reason: 'fleet-snoozed',
        until: fleet.until,
        snoozeReason: fleet.reason,
      });
    }

    // Compose fleet health
    const health = await composeFleetHealth();

    // Filter to agents that should alert: scaffolded + has drift (or missing)
    // + not under per-agent snooze
    const candidates: FleetAgentSummary[] = [];
    for (const a of health.agents) {
      if (!a.scaffolded) continue;
      const s = a.summary;
      const bad = s.filesDrift + s.filesMissing;
      if (bad === 0) continue;
      if (missingOnly && s.filesMissing === 0) continue;
      const snz = await isSnoozedNow(a.name);
      if (snz.snoozed) continue;
      candidates.push(a);
    }

    if (candidates.length === 0) {
      return NextResponse.json({
        success: true,
        posted: false,
        reason: 'all-snoozed-or-healthy',
        fleetSize: health.agentsTotal,
        fleetSnoozed: false,
      });
    }

    const content = formatAlertMessage(candidates, health.agentsTotal);

    if (!dryRun) {
      const message: CollabMessage = {
        id: randomUUID(),
        channelId,
        from: makeDriftAlarmParticipant(),
        content,
        timestamp: new Date().toISOString(),
        silent: true,
      };
      try {
        await appendSilentMessage(channelId, message);
      } catch (err) {
        console.error('[drift-alarm] failed to append message', err);
        return NextResponse.json(
          { success: false, error: 'Failed to post alert', detail: (err as Error).message },
          { status: 500 },
        );
      }

      // Apply per-agent cooldown snoozes so the next cron tick doesn't repeat
      const cooldownReason = body.cooldownHours
        ? `auto-cooldown ${body.cooldownHours}h after drift alarm`
        : 'auto-cooldown after drift alarm fire';
      const cooldownMs = body.cooldownHours
        ? body.cooldownHours * 60 * 60 * 1000
        : undefined;
      for (const a of candidates) {
        if (cooldownMs) {
          // Manual override of the default — same setter, custom duration
          try {
            const { setSnooze } = await import('@/lib/scaffolding-snooze');
            await setSnooze(
              a.name,
              new Date(Date.now() + cooldownMs).toISOString(),
              cooldownReason,
              'DriftAlarm (auto)',
            );
          } catch (err) {
            console.error(`[drift-alarm] cooldown snooze failed for ${a.name}`, err);
          }
        } else {
          await applyFireSnooze(a.name, cooldownReason).catch((err) => {
            console.error(`[drift-alarm] cooldown snooze failed for ${a.name}`, err);
          });
        }
      }
    }

    return NextResponse.json({
      success: true,
      posted: !dryRun,
      reason: dryRun ? 'dry-run' : 'alerted',
      channelId,
      alertedCount: candidates.length,
      fleetSize: health.agentsTotal,
      alertedAgents: candidates.map((a) => ({
        name: a.name,
        drift: a.summary.filesDrift,
        missing: a.summary.filesMissing,
        model: a.model,
      })),
      content: dryRun ? content : undefined,
    });
  } catch (err) {
    console.error('[scaffolding/drift-alarm] error', err);
    return NextResponse.json(
      { success: false, error: 'Internal error', detail: (err as Error).message },
      { status: 500 },
    );
  }
});

/** GET alias for ad-hoc CLI testing — same as POST with empty body. */
export const GET = POST;
