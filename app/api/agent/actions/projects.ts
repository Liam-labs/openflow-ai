/**
 * Projects Actions
 *
 * Actions for managing projects in DevFlow.
 */

import { loadConfig, saveConfig } from '@/lib/config';
import { trustCodexWorkspace } from '@/lib/codex-workspace-trust';
import { runProjectHealthChecks } from '@/lib/health-checks';
import type { AgentApiRequest, AgentAuthContext, Project, ProjectCategory } from '@/lib/types';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * projects.list - List all projects
 */
export async function list(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ projects: Project[]; count: number }> {
  const config = await loadConfig();

  // Optional filtering
  let projects = config.projects;

  if (body.category && typeof body.category === 'string') {
    projects = projects.filter(p => p.category === body.category);
  }

  if (body.tag && typeof body.tag === 'string') {
    projects = projects.filter(p => p.tags.includes(body.tag as string));
  }

  return {
    projects,
    count: projects.length,
  };
}

/**
 * projects.get - Get a single project by ID
 */
export async function get(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ project: Project }> {
  const projectId = body.projectId;

  if (!projectId || typeof projectId !== 'string') {
    throw new Error('projectId is required');
  }

  const config = await loadConfig();
  const project = config.projects.find(p => p.id === projectId);

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  return { project };
}

/**
 * projects.create - Create a new project
 */
export async function create(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ project: Project }> {
  const { name, description, path, category, tags, links, healthCheck, server } = body as {
    name?: string;
    description?: string;
    path?: string;
    category?: string;
    tags?: string[];
    links?: { local?: string; repo?: string; docs?: string };
    healthCheck?: { type?: string; port?: number; url?: string; label?: string };
    server?: { pm2Name?: string; port?: number; startCommand?: string; stopCommand?: string; autoStart?: boolean; watchdog?: { enabled: boolean } };
  };

  // Validation
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('name is required');
  }
  if (!path || typeof path !== 'string' || path.trim().length === 0) {
    throw new Error('path is required');
  }
  if (!category || !['tool', 'site', 'server', 'service', 'api', 'ai', 'development', 'automation', 'media', 'monitoring', 'utility', 'infrastructure', 'agent'].includes(category)) {
    throw new Error('category must be one of: tool, site, server, service, api, ai, development, automation, media, monitoring, utility, infrastructure, agent');
  }

  // Generate ID from name
  const id = slugify(name.trim());
  if (!id) {
    throw new Error('Could not generate valid ID from name');
  }

  // Load existing config and check for duplicates
  const config = await loadConfig();
  if (config.projects.some(p => p.id === id)) {
    throw new Error(`Project with ID "${id}" already exists`);
  }

  // Build health checks array
  const healthChecks = [];
  if (healthCheck && healthCheck.type) {
    if (healthCheck.type === 'port' && healthCheck.port) {
      healthChecks.push({
        type: 'port' as const,
        port: healthCheck.port,
        label: healthCheck.label || 'Port Check',
      });
    } else if (healthCheck.type === 'http' && healthCheck.url) {
      healthChecks.push({
        type: 'http' as const,
        url: healthCheck.url,
        label: healthCheck.label || 'HTTP Check',
      });
    }
  }

  // Build server config if provided
  const serverConfig = server && typeof server === 'object' ? {
    ...(typeof server.pm2Name === 'string' ? { pm2Name: server.pm2Name.trim() } : {}),
    ...(typeof server.port === 'number' ? { port: server.port } : {}),
    ...(typeof server.startCommand === 'string' ? { startCommand: server.startCommand.trim() } : {}),
    ...(typeof server.stopCommand === 'string' ? { stopCommand: server.stopCommand.trim() } : {}),
    ...(typeof server.autoStart === 'boolean' ? { autoStart: server.autoStart } : {}),
    ...(server.watchdog && typeof server.watchdog === 'object' ? { watchdog: server.watchdog } : {}),
  } : undefined;

  // Build new project
  const newProject: Project = {
    id,
    name: name.trim(),
    description: description?.trim() || '',
    path: path.trim(),
    category: category as ProjectCategory,
    tags: Array.isArray(tags) ? tags.filter((t: string) => t.trim()) : [],
    healthChecks,
    links: {
      local: links?.local?.trim() || undefined,
      repo: links?.repo?.trim() || undefined,
      docs: links?.docs?.trim() || undefined,
    },
    ...(serverConfig && Object.keys(serverConfig).length > 0 ? { server: serverConfig as Project['server'] } : {}),
  };

  // Add to config and save
  await trustCodexWorkspace(newProject.path);
  config.projects.push(newProject);
  await saveConfig(config);

  return { project: newProject };
}

/**
 * projects.update - Update project configuration
 */
