/**
 * Archive rotation + token pruning + storage cleanup
 * Runs on startup then daily.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { rotateMessageArchives, backupMessageFiles } from '../collab-message-io';
import { DataPaths } from '../data-paths';
// Dynamic import to avoid pulling crypto/os into webpack bundle
const getPruneStaleTokens = async () => (await import('../api-auth')).pruneStaleTokens;

const DAILY = 24 * 60 * 60 * 1000;

// Storage cleanup constants
const IMAGES_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // delete collab images older than 30 days
const IMAGES_MAX_COUNT = 1000;                       // hard cap — evict oldest first above this
const CRASH_JSON_TTL_MS = 30 * 24 * 60 * 60 * 1000; // delete crash reports older than 30 days
const CRASH_JSON_MAX = 200;                           // keep at most 200 crash report files
const PIPE_LOG_IDLE_MS = 24 * 60 * 60 * 1000;        // delete pipe-pane logs idle > 24h (agent dead)

async function cleanupCollabImages(): Promise<{ deleted: number; freedBytes: number }> {
  let deleted = 0;
  let freedBytes = 0;
  try {
    const files = await fs.readdir(DataPaths.collabImages);
    const now = Date.now();
    const withStats = (await Promise.all(
      files.map(async (f) => {
        const p = path.join(DataPaths.collabImages, f);
        try { const s = await fs.stat(p); return { p, mtime: s.mtimeMs, size: s.size }; }
        catch { return null; }
      })
    )).filter((x): x is { p: string; mtime: number; size: number } => x !== null);

    withStats.sort((a, b) => a.mtime - b.mtime);

    const toDelete = new Set<string>(
      withStats.filter(f => now - f.mtime > IMAGES_TTL_MS).map(f => f.p)
    );
    // Also evict oldest to stay under max count
    if (withStats.length > IMAGES_MAX_COUNT) {
      for (const f of withStats.slice(0, withStats.length - IMAGES_MAX_COUNT)) {
        toDelete.add(f.p);
      }
    }
    for (const f of withStats) {
      if (!toDelete.has(f.p)) continue;
      try { await fs.unlink(f.p); deleted++; freedBytes += f.size; } catch {}
    }
  } catch { /* directory may not exist yet */ }
  return { deleted, freedBytes };
}

async function cleanupCrashLogs(): Promise<{ deleted: number }> {
  let deleted = 0;
  try {
    const files = await fs.readdir(DataPaths.crashLogs);
    const now = Date.now();

    // Crash report JSON files: age-based + count cap
    const jsonNames = files.filter(f => f.endsWith('.json'));
    const jsonWithStats = (await Promise.all(
      jsonNames.map(async (f) => {
        const p = path.join(DataPaths.crashLogs, f);
        try { const s = await fs.stat(p); return { p, mtime: s.mtimeMs }; }
        catch { return null; }
      })
    )).filter((x): x is { p: string; mtime: number } => x !== null);

    jsonWithStats.sort((a, b) => a.mtime - b.mtime);
    const toDeleteJson = new Set<string>(
      jsonWithStats.filter(f => now - f.mtime > CRASH_JSON_TTL_MS).map(f => f.p)
    );
    if (jsonWithStats.length > CRASH_JSON_MAX) {
      for (const f of jsonWithStats.slice(0, jsonWithStats.length - CRASH_JSON_MAX)) {
        toDeleteJson.add(f.p);
      }
    }
    for (const p of toDeleteJson) {
      try { await fs.unlink(p); deleted++; } catch {}
    }

    // Pipe-pane log files (*.log): delete if idle > 24h — agent is dead or stale
    for (const f of files.filter(n => n.endsWith('.log'))) {
      const p = path.join(DataPaths.crashLogs, f);
      try {
        const s = await fs.stat(p);
        if (now - s.mtimeMs > PIPE_LOG_IDLE_MS) {
          await fs.unlink(p);
          deleted++;
        }
      } catch {}
    }
  } catch { /* directory may not exist yet */ }
  return { deleted };
}

export async function startArchiveRotation(): Promise<() => void> {
  // Message archive rotation on startup
  try {
    await backupMessageFiles();
    const rotation = await rotateMessageArchives();
    if (rotation.deleted > 0 || rotation.archived > 0) {
      console.log(
        `[DevFlow] Message archive rotation: deleted ${rotation.deleted} old archives, archived ${rotation.archived} stale messages`
      );
    }
  } catch (err) {
    console.log('[DevFlow] Message archive rotation not started:', err instanceof Error ? err.message : String(err));
  }

  // API token pruning on startup
  try {
    const pruneStaleTokens = await getPruneStaleTokens();
    const result = await pruneStaleTokens();
    if (result.pruned > 0) {
      console.log(`[DevFlow] Startup token prune: removed ${result.pruned} stale token(s)`);
    }
    console.log('[DevFlow] API token pruning started (daily, 7-day TTL, 50-token cap)');
  } catch (err) {
    console.log('[DevFlow] API token pruning not started:', err instanceof Error ? err.message : String(err));
  }

  // Storage cleanup on startup
  try {
    const [images, crash] = await Promise.all([cleanupCollabImages(), cleanupCrashLogs()]);
    const totalDeleted = images.deleted + crash.deleted;
    if (totalDeleted > 0) {
      const mb = (images.freedBytes / 1024 / 1024).toFixed(1);
      console.log(
        `[DevFlow] Storage cleanup: deleted ${images.deleted} images (${mb} MB freed), ${crash.deleted} crash log files`
      );
    }
  } catch (err) {
    console.log('[DevFlow] Storage cleanup not started:', err instanceof Error ? err.message : String(err));
  }

  // Daily rotation timer
  const rotationTimer = setInterval(async () => {
    try { await rotateMessageArchives(); } catch (err) {
      console.error('[DevFlow] Message archive rotation error:', err);
    }
  }, DAILY);

  // Daily token prune timer
  const pruneTimer = setInterval(async () => {
    try { const prune = await getPruneStaleTokens(); await prune(); } catch (err) {
      console.error('[DevFlow] Token prune error:', err);
    }
  }, DAILY);

  // Daily storage cleanup timer
  const cleanupTimer = setInterval(async () => {
    try { await Promise.all([cleanupCollabImages(), cleanupCrashLogs()]); } catch (err) {
      console.error('[DevFlow] Storage cleanup error:', err);
    }
  }, DAILY);

  return () => {
    clearInterval(rotationTimer);
    clearInterval(pruneTimer);
    clearInterval(cleanupTimer);
  };
}
