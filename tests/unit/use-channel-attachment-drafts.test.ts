// @vitest-environment jsdom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useChannelAttachmentDrafts } from '@/hooks/useChannelAttachmentDrafts';
import { ChannelDraftAttachments, type DraftAttachment } from '@/lib/chat-draft-attachments';

const image = (clientId: string, data = 'data:image/png;base64,ORIGINAL'): DraftAttachment => ({
  clientId, data, name: `${clientId}.png`, type: 'image/png',
});
const marked = (items: DraftAttachment[]) => items.map(item => ({ ...item, data: 'data:image/png;base64,MARKED' }));

type Api = ReturnType<typeof useChannelAttachmentDrafts>;

describe('useChannelAttachmentDrafts setter', () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ChannelDraftAttachments;
  let latest: Api;
  let writers: Api['setAttachments'][];

  function Probe({ channelId }: { channelId?: string }) {
    latest = useChannelAttachmentDrafts(channelId, store);
    writers.push(latest.setAttachments);
    return null;
  }
  const show = (channelId?: string) => act(async () => { root.render(React.createElement(Probe, { channelId })); });

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    store = new ChannelDraftAttachments(null);
    writers = [];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  // The markup editor's Save runs a callback created once, on the first render, when no channel was open yet.
  // 18 Oct 2026: that callback held a setter tied to "no channel", so Save changed nothing.
  it('a setter kept from the first render still saves into the channel that is open when it is called', async () => {
    await show(undefined);
    const keptFromFirstRender = latest.setAttachments;
    await act(async () => store.set('chan-a', [image('one')]));
    await show('chan-a');

    await act(async () => keptFromFirstRender(marked));

    expect(store.get('chan-a')[0].data).toBe('data:image/png;base64,MARKED');
    expect(latest.attachments[0].data).toBe('data:image/png;base64,MARKED');
  });

  it('follows the channel the user switches to and never writes into the one they left', async () => {
    await act(async () => store.set('chan-a', [image('a1')]));
    await act(async () => store.set('chan-b', [image('b1')]));
    await show('chan-a');
    const keptFromChannelA = latest.setAttachments;
    await show('chan-b');

    await act(async () => keptFromChannelA(current => [...current, image('b2')]));

    expect(store.get('chan-b').map(item => item.clientId)).toEqual(['b1', 'b2']);
    expect(store.get('chan-a').map(item => item.clientId)).toEqual(['a1']);
  });

  it('is the same function on every render and channel switch, so a dependency list can never go stale', async () => {
    await show(undefined);
    await show('chan-a');
    await show('chan-b');
    await show('chan-a');
    expect(new Set(writers).size).toBe(1);
  });

  it('does nothing while no channel is open', async () => {
    await show(undefined);
    await act(async () => latest.setAttachments([image('x')]));
    expect(store.get('chan-a')).toEqual([]);
    expect(latest.attachments).toEqual([]);
  });

  it('still takes a plain array as well as an updater function', async () => {
    await show('chan-a');
    await act(async () => latest.setAttachments([image('p1'), image('p2')]));
    expect(store.get('chan-a').map(item => item.clientId)).toEqual(['p1', 'p2']);
  });
});
