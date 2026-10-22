/**
 * Supabase Actions (Agent API)
 *
 * Exposes the Supabase instance registry and client via the agent API.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { AgentApiRequest, AgentAuthContext } from '@/lib/types';
import { supabaseInstanceStore } from '@/lib/supabase-instance-store';
import { getClientForInstance, getDefaultClient, testConnection, testHostedInstance, invalidateClient } from '@/lib/supabase-client';
import type { SupabaseInstance, SupabaseInstanceType, UpsertSupabaseInstanceInput } from '@/lib/supabase-types';
import { getHomeDir } from '@/lib/home-dir';

/** supabase.instances.list — List all registered instances */
export async function instancesList(_body: AgentApiRequest, _auth: AgentAuthContext) {
  const instances = await supabaseInstanceStore.listInstances();
  return { instances };
}

/** supabase.instances.get — Get a single instance by ID */
export async function instancesGet(body: AgentApiRequest, _auth: AgentAuthContext) {
  const id = body.id as string;
  if (!id) throw Object.assign(new Error('id is required'), { statusCode: 400 });
  const instance = await supabaseInstanceStore.getInstance(id);
  if (!instance) throw Object.assign(new Error(`Instance not found: ${id}`), { statusCode: 404 });
  return { instance };
}

/** supabase.instances.upsert — Create or update an instance */
export async function instancesUpsert(body: AgentApiRequest, _auth: AgentAuthContext) {
  const input: UpsertSupabaseInstanceInput = {
    id: body.id as string | undefined,
    name: body.name as string,
    type: (body.type as SupabaseInstanceType) || 'hosted',
    connection: {
      url: body.url as string,
      anonKeyEnvVar: (body.anonKeyEnvVar as string) || 'SUPABASE_PUBLISHABLE_KEY',
      serviceRoleKeyEnvVar: (body.serviceRoleKeyEnvVar as string) || 'SUPABASE_SECRET_KEY',
      dbPasswordEnvVar: body.dbPasswordEnvVar as string | undefined,
      dbConnectionStringEnvVar: body.dbConnectionStringEnvVar as string | undefined,
      projectId: body.projectId as string | undefined,
    },
    linkedProjects: body.linkedProjects as string[] | undefined,
    notes: body.notes as string | undefined,
  };

  if (!input.name || !input.connection.url) {
    throw Object.assign(new Error('name and url are required'), { statusCode: 400 });
  }

  const instance = await supabaseInstanceStore.upsertInstance(input);
  return { instance };
}

/** supabase.instances.delete — Delete an instance */
export async function instancesDelete(body: AgentApiRequest, _auth: AgentAuthContext) {
  const id = body.id as string;
  if (!id) throw Object.assign(new Error('id is required'), { statusCode: 400 });
  // Invalidate cached client for this instance
  const instance = await supabaseInstanceStore.getInstance(id);
  if (instance) {
    invalidateClient(instance.connection.url);
  }
  await supabaseInstanceStore.deleteInstance(id);
  return { deleted: true };
}

/** supabase.instances.test — Test connectivity to an instance */
export async function instancesTest(body: AgentApiRequest, _auth: AgentAuthContext) {
  const id = body.id as string;
  if (!id) throw Object.assign(new Error('id is required'), { statusCode: 400 });

  const instance = await supabaseInstanceStore.getInstance(id);
  if (!instance) throw Object.assign(new Error(`Instance not found: ${id}`), { statusCode: 404 });

  // Hosted instances with a projectId: use Management API (works for all projects under the account)
  if (instance.type === 'hosted' && instance.connection.projectId) {
    const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
    if (accessToken) {
      const result = await testHostedInstance(instance.connection.projectId, accessToken);
      const status = result.ok ? 'online' : (result.status === 'INACTIVE' ? 'offline' : 'error');
      await supabaseInstanceStore.updateStatus(id, status);
      return { ...result, instanceId: id };
    }
    // Fall through to PostgREST check if no access token
  }

  // Local instances or fallback: use PostgREST with service role key
  const key = process.env[instance.connection.serviceRoleKeyEnvVar];
  if (!key) {
    await supabaseInstanceStore.updateStatus(id, 'error');
    throw Object.assign(
      new Error(`Env var ${instance.connection.serviceRoleKeyEnvVar} not set`),
      { statusCode: 500 }
    );
  }

  const result = await testConnection(instance.connection.url, key);
  await supabaseInstanceStore.updateStatus(id, result.ok ? 'online' : 'error');
  return { ...result, instanceId: id };
}

