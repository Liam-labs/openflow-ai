/**
 * Scaffolding auto-sync watcher
 * Watches data/scaffolding/masters/** and runs sync.py --all on any change (2s debounce).
 */
import { watch as chokidarWatch } from 'chokidar';
import { spawn } from 'child_process';
import path from 'path';
import { appPath } from '@/lib/app-paths';

const MASTERS_DIR = appPath('data', 'scaffolding', 'masters');
const SYNC_SCRIPT = appPath('data', 'scaffolding', 'sync.py');

export function startScaffoldingSync(): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const runSync = () => {
    const proc = spawn('python3', [SYNC_SCRIPT, '--all'], { env: { ...process.env } });
    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => {
      console.error('[DevFlow] Scaffolding auto-sync error:', chunk.toString().trim());
    });
    proc.on('close', (code) => {
      const lines = output.trim().split('\n').filter(Boolean);
      console.log(`[DevFlow] Scaffolding auto-sync complete: ${lines[lines.length - 1] ?? ''}`);
      if (code !== 0) {
        console.error(`[DevFlow] Scaffolding auto-sync exited with code ${code}`);
      }
    });
  };

  const onFileEvent = (filePath: string) => {
    console.log(`[DevFlow] Scaffolding auto-sync triggered by ${path.basename(filePath)}`);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSync, 2000);
  };

  const watcher = chokidarWatch(MASTERS_DIR, { persistent: true, ignoreInitial: true });
  watcher.on('add', onFileEvent);
  watcher.on('change', onFileEvent);
  watcher.on('unlink', onFileEvent);

  console.log('[DevFlow] Scaffolding auto-sync watcher started');
  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close().catch(() => {});
  };
}
