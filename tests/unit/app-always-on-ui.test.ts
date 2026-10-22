import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('App settings Always On control', () => {
  it('persists and explains the Always On policy', async () => {
    const modal = await readFile('components/AppRegistryModal.tsx', 'utf8');
    const route = await readFile('app/api/apps/route.ts', 'utf8');

    expect(modal).toContain('Always On');
    expect(modal).toContain('Windows startup');
    expect(modal).toContain("alwaysOn: formData.alwaysOn");
    expect(route).toMatch(/allowedFields[^\n]+alwaysOn/);
  });

  it('shows WebGate hosting state and URL in app settings', async () => {
    const modal = await readFile('components/AppRegistryModal.tsx', 'utf8');
    const route = await readFile('app/api/apps/route.ts', 'utf8');

    expect(modal).toContain('WebGate');
    expect(modal).toContain('Hosted through WebGate');
    expect(modal).toContain('Not hosted through WebGate');
    expect(modal).toContain('editingApp.webGate.url');
    expect(route).toContain('findWebGateService');
  });
});