/** supabase.instances.link — Link a DevFlow project to an instance */
export async function instancesLink(body: AgentApiRequest, _auth: AgentAuthContext) {
  const instanceId = body.instanceId as string;
  const projectId = body.projectId as string;
  if (!instanceId || !projectId) {
    throw Object.assign(new Error('instanceId and projectId are required'), { statusCode: 400 });
  }
  await supabaseInstanceStore.linkProject(instanceId, projectId);
  return { linked: true };
}

/** supabase.instances.unlink — Unlink a DevFlow project from an instance */
export async function instancesUnlink(body: AgentApiRequest, _auth: AgentAuthContext) {
  const instanceId = body.instanceId as string;
  const projectId = body.projectId as string;
  if (!instanceId || !projectId) {
    throw Object.assign(new Error('instanceId and projectId are required'), { statusCode: 400 });
  }
  await supabaseInstanceStore.unlinkProject(instanceId, projectId);
  return { unlinked: true };
}

// ============================================================
// Discovery helpers
// ============================================================

export interface DiscoveredSupabaseProject {
  /** Absolute path to the project root (parent of supabase/) */
  projectPath: string;
  /** Supabase project name from config.toml (or directory name fallback) */
  name: string;
  /** Project ref / ID from config.toml or .temp/project-ref */
  projectId: string | null;
  /** Local API port from config.toml (default 54321) */
  localPort: number;
  /** Whether the project has a .temp/project-ref (linked to cloud) */
  hasCloudLink: boolean;
  /** Whether a running local API was detected (.supabase/ dir exists) */
  hasLocalRuntime: boolean;
}

