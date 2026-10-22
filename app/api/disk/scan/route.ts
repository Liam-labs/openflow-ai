import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { requireAuthOrLocal } from '@/lib/api-auth';

export interface DiskEntry {
  name: string;
  path: string;
  sizeBytes: number;
  sizeHuman: string;
  type: 'dir' | 'file';
}

interface ScanResponse {
  entries: DiskEntry[];
  path: string;
  totalBytes: number;
  totalHuman: string;
  scanMs: number;
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
  const targetPath = body.path ?? '/';

  // Reject /mnt/* — Windows drives, not WSL disk
  if (/^\/mnt(\/|$)/.test(targetPath)) {
    return NextResponse.json({ error: 'Scanning /mnt paths is not supported' }, { status: 400 });
  }

  // Absolute path only, no traversal
  if (!targetPath.startsWith('/') || targetPath.includes('..')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  const startMs = Date.now();

  const entries = await new Promise<DiskEntry[]>((resolve, reject) => {
    // -h = human readable, -d1 = depth 1, -x = stay on same filesystem
    const child = spawn('du', ['-hd1', '-x', targetPath], {
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('error', reject);
    child.on('close', (code) => {
      // du exits 1 on permission errors but still produces useful output
      if (code !== 0 && code !== 1) {
        reject(new Error(`du exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }

      const lines = stdout.trim().split('\n').filter(Boolean);
      const parsed: DiskEntry[] = [];

      for (const line of lines) {
        const tab = line.indexOf('\t');
        if (tab === -1) continue;
        const sizeStr = line.slice(0, tab).trim();
        const entryPath = line.slice(tab + 1).trim();

        // Skip the summary line (the scanned dir itself)
        if (entryPath === targetPath || entryPath === targetPath + '/') continue;

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

      // Sort by size descending
      parsed.sort((a, b) => b.sizeBytes - a.sizeBytes);
      resolve(parsed);
    });
  }).catch((err: Error) => {
    throw err;
  });

  const totalBytes = entries.reduce((s, e) => s + e.sizeBytes, 0);

  const response: ScanResponse = {
    entries,
    path: targetPath,
    totalBytes,
    totalHuman: toHuman(totalBytes),
    scanMs: Date.now() - startMs,
  };

  return NextResponse.json(response);
}