export async function update(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ project: Project }> {
  const projectId = body.projectId;

  if (!projectId || typeof projectId !== 'string') {
    throw new Error('projectId is required');
  }

  const config = await loadConfig();
  const projectIndex = config.projects.findIndex(p => p.id === projectId);

  if (projectIndex === -1) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const project = config.projects[projectIndex];

  // Update fields if provided
  if (body.name !== undefined && typeof body.name === 'string') {
    project.name = body.name.trim();
  }
  if (body.description !== undefined && typeof body.description === 'string') {
    project.description = body.description.trim();
  }
  if (body.path !== undefined && typeof body.path === 'string') {
    const updatedPath = body.path.trim();
    await trustCodexWorkspace(updatedPath);
    project.path = updatedPath;
  }
  if (body.category !== undefined && ['tool', 'site', 'server', 'service', 'api', 'ai', 'development', 'automation', 'media', 'monitoring', 'utility', 'infrastructure', 'agent'].includes(body.category as string)) {
    project.category = body.category as ProjectCategory;
  }
  if (body.tags !== undefined && Array.isArray(body.tags)) {
    project.tags = body.tags.filter((t: unknown) => typeof t === 'string' && (t as string).trim());
  }
  if (body.links !== undefined && typeof body.links === 'object') {
    const links = body.links as Record<string, unknown>;
    project.links = {
      ...project.links,
      local: typeof links.local === 'string' ? links.local.trim() : project.links.local,
      repo: typeof links.repo === 'string' ? links.repo.trim() : project.links.repo,
      docs: typeof links.docs === 'string' ? links.docs.trim() : project.links.docs,
    };
  }
  if (body.server !== undefined && typeof body.server === 'object') {
    const s = body.server as Record<string, unknown>;
    const existing = (project.server || {}) as Record<string, unknown>;
    // Merge: new values override existing, keep existing for unspecified fields
    const merged: Record<string, unknown> = { ...existing };
    if (typeof s.port === 'number') merged.port = s.port;
    if (typeof s.startCommand === 'string') merged.startCommand = s.startCommand.trim();
    if (typeof s.stopCommand === 'string') merged.stopCommand = s.stopCommand.trim();
    if (typeof s.pm2Name === 'string') merged.pm2Name = s.pm2Name.trim();
    if (typeof s.autoStart === 'boolean') merged.autoStart = s.autoStart;
    if (s.watchdog && typeof s.watchdog === 'object') merged.watchdog = s.watchdog;
    // Ensure required fields have defaults
    if (typeof merged.port !== 'number') merged.port = 0;
    if (typeof merged.startCommand !== 'string') merged.startCommand = '';
    project.server = merged as unknown as NonNullable<Project['server']>;
  }
  if (body.healthChecks !== undefined && Array.isArray(body.healthChecks)) {
    project.healthChecks = (body.healthChecks as Array<Record<string, unknown>>).filter(hc => {
      if (hc.type === 'port' && typeof hc.port === 'number') return true;
      if (hc.type === 'http' && typeof hc.url === 'string') return true;
      if (hc.type === 'process' && typeof hc.processName === 'string') return true;
      return false;
    }) as unknown as Project['healthChecks'];
  }

  config.projects[projectIndex] = project;
  await saveConfig(config);

  return { project };
}

/**
 * projects.delete - Delete a project (admin only)
 */
export async function remove(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{ deleted: boolean; projectId: string }> {
  const projectId = body.projectId;

  if (!projectId || typeof projectId !== 'string') {
    throw new Error('projectId is required');
  }

  const config = await loadConfig();
  const projectIndex = config.projects.findIndex(p => p.id === projectId);

  if (projectIndex === -1) {
    const err = new Error(`Project not found: ${projectId}`);
    (err as NodeJS.ErrnoException & { statusCode: number }).statusCode = 404;
    throw err;
  }

  config.projects.splice(projectIndex, 1);
  await saveConfig(config);

  return { deleted: true, projectId };
}

/**
 * projects.health - Run health checks for a project
 */
export async function health(
  body: AgentApiRequest,
  _auth: AgentAuthContext
): Promise<{
  projectId: string;
  overallStatus: string;
  checks: Array<{
    checkId: string;
    label: string;
    status: string;
    message?: string;
    responseTime?: number;
  }>;
  lastChecked: string;
}> {
  const projectId = body.projectId;

  if (!projectId || typeof projectId !== 'string') {
    throw new Error('projectId is required');
  }

  const config = await loadConfig();
  const project = config.projects.find(p => p.id === projectId);

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  if (project.healthChecks.length === 0) {
    return {
      projectId,
      overallStatus: 'unknown',
      checks: [],
      lastChecked: new Date().toISOString(),
    };
  }

  const result = await runProjectHealthChecks(project);

  return {
    projectId: result.projectId,
    overallStatus: result.overallStatus,
    checks: result.checks,
    lastChecked: result.lastChecked,
  };
}
