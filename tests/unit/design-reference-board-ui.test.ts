// @vitest-environment jsdom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignReferenceBoardCard } from '@/components/DesignReferenceBoardCard';
import type { DesignReferenceBoard } from '@/lib/design-references/types';

const board: DesignReferenceBoard = {
  id: 'board-ui',
  channelId: 'channel-ui',
  revision: 1,
  fingerprint: 'a'.repeat(64),
  brief: 'A warm editorial marketplace for independent makers.',
  shortlistSize: 5,
  candidates: Array.from({ length: 5 }, (_, index) => ({
    id: `candidate-${index + 1}`,
    title: `Reference ${index + 1}`,
    source: index % 2 ? 'Webflow' : 'GitHub',
    itemUrl: `https://example.com/item/${index + 1}`,
    previewUrl: `https://example.com/preview/${index + 1}`,
    imageUrl: `https://images.example.com/${index + 1}.jpg`,
    capturedAt: '2026-08-30T16:00:00.000Z',
    platform: 'Next.js',
    stack: ['Next.js'],
    licence: { status: 'clear' as const, summary: 'MIT', url: 'https://example.com/licence' },
    popularity: { label: 'GitHub stars', value: '2.4k', confidence: 'high' as const },
    useMode: 'open-source-base' as const,
    fitScore: 95 - index,
    fitReasons: ['Strong hierarchy', 'Good product journey'],
    tradeoff: 'Needs original checkout work.',
  })),
  createdBy: { participantId: 'roster-architect', name: 'Architect' },
  createdAt: '2026-08-30T16:00:00.000Z',
  expiresAt: '2026-09-06T16:00:00.000Z',
};

function button(label: string, occurrence = 0): HTMLButtonElement {
  const matches = Array.from(document.querySelectorAll('button'))
    .filter(element => element.textContent?.trim().includes(label));
  const match = matches[occurrence];
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return match;
}

describe('DesignReferenceBoardCard', () => {
  let container: HTMLDivElement;
  let root: Root;

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

  it('combines two selected cards and collapses to the durable decision summary', async () => {
    const onSelection = vi.fn();
    await act(async () => {
      root.render(React.createElement(DesignReferenceBoardCard, {
        board,
        currentParticipantId: 'browser-owner',
        onSelection,
      }));
    });

    expect(container.textContent).toContain('Choose the design DNA before we build');
    expect(container.textContent).toContain('Build paused');
    expect(container.textContent).toContain('GitHub stars: 2.4k · high confidence');
    expect(container.querySelectorAll('article')).toHaveLength(5);

    await act(async () => (container.querySelectorAll('button[aria-pressed]')[0] as HTMLButtonElement).click());
    await act(async () => (container.querySelectorAll('button[aria-pressed]')[1] as HTMLButtonElement).click());
    expect(container.textContent).toContain('2 selected: Reference 1 + Reference 2');

    await act(async () => button('Combine selected').click());
    expect(onSelection).toHaveBeenCalledWith(expect.objectContaining({
      action: 'combine',
      candidateIds: ['candidate-1', 'candidate-2'],
      answeredBy: 'browser-owner',
      channelId: 'channel-ui',
      boardRevision: 1,
      boardFingerprint: 'a'.repeat(64),
    }));
    expect(container.textContent).toContain('Direction selected');
    expect(container.textContent).toContain('Combine Reference 1 + Reference 2');
  });

  it('opens one consolidated refinement path', async () => {
    await act(async () => {
      root.render(React.createElement(DesignReferenceBoardCard, {
        board,
        currentParticipantId: 'browser-owner',
        onSelection: () => undefined,
      }));
    });

    await act(async () => button('Refine search').click());
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect(textarea?.placeholder).toContain('What should change?');
    expect(button('Send refinement')).toBeTruthy();
  });

  it('keeps the current board open and explains a stale-selection rejection', async () => {
    const onSelection = vi.fn().mockRejectedValue(
      new Error('Invalid design reference payload: selection targets a stale board revision or fingerprint'),
    );
    await act(async () => {
      root.render(React.createElement(DesignReferenceBoardCard, {
        board,
        currentParticipantId: 'browser-owner',
        onSelection,
      }));
    });

    await act(async () => button('Use this direction').click());

    expect(container.textContent).toContain('Choose the design DNA before we build');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'selection targets a stale board revision or fingerprint',
    );
  });
});
