import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { loadConfig, saveConfig } from '@/lib/config';
import { getListeningPorts } from '@/lib/port-utils';
import { Project, ProjectCategory } from '@/lib/types';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { getHomeDir } from '@/lib/home-dir';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/projects', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const config = await loadConfig();
    return NextResponse.json({
      projects: config.projects,
      settings: config.settings,
    }, { headers: { 'Cache-Control': 'public, max-age=60' } });
  } catch (error) {
    console.error('Error fetching projects:', error);
    return NextResponse.json(
      { error: 'Failed to fetch projects' },
      { status: 500 }
    );
  }
});

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export const POST = tracked('/api/projects', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body = await request.json();
    const { name, description, path, category, tags, links, healthCheck, server, createDirectory } = body;

    // Validation
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }
    if (!path || typeof path !== 'string' || path.trim().length === 0) {
      return NextResponse.json({ error: 'Path is required' }, { status: 400 });
    }
    if (!category || !['tool', 'site', 'server', 'service', 'api', 'ai'].includes(category)) {
      return NextResponse.json({ error: 'Valid category is required' }, { status: 400 });
    }

    // Generate ID from name
    const id = slugify(name.trim());
    if (!id) {
      return NextResponse.json({ error: 'Could not generate valid ID from name' }, { status: 400 });
    }

    // Load existing config and check for duplicates
    const config = await loadConfig();
    if (config.projects.some(p => p.id === id)) {
      return NextResponse.json({ error: `Project with ID "${id}" already exists` }, { status: 409 });
    }

    // Port uniqueness validation — two layers:
    // 1. Registry check: another project in projects.json claims this port
    // 2. Live check: port is currently bound by a running process
    const declaredPort = server?.port ? parseInt(server.port, 10) : 0;
    if (declaredPort > 0) {
      const conflicting = config.projects.find(p => p.server?.port === declaredPort);
      if (conflicting) {
        return NextResponse.json(
          { error: `Port ${declaredPort} is already registered for "${conflicting.name}"` },
          { status: 409 }
        );
      }

      const listeningPorts = await getListeningPorts();
      const liveConflict = listeningPorts.find(p => p.port === declaredPort);
      if (liveConflict) {
        return NextResponse.json(
          { error: `Port ${declaredPort} is currently in use by process "${liveConflict.process}" (PID ${liveConflict.pid})` },
          { status: 409 }
        );
      }
    }

    // Build health checks array
    const healthChecks = [];
    if (healthCheck && healthCheck.type) {
      if (healthCheck.type === 'port' && healthCheck.port) {
        healthChecks.push({
          type: 'port' as const,
          port: parseInt(healthCheck.port, 10),
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
      ...(declaredPort > 0 && {
        server: {
          port: declaredPort,
          startCommand: server?.startCommand?.trim() || '',
          stopCommand: server?.stopCommand?.trim() || undefined,
          autoStart: server?.autoStart ?? false,
          pm2Name: server?.pm2Name?.trim() || undefined,
        },
      }),
    };

    // Optionally create the project directory
    if (createDirectory) {
      const home = getHomeDir();
      if (!path.trim().startsWith(`${home}/`) || path.includes('..')) {
        return NextResponse.json(
          { error: `Directory creation only allowed under ${home}/` },
          { status: 403 }
        );
      }
      await fs.mkdir(path.trim(), { recursive: true });
    }

    // Add to config and save
    config.projects.push(newProject);
    await saveConfig(config);

    return NextResponse.json({ success: true, project: newProject, directoryCreated: !!createDirectory });
  } catch (error) {
    console.error('Error creating project:', error);
    return NextResponse.json(
      { error: 'Failed to create project' },
      { status: 500 }
    );
  }
});

export const DELETE = tracked('/api/projects', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body = await request.json();
    const { projectId, deleteDirectory } = body;

    if (!projectId || typeof projectId !== 'string') {
      return NextResponse.json({ error: 'Project ID is required' }, { status: 400 });
    }

    const config = await loadConfig();
    const projectIndex = config.projects.findIndex(p => p.id === projectId);

    if (projectIndex === -1) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const project = config.projects[projectIndex];
    const projectPath = project.path;

    // Delete directory FIRST (if requested) — before removing from config.
    // Prevents orphan state: if rm fails, project stays in registry.
    let directoryDeleted = false;
    if (deleteDirectory && projectPath) {
      const homeDir = getHomeDir();
      if (!projectPath.startsWith(`${homeDir}/`) || projectPath.includes('..')) {
        return NextResponse.json(
          { error: `Directory deletion only allowed for paths under ${homeDir}/` },
          { status: 403 }
        );
      }

      try {
        const fsPromises = await import('fs/promises');
        await fsPromises.rm(projectPath, { recursive: true, force: true });
        directoryDeleted = true;
      } catch (dirError) {
        console.error('Failed to delete directory:', dirError);
        return NextResponse.json({
          success: false,
          error: 'Failed to delete directory — project not removed from registry',
          directoryError: dirError instanceof Error ? dirError.message : 'Unknown error',
        }, { status: 500 });
      }
    }

    // Remove from config only after directory is successfully deleted
    config.projects.splice(projectIndex, 1);
    await saveConfig(config);

    return NextResponse.json({ success: true, project, directoryDeleted });
  } catch (error) {
    console.error('Error deleting project:', error);
    return NextResponse.json(
      { error: 'Failed to delete project' },
      { status: 500 }
    );
  }
});

