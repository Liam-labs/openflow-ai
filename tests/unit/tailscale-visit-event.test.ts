import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventBus } from '@/lib/event-bus';
import { emitWizardChanged } from '@/lib/wizards/events';
import { clearVisitsForTests, noteTailnetVisit } from '@/lib/wizards/tailscale-visits';

const headers = (device: string | null, user: string | null = null) => ({
  get: (name: string) => (name === 'x-forwarded-for' ? device : name === 'tailscale-user-login' ? user : null),
});

describe('wizard:changed event (replaces polling in the connection wizards)', () => {
  let emit: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { clearVisitsForTests(); emit = vi.spyOn(eventBus, 'emitEvent').mockImplementation(() => {}); });
  afterEach(() => emit.mockRestore());

  it('carries the wizard name and nothing else', () => {
    emitWizardChanged('cloudflare');
    expect(emit).toHaveBeenCalledWith('wizard:changed', { wizard: 'cloudflare' });
  });
  it('is emitted when a tailnet device opens the installation, without the device, the user or the answer', () => {
    noteTailnetVisit(headers('100.100.1.5', 'someone@example.com'), true, 1000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('wizard:changed', { wizard: 'tailscale' });
    const sent = JSON.stringify(emit.mock.calls);
    expect(sent).not.toContain('someone@example.com');
    expect(sent).not.toContain('100.100.1.5');
  });
  it('is not emitted again for the same device and answer within 30 seconds', () => {
    noteTailnetVisit(headers('100.100.1.5'), true, 1000);
    noteTailnetVisit(headers('100.100.1.5'), true, 20_000);
    expect(emit).toHaveBeenCalledTimes(1);
  });
  it('is emitted again when the answer changes, the device changes, or it has been quiet for over 30 seconds', () => {
    noteTailnetVisit(headers('100.100.1.5'), true, 1000);
    noteTailnetVisit(headers('100.100.1.5'), false, 2000);
    noteTailnetVisit(headers('100.100.1.6'), false, 3000);
    noteTailnetVisit(headers('100.100.1.6'), false, 40_000);
    expect(emit).toHaveBeenCalledTimes(4);
  });
  it('is not emitted for a request that did not come through the tailnet', () => {
    noteTailnetVisit(headers('203.0.113.9'), true, 1000);
    noteTailnetVisit(headers(null), true, 2000);
    expect(emit).not.toHaveBeenCalled();
  });
});
