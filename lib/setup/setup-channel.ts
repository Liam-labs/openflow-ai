/**
 * The default "Setup" channel and its Guide agent.
 *
 * Created once, at the end of the first-run wizard, after the first team starts. A marker file records that it ran, so deleting the
 * channel does not bring it back and a retry of the wizard does not make a second one. The marker is written after the channel exists,
 * so a crash in between retries instead of losing it.
 */

import { promises as fs } from 'fs';
import path from 'path';

export interface GuideDefinition {
  name: string;
  channelName: string;
  channelDescription: string;
  roleSlug: string;
  personality: string;
  /** What the Team panel shows for his role. */
  roleLabel?: string;
  firstMessage: string;
}

export interface SetupChannelDeps {
  readMarker: () => Promise<{ channelId: string } | null>;
  writeMarker: (m: { channelId: string; at: string }) => Promise<void>;
  loadGuide: () => Promise<GuideDefinition>;
  createChannel: (name: string, description: string) => Promise<string>;
  startGuide: (channelId: string, guide: GuideDefinition) => Promise<{ started: boolean; error?: string }>;
  now: () => string;
}

export interface SetupChannelResult {
  /** 'created' now, 'exists' because an earlier run made it, 'failed' with the reason (the wizard goes on regardless). */
  status: 'created' | 'exists' | 'failed';
  channelId?: string;
  guideStarted?: boolean;
  firstMessage?: string;
  error?: string;
}

export async function ensureSetupChannel(d: SetupChannelDeps): Promise<SetupChannelResult> {
  try {
    if (await d.readMarker()) return { status: 'exists' };
    const guide = await d.loadGuide();
    const channelId = await d.createChannel(guide.channelName, guide.channelDescription);
    await d.writeMarker({ channelId, at: d.now() });
    const started = await d.startGuide(channelId, guide);
    return { status: 'created', channelId, guideStarted: started.started, firstMessage: guide.firstMessage, ...(started.error ? { error: started.error } : {}) };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : 'The Setup channel could not be created.' };
  }
}

export function markerFile(appDataDir: string): string {
  return path.join(appDataDir, 'setup-channel.json');
}

export async function readMarkerFile(file: string): Promise<{ channelId: string } | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as { channelId?: unknown };
    return typeof parsed.channelId === 'string' ? { channelId: parsed.channelId } : null;
  } catch { return null; }
}

export async function writeMarkerFile(file: string, marker: { channelId: string; at: string }): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(marker), { mode: 0o600 });
}