export const PATCH = tracked('/api/projects', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;

  try {
    const body = await request.json();
    const { projectId, port } = body;

    if (!projectId) {
      return NextResponse.json({ error: 'Project ID is required' }, { status: 400 });
    }

    const config = await loadConfig();
    let projectIndex = config.projects.findIndex(p => p.id === projectId);

    // Auto-create a minimal project entry if this is an unconfigured PM2 process
    if (projectIndex === -1 && body.pm2Name) {
      const portNum = port ? parseInt(port, 10) : undefined;

      // Check port uniqueness before auto-creating
      if (portNum) {
        const conflicting = config.projects.find(p => p.server?.port === portNum);
        if (conflicting) {
          return NextResponse.json(
            { error: `Port ${portNum} is already configured for "${conflicting.name}"` },
            { status: 409 }
          );
        }
      }

      const newProject: Project = {
        id: projectId,
        name: body.pm2Name,
        description: '',
        path: body.cwd || getHomeDir(),
        category: 'tool' as ProjectCategory,
        tags: ['pm2'],
        healthChecks: portNum ? [{ type: 'port' as const, port: portNum, label: 'Server' }] : [],
        links: portNum ? { local: `http://localhost:${portNum}` } : {},
        server: {
          port: portNum || 0,
          startCommand: `pm2 start ${body.pm2Name}`,
          stopCommand: `pm2 stop ${body.pm2Name}`,
          pm2Name: body.pm2Name,
          autoStart: false,
        },
      };
      config.projects.push(newProject);
      await saveConfig(config);
      return NextResponse.json({ success: true, project: newProject, created: true });
    }

    if (projectIndex === -1) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const project = config.projects[projectIndex];

    // Update name if provided
    if (body.name !== undefined && typeof body.name === 'string' && body.name.trim()) {
      project.name = body.name.trim();
    }

    // Update description if provided
    if (body.description !== undefined && typeof body.description === 'string') {
      project.description = body.description.trim();
    }

    // Update category if provided
    const VALID_CATEGORIES = ['tool', 'site', 'server', 'service', 'api', 'ai',
      'development', 'automation', 'media', 'monitoring', 'infrastructure', 'agent'];
    if (body.category !== undefined && VALID_CATEGORIES.includes(body.category as string)) {
      project.category = body.category as ProjectCategory;
    }

    // Update watchdog.enabled if provided
    if (body.watchdog !== undefined) {
      if (typeof body.watchdog.enabled !== 'boolean') {
        return NextResponse.json({ error: 'watchdog.enabled must be a boolean' }, { status: 400 });
      }
      if (!project.server) {
        return NextResponse.json({ error: 'Project has no server config — cannot configure watchdog' }, { status: 400 });
      }
      if (!project.server.watchdog) {
        project.server.watchdog = { enabled: body.watchdog.enabled };
      } else {
        project.server.watchdog.enabled = body.watchdog.enabled;
      }
    }

    // Update port if provided
    if (port !== undefined) {
      const portNum = parseInt(port, 10);
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        return NextResponse.json({ error: 'Invalid port number' }, { status: 400 });
      }

      // Check port uniqueness against other projects
      const conflicting = config.projects.find(
        p => p.id !== projectId && p.server?.port === portNum
      );
      if (conflicting) {
        return NextResponse.json(
          { error: `Port ${portNum} is already configured for "${conflicting.name}"` },
          { status: 409 }
        );
      }

      // Initialize server config if not present
      if (!project.server) {
        project.server = {
          port: portNum,
          startCommand: '',
          autoStart: false,
        };
      } else {
        project.server.port = portNum;
      }

      // Update health checks to use new port
      const portCheckIndex = project.healthChecks.findIndex(h => h.type === 'port');
      if (portCheckIndex !== -1) {
        const existingCheck = project.healthChecks[portCheckIndex];
        if (existingCheck.type === 'port') {
          project.healthChecks[portCheckIndex] = {
            type: 'port',
            port: portNum,
            label: existingCheck.label,
          };
        }
      }

      // Update local link if it was a localhost URL
      if (project.links.local?.includes('localhost:')) {
        project.links.local = `http://localhost:${portNum}`;
      }

      // Update startCommand if it contains a port flag (-p XXXX or --port XXXX)
      if (project.server.startCommand) {
        // Replace -p followed by a number
        project.server.startCommand = project.server.startCommand
          .replace(/-p\s+\d+/, `-p ${portNum}`)
          .replace(/--port\s+\d+/, `--port ${portNum}`);
      }
    }

    config.projects[projectIndex] = project;
    await saveConfig(config);

    return NextResponse.json({ success: true, project, needsRestart: true });
  } catch (error) {
    console.error('Error updating project:', error);
    return NextResponse.json(
      { error: 'Failed to update project' },
      { status: 500 }
    );
  }
});
