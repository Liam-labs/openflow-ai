/**
 * /api/alerts — Persistent notification store for critical system alerts
 *
 * Provides a notification path for stability events that need the owner's attention.
 * The stability-alerts collab channel posts chat messages; this endpoint stores
 * actionable alerts that surface in the dashboard header badge.
 *
 * GET  /api/alerts
 *   Query: acknowledged=false (default) | true | all
 *          severity=critical,high (comma-separated, default: all)
 *          limit=N (default: 50)
 *   Response: { alerts: Alert[]; unacknowledgedCount: number }
 *
 * POST /api/alerts
 *   Body: { title, severity, message?, source?, metadata? }
 *   Response: { alert: Alert }
 *
 * POST /api/alerts/acknowledge
 *   Body: { id } | { all: true }
 *   Response: { acknowledged: number }
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { withFileLock } from '@/lib/data-io';
import { tracked } from '@/lib/api-tracking';
import { appPath } from '@/lib/app-paths';

export const dynamic = 'force-dynamic';

// ============================================
// Types
// ============================================

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'info';

export interface Alert {
  id: string;
  title: string;
  severity: AlertSeverity;
  message?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;        // ISO
  acknowledgedAt?: string;  // ISO — present when acknowledged
}

interface AlertsStore {
  alerts: Alert[];
}

// ============================================
// Storage
// ============================================

const ALERTS_FILE = appPath('.AppData', 'alerts.json');

// Trim store to most recent N alerts to prevent unbounded growth
const MAX_ALERTS = 500;

async function readStore(): Promise<AlertsStore> {
  try {
    const raw = await fs.readFile(ALERTS_FILE, 'utf-8');
    return JSON.parse(raw) as AlertsStore;
  } catch {
    return { alerts: [] };
  }
}

async function writeStore(store: AlertsStore): Promise<void> {
  // Trim oldest acknowledged alerts beyond MAX_ALERTS
  if (store.alerts.length > MAX_ALERTS) {
    const unacked = store.alerts.filter(a => !a.acknowledgedAt);
    const acked = store.alerts
      .filter(a => a.acknowledgedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_ALERTS - unacked.length);
    store.alerts = [...unacked, ...acked].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // Atomic write via unique temp file (PID + timestamp prevents concurrent-write races)
  const tmp = `${ALERTS_FILE}.tmp.${process.pid}.${Date.now()}`;
  await fs.mkdir(path.dirname(ALERTS_FILE), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8');
  await fs.rename(tmp, ALERTS_FILE);
}

// ============================================
// Route handlers
// ============================================

export const GET = tracked('/api/alerts', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const { searchParams } = request.nextUrl;
    const acknowledgedParam = searchParams.get('acknowledged') ?? 'false';
    const severityParam = searchParams.get('severity');
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200);

    const store = await readStore();
    let alerts = store.alerts;

    // Filter by acknowledgement status
    if (acknowledgedParam === 'false') {
      alerts = alerts.filter(a => !a.acknowledgedAt);
    } else if (acknowledgedParam === 'true') {
      alerts = alerts.filter(a => !!a.acknowledgedAt);
    }
    // 'all' returns everything

    // Filter by severity if specified
    if (severityParam) {
      const severities = severityParam.split(',').map(s => s.trim());
      alerts = alerts.filter(a => severities.includes(a.severity));
    }

    // Sort newest first and paginate
    alerts = alerts
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);

    const unacknowledgedCount = store.alerts.filter(a => !a.acknowledgedAt).length;

    return NextResponse.json({ alerts, unacknowledgedCount });
  } catch (err) {
    console.error('[api/alerts GET] error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
});

export const POST = tracked('/api/alerts', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body = await request.json() as Record<string, unknown>;

    // Handle acknowledge action
    if (body.action === 'acknowledge') {
      // Validate input before acquiring lock
      if (body.all !== true && typeof body.id !== 'string') {
        return NextResponse.json({ success: false, error: 'Provide id or all:true' }, { status: 400 });
      }

      let count = 0;
      let notFound = false;
      await withFileLock(ALERTS_FILE, async () => {
        const store = await readStore();
        const now = new Date().toISOString();

        if (body.all === true) {
          for (const alert of store.alerts) {
            if (!alert.acknowledgedAt) {
              alert.acknowledgedAt = now;
              count++;
            }
          }
        } else {
          const alert = store.alerts.find(a => a.id === body.id);
          if (!alert) { notFound = true; return; }
          if (!alert.acknowledgedAt) {
            alert.acknowledgedAt = now;
            count = 1;
          }
        }
        await writeStore(store);
      });

      if (notFound) return NextResponse.json({ success: false, error: 'Alert not found' }, { status: 404 });
      return NextResponse.json({ acknowledged: count });
    }

    // Create new alert
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      return NextResponse.json({ success: false, error: 'title is required' }, { status: 400 });
    }

    const severity = (['critical', 'high', 'medium', 'info'].includes(body.severity as string)
      ? body.severity
      : 'info') as AlertSeverity;

    const alert: Alert = {
      id: randomUUID(),
      title,
      severity,
      message:  typeof body.message  === 'string' ? body.message  : undefined,
      source:   typeof body.source   === 'string' ? body.source   : undefined,
      metadata: body.metadata != null && typeof body.metadata === 'object'
        ? body.metadata as Record<string, unknown>
        : undefined,
      createdAt: new Date().toISOString(),
    };

    await withFileLock(ALERTS_FILE, async () => {
      const store = await readStore();
      store.alerts.unshift(alert);
      await writeStore(store);
    });

    return NextResponse.json({ alert }, { status: 201 });
  } catch (err) {
    console.error('[api/alerts POST] error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
});
