import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { AppRegistryData, AppRegistryEntry, AppCategory } from '@/lib/types';
import { pm2List, pm2Exec } from '@/lib/host-bridge/client';
import { tracked, withTiming } from '@/lib/api-tracking';
import { validateAlwaysOnConfig } from '@/lib/app-always-on-monitor';
import { findWebGateService } from '@/lib/app-webgate';
import type { GatewayServicesData } from '@/lib/types';

const PM2_EXEC_TIMEOUT_MS = 30000;

interface AppActionBody {
  action?: string;
  id?: string;
  name?: string;
  description?: string;
  icon?: string;
  iconType?: 'emoji' | 'lucide';
  color?: string;
  category?: AppCategory;
  tags?: string[];
  url?: string;
  path?: string;
  pm2Name?: string;
  alwaysOn?: boolean;
  healthCheck?: { type: 'port' | 'http'; target: string };
  source?: 'manual' | 'auto';
  autoRegistered?: boolean;
  portConflict?: { port: number; conflictsWith: string };
  sortOrder?: number;
  orderedIds?: string[];
}

const DEFAULT_DATA: AppRegistryData = {
  apps: [],
  lastUpdated: new Date().toISOString(),
};

export const GET = withTiming('/api/apps', tracked('/api/apps', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  const data = await readJsonFile<AppRegistryData>(DataPaths.appRegistry, DEFAULT_DATA);

  // Enrich apps with tunnel URLs from gateway-services.json
  try {
    const gwData = await readJsonFile<GatewayServicesData>(
      DataPaths.gatewayServices, { services: [], lastUpdated: '' }
    );
    for (const app of data.apps) {
      const service = findWebGateService(app, gwData.services);
      if (service) {
        app.webGate = {
          name: service.name,
          url: service.url,
          port: service.port,
          status: service.status,
          locked: service.locked,
        };
        if (service.status === 'active') app.tunnelUrl = service.url;
      }
    }
  } catch { /* gateway-services.json missing — no tunnel URLs */ }

  return NextResponse.json({ apps: data.apps }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}));

