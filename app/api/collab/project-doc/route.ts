/**
 * /api/collab/project-doc
 *
 * GET  ?channelId=<id>  — returns the channel's projectPath and PROJECT.md content
 * POST { channelId, projectPath } — sets the channel's working directory
 *
 * The project lives on the agents' machine, which is not the machine DevFlow runs on now, so both read and check the folder
 * through lib/project-doc.ts (agent-hostd op project-doc-read) rather than this server's own disk.
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import type { CollabChannelsData } from '@/lib/types';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile } from '@/lib/data-io';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { appRoot } from '@/lib/app-paths';
import { projectFolderExists, readProjectDoc } from '@/lib/project-doc';
import { getHomeDir } from '@/lib/home-dir';

const HOME = getHomeDir();

function isAllowedProjectPath(p: string): boolean {
  const resolved = path.resolve(p);
  return resolved.startsWith(HOME + path.sep) || resolved.startsWith(appRoot() + path.sep);
}

const CHANNELS_PATH = DataPaths.collabChannels;

async function loadChannels(): Promise<CollabChannelsData> {
  return readJsonFile<CollabChannelsData>(CHANNELS_PATH, { channels: [], lastUpdated: '' });
}

export const GET = tracked('/api/collab/project-doc', async (req: NextRequest) => {
  const authDenied = await requireAuthOrLocal(req, 'read');
  if (authDenied) return authDenied;
  const channelId = req.nextUrl.searchParams.get('channelId');

  if (!channelId) {
    return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
  }

  const data = await loadChannels();
  const channel = data.channels.find(ch => ch.id === channelId);

  if (!channel) {
    return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
  }

  // Fall back to first roster agent's workingDirectory if projectPath not explicitly set
  const rosterAgent = channel.roster?.agents?.find(a => a.workingDirectory);
  const projectPath = channel.projectPath ?? rosterAgent?.workingDirectory ?? null;

  if (!projectPath) {
    return NextResponse.json({ projectPath: null, content: null, exists: false });
  }

  // Read PROJECT.md from where the project lives (status and message say why when there is nothing to show)
  return NextResponse.json(await readProjectDoc(projectPath, rosterAgent));
});

export const POST = tracked('/api/collab/project-doc', async (req: NextRequest) => {
  const authDenied = await requireAuthOrLocal(req, 'write');
  if (authDenied) return authDenied;
  let body: { channelId?: string; projectPath?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { channelId, projectPath } = body;

  if (!channelId || typeof channelId !== 'string') {
    return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
  }
  if (!projectPath || typeof projectPath !== 'string') {
    return NextResponse.json({ error: 'projectPath is required' }, { status: 400 });
  }

  // Path traversal guard: only allow paths under $HOME or project root
  if (!isAllowedProjectPath(projectPath)) {
    return NextResponse.json({ error: 'Access to this path is not allowed' }, { status: 403 });
  }

  // Validate the folder exists, on the machine where the project lives
  const rosterAgent = (await loadChannels()).channels.find(ch => ch.id === channelId)?.roster?.agents?.find(a => a.workingDirectory);
  const folder = await projectFolderExists(projectPath, rosterAgent);
  if (!folder.ok) {
    return NextResponse.json({ error: folder.message }, { status: 502 });
  }
  if (!folder.exists) {
    return NextResponse.json({ error: `Path does not exist: ${projectPath}` }, { status: 400 });
  }

  const result = await mutateChannels('project-doc:set-project-path', async data => {
    const channel = data.channels.find(ch => ch.id === channelId);

    if (!channel) {
      return null;
    }

    channel.projectPath = projectPath;
    await saveChannels(data);
    return projectPath;
  });

  if (result === null) {
    return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true, projectPath: result });
});
