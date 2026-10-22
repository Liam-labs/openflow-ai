/**
 * Directives Management Actions (Agent API)
 *
 * Provides programmatic access to agent directive files (Personality, Directives, Expertise).
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { AgentApiRequest, AgentAuthContext, AgentRosterEntry } from '@/lib/types';
import { selfOrigin } from '@/lib/self-origin';

const PTY_API_URL = `${selfOrigin()}/api/collab/pty`;

interface PtyCallResult {
  status: number;
  body: { success?: boolean; error?: string; [k: string]: unknown };
}
async function callPtyApi(body: Record<string, unknown>): Promise<PtyCallResult> {
  const res = await fetch(PTY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  return { status: res.status, body: parsed as PtyCallResult['body'] };
}

function ptyErrorStatusCode(status: number): number {
  return status >= 400 && status < 600 ? status : 500;
}

/**
 * roster.directives.read - Read directive files for a roster agent
 */
export async function read(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  if (!channelId || !agentId) throw new Error('channelId and agentId are required');

  // Get the roster to find the agent's working directory
  const { status: rosterStatus, body: rosterData } = await callPtyApi({ action: 'roster_list', channelId });
  if (!rosterData.success) throw Object.assign(new Error(rosterData.error || 'Failed to get roster'), { statusCode: ptyErrorStatusCode(rosterStatus) });

  const agents = rosterData.agents as AgentRosterEntry[] | undefined;
  const agent = agents?.find((a: AgentRosterEntry) => a.id === agentId);
  if (!agent) throw Object.assign(new Error(`Agent ${agentId} not found in roster`), { statusCode: 404 });

  const workingDirectory = agent.effectiveWorkingDirectory || agent.workingDirectory;
  const rulesDir = path.join(workingDirectory, '.claude', 'rules');

  // Read the three directive files
  const fileMap = {
    personality: 'Personality.md',
    directives: 'Directives.md',
    expertise: 'Expertise.md',
  };

  const result: Record<string, string> = {};

  for (const [key, filename] of Object.entries(fileMap)) {
    const filePath = path.join(rulesDir, filename);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      result[key] = content;
    } catch (err: unknown) {
      // File doesn't exist or can't be read - return empty string
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        result[key] = '';
      } else {
        throw new Error(`Failed to read ${filename}: ${nodeErr.message}`);
      }
    }
  }

  return {
    personality: result.personality,
    directives: result.directives,
    expertise: result.expertise,
    agentName: agent.name,
    workingDirectory,
  };
}

/**
 * roster.directives.write - Write a directive file for a roster agent
 */
export async function write(body: AgentApiRequest, _auth: AgentAuthContext) {
  const channelId = body.channelId as string;
  const agentId = body.agentId as string;
  const file = body.file as string;
  const content = body.content as string;

  if (!channelId || !agentId || !file || content === undefined) {
    throw new Error('channelId, agentId, file, and content are required');
  }

  // Validate file param
  const fileMap: Record<string, string> = {
    personality: 'Personality.md',
    directives: 'Directives.md',
    expertise: 'Expertise.md',
  };

  const filename = fileMap[file];
  if (!filename) {
    throw new Error(`Invalid file parameter. Must be one of: ${Object.keys(fileMap).join(', ')}`);
  }

  // Enforce 150-line cap — rules files are loaded on every message, so every line costs tokens
  const lineCount = content.split('\n').length;
  if (lineCount > 150) {
    throw new Error(`File exceeds 150-line limit (${lineCount} lines). Rules files are loaded on every message — keep them concise.`);
  }

  // Get the roster to find the agent's working directory
  const { status: rosterStatus, body: rosterData } = await callPtyApi({ action: 'roster_list', channelId });
  if (!rosterData.success) throw Object.assign(new Error(rosterData.error || 'Failed to get roster'), { statusCode: ptyErrorStatusCode(rosterStatus) });

  const agents = rosterData.agents as AgentRosterEntry[] | undefined;
  const agent = agents?.find((a: AgentRosterEntry) => a.id === agentId);
  if (!agent) throw Object.assign(new Error(`Agent ${agentId} not found in roster`), { statusCode: 404 });

  const workingDirectory = agent.effectiveWorkingDirectory || agent.workingDirectory;
  const rulesDir = path.join(workingDirectory, '.claude', 'rules');
  const filePath = path.join(rulesDir, filename);

  // Ensure the directory exists
  await fs.mkdir(rulesDir, { recursive: true });

  // Write the file
  await fs.writeFile(filePath, content, 'utf-8');

  return {
    success: true,
    file: filename,
    path: filePath,
  };
}
