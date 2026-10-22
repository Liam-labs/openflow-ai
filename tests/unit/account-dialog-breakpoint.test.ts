// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { useBreakpoint } from '../../lib/hooks/useBreakpoint';
import { SettingsDialog } from '../../components/collab/AccountSettings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
describe('Account dialog and responsive hydration', () => {
  it('hydrates server markup on a phone then applies the mobile layout without recovery', async () => {
    const previousWidth = window.innerWidth;
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    window.matchMedia = vi.fn().mockImplementation(() => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    function Probe() { const { isMobile } = useBreakpoint(); return isMobile ? React.createElement('button', null, 'Open channels') : React.createElement('aside', null, 'Desktop sidebar'); }
    const host = document.createElement('div');
    host.innerHTML = renderToString(React.createElement(Probe));
    expect(host.textContent).toBe('Desktop sidebar');
    document.body.append(host);
    const recover = vi.fn();
    let root: ReturnType<typeof hydrateRoot>;
    try {
      await act(async () => { root = hydrateRoot(host, React.createElement(Probe), { onRecoverableError: recover }); });
      expect(host.textContent).toBe('Open channels');
      expect(recover).not.toHaveBeenCalled();
    } finally {
      await act(async () => root!.unmount()); host.remove();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth });
      window.matchMedia = previousMatchMedia;
    }
  });
  it('closes settings on Escape without triggering page shortcuts', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host); const close = vi.fn(); const pageShortcut = vi.fn();
    document.addEventListener('keydown', pageShortcut);
    try {
      await act(async () => root.render(React.createElement(SettingsDialog, { title: 'Customise sidebar', onClose: close, children: React.createElement('input', { 'aria-label': 'Example' }) })));
      await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(close).toHaveBeenCalledOnce();
      expect(pageShortcut).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', pageShortcut);
      await act(async () => root.unmount()); host.remove();
    }
  });
});
