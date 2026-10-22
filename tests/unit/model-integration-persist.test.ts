/**
 * Sprint M P1 T3 — Reynolds, 2026-05-27.
 *
 * Verifies the integration-persist module against an isolated tmpdir
 * fixture: idempotent re-run produces zero writes, mid-run infra-change
 * (simulated by mutating capabilities directly) flips to a write, and the
 * report shape matches the contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ModelEntry, ModelIntegration } from '@/lib/model-registry';

// Mock DataPaths to redirect models.json to the tmpdir for the test.
let tmp: string;
let modelsPath: string;
let originalCwd: string;

vi.mock('@/lib/data-paths', async () => {
  const actual = await vi.importActual<typeof import('@/lib/data-paths')>('@/lib/data-paths');
  return {
    ...actual,
    DataPaths: new Proxy(actual.DataPaths, {
      get(target, prop) {
        if (prop === 'models') return modelsPath;
        return Reflect.get(target, prop);
      },
    }),
  };
});

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'mip-test-'));
  modelsPath = path.join(tmp, 'models.json');
  originalCwd = process.cwd();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

function writeModels(models: ModelEntry[]): void {
  writeFileSync(modelsPath, JSON.stringify({ models }, null, 2), 'utf-8');
}

function readModels(): { models: ModelEntry[] } {
  return JSON.parse(readFileSync(modelsPath, 'utf-8'));
}

describe('runIntegrationDetectionAndPersist — first-run write', () => {
  it('populates integration blocks on a fresh models.json', async () => {
    writeModels([
      { id: 'opus', agentTypes: ['claude'] },
      { id: 'codex-test', agentTypes: ['codex'] },
    ]);

    const { runIntegrationDetectionAndPersist } = await import('@/lib/model-integration-persist');
    const r = await runIntegrationDetectionAndPersist();

    expect(r.totalModels).toBe(2);
    expect(r.changed).toBe(2);
    expect(r.unchanged).toBe(0);
    expect(r.wrote).toBe(true);
    expect(r.changes['opus']).toBe('created');
    expect(r.changes['codex-test']).toBe('created');

    const after = readModels();
    expect(after.models[0].integration?.interfaceType).toBe('claude-code');
    expect(after.models[1].integration?.interfaceType).toBe('codex');
  });
});

describe('runIntegrationDetectionAndPersist — idempotency (AMENDMENT #3)', () => {
  it('re-running with no infra change produces zero writes', async () => {
    writeModels([{ id: 'opus', agentTypes: ['claude'] }]);

    const { runIntegrationDetectionAndPersist } = await import('@/lib/model-integration-persist');

    const first = await runIntegrationDetectionAndPersist();
    expect(first.wrote).toBe(true);
    expect(first.changed).toBe(1);

    // Capture mtime of models.json after first run
    const mtime1 = readFileSync(modelsPath, 'utf-8');

    // Re-run — should be no-op since detection produces same blocks
    const second = await runIntegrationDetectionAndPersist();
    expect(second.wrote).toBe(false);
    expect(second.changed).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.changes['opus']).toBe('unchanged');

    // File content unchanged (only differs by detectedAt — but if zero writes,
    // file should be byte-identical to first run)
    const mtime2 = readFileSync(modelsPath, 'utf-8');
    expect(mtime2).toBe(mtime1);
  });

  it('treats only-detectedAt diff as equivalent (does not re-write)', async () => {
    writeModels([{ id: 'opus', agentTypes: ['claude'] }]);

    const { runIntegrationDetectionAndPersist } = await import('@/lib/model-integration-persist');

    // Seed an integration block with an OLD detectedAt — capabilities will
    // match what fresh detection produces.
    await runIntegrationDetectionAndPersist();
    const file = readModels();
    const seeded = file.models[0].integration!;
    seeded.detectedAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(modelsPath, JSON.stringify(file, null, 2));

    const r = await runIntegrationDetectionAndPersist();
    expect(r.wrote).toBe(false);
    expect(r.changes['opus']).toBe('unchanged');

    // detectedAt stays as the OLD value since we didn't write
    const after = readModels();
    expect(after.models[0].integration?.detectedAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('writes when capabilities differ (simulated infra change)', async () => {
    writeModels([{ id: 'opus', agentTypes: ['claude'] }]);

    const { runIntegrationDetectionAndPersist } = await import('@/lib/model-integration-persist');

    await runIntegrationDetectionAndPersist();
    const file = readModels();
    // Mutate a capability to simulate "infra changed since last detect"
    file.models[0].integration!.capabilities.hooks = 'none' as ModelIntegration['capabilities'][string];
    file.models[0].integration!.status = 'none';
    writeFileSync(modelsPath, JSON.stringify(file, null, 2));

    const r = await runIntegrationDetectionAndPersist();
    expect(r.wrote).toBe(true);
    expect(r.changed).toBe(1);
    expect(r.changes['opus']).toBe('updated');

    const after = readModels();
    // Detection should re-derive hooks=full for claude
    expect(after.models[0].integration?.capabilities.hooks).toBe('full');
  });
});

describe('runIntegrationDetectionAndPersist — report shape', () => {
  it('counts mixed-state runs correctly', async () => {
    writeModels([
      { id: 'a', agentTypes: ['claude'] },
      { id: 'b', agentTypes: ['codex'] },
      { id: 'c', agentTypes: ['gemini'] },
    ]);

    const { runIntegrationDetectionAndPersist } = await import('@/lib/model-integration-persist');

    const r1 = await runIntegrationDetectionAndPersist();
    expect(r1.totalModels).toBe(3);
    expect(r1.changed).toBe(3);
    expect(r1.unchanged).toBe(0);

    // Mutate just one to dirty
    const file = readModels();
    file.models[1].integration!.capabilities.hooks = 'none' as ModelIntegration['capabilities'][string];
    writeFileSync(modelsPath, JSON.stringify(file, null, 2));

    const r2 = await runIntegrationDetectionAndPersist();
    expect(r2.totalModels).toBe(3);
    expect(r2.changed).toBe(1);
    expect(r2.unchanged).toBe(2);
    expect(r2.wrote).toBe(true);
    expect(r2.changes['a']).toBe('unchanged');
    expect(r2.changes['b']).toBe('updated');
    expect(r2.changes['c']).toBe('unchanged');
  });

  it('returns ranAt as an ISO timestamp', async () => {
    writeModels([{ id: 'opus', agentTypes: ['claude'] }]);
    const { runIntegrationDetectionAndPersist } = await import('@/lib/model-integration-persist');
    const r = await runIntegrationDetectionAndPersist();
    expect(r.ranAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('startupRunIntegrationDetection — never throws', () => {
  it('logs and swallows errors on missing models.json', async () => {
    // Don't write models.json — startup should not throw on missing file.
    const { startupRunIntegrationDetection } = await import('@/lib/model-integration-persist');
    await expect(startupRunIntegrationDetection()).resolves.toBeUndefined();
  });

  it('logs success on a clean run', async () => {
    writeModels([{ id: 'opus', agentTypes: ['claude'] }]);
    const { startupRunIntegrationDetection } = await import('@/lib/model-integration-persist');
    await expect(startupRunIntegrationDetection()).resolves.toBeUndefined();

    const after = readModels();
    expect(after.models[0].integration).toBeDefined();
  });
});
