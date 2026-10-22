/**
 * Scaffolding Sync Trigger
 *
 * POST /api/settings/sync
 * Triggers sync.py to deploy updated alignment masters to all agents.
 *
 * Body (optional):
 *   { agent?: string }  — sync a single agent instead of all
 *
 * Response includes stdout/stderr from sync.py so the UI can show results.
 */

import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';
import { requireAuthOrLocal } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const SYNC_SCRIPT = appPath('data', 'scaffolding', 'sync.py');
const VALID_AGENT_NAME = /^[a-zA-Z0-9_-]+$/;
const SYNC_TIMEOUT_MS = 60_000; // 60s max — sync across 5+ agents can take a moment

function runSync(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn('python3', [SYNC_SCRIPT, ...args], {
      timeout: SYNC_TIMEOUT_MS,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ stdout, stderr: stderr + '\n[TIMEOUT] sync.py exceeded 60s', exitCode: 124 });
    }, SYNC_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

/**
 * POST /api/settings/sync
 */
export const POST = tracked('/api/settings/sync', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  try {
    let body: { agent?: string } = {};
    try {
      body = await request.json();
    } catch {
      // No body is fine — defaults to full sync
    }

    const args: string[] = [];

    if (body.agent) {
      // Validate agent name — only safe characters
      if (!VALID_AGENT_NAME.test(body.agent) || body.agent.length > 64) {
        return NextResponse.json(
          { success: false, error: 'Invalid agent name' },
          { status: 400 }
        );
      }
      args.push('--agent', body.agent);
    } else {
      // No agent specified — sync all
      args.push('--all');
    }

    const startedAt = new Date().toISOString();
    const { stdout, stderr, exitCode } = await runSync(args);
    const completedAt = new Date().toISOString();

    const success = exitCode === 0;

    // Parse summary line from sync.py output (last non-empty line)
    const lines = stdout.trim().split('\n').filter(Boolean);
    const summary = lines[lines.length - 1] ?? '';

    return NextResponse.json({
      success,
      data: {
        exitCode,
        summary,
        stdout,
        stderr: stderr || null,
        startedAt,
        completedAt,
        agent: body.agent ?? null,
      },
      ...(success ? {} : { error: `sync.py exited with code ${exitCode}` }),
    });
  } catch (error) {
    console.error('[settings/sync] POST error:', error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
});
