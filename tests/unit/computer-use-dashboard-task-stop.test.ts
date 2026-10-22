/**
 * Structural test for the dashboard route exposing `task.stop` / `task.status`
 * (audit task 5119f8a2) — verifies the wiring without spinning up Next.js.
 *
 * Sheppard's local-dashboard stop button targets POST /api/computer-use because
 * it has the localhost-bypass auth pattern; the agent-API route requires bearer.
 * The wiring forwards to the same handlers the agent API uses, so behaviour is
 * identical. This test guards the file-level wiring against regressions.
 */

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

const ROUTE_PATH = path.resolve(__dirname, '../../app/api/computer-use/route.ts');

describe('dashboard route: task.stop / task.status wiring', () => {
  it('imports stopTask and taskStatus from the agent action module', async () => {
    const text = await fs.readFile(ROUTE_PATH, 'utf-8');
    expect(text).toMatch(/import\s*\{[^}]*stopTask[^}]*\}\s*from\s*'@\/app\/api\/agent\/actions\/computer-use'/);
    expect(text).toMatch(/import\s*\{[^}]*taskStatus[^}]*\}\s*from\s*'@\/app\/api\/agent\/actions\/computer-use'/);
  });

  it('handles action === task.stop', async () => {
    const text = await fs.readFile(ROUTE_PATH, 'utf-8');
    expect(text).toMatch(/action\s*===\s*['"]task\.stop['"]/);
  });

  it('handles action === task.status', async () => {
    const text = await fs.readFile(ROUTE_PATH, 'utf-8');
    expect(text).toMatch(/action\s*===\s*['"]task\.status['"]/);
  });

  it('forwards to the shared handlers (no duplicated business logic)', async () => {
    const text = await fs.readFile(ROUTE_PATH, 'utf-8');
    // The dispatch should reference the imported handlers, not redefine them.
    expect(text).toMatch(/handler\s*=\s*action\s*===\s*['"]task\.stop['"]\s*\?\s*stopTask\s*:\s*taskStatus/);
  });
});
