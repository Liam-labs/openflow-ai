import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  availableMemoryMB, isPidAlive, parseVmStatAvailableMB, readProcChildren, readProcCmdline, type Runner,
} from '@/lib/proc-info';

// What `vm_stat` prints on a Mac (16 KiB pages on Apple Silicon).
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12345.
Pages active:                            200000.
Pages inactive:                           50000.
Pages speculative:                         1000.
Pages wired down:                         90000.
`;

const failing: Runner = async () => { throw new Error('boom'); };

describe('proc-info on Linux (real /proc)', () => {
  it('sees this process: alive, its own command line, no bogus ids', async () => {
    expect(await isPidAlive(process.pid, 'linux')).toBe(true);
    expect(await isPidAlive(2 ** 22 + 12345, 'linux')).toBe(false);
    expect(await isPidAlive(0, 'linux')).toBe(false);
    expect(await isPidAlive('abc', 'linux')).toBe(false);
    expect(await readProcCmdline(process.pid, 'linux')).toContain('node');
    expect(await readProcCmdline(2 ** 22 + 12345, 'linux')).toBe('');
  });

  it('lists the children of a process', async () => {
    const child = spawn('sleep', ['30']);
    try {
      expect(await readProcChildren(process.pid, 'linux')).toContain(String(child.pid));
      expect(await readProcChildren(child.pid!, 'linux')).toEqual([]);
    } finally {
      child.kill();
    }
  });

  it('separates the words of a command line with spaces', async () => {
    const child = spawn('sleep', ['31']);
    try {
      for (let i = 0; i < 100 && !(await readProcCmdline(child.pid!, 'linux')); i++) await new Promise((r) => setTimeout(r, 20));   // empty for a moment while the program loads
      expect(await readProcCmdline(child.pid!, 'linux')).toBe('sleep 31 ');   // /proc ends the last word with NUL
    } finally {
      child.kill();
    }
  });

  it('reads free memory in MB from /proc/meminfo', async () => {
    const kb = Number(readFileSync('/proc/meminfo', 'utf-8').match(/MemAvailable:\s+(\d+)\s+kB/)![1]);
    const mb = await availableMemoryMB('linux');
    expect(Math.abs(mb! - kb / 1024)).toBeLessThan(500);   // memory moves between the two reads; MB not kB
    expect(mb!).toBeGreaterThan(0);
  });
});

describe('proc-info on macOS (fake ps, pgrep and vm_stat)', () => {
  it('asks ps for the command line, trimmed', async () => {
    const calls: string[][] = [];
    const run: Runner = async (file, args) => { calls.push([file, ...args]); return '  /usr/local/bin/node server.js --name X\n'; };
    expect(await readProcCmdline(4242, 'darwin', run)).toBe('/usr/local/bin/node server.js --name X');
    expect(calls).toEqual([['ps', '-p', '4242', '-o', 'command=']]);
  });

  it('gives an empty command line when ps fails or the id is not a process id', async () => {
    expect(await readProcCmdline(4242, 'darwin', failing)).toBe('');
    expect(await readProcCmdline('4242; rm -rf /', 'darwin', async () => 'must not run')).toBe('');
  });

  it('lists children with pgrep, and none when pgrep exits 1 (no match)', async () => {
    const calls: string[][] = [];
    expect(await readProcChildren(10, 'darwin', async (f, a) => { calls.push([f, ...a]); return '11\n12\n'; })).toEqual(['11', '12']);
    expect(calls).toEqual([['pgrep', '-P', '10']]);
    expect(await readProcChildren(10, 'darwin', failing)).toEqual([]);
  });

  it('uses signal 0 for liveness: this process is alive, a made-up id is not', async () => {
    expect(await isPidAlive(process.pid, 'darwin')).toBe(true);
    expect(await isPidAlive(2 ** 22 + 12345, 'darwin')).toBe(false);
  });

  it('counts a process of another user as alive (signal 0 is refused with EPERM, not ESRCH)', async () => {
    expect(await isPidAlive(1, 'darwin')).toBe(true);
  });

  it('never signals a group or "every process": 0 and negative ids are not processes', async () => {
    expect(await isPidAlive(0, 'darwin')).toBe(false);
    expect(await isPidAlive(-1, 'darwin')).toBe(false);
  });

  it('says there are no children when pgrep prints nothing', async () => {
    expect(await readProcChildren(10, 'darwin', async () => '\n')).toEqual([]);
  });

  it('computes free memory from vm_stat: free + inactive + speculative pages', async () => {
    expect(parseVmStatAvailableMB(VM_STAT)).toBe(Math.floor(((12345 + 50000 + 1000) * 16384) / (1024 * 1024)));
    expect(await availableMemoryMB('darwin', async () => VM_STAT)).toBe(Math.floor(((12345 + 50000 + 1000) * 16384) / (1024 * 1024)));
  });

  it('says "unknown" for unreadable or unrecognised vm_stat output and for other systems', async () => {
    expect(parseVmStatAvailableMB('nonsense')).toBeNull();
    expect(parseVmStatAvailableMB('Mach Virtual Memory Statistics: (page size of 4096 bytes)\n')).toBeNull();
    expect(await availableMemoryMB('darwin', failing)).toBeNull();
    expect(await availableMemoryMB('win32', async () => VM_STAT)).toBeNull();
  });
});
