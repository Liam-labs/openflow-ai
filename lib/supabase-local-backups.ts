import { execFile } from 'child_process';
import type { Dirent } from 'fs';
import { lstat, readdir, realpath, stat } from 'fs/promises';
import path from 'path';

export type SupabaseBackupTier = 'daily' | 'hourly';
export type SupabaseBackupHealth = 'healthy' | 'stale' | 'offline' | 'unknown';

export interface LocalSupabaseBackup {
  id: string;
  filename: string;
  projectId: string;
  projectName: string;
  tier: SupabaseBackupTier;
  createdAt: string;
  sizeBytes: number;
  status: 'available';
}

export interface LocalSupabaseBackupProject {
  id: string;
  name: string;
  slug: string;
  status: SupabaseBackupHealth;
  containerRunning: boolean | null;
  latestBackupAt: string | null;
  counts: { total: number; daily: number; hourly: number };
  totalSizeBytes: number;
  backups: LocalSupabaseBackup[];
}

export interface LocalSupabaseBackupInventory {
  summary: {
    totalBackups: number;
    totalProjects: number;
    healthyProjects: number;
    staleProjects: number;
    offlineProjects: number;
    unknownProjects: number;
    lastBackupAt: string | null;
    totalSizeBytes: number;
  };
  projects: LocalSupabaseBackupProject[];
}

const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FRESH_HOURLY_MS = 90 * 60 * 1000;

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export function isSafeCustomBackupSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SAFE_SLUG.test(slug);
}

export function parseCustomBackupFilename(
  projectSlug: string,
  filename: unknown,
): { tier: SupabaseBackupTier } | null {
  if (!isSafeCustomBackupSlug(projectSlug) || typeof filename !== 'string') return null;
  if (filename.length > 255 || path.basename(filename) !== filename) return null;
  if (filename.includes('..') || filename.includes('\0')) return null;

  for (const tier of ['daily', 'hourly'] as const) {
    const prefix = `${projectSlug}-${tier}-`;
    if (filename.startsWith(prefix) && filename.endsWith('.dump') && filename.length > prefix.length + 5) {
      return { tier };
    }
  }
  return null;
}

export interface RunningSupabaseContainers {
  containers: Set<string>;
  apiPortSlugs: Map<number, string>;
  available: boolean;
  error: string | null;
}

interface LocalSupabaseIdentityCandidate {
  type: string;
  name: string;
  connection: {
    url: string;
    projectId?: string;
  };
  containerRef?: string;
  portMap?: { api: number };
}

export function resolveKnownLocalSupabaseProjects(
  instances: LocalSupabaseIdentityCandidate[],
  apiPortSlugs: ReadonlyMap<number, string>,
): Map<string, string> {
  const projects = new Map<string, string>();

  for (const instance of instances) {
    if (instance.type !== 'local') continue;
    let apiPort = instance.portMap?.api;
    if (!apiPort) {
      try {
        const parsedPort = Number(new URL(instance.connection.url).port);
        if (Number.isInteger(parsedPort) && parsedPort > 0) apiPort = parsedPort;
      } catch {
        // Invalid legacy URL: fall through to the stored identity fields.
      }
    }

    const registeredProjectId = instance.connection.projectId;
    const projectIdIsConcrete = isSafeCustomBackupSlug(registeredProjectId)
      && !registeredProjectId.startsWith('SUPABASE_PROJECT_');
    const slug = projectIdIsConcrete
      ? registeredProjectId
      : apiPort
        ? apiPortSlugs.get(apiPort)
        : undefined;
    const fallbackSlug = slug ?? (isSafeCustomBackupSlug(instance.containerRef) ? instance.containerRef : undefined);
    if (fallbackSlug) projects.set(fallbackSlug, instance.name);
  }

  return projects;
}

export async function listRunningSupabaseContainers(): Promise<RunningSupabaseContainers> {
  return new Promise(resolve => {
    execFile(
      'docker',
      ['ps', '--format', '{{.Names}}\t{{.Ports}}'],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({
            containers: new Set(),
            apiPortSlugs: new Map(),
            available: false,
            error: String(error.message || 'Docker container discovery failed'),
          });
          return;
        }
        const rows = String(stdout)
          .split('\n')
          .map(row => row.trim())
          .filter(Boolean);
        const containers = new Set<string>();
        const apiPortSlugs = new Map<number, string>();
        for (const row of rows) {
          const [name, ports = ''] = row.split('\t');
          if (name.startsWith('supabase_db_')) containers.add(name);
          if (name.startsWith('supabase_kong_')) {
            const portMatch = ports.match(/(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):(\d+)->8000\/tcp/);
            if (portMatch) apiPortSlugs.set(Number(portMatch[1]), name.slice('supabase_kong_'.length));
          }
        }
        resolve({ containers, apiPortSlugs, available: true, error: null });
      },
    );
  });
}

export async function resolveCustomBackupFile(
  backupsRoot: string,
  projectSlug: string,
  filename: string,
): Promise<{ filePath: string; tier: SupabaseBackupTier; sizeBytes: number }> {
  if (!isSafeCustomBackupSlug(projectSlug)) {
    throw httpError('Invalid projectSlug', 400);
  }
  const parsed = parseCustomBackupFilename(projectSlug, filename);
  if (!parsed) {
    throw httpError('Invalid backup filename for selected project', 400);
  }

  const rootPath = path.resolve(backupsRoot);
  const filePath = path.resolve(rootPath, projectSlug, parsed.tier, filename);
  if (!filePath.startsWith(`${rootPath}${path.sep}`)) {
    throw httpError('Backup path escapes the configured backup directory', 400);
  }

  let fileInfo;
  try {
    fileInfo = await lstat(filePath);
  } catch {
    throw httpError('Backup file not found', 404);
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw httpError('Backup must be a regular file', 400);
  }

  const [canonicalRoot, canonicalFile] = await Promise.all([
    realpath(rootPath),
    realpath(filePath),
  ]);
  if (!canonicalFile.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw httpError('Backup path escapes the configured backup directory', 400);
  }

  return { filePath: canonicalFile, tier: parsed.tier, sizeBytes: fileInfo.size };
}

