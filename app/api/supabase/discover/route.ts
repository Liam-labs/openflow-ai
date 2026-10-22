/**
 * POST /api/supabase/discover — Auto-discover Supabase projects
 *
 * 1. Calls Supabase Management API GET /v1/projects to list all hosted projects
 * 2. Scans local filesystem for supabase/config.toml files
 * 3. Auto-registers any unregistered projects as instances
 * 4. Returns discovered/registered/existing counts
 */

import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { supabaseInstanceStore } from '@/lib/supabase-instance-store';
import { requireAuthOrLocal, successResponse, errorResponse } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { fetchWithTimeout } from '@/lib/fetch-utils';
import { getHomeDir } from '@/lib/home-dir';
import type { SupabaseInstance } from '@/lib/supabase-types';

export const dynamic = 'force-dynamic';

interface SupabaseProject {
  id: string;
  ref: string;
  name: string;
  region: string;
  status: string;
  database?: { host: string; version: string };
  created_at: string;
}

interface DiscoverResult {
  name: string;
  type: 'hosted' | 'local';
  ref?: string;
  region?: string;
  url: string;
  status: 'registered' | 'existing' | 'failed';
  error?: string;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out',
  '__pycache__', '.venv', 'venv', '.cache', 'coverage', '.turbo',
  'vendor', 'target', '.cargo',
]);

/** Simple TOML value extractor — no full parser needed */
function extractTomlValue(content: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*["']?([^"'\\r\\n]+)["']?`, 'm');
  const match = content.match(re);
  return match ? match[1].trim() : null;
}

/** Scan filesystem for supabase/config.toml up to maxDepth */
async function scanLocalProjects(
  rootDir: string,
  maxDepth: number,
  depth = 0
): Promise<Array<{ name: string; projectPath: string; projectId: string | null; port: number }>> {
  const results: Array<{ name: string; projectPath: string; projectId: string | null; port: number }> = [];

  // Check if this dir has supabase/config.toml
  const configPath = path.join(rootDir, 'supabase', 'config.toml');
  try {
    const content = await fs.readFile(configPath, 'utf8');
    const name = extractTomlValue(content, 'name') || extractTomlValue(content, 'project_name') || path.basename(rootDir);
    const projectId = extractTomlValue(content, 'project_id');
    const portStr = extractTomlValue(content, 'port');
    const port = portStr ? parseInt(portStr, 10) : 54321;
    results.push({ name, projectPath: rootDir, projectId, port: isNaN(port) ? 54321 : port });
    return results; // Don't recurse into project dirs
  } catch {
    // No config.toml here
  }

  if (depth >= maxDepth) return results;

  try {
    const dirents = await fs.readdir(rootDir, { withFileTypes: true });
    const subdirs = dirents
      .filter(d => d.isDirectory() && !SKIP_DIRS.has(d.name) && !d.name.startsWith('.'))
      .map(d => d.name);

    const subResults = await Promise.all(
      subdirs.map(name => scanLocalProjects(path.join(rootDir, name), maxDepth, depth + 1))
    );
    for (const sub of subResults) results.push(...sub);
  } catch {
    // Can't read directory — skip
  }

  return results;
}

export const POST = tracked('/api/supabase/discover', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request, 'write');
  if (denied) return denied;

  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const existing = await supabaseInstanceStore.listInstances();
  const existingByProjectId = new Map<string, SupabaseInstance>();
  const existingByUrl = new Map<string, SupabaseInstance>();
  for (const inst of existing) {
    if (inst.connection.projectId) existingByProjectId.set(inst.connection.projectId, inst);
    existingByUrl.set(inst.connection.url, inst);
  }

  const results: DiscoverResult[] = [];
  let discoveredCount = 0;
  let registeredCount = 0;
  let existingCount = 0;

  // ── 1. Hosted projects via Management API ──────────────────────────────
  if (accessToken) {
    try {
      const resp = await fetchWithTimeout(
        'https://api.supabase.com/v1/projects',
        { headers: { Authorization: `Bearer ${accessToken}` } },
        15_000
      );

      if (!resp.ok) {
        return errorResponse(`Management API returned ${resp.status}: ${resp.statusText}`, 'SERVICE_UNAVAILABLE', 502);
      }

      const projects: SupabaseProject[] = await resp.json();
      discoveredCount += projects.length;

      for (const proj of projects) {
        const url = `https://${proj.ref}.supabase.co`;
        const isRegistered = existingByProjectId.has(proj.ref) || existingByUrl.has(url);

        if (isRegistered) {
          existingCount++;
          results.push({ name: proj.name, type: 'hosted', ref: proj.ref, region: proj.region, url, status: 'existing' });
          continue;
        }

        try {
          await supabaseInstanceStore.upsertInstance({
            name: proj.name,
            type: 'hosted',
            connection: {
              url,
              anonKeyEnvVar: 'SUPABASE_PUBLISHABLE_KEY',
              serviceRoleKeyEnvVar: 'SUPABASE_SECRET_KEY',
              projectId: proj.ref,
            },
            notes: `Auto-discovered via Management API. Region: ${proj.region}`,
          });
          registeredCount++;
          results.push({ name: proj.name, type: 'hosted', ref: proj.ref, region: proj.region, url, status: 'registered' });
        } catch (err) {
          results.push({
            name: proj.name, type: 'hosted', ref: proj.ref, region: proj.region, url,
            status: 'failed', error: err instanceof Error ? err.message : 'Registration failed',
          });
        }
      }
    } catch (err) {
      return errorResponse(
        `Failed to reach Supabase Management API: ${err instanceof Error ? err.message : String(err)}`,
        'SERVICE_UNAVAILABLE',
        502
      );
    }
  }

  // ── 2. Local projects via filesystem scan ──────────────────────────────
  const homeDir = process.env.HOME || getHomeDir();
  const localProjects = await scanLocalProjects(homeDir, 3);
  discoveredCount += localProjects.length;

  for (const proj of localProjects) {
    const url = `http://127.0.0.1:${proj.port}`;
    const isRegistered = existingByUrl.has(url) ||
      (proj.projectId && existingByProjectId.has(proj.projectId));

    if (isRegistered) {
      existingCount++;
      results.push({ name: proj.name, type: 'local', url, status: 'existing' });
      continue;
    }

    try {
      await supabaseInstanceStore.upsertInstance({
        name: proj.name,
        type: 'local',
        connection: {
          url,
          anonKeyEnvVar: 'SUPABASE_LOCAL_ANON_KEY',
          serviceRoleKeyEnvVar: 'SUPABASE_LOCAL_SERVICE_ROLE_KEY',
          projectId: proj.projectId ?? undefined,
        },
        notes: `Auto-discovered. projectPath:${proj.projectPath}`,
      });
      registeredCount++;
      results.push({ name: proj.name, type: 'local', url, status: 'registered' });
    } catch (err) {
      results.push({
        name: proj.name, type: 'local', url,
        status: 'failed', error: err instanceof Error ? err.message : 'Registration failed',
      });
    }
  }

  return successResponse({
    discovered: discoveredCount,
    registered: registeredCount,
    existing: existingCount,
    projects: results,
  });
});
