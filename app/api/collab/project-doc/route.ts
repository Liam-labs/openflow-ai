/**
 * /api/collab/project-doc
 *
 * GET  ?channelId=<id>  — returns the channel's projectPath and PROJECT.md content
 * POST { channelId, projectPath } — sets the channel's working directory
 * POST { channelId, content, expectedMtime } — saves the channel's PROJECT.md (409 with the current text if it changed since expectedMtime)
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
import { projectFolderExists, readProjectDoc, writeProjectDoc } from '@/lib/project-doc';
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
  let body: { channelId?: string; projectPath?: string; content?: unknown; expectedMtime?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { channelId, projectPath } = body;

  if (!channelId || typeof channelId !== 'string') {
    return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
  }

  // Save the document itself
  if (body.content !== undefined) {
    if (typeof body.content !== 'string') return NextResponse.json({ error: 'content must be text' }, { status: 400 });
    if (Buffer.byteLength(body.content, 'utf-8') > 1024 * 1024) return NextResponse.json({ error: 'The document is too large (1 MB limit)' }, { status: 413 });
    const expectedMtime = typeof body.expectedMtime === 'number' && Number.isFinite(body.expectedMtime) ? body.expectedMtime : null;
    const channel = (await loadChannels()).channels.find(ch => ch.id === channelId);
    if (!channel) return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    const agent = channel.roster?.agents?.find(a => a.workingDirectory);
    const docPath = channel.projectPath ?? agent?.workingDirectory ?? null;
    if (!docPath) return NextResponse.json({ error: 'This channel has no working directory set' }, { status: 400 });
    if (!isAllowedProjectPath(docPath)) return NextResponse.json({ error: 'Access to this path is not allowed' }, { status: 403 });
    const saved = await writeProjectDoc(docPath, body.content, expectedMtime, agent);
    if (saved.ok) return NextResponse.json({ success: true, mtime: saved.mtime });
    if (saved.conflict) return NextResponse.json({ error: 'PROJECT.md changed since you opened it', conflict: true, content: saved.content, mtime: saved.mtime }, { status: 409 });
    return NextResponse.json({ error: saved.message, status: saved.status }, { status: 502 });
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
