import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';
import { NextRequest } from 'next/server';
import { requireAuthOrLocal } from '@/lib/api-auth';

const EVENTS_FILE = appPath('.AppData', 'earlyoom-events.json');

interface MemoryEvent {
  id: string;
  timestamp: string;
  type: 'earlyoom_kill' | 'ollama_idle_unload';
  severity: 'critical' | 'warning' | 'info';
  killedPid?: string;
  killedProcess?: string;
  killedUid?: string;
  memAvailPercent?: string;
  swapFreePercent?: string;
  memoryInfo?: {
    total: number;
    used: number;
    free: number;
    available: number;
  };
  model?: string;
  message: string;
}

export const GET = tracked('/api/memory/events', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  try {
    const raw = await fs.readFile(EVENTS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const events: MemoryEvent[] = data.events || [];

    // Sort by timestamp descending (most recent first)
    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Get current memory info
    let memoryInfo = null;
    try {
      const meminfo = await fs.readFile('/proc/meminfo', 'utf-8');
      const lines = meminfo.split('\n');
      const getValue = (key: string) => {
        const line = lines.find(l => l.startsWith(key));
        if (!line) return 0;
        return parseInt(line.split(/\s+/)[1], 10); // Value in kB
      };
      memoryInfo = {
        totalMB: Math.round(getValue('MemTotal:') / 1024),
        availableMB: Math.round(getValue('MemAvailable:') / 1024),
        freeMB: Math.round(getValue('MemFree:') / 1024),
        swapTotalMB: Math.round(getValue('SwapTotal:') / 1024),
        swapFreeMB: Math.round(getValue('SwapFree:') / 1024),
      };
    } catch {
      // Ignore meminfo errors
    }

    return NextResponse.json({
      events,
      count: events.length,
      memoryInfo,
    });
  } catch (err) {
    // If file doesn't exist, return empty
    return NextResponse.json({
      events: [],
      count: 0,
      memoryInfo: null,
    });
  }
});

export const DELETE = tracked('/api/memory/events', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'write');
  if (denied) return denied;

  try {
    await fs.writeFile(EVENTS_FILE, JSON.stringify({ events: [] }, null, 2));
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: 'Failed to clear events' }, { status: 500 });
  }
});
