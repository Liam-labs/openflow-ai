import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { readdir } from 'fs/promises';
import path from 'path';
import { requireAuthOrLocal } from '@/lib/api-auth';

export interface DiskEntry {
  name: string;
  path: string;
  sizeBytes: number | null;
  sizeHuman: string;
  type: 'dir' | 'file';
}

interface ScanResponse {
  entries: DiskEntry[];
  path: string;
  totalBytes: number;
  totalHuman: string;
  scanMs: number;
  partial: boolean;
  warning?: string;
}

function parseHumanSize(s: string): number {
  const units: Record<string, number> = { K: 1024, M: 1048576, G: 1073741824, T: 1099511627776 };
  const match = s.match(/^([\d.]+)([KMGT]?)$/);
  if (!match) return 0;
  const [, num, unit] = match;
  return Math.round(parseFloat(num) * (units[unit] ?? 1));
}

function toHuman(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export async function POST(req: NextRequest) {
  const denied = await requireAuthOrLocal(req, 'write');
  if (denied) return denied;

  const body = await req.json().catch(() => ({})) as { path?: string };
  const targetPath = body?.path ?? '/';

  // Reject /mnt/* — Windows drives, not WSL disk
  if (/^\/mnt(\/|$)/.test(targetPath)) {
    return NextResponse.json({ error: 'Scanning /mnt paths is not supported' }, { status: 400 });
  }

  // Absolute path only, no traversal
  if (typeof targetPath !== 'string' || !targetPath.startsWith('/') || targetPath.includes('..') || targetPath.includes('\0')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  const startMs = Date.now();
  const scanPath = path.resolve(targetPath);
  let folders;
  try {
    folders = (await readdir(scanPath, { withFileTypes: true })).filter(entry => entry.isDirectory());
  } catch {
    return NextResponse.json({ error: 'This folder cannot be read. It may not exist or access may be denied.' }, { status: 400 });
  }

  try {
    const scan = await new Promise<{ entries: DiskEntry[]; partial: boolean }>((resolve, reject) => {
      // -h = human readable, -d1 = depth 1, -x = stay on same filesystem
      const child = spawn('du', ['-hd1', '-x', '--', scanPath], {
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('error', reject);
      child.on('close', (code, signal) => {
        // du exits 1 on permission errors but still produces useful output
        const timedOut = signal === 'SIGTERM' || signal === 'SIGKILL';
        if (code !== 0 && code !== 1 && !timedOut) {
          reject(new Error(`du exited ${code}: ${stderr.slice(0, 200)}`));
          return;
        }

        // A killed process may leave an unfinished final record.
        const lines = stdout.slice(0, stdout.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
        const parsed: DiskEntry[] = [];

        for (const line of lines) {
          const tab = line.indexOf('\t');
          if (tab === -1) continue;
          const sizeStr = line.slice(0, tab).trim();
          const entryPath = line.slice(tab + 1).trim();

          // Skip the summary line (the scanned dir itself)
          if (path.resolve(entryPath) === scanPath) continue;

          const sizeBytes = parseHumanSize(sizeStr);
          const name = entryPath.split('/').pop() ?? entryPath;

          parsed.push({
            name,
            path: entryPath,
            sizeBytes,
            sizeHuman: toHuman(sizeBytes),
            type: 'dir', // du only emits dirs with -d1; files summarised into their parent
          });
        }

        // Keep navigation usable even when du times out inside a large folder.
        // Unknown sizes must not look like empty directories.
        const measured = new Set(parsed.map(entry => entry.path));
        for (const folder of folders) {
          const folderPath = path.join(scanPath, folder.name);
          if (!measured.has(folderPath)) parsed.push({ name: folder.name, path: folderPath, sizeBytes: null, sizeHuman: 'Not measured', type: 'dir' });
        }
        parsed.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));
        resolve({ entries: parsed, partial: timedOut || code === 1 || parsed.some(entry => entry.sizeBytes === null) });
      });
    });
    const { entries, partial } = scan;
    const totalBytes = entries.reduce((s, e) => s + (e.sizeBytes ?? 0), 0);

    const response: ScanResponse = {
      entries,
      path: targetPath,
      totalBytes,
      totalHuman: toHuman(totalBytes),
      scanMs: Date.now() - startMs,
      partial,
      ...(partial ? { warning: 'Some folder sizes could not be measured within the scan limit or access was denied. Open a folder to scan it separately.' } : {}),
    };

    return NextResponse.json(response);
  } catch {
    return NextResponse.json({ error: 'Disk scan failed. Please retry or open a smaller folder.' }, { status: 500 });
  }
}