export async function scanLocalSupabaseBackups(options: {
  backupsRoot: string;
  runningContainers: Set<string>;
  knownProjects?: ReadonlyMap<string, string>;
  dockerAvailable?: boolean;
  now?: Date;
}): Promise<LocalSupabaseBackupInventory> {
  const {
    backupsRoot,
    runningContainers,
    knownProjects = new Map<string, string>(),
    dockerAvailable = true,
    now = new Date(),
  } = options;
  let projectEntries: Dirent[] = [];
  let canonicalRoot: string | null = null;
  try {
    projectEntries = await readdir(backupsRoot, { withFileTypes: true });
    canonicalRoot = await realpath(backupsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      canonicalRoot = null;
    } else {
      throw error;
    }
  }

  const projectSlugs = new Set<string>();
  for (const entry of projectEntries) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && isSafeCustomBackupSlug(entry.name)) {
      projectSlugs.add(entry.name);
    }
  }
  for (const containerName of runningContainers) {
    if (!containerName.startsWith('supabase_db_')) continue;
    const slug = containerName.slice('supabase_db_'.length);
    if (isSafeCustomBackupSlug(slug)) projectSlugs.add(slug);
  }
  for (const slug of knownProjects.keys()) {
    if (isSafeCustomBackupSlug(slug)) projectSlugs.add(slug);
  }

  const projects: LocalSupabaseBackupProject[] = [];
  for (const slug of projectSlugs) {
    const backups: LocalSupabaseBackup[] = [];
    for (const tier of ['daily', 'hourly'] as const) {
      const tierDir = path.join(backupsRoot, slug, tier);
      let fileEntries: Dirent[];
      try {
        const tierInfo = await lstat(tierDir);
        if (!tierInfo.isDirectory() || tierInfo.isSymbolicLink()) continue;
        const canonicalTier = await realpath(tierDir);
        if (!canonicalRoot || !canonicalTier.startsWith(`${canonicalRoot}${path.sep}`)) continue;
        fileEntries = await readdir(tierDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }

      for (const fileEntry of fileEntries) {
        if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) continue;
        const filename = fileEntry.name;
        if (parseCustomBackupFilename(slug, filename)?.tier !== tier) continue;
        try {
          const info = await stat(path.join(tierDir, filename));
          // The backup schedulers delete dumps below this floor because they
          // indicate a truncated/failed pg_dump. Never let one advertise false
          // freshness or inflate the visible inventory before cleanup wins.
          if (!info.isFile() || info.size < 1000) continue;
          backups.push({
            id: `${slug}:${tier}:${filename}`,
            filename,
            projectId: slug,
            projectName: slug,
            tier,
            createdAt: info.mtime.toISOString(),
            sizeBytes: info.size,
            status: 'available',
          });
        } catch {
          // A retention job may remove a file between readdir and stat. Omit it
          // from this snapshot and let the next poll see the settled state.
        }
      }
    }

    const isRunning = runningContainers.has(`supabase_db_${slug}`);
    const isKnown = knownProjects.has(slug);
    if (backups.length === 0 && !isRunning && !isKnown) continue;
    const projectName = knownProjects.get(slug) ?? slug;
    for (const backup of backups) backup.projectName = projectName;
    backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latestHourly = backups.find(backup => backup.tier === 'hourly');
    const containerRunning = dockerAvailable ? isRunning : null;
    const hourlyAge = latestHourly ? now.getTime() - new Date(latestHourly.createdAt).getTime() : Infinity;
    const status: SupabaseBackupHealth = !dockerAvailable
      ? 'unknown'
      : !containerRunning
      ? 'offline'
      : hourlyAge >= 0 && hourlyAge <= FRESH_HOURLY_MS
        ? 'healthy'
        : 'stale';
    const daily = backups.filter(backup => backup.tier === 'daily').length;
    const hourly = backups.length - daily;

    projects.push({
      id: slug,
      name: projectName,
      slug,
      status,
      containerRunning,
      latestBackupAt: backups[0]?.createdAt ?? null,
      counts: { total: backups.length, daily, hourly },
      totalSizeBytes: backups.reduce((sum, backup) => sum + backup.sizeBytes, 0),
      backups,
    });
  }

  projects.sort((a, b) => a.name.localeCompare(b.name));
  const allBackups = projects.flatMap(project => project.backups);
  const lastBackupAt = allBackups.reduce<string | null>(
    (latest, backup) => !latest || backup.createdAt > latest ? backup.createdAt : latest,
    null,
  );
  const healthyProjects = projects.filter(project => project.status === 'healthy').length;
  const staleProjects = projects.filter(project => project.status === 'stale').length;
  const offlineProjects = projects.filter(project => project.status === 'offline').length;
  const unknownProjects = projects.filter(project => project.status === 'unknown').length;

  return {
    summary: {
      totalBackups: allBackups.length,
      totalProjects: projects.length,
      healthyProjects,
      staleProjects,
      offlineProjects,
      unknownProjects,
      lastBackupAt,
      totalSizeBytes: projects.reduce((sum, project) => sum + project.totalSizeBytes, 0),
    },
    projects,
  };
}