export const POST = tracked('/api/apps', async (request: NextRequest) => {
  try {
    const authDenied = await requireAuthOrLocal(request, 'write');
    if (authDenied) return authDenied;

    let body: AppActionBody;
    try {
      body = await request.json() as AppActionBody;
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON body' },
        { status: 400 }
      );
    }
    const { action } = body;

    switch (action) {
      case 'create': {
        const { name, description, icon, iconType, color, category, tags, url, path, pm2Name, alwaysOn, healthCheck, source, autoRegistered, portConflict } = body;
        if (!name) {
          return NextResponse.json({ success: false, error: 'Name is required' }, { status: 400 });
        }

        const newApp: AppRegistryEntry = {
          id: uuidv4(),
          name,
          description: description || '',
          icon: icon || '📦',
          iconType: iconType || 'emoji',
          color: color || '#3B82F6',
          category: category || 'other',
          tags: tags || [],
          url: url || undefined,
          path: path || undefined,
          pm2Name: pm2Name || undefined,
          alwaysOn: alwaysOn ?? false,
          healthCheck: healthCheck || undefined,
          sortOrder: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...(source && { source }),
          ...(autoRegistered !== undefined && { autoRegistered }),
          ...(portConflict && { portConflict }),
        };

        const validationError = validateAlwaysOnConfig(newApp);
        if (validationError) {
          return NextResponse.json({ success: false, error: validationError }, { status: 400 });
        }

        await withFileLock(DataPaths.appRegistry, async () => {
          const data = await readJsonFile<AppRegistryData>(DataPaths.appRegistry, DEFAULT_DATA);
          newApp.sortOrder = data.apps.length;
          data.apps.push(newApp);
          data.lastUpdated = new Date().toISOString();
          await writeJsonFile(DataPaths.appRegistry, data);
        });

        return NextResponse.json({ success: true, app: newApp });
      }

      case 'update': {
        const { id, ...rawUpdates } = body;
        const updates = rawUpdates as Record<string, unknown>;
        if (!id) {
          return NextResponse.json({ success: false, error: 'App ID is required' }, { status: 400 });
        }

        let updatedApp: AppRegistryEntry | null = null;
        let validationError: string | null = null;

        await withFileLock(DataPaths.appRegistry, async () => {
          const data = await readJsonFile<AppRegistryData>(DataPaths.appRegistry, DEFAULT_DATA);
          const index = data.apps.findIndex(a => a.id === id);
          if (index === -1) {
            return;
          }

          const allowedFields = ['name', 'description', 'icon', 'iconType', 'color', 'category', 'tags', 'url', 'path', 'pm2Name', 'healthCheck', 'alwaysOn', 'runsOn', 'sortOrder'];
          const candidate = { ...data.apps[index] };
          for (const field of allowedFields) {
            if (updates[field] !== undefined) {
              (candidate as unknown as Record<string, unknown>)[field] = updates[field];
            }
          }
          validationError = validateAlwaysOnConfig(candidate);
          if (validationError) return;

          candidate.updatedAt = new Date().toISOString();
          data.apps[index] = candidate;
          data.lastUpdated = new Date().toISOString();
          updatedApp = candidate;
          await writeJsonFile(DataPaths.appRegistry, data);
        });

        if (validationError) {
          return NextResponse.json({ success: false, error: validationError }, { status: 400 });
        }

        if (!updatedApp) {
          return NextResponse.json({ success: false, error: 'App not found' }, { status: 404 });
        }

        return NextResponse.json({ success: true, app: updatedApp });
      }

      case 'delete': {
        const { id: deleteId } = body;
        if (!deleteId) {
          return NextResponse.json({ success: false, error: 'App ID is required' }, { status: 400 });
        }

        let found = false;

        await withFileLock(DataPaths.appRegistry, async () => {
          const data = await readJsonFile<AppRegistryData>(DataPaths.appRegistry, DEFAULT_DATA);
          const before = data.apps.length;
          data.apps = data.apps.filter(a => a.id !== deleteId);
          found = data.apps.length < before;
          if (found) {
            data.lastUpdated = new Date().toISOString();
            await writeJsonFile(DataPaths.appRegistry, data);
          }
        });

        if (!found) {
          return NextResponse.json({ success: false, error: 'App not found' }, { status: 404 });
        }

        return NextResponse.json({ success: true });
      }

      case 'start': {
        const { id: startId } = body;
        if (!startId) {
          return NextResponse.json({ success: false, error: 'App ID is required' }, { status: 400 });
        }

        const data = await readJsonFile<AppRegistryData>(DataPaths.appRegistry, DEFAULT_DATA);
        const app = data.apps.find(a => a.id === startId);
        if (!app) {
          return NextResponse.json({ success: false, error: 'App not found' }, { status: 404 });
        }

        if (!app.pm2Name) {
          return NextResponse.json({ success: false, error: 'App has no PM2 process configured' }, { status: 400 });
        }

        try {
          // Check if process exists and is stopped, or needs restart
          const processes = await pm2List();
          const proc = processes.find(p => p.name === app.pm2Name);

          if (proc) {
            if (proc.status === 'online') {
              return NextResponse.json({ success: true, message: 'Already running', alreadyRunning: true });
            }
            // Restart stopped/errored process
            await pm2Exec('restart', app.pm2Name!, { timeout: PM2_EXEC_TIMEOUT_MS });
          } else {
            // Try to start it
            await pm2Exec('start', app.pm2Name!, { timeout: PM2_EXEC_TIMEOUT_MS });
          }

          return NextResponse.json({ success: true, message: `Starting ${app.name}...` });
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          return NextResponse.json({ success: false, error: `Failed to start: ${msg}` }, { status: 500 });
        }
      }

      case 'reorder': {
        const { orderedIds } = body;
        if (!Array.isArray(orderedIds)) {
          return NextResponse.json({ success: false, error: 'orderedIds array required' }, { status: 400 });
        }

        await withFileLock(DataPaths.appRegistry, async () => {
          const data = await readJsonFile<AppRegistryData>(DataPaths.appRegistry, DEFAULT_DATA);
          for (let i = 0; i < orderedIds.length; i++) {
            const app = data.apps.find(a => a.id === orderedIds[i]);
            if (app) app.sortOrder = i;
          }
          data.apps.sort((a, b) => a.sortOrder - b.sortOrder);
          data.lastUpdated = new Date().toISOString();
          await writeJsonFile(DataPaths.appRegistry, data);
        });

        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error('[Apps API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
});
