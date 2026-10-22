// @vitest-environment jsdom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelDeleteDialog } from '@/components/modals/ChannelDeleteDialog';

type Workspace = { path: string; eligible: boolean; exists: boolean; bytes: number; files: number; gitIssues: string[] };
const folder = (gitIssues: string[] = []): Workspace => ({ path: '/home/user/Acme-Showcase', eligible: true, exists: true, bytes: 12 * 1024 ** 3, files: 15796, gitIssues });

function buttonByText(text: string): HTMLButtonElement {
  const match = Array.from(document.body.querySelectorAll('button')).find(b => b.textContent?.trim() === text);
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`);
  return match;
}
const checkbox = () => document.body.querySelector('input[type="checkbox"]') as HTMLInputElement | null;

describe('ChannelDeleteDialog and unsaved git work', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onConfirm: ReturnType<typeof vi.fn>;

  async function open(workspace: Workspace) {
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ workspace }) })) as unknown as typeof fetch;
    onConfirm = vi.fn();
    await act(async () => {
      root.render(React.createElement(ChannelDeleteDialog, {
        channelId: 'acme-showcase', channelName: 'Acme Showcase', mode: 'archive', busy: false, onCancel: () => undefined, onConfirm,
      }));
    });
    await act(async () => { await Promise.resolve(); });
  }
  const click = (el: HTMLElement) => act(async () => el.click());

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('lets a folder with unsaved git work be chosen for deletion (it used to be greyed out)', async () => {
    await open(folder(['.: uncommitted changes']));
    expect(buttonByText('Delete folder').disabled).toBe(false);
    expect(document.body.textContent).toContain('Has unsaved git work: .: uncommitted changes');
    expect(document.body.textContent).toContain('you can still delete it');
  });

  it('shows what would be lost and keeps the red button off until the box is ticked', async () => {
    await open(folder(['.: uncommitted changes', 'app: commits not pushed']));
    await click(buttonByText('Delete folder'));

    const box = checkbox();
    expect(box).not.toBeNull();
    expect(document.body.textContent).toContain('.: uncommitted changes; app: commits not pushed');
    expect(document.body.textContent).toContain('lost for good');
    expect(buttonByText('Archive channel').disabled).toBe(true);

    await click(box!);
    expect(buttonByText('Archive channel').disabled).toBe(false);
    await click(buttonByText('Archive channel'));
    expect(onConfirm).toHaveBeenCalledWith(true, true);
  });

  it('keeping the folder needs no tick and never discards anything', async () => {
    await open(folder(['.: uncommitted changes']));
    expect(checkbox()).toBeNull();
    await click(buttonByText('Archive channel'));
    expect(onConfirm).toHaveBeenCalledWith(false, false);
  });

  it('a tick does not carry over after switching back to Keep folder and choosing Delete folder again', async () => {
    await open(folder(['.: uncommitted changes']));
    await click(buttonByText('Delete folder'));
    await click(checkbox()!);
    await click(buttonByText('Keep folder'));
    expect(checkbox()).toBeNull();
    await click(buttonByText('Delete folder'));
    expect(checkbox()!.checked).toBe(false);
    expect(buttonByText('Archive channel').disabled).toBe(true);
  });

  it('a clean folder is deleted as before, with no extra step', async () => {
    await open(folder([]));
    await click(buttonByText('Delete folder'));
    expect(checkbox()).toBeNull();
    await click(buttonByText('Archive channel'));
    expect(onConfirm).toHaveBeenCalledWith(true, false);
  });
});
