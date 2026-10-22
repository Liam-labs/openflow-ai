import type { Request, Response, NextFunction } from 'express';
import { appendFileSync, existsSync, renameSync, statSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { AuditEntry } from '../../../lib/host-bridge/types';
import { DEVFLOW_HOME } from '../config';

const MAX_MEMORY_ENTRIES = 10_000;
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB per log file
const MAX_LOG_FILES = 7; // Keep 7 rotated files

const auditLog: AuditEntry[] = [];
const LOG_DIR = join(DEVFLOW_HOME, 'logs', 'host-bridge');
const LOG_FILE = join(LOG_DIR, 'audit.jsonl');

// Ensure log dir exists
mkdirSync(LOG_DIR, { recursive: true });

export function auditMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.path,
        command: extractCommand(req),
        sourceIp: req.ip || req.socket.remoteAddress || 'unknown',
        result: res.statusCode < 400 ? 'success' : res.statusCode === 403 ? 'denied' : 'error',
        durationMs: Date.now() - start,
      };

      if (res.statusCode >= 400) {
        const b = body as Record<string, unknown>;
        entry.error = (b?.error as string) || `HTTP ${res.statusCode}`;
      }

      // In-memory ring buffer
      auditLog.push(entry);
      if (auditLog.length > MAX_MEMORY_ENTRIES) {
        auditLog.splice(0, auditLog.length - MAX_MEMORY_ENTRIES);
      }

      // Write to disk (JSONL format — one JSON object per line)
      writeToDisk(entry);

      return originalJson(body);
    };

    next();
  };
}

function extractCommand(req: Request): string {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body) return req.path;

  if (body.action && body.target) return `pm2 ${body.action} ${body.target}`;
  if (body.script) return `script/${body.script}`;
  if (body.input) return `pty/write (${(body.input as string).length} chars)`;

  return req.path;
}

function writeToDisk(entry: AuditEntry): void {
  try {
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    rotateIfNeeded();
  } catch (e) {
    // Log write failure to stderr but don't crash the server
    console.error(`[audit] Failed to write log: ${e}`);
  }
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const stat = statSync(LOG_FILE);
    if (stat.size < MAX_LOG_SIZE) return;

    // Rotate: audit.jsonl -> audit.1.jsonl, audit.1.jsonl -> audit.2.jsonl, etc.
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const from = join(LOG_DIR, `audit.${i}.jsonl`);
      const to = join(LOG_DIR, `audit.${i + 1}.jsonl`);
      if (existsSync(from)) {
        if (i + 1 >= MAX_LOG_FILES) {
          unlinkSync(from); // Delete oldest
        } else {
          renameSync(from, to);
        }
      }
    }
    renameSync(LOG_FILE, join(LOG_DIR, 'audit.1.jsonl'));

    console.log('[audit] Log rotated');
  } catch (e) {
    console.error(`[audit] Rotation failed: ${e}`);
  }
}

/**
 * Clean up old rotated logs beyond retention.
 * Call periodically (e.g. daily) or on startup.
 */
export function cleanOldLogs(retentionDays: number): void {
  try {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const files = readdirSync(LOG_DIR).filter((f) => f.startsWith('audit.') && f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = join(LOG_DIR, file);
      const stat = statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        unlinkSync(filePath);
        console.log(`[audit] Cleaned old log: ${file}`);
      }
    }
  } catch (e) {
    console.error(`[audit] Cleanup failed: ${e}`);
  }
}

export function getRecentAuditEntries(limit: number): AuditEntry[] {
  return auditLog.slice(-limit);
}
