/** OpenFlow's after-first-team hook: the Setup channel and its assistant (see lib/setup/setup-channel.ts). */
import { promises as fs } from 'fs';
import path from 'path';
import { appPath } from '@/lib/app-paths';
import { DataPaths } from '@/lib/data-paths';
import { getHomeDir } from '@/lib/home-dir';
import type { FirstTeamHook } from '@/lib/instance-extensions';
import { ensureSetupChannel, markerFile, readMarkerFile, writeMarkerFile, type GuideDefinition } from '@/lib/setup/setup-channel';

export const setupChannelHook: FirstTeamHook = {
  id: 'setupChannel',
  run: async (ctx) => {
    const marker = markerFile(path.dirname(DataPaths.memoryWizard));
    return ensureSetupChannel({
      readMarker: () => readMarkerFile(marker),
      writeMarker: (m) => writeMarkerFile(marker, m),
      loadGuide: async () => JSON.parse(await fs.readFile(appPath('data', 'examples', 'guide.json'), 'utf-8')) as GuideDefinition,
      createChannel: (name, description) => ctx.createChannel(name, description, ctx.workingDirectory),
      startGuide: async (channelId, guide) => {
        // Its own folder: the first team may also have an agent called Jack, and two agents with one name must not share an agent folder.
        const dir = path.join(getHomeDir(), 'devflow-projects', 'setup-assistant');
        await fs.mkdir(dir, { recursive: true });
        return ctx.startAgent(channelId, { name: guide.name, roleSlug: guide.roleSlug, personality: guide.personality, workingDirectory: dir });
      },
      now: () => new Date().toISOString(),
    });
  },
};