/** Extract a string value from a TOML file — simple line-by-line, no full parser */
function extractTomlValue(content: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*["']?([^"'\\r\\n]+)["']?`, 'm');
  const match = content.match(re);
  return match ? match[1].trim() : null;
}

/**
 * Attempt to read and parse a supabase/config.toml at the given project root.
 * Returns null if not found or unreadable.
 */
async function readSupabaseConfig(projectRoot: string): Promise<{
  name: string | null;
  projectId: string | null;
  apiPort: number;
} | null> {
  const configPath = path.join(projectRoot, 'supabase', 'config.toml');
  try {
    const content = await fs.readFile(configPath, 'utf8');
    const projectId = extractTomlValue(content, 'project_id');
    const name = extractTomlValue(content, 'name') || extractTomlValue(content, 'project_name');
    const portStr = extractTomlValue(content, 'port');
    const apiPort = portStr ? parseInt(portStr, 10) : 54321;
    return { name, projectId, apiPort: isNaN(apiPort) ? 54321 : apiPort };
  } catch {
    return null;
  }
}

/**
 * Check if a directory entry looks like a Supabase project.
 * Indicators: supabase/config.toml, supabase/.temp/project-ref, .supabase/
 */
async function detectSupabaseProject(dir: string): Promise<DiscoveredSupabaseProject | null> {
  const supabaseDir = path.join(dir, 'supabase');
  const dotSupabaseDir = path.join(dir, '.supabase');
  const configToml = path.join(supabaseDir, 'config.toml');
  const projectRefFile = path.join(supabaseDir, '.temp', 'project-ref');

  let hasConfig = false;
  let hasCloudLink = false;
  let hasLocalRuntime = false;
  let projectId: string | null = null;

  // Check supabase/config.toml
  try {
    await fs.access(configToml);
    hasConfig = true;
  } catch { /* not found */ }

  // Check .supabase/ directory (local runtime marker)
  try {
    await fs.access(dotSupabaseDir);
    hasLocalRuntime = true;
  } catch { /* not found */ }

  if (!hasConfig && !hasLocalRuntime) return null;

  // Check supabase/.temp/project-ref (cloud link)
  try {
    const ref = await fs.readFile(projectRefFile, 'utf8');
    projectId = ref.trim();
    hasCloudLink = true;
  } catch { /* not linked to cloud */ }

  // Parse config.toml
  const config = hasConfig ? await readSupabaseConfig(dir) : null;
  if (config?.projectId && !projectId) {
    projectId = config.projectId;
  }

  const name = config?.name || path.basename(dir);
  const localPort = config?.apiPort ?? 54321;

  return {
    projectPath: dir,
    name,
    projectId,
    localPort,
    hasCloudLink,
    hasLocalRuntime,
  };
}

/**
 * Recursively scan a directory for Supabase projects up to maxDepth levels deep.
 * Skips node_modules, .git, .next, and other noise directories.
 */
async function scanForSupabaseProjects(
  rootDir: string,
  maxDepth: number,
  currentDepth = 0
): Promise<DiscoveredSupabaseProject[]> {
  const results: DiscoveredSupabaseProject[] = [];

  // Check if this directory itself is a Supabase project
  const project = await detectSupabaseProject(rootDir);
  if (project) {
    results.push(project);
    // Don't recurse into a project directory — nested projects are unusual
    return results;
  }

  if (currentDepth >= maxDepth) return results;

  // Read subdirectories
  let entries: string[];
  try {
    const dirents = await fs.readdir(rootDir, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => !SKIP_DIRS.has(name) && !name.startsWith('.'));
  } catch {
    return results;
  }

  const subScans = await Promise.all(
    entries.map((e) =>
      scanForSupabaseProjects(path.join(rootDir, e), maxDepth, currentDepth + 1)
    )
  );
  for (const sub of subScans) results.push(...sub);
  return results;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out',
  '__pycache__', '.venv', 'venv', '.cache', 'coverage', '.turbo',
  'vendor', 'target', '.cargo',
]);

const DEFAULT_SCAN_PATHS = [
  getHomeDir(),
];

// ============================================================

/** supabase.instances.discover — Scan filesystem for local Supabase projects */
export async function instancesDiscover(body: AgentApiRequest, _auth: AgentAuthContext) {
  const scanPaths = Array.isArray(body.scanPaths)
    ? (body.scanPaths as string[])
    : DEFAULT_SCAN_PATHS;
  const maxDepth = typeof body.maxDepth === 'number' ? Math.min(body.maxDepth, 5) : 3;
  const autoRegister = body.autoRegister === true;

  // Deduplicate scan paths
  const uniquePaths = [...new Set(scanPaths)];

  const allFound: DiscoveredSupabaseProject[] = [];
  await Promise.all(
    uniquePaths.map(async (p) => {
      const found = await scanForSupabaseProjects(p, maxDepth);
      allFound.push(...found);
    })
  );

  // Deduplicate by projectPath
  const seenPaths = new Set<string>();
  const discovered = allFound.filter((d) => {
    if (seenPaths.has(d.projectPath)) return false;
    seenPaths.add(d.projectPath);
    return true;
  });

  let registered: SupabaseInstance[] = [];
  if (autoRegister && discovered.length > 0) {
    const existing = await supabaseInstanceStore.listInstances();
    const existingPaths = new Set(
      existing.map((i) => i.notes?.match(/projectPath:([^\s]+)/)?.[1]).filter(Boolean)
    );

    const toRegister = discovered.filter((d) => !existingPaths.has(d.projectPath));
    registered = await Promise.all(
      toRegister.map((d) =>
        supabaseInstanceStore.upsertInstance({
          name: d.name,
          type: 'local',
          connection: {
            url: `http://localhost:${d.localPort}`,
            anonKeyEnvVar: 'SUPABASE_LOCAL_ANON_KEY',
            serviceRoleKeyEnvVar: 'SUPABASE_LOCAL_SERVICE_ROLE_KEY',
            projectId: d.projectId ?? undefined,
          },
          notes: `Auto-discovered. projectPath:${d.projectPath}`,
        })
      )
    );
  }

  return {
    discovered,
    registered: autoRegister ? registered : [],
    scanPaths: uniquePaths,
    maxDepth,
  };
}

/** supabase.query — Execute a read-only query via the default Supabase client */
export async function query(body: AgentApiRequest, _auth: AgentAuthContext) {
  const table = body.table as string;
  const select = (body.select as string) || '*';
  const limit = typeof body.limit === 'number' ? body.limit : 100;
  const instanceId = body.instanceId as string | undefined;

  if (!table) throw Object.assign(new Error('table is required'), { statusCode: 400 });

  let client;
  if (instanceId) {
    const instance = await supabaseInstanceStore.getInstance(instanceId);
    if (!instance) throw Object.assign(new Error(`Instance not found: ${instanceId}`), { statusCode: 404 });
    client = getClientForInstance(instance.connection.url, instance.connection.serviceRoleKeyEnvVar);
  } else {
    client = getDefaultClient();
  }

  const { data, error, count } = await client
    .from(table)
    .select(select, { count: 'exact' })
    .limit(limit);

  if (error) {
    throw Object.assign(new Error(error.message), { statusCode: 400, details: error });
  }

  return { data, count };
}
