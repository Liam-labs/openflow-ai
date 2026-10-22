/**
 * POST /api/setup/first-team
 *
 * Last step of the first-run wizard: create the first channel and start the
 * example agents from data/examples/agents.json. The wizard then joins the
 * channel as the person and sends each agent its first message, so the reply
 * shows up live.
 *
 * Body: { agents?: string[], agentType?: string, model?: string,
 *         workingDirectory?: string, channelId?: string }
 *   - channelId: reuse the channel from an earlier attempt (retry only the
 *     agents that failed instead of creating a second channel).
 *
 * GET returns the example agents for the wizard cards.
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';
import { getHomeDir } from '@/lib/home-dir';
import { claudeUsesApiKey } from '@/lib/claude-spawn-env';
import { ensureClaudeFirstRun } from '@/lib/claude-first-run';
import { resolveSecretStore } from '@/lib/secret-store';
import { createChannel, getChannel } from '@/app/api/agent/actions/collab';
import { provision } from '@/app/api/agent/actions/roster';
import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';

interface ExampleAgent {
  name: string;
  roleSlug: string;
  personality?: string;
  /** Ticked when the wizard opens. Absent means ticked. */
  default?: boolean;
  summary: string;
  firstMessage: string;
}

interface AgentResult {
  name: string;
  started: boolean;
  error?: string;
}

const ALLOWED_RUNTIMES = new Set(['claude', 'codex', 'gemini', 'antigravity', 'grok']);

// The command-line tool each runtime needs on this machine, and how to install it. Grok has no tool to check.
const RUNTIME_TOOLS: Record<string, { binary?: string; install?: string }> = {
  claude: { binary: 'claude', install: 'npm install -g @anthropic-ai/claude-code' },
  codex: { binary: 'codex', install: 'npm install -g @openai/codex' },
  gemini: { binary: 'gemini', install: 'npm install -g @google/gemini-cli' },
  antigravity: { binary: 'agy', install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
  grok: {},
};

async function onPath(binary: string): Promise<boolean> {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      await fs.access(path.join(dir, binary), fs.constants.X_OK);
      return true;
    } catch { /* next directory */ }
  }
  return false;
}

const AUTH: AgentAuthContext = {
  tokenId: 'setup-wizard',
  tokenName: 'Setup wizard',
  scope: 'write',
  createdBy: 'setup-wizard',
};

async function loadExamples(): Promise<ExampleAgent[]> {
  const raw = await fs.readFile(appPath('data', 'examples', 'agents.json'), 'utf-8');
  const parsed = JSON.parse(raw) as { agents?: ExampleAgent[] };
  return Array.isArray(parsed.agents) ? parsed.agents : [];
}

async function roleIdForSlug(slug: string): Promise<string | undefined> {
  const raw = await fs.readFile(appPath('data', 'roles', 'roles.json'), 'utf-8');
  const parsed = JSON.parse(raw) as { roles?: Array<{ id: string; slug: string }> } | Array<{ id: string; slug: string }>;
  const roles = Array.isArray(parsed) ? parsed : parsed.roles ?? [];
  return roles.find(r => r.slug === slug)?.id;
}

export const GET = tracked('/api/setup/first-team', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'read');
  if (denied) return denied;
  try {
    const agents = await loadExamples();
    const runtimes: Record<string, { installed: boolean | null; install?: string }> = {};
    for (const [name, tool] of Object.entries(RUNTIME_TOOLS)) {
      runtimes[name] = { installed: tool.binary ? await onPath(tool.binary) : null, install: tool.install };
    }
    return NextResponse.json({
      success: true,
      runtimes,
      agents: agents.map(({ name, roleSlug, summary, firstMessage, default: ticked }) => ({ name, roleSlug, summary, firstMessage, default: ticked !== false })),
      defaultWorkingDirectory: path.join(getHomeDir(), 'devflow-projects', 'first-project'),
    });
  } catch {
    return NextResponse.json({ success: false, error: 'The example agents file (data/examples/agents.json) is missing or unreadable.' }, { status: 500 });
  }
});

