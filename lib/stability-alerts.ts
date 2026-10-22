/**
 * Stability Alerts Channel Utility
 *
 * Posts stability event alerts (mass crashes, OOM kills, etc.) to the
 * #stability-alerts collab channel. Creates the channel on first use.
 *
 * Designed to be called from anywhere inside the DevFlow server process.
 * Uses HTTP calls to the local agent API to avoid circular imports.
 */

import { getDevFlowApiToken } from './api-auth';
import path from 'path';
import { APP_CWD } from './app-paths';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { PRODUCT_NAME } from '@/lib/brand';
import { selfOrigin } from '@/lib/self-origin';

const BASE_URL = selfOrigin();
const CHANNEL_NAME = 'stability-alerts';
const PARTICIPANT_NAME = PRODUCT_NAME;

// Alerts store path — mirrors /api/alerts route
const ALERTS_FILE = path.join(/* turbopackIgnore: true */ APP_CWD, '.AppData', 'alerts.json');

// Cached after first successful init
let cachedChannelId: string | null = null;
let cachedParticipantId: string | null = null;
let initInProgress = false;

type AlertSeverity = 'critical' | 'high' | 'medium' | 'info';

async function agentApi(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = getDevFlowApiToken();
  const res = await fetch(`${BASE_URL}/api/agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Agent API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

/**
 * Find or create the #stability-alerts channel and join as "DevFlow" participant.
 * Caches IDs in module scope for subsequent calls.
 */
async function ensureChannel(): Promise<{ channelId: string; participantId: string }> {
  if (cachedChannelId && cachedParticipantId) {
    return { channelId: cachedChannelId, participantId: cachedParticipantId };
  }

  // List channels and look for existing stability-alerts channel.
  // Agent API wraps payload under `data` — the earlier shape `result.channels` was
  // always undefined, so name-match never succeeded and every fresh module load
  // (PM2 restart, cache-clear after transient error) created a new duplicate channel.
  const listResult = await agentApi({ action: 'collab.channels.list' });
  const channels =
    (listResult as { data?: { channels?: Array<{ id: string; name: string }> } }).data?.channels ??
    (listResult as { channels?: Array<{ id: string; name: string }> }).channels ??
    [];
  let channelId = channels.find(c => c.name === CHANNEL_NAME)?.id ?? null;

  // Create if not found
  if (!channelId) {
    const createResult = await agentApi({
      action: 'collab.channels.create',
      name: CHANNEL_NAME,
      description: 'Automated stability event alerts — crashes, OOM kills, tmux failures',
    });
    const channel = (createResult as { data?: { channel?: { id: string } } }).data?.channel;
    if (!channel?.id) throw new Error('Failed to create stability-alerts channel');
    channelId = channel.id;
  }

  // Join as DevFlow system participant
  const joinResult = await agentApi({
    action: 'collab.join',
    channelId,
    participant: {
      name: PARTICIPANT_NAME,
      type: 'agent',
      source: 'DevFlow stability-alerts',
    },
  });
  const participantId = (joinResult as { data?: { participantId?: string } }).data?.participantId;
  if (!participantId) throw new Error('Failed to join stability-alerts channel');

  cachedChannelId = channelId;
  cachedParticipantId = participantId;
  return { channelId, participantId };
}

const SEVERITY_PREFIX: Record<AlertSeverity, string> = {
  critical: '🔴 CRITICAL',
  high:     '🟠 HIGH',
  medium:   '🟡 MEDIUM',
  info:     '🔵 INFO',
};

/**
 * Persist an alert to the .AppData/alerts.json store.
 * Called in parallel with the collab channel post — fire-and-forget, non-fatal.
 * Only persists critical and high severity alerts (medium/info are chat-only noise).
 */
async function persistAlert(
  title: string,
  severity: AlertSeverity,
  details?: string,
): Promise<void> {
  if (severity !== 'critical' && severity !== 'high') return;

  try {
    let store: { alerts: unknown[] } = { alerts: [] };
    try {
      const raw = await fs.readFile(ALERTS_FILE, 'utf-8');
      store = JSON.parse(raw) as { alerts: unknown[] };
    } catch { /* file not created yet */ }

    const alert = {
      id: randomUUID(),
      title,
      severity,
      message: details,
      source: 'stability-alerts',
      createdAt: new Date().toISOString(),
    };
    store.alerts.unshift(alert);

    // Keep at most 500 entries
    if (store.alerts.length > 500) store.alerts = store.alerts.slice(0, 500);

    const tmp = `${ALERTS_FILE}.tmp.${process.pid}.${Date.now()}`;
    await fs.mkdir(path.dirname(ALERTS_FILE), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8');
    await fs.rename(tmp, ALERTS_FILE);
  } catch {
    // Non-fatal — alerts store write failure must not crash the caller
  }
}

/**
 * Post a stability alert to the #stability-alerts channel.
 * Also persists critical/high alerts to .AppData/alerts.json for the dashboard badge.
 *
 * @param title   Short description of the event
 * @param severity  Alert severity level
 * @param details   Optional additional details (metadata, counts, etc.)
 */
export async function postStabilityAlert(
  title: string,
  severity: AlertSeverity,
  details?: string
): Promise<void> {
  // 2026-04-19 — collab channel integration disabled per the owner. Stability
  // events now land only in the dashboard alerts badge (.AppData/alerts.json).
  // The #stability-alerts channel + its participant were spawning duplicate
  // channels and adding chat noise for no added signal. ensureChannel(),
  // cachedChannelId, cachedParticipantId, initInProgress, and SEVERITY_PREFIX
  // remain defined but are intentionally unused so re-enabling is a one-line flip.
  try {
    await persistAlert(title, severity, details);
  } catch (err) {
    console.error('[stability-alerts] Failed to persist alert:', err instanceof Error ? err.message : err);
  }
}
