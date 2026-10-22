/**
 * Unit tests for deps.install status reporting (audit task 85fa35d9).
 *
 * Covers:
 * - Parsing status JSON written by the PowerShell wrapper
 * - Reporting 'running' / 'completed' / 'failed' based on file contents
 * - Returning null when the file does not exist
 * - Tail-of-log truncation for the response payload
 * - Pip-failure exit code is reflected as status:'failed'
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseDepsInstallStatus,
  loadDepsInstallStatus,
  tailLog,
} from '@/app/api/computer-use/deps-install';

describe('parseDepsInstallStatus', () => {
  it('returns parsed object for a valid running record', () => {
    const json = JSON.stringify({
      id: 'abc123',
      status: 'running',
      startedAt: '2026-04-27T20:00:00Z',
    });
    const parsed = parseDepsInstallStatus(json);
    expect(parsed).toEqual({
      id: 'abc123',
      status: 'running',
      startedAt: '2026-04-27T20:00:00Z',
    });
  });

  it('returns parsed object for a completed record with exitCode 0', () => {
    const json = JSON.stringify({
      id: 'abc',
      status: 'completed',
      startedAt: '2026-04-27T20:00:00Z',
      endedAt: '2026-04-27T20:01:30Z',
      exitCode: 0,
    });
    const parsed = parseDepsInstallStatus(json);
    expect(parsed?.status).toBe('completed');
    expect(parsed?.exitCode).toBe(0);
    expect(parsed?.endedAt).toBe('2026-04-27T20:01:30Z');
  });

  it('returns parsed object for a failed record with non-zero exitCode', () => {
    const json = JSON.stringify({
      id: 'abc',
      status: 'failed',
      startedAt: '2026-04-27T20:00:00Z',
      endedAt: '2026-04-27T20:01:30Z',
      exitCode: 1,
    });
    const parsed = parseDepsInstallStatus(json);
    expect(parsed?.status).toBe('failed');
    expect(parsed?.exitCode).toBe(1);
  });

  it('returns null for malformed JSON', () => {
    expect(parseDepsInstallStatus('{ not valid json')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    expect(parseDepsInstallStatus(JSON.stringify({ id: 'abc' }))).toBeNull();
    expect(parseDepsInstallStatus(JSON.stringify({ status: 'running' }))).toBeNull();
  });

  it('rejects unknown status values', () => {
    expect(parseDepsInstallStatus(JSON.stringify({
      id: 'abc', status: 'pending', startedAt: '2026-04-27T20:00:00Z',
    }))).toBeNull();
  });
});

describe('tailLog', () => {
  it('returns the whole content when shorter than maxLines', () => {
    expect(tailLog('a\nb\nc', 10)).toBe('a\nb\nc');
  });

  it('returns the last N lines when longer than maxLines', () => {
    const content = ['1','2','3','4','5','6','7','8','9','10'].join('\n');
    expect(tailLog(content, 3)).toBe('8\n9\n10');
  });

  it('returns empty string for empty input', () => {
    expect(tailLog('', 5)).toBe('');
  });

  it('handles trailing newline', () => {
    expect(tailLog('a\nb\nc\n', 2)).toBe('b\nc');
  });
});

describe('loadDepsInstallStatus', () => {
  it('returns parsed status when file exists and log is readable', async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        id: 'abc',
        status: 'running',
        startedAt: '2026-04-27T20:00:00Z',
      }))
      .mockResolvedValueOnce('pip install line 1\npip install line 2');
    const result = await loadDepsInstallStatus('abc', { readFile });
    expect(result).not.toBeNull();
    expect(result?.id).toBe('abc');
    expect(result?.status).toBe('running');
    expect(result?.logTail).toBe('pip install line 1\npip install line 2');
  });

  it('returns null when status file does not exist', async () => {
    const readFile = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const result = await loadDepsInstallStatus('abc', { readFile });
    expect(result).toBeNull();
  });

  it('omits logTail when log file is unreadable but status JSON exists', async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        id: 'abc',
        status: 'completed',
        startedAt: '2026-04-27T20:00:00Z',
        endedAt: '2026-04-27T20:01:00Z',
        exitCode: 0,
      }))
      .mockRejectedValueOnce(new Error('ENOENT'));
    const result = await loadDepsInstallStatus('abc', { readFile });
    expect(result?.status).toBe('completed');
    expect(result?.logTail).toBeUndefined();
  });

  it('reflects failed pip install when status JSON shows non-zero exitCode', async () => {
    // Acceptance: induce pip failure → status reports failed
    const readFile = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        id: 'abc',
        status: 'failed',
        startedAt: '2026-04-27T20:00:00Z',
        endedAt: '2026-04-27T20:01:00Z',
        exitCode: 1,
      }))
      .mockResolvedValueOnce('ERROR: Could not install packages\nNo matching distribution');
    const result = await loadDepsInstallStatus('abc', { readFile });
    expect(result?.status).toBe('failed');
    expect(result?.exitCode).toBe(1);
    expect(result?.logTail).toContain('ERROR');
  });

  it('uses provided dirOverride for status + log paths', async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        id: 'xyz',
        status: 'running',
        startedAt: '2026-04-27T20:00:00Z',
      }))
      .mockResolvedValueOnce('log content');
    await loadDepsInstallStatus('xyz', { readFile, dirOverride: '/tmp/test-deps' });
    const calls = readFile.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe('/tmp/test-deps/devflow-deps-install-xyz.json');
    expect(calls[1]).toBe('/tmp/test-deps/devflow-deps-install-xyz.log');
  });
});