export const POST = tracked('/api/setup/first-team', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'admin');
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }

  let examples: ExampleAgent[];
  try {
    examples = await loadExamples();
  } catch {
    return NextResponse.json({ success: false, error: 'The example agents file (data/examples/agents.json) is missing or unreadable.' }, { status: 500 });
  }

  const wanted = Array.isArray(body.agents) ? new Set(body.agents.map(String)) : new Set(examples.map(a => a.name));
  const chosen = examples.filter(a => wanted.has(a.name));
  if (chosen.length === 0) {
    return NextResponse.json({ success: false, error: 'Pick at least one agent.' }, { status: 400 });
  }

  const agentType = typeof body.agentType === 'string' && ALLOWED_RUNTIMES.has(body.agentType) ? body.agentType : 'claude';
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
  const workingDirectory = typeof body.workingDirectory === 'string' && body.workingDirectory.trim()
    ? path.resolve(body.workingDirectory.trim())
    : path.join(getHomeDir(), 'devflow-projects', 'first-project');

  try {
    await fs.mkdir(workingDirectory, { recursive: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: `Could not create the project folder: ${error instanceof Error ? error.message : 'unknown error'}` }, { status: 400 });
  }

  // Channel: reuse one from an earlier attempt, otherwise create it.
  let channelId = typeof body.channelId === 'string' ? body.channelId : '';
  if (channelId) {
    const { found } = await getChannel({ action: 'collab.channels.get', channelId } as AgentApiRequest, AUTH);
    if (!found) channelId = '';
  }
  if (!channelId) {
    const { channel } = await createChannel(
      { action: 'collab.channels.create', name: 'My first team', description: 'Created by the first-run wizard', projectPath: workingDirectory } as AgentApiRequest,
      AUTH,
    );
    channelId = channel.id;
  }

  // Agents already running in a retried channel are left alone.
  const { channel: channelNow } = await getChannel({ action: 'collab.channels.get', channelId } as AgentApiRequest, AUTH);
  const alreadyThere = new Set((channelNow?.roster?.agents ?? []).map(r => r.name));

  // Claude Code has nobody to answer its first-run questions (welcome, theme, the bypass-permissions warning, and in API-key mode "use this key?"):
  // answer them in its own settings. Subscription mode passes no key, so only the missing welcome and warning answers are filled in.
  if (agentType === 'claude') {
    try {
      let key = '';
      if (claudeUsesApiKey()) {
        key = process.env.ANTHROPIC_API_KEY || '';
        if (!key) key = resolveSecretStore().get('ANTHROPIC_API_KEY') || '';
      }
      await ensureClaudeFirstRun(getHomeDir(), key);
    } catch (error) {
      console.warn('[setup] could not prepare Claude Code first run:', error instanceof Error ? error.message : error);
    }
  }

  const results: AgentResult[] = [];
  for (const agent of chosen) {
    if (alreadyThere.has(agent.name)) {
      results.push({ name: agent.name, started: true });
      continue;
    }
    const roleId = await roleIdForSlug(agent.roleSlug);
    if (!roleId) {
      results.push({ name: agent.name, started: false, error: `Role "${agent.roleSlug}" is not installed.` });
      continue;
    }
    try {
      const out = await provision(
        {
          action: 'roster.provision',
          channelId,
          name: agent.name,
          workingDirectory,
          roleId,
          roleSlug: agent.roleSlug,
          personality: agent.personality ?? agent.name,
          agentType,
          model,
        } as AgentApiRequest,
        AUTH,
      );
      results.push(out.spawned
        ? { name: agent.name, started: true }
        : { name: agent.name, started: false, error: (out as { error?: string }).error || 'The agent did not start.' });
    } catch (error) {
      results.push({ name: agent.name, started: false, error: error instanceof Error ? error.message : 'The agent did not start.' });
    }
  }

  return NextResponse.json({
    success: results.some(r => r.started),
    channelId,
    agents: results,
    firstMessages: Object.fromEntries(chosen.map(a => [a.name, a.firstMessage])),
  });
});
