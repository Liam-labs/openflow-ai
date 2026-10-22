// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ChannelDraftAttachments,
  createIndexedDbPersistence,
  type DraftAttachment,
  type DraftEntry,
  type DraftPersistence,
} from '@/lib/chat-draft-attachments';
import { useChannelAttachmentDrafts } from '@/hooks/useChannelAttachmentDrafts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const image = (id: string, name = `${id}.png`): DraftAttachment => ({ clientId: id, name, type: 'image/png', data: `data:image/png;base64,${id}`, size: 10 });

class FakePersistence implements DraftPersistence {
  saved = new Map<string, DraftEntry>();
  calls: string[] = [];
  failWith: Error | null = null;

  async load(channelId: string) {
    this.calls.push(`load ${channelId}`);
    if (this.failWith) throw this.failWith;
    return this.saved.get(channelId) ?? null;
  }

  async save(channelId: string, entry: DraftEntry) {
    this.calls.push(`save ${channelId}`);
    if (this.failWith) throw this.failWith;
    this.saved.set(channelId, entry);
  }

  async remove(channelId: string) {
    this.calls.push(`remove ${channelId}`);
    if (this.failWith) throw this.failWith;
    this.saved.delete(channelId);
  }
}

describe('a pasted image stays with the draft of the channel it was pasted into', () => {
  it('is not visible, or sendable, from another channel', () => {
    const store = new ChannelDraftAttachments();
    store.set('sg-1', [image('a')]);
    expect(store.get('sg-1').map(item => item.clientId)).toEqual(['a']);
    expect(store.get('other')).toEqual([]);
  });

  it('is still there when the original channel is opened again', () => {
    const store = new ChannelDraftAttachments();
    store.set('sg-1', [image('a'), image('b')]);
    store.set('other', [image('c')]);
    expect(store.get('sg-1').map(item => item.clientId)).toEqual(['a', 'b']);
    expect(store.get('other').map(item => item.clientId)).toEqual(['c']);
  });

  it('is cleared only when that channel sends, leaving other drafts and their numbering alone', () => {
    const store = new ChannelDraftAttachments();
    store.set('sg-1', [image('a')]);
    store.nextOrdinal('sg-1');
    store.set('other', [image('c')]);
    store.nextOrdinal('other');
    store.nextOrdinal('other');
    store.clear('other');
    expect(store.get('other')).toEqual([]);
    expect(store.nextOrdinal('other')).toBe(1);               // numbering starts again after a send
    expect(store.get('sg-1').map(item => item.clientId)).toEqual(['a']);
    expect(store.nextOrdinal('sg-1')).toBe(2);                // and carries on in the draft that was not sent
  });

  it('keeps numbering "Image N" per channel and does not reuse a number after a removal', () => {
    const store = new ChannelDraftAttachments();
    expect([store.nextOrdinal('a'), store.nextOrdinal('a'), store.nextOrdinal('b')]).toEqual([1, 2, 1]);
    store.set('a', [image('x')]);
    store.set('a', []);                                       // the user removed the image
    expect(store.nextOrdinal('a')).toBe(3);
  });

  it('tracks files still being read per channel, so a slow read in one channel never blocks sending in another', () => {
    const store = new ChannelDraftAttachments();
    store.beginReads('a', 2);
    expect([store.readsInFlight('a'), store.readsInFlight('b')]).toEqual([2, 0]);
    store.endReads('a', 1);
    store.endReads('a', 5);                                   // never negative
    expect(store.readsInFlight('a')).toBe(0);
  });

  it('lets a read that finishes after a channel switch land in the channel it started in', () => {
    const store = new ChannelDraftAttachments();
    store.beginReads('a', 1);
    // the user has moved to channel b; the read for a completes
    store.update('a', current => [...current, image('late')]);
    store.endReads('a', 1);
    expect(store.get('b')).toEqual([]);
    expect(store.get('a').map(item => item.clientId)).toEqual(['late']);
  });
});

describe('the store as something React can read', () => {
  it('returns the same array until the attachments change, and says which channel changed', () => {
    const store = new ChannelDraftAttachments();
    const seen: string[] = [];
    const unsubscribe = store.subscribe(channelId => seen.push(channelId));
    const first = [image('a')];
    store.set('a', first);
    expect(store.get('a')).toBe(store.get('a'));
    store.set('a', first);                                    // same array: nothing changed
    store.set('empty', []);                                   // nothing to remember
    store.beginReads('b', 1);
    expect(seen).toEqual(['a', 'b']);
    unsubscribe();
    store.set('a', [image('x')]);
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('a draft survives a page reload', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is saved shortly after it changes, with its numbering, and removed once empty', async () => {
    const saved = new FakePersistence();
    const store = new ChannelDraftAttachments(saved, 250);
    store.nextOrdinal('a');
    store.set('a', [image('x')]);
    store.set('a', [image('x'), image('y')]);                 // quick successive changes write once
    await vi.advanceTimersByTimeAsync(300);
    expect(saved.calls).toEqual(['save a']);
    expect(saved.saved.get('a')?.attachments.map(item => item.clientId)).toEqual(['x', 'y']);
    expect(saved.saved.get('a')?.ordinal).toBe(1);
    store.clear('a');
    await vi.advanceTimersByTimeAsync(300);
    expect(saved.saved.has('a')).toBe(false);
  });

  it('can be written at once when the page is being hidden', async () => {
    const saved = new FakePersistence();
    const store = new ChannelDraftAttachments(saved, 60_000);
    store.set('a', [image('x')]);
    await store.flush();
    expect(saved.saved.get('a')?.attachments).toHaveLength(1);
  });

  it('comes back when the channel is opened, merged with anything added while it was loading', async () => {
    const saved = new FakePersistence();
    saved.saved.set('a', { attachments: [image('old1'), image('old2')], ordinal: 2, savedAt: 1 });
    const store = new ChannelDraftAttachments(saved);
    store.set('a', [image('old2'), image('new')]);            // pasted before the saved copy arrived
    store.nextOrdinal('a');
    await store.hydrate('a');
    expect(store.get('a').map(item => item.clientId)).toEqual(['old1', 'old2', 'new']);
    expect(store.nextOrdinal('a')).toBe(3);
  });

  it('restores into an empty channel and only loads once', async () => {
    const saved = new FakePersistence();
    saved.saved.set('a', { attachments: [image('old1')], ordinal: 1, savedAt: 1 });
    const store = new ChannelDraftAttachments(saved);
    await store.hydrate('a');
    await store.hydrate('a');
    expect(store.get('a').map(item => item.clientId)).toEqual(['old1']);
    expect(saved.calls.filter(call => call === 'load a')).toHaveLength(1);
  });

  it('does not bring back a draft that was sent while its saved copy was still loading', async () => {
    const saved = new FakePersistence();
    saved.saved.set('a', { attachments: [image('sent')], ordinal: 1, savedAt: 1 });
    const store = new ChannelDraftAttachments(saved);
    const loading = store.hydrate('a');
    store.clear('a');
    await loading;
    expect(store.get('a')).toEqual([]);
  });

  it('ignores a damaged saved copy and a store that cannot read or write at all', async () => {
    const saved = new FakePersistence();
    saved.saved.set('a', { attachments: 'nonsense' as unknown as DraftAttachment[], ordinal: 1, savedAt: 1 });
    const store = new ChannelDraftAttachments(saved);
    await store.hydrate('a');
    expect(store.get('a')).toEqual([]);

    const broken = new FakePersistence();
    broken.failWith = new Error('quota exceeded');
    const offline = new ChannelDraftAttachments(broken, 10);
    await offline.hydrate('b');
    offline.set('b', [image('x')]);
    await vi.advanceTimersByTimeAsync(50);
    expect(offline.get('b').map(item => item.clientId)).toEqual(['x']);   // the draft is intact in memory
  });

  it('is memory-only where there is no IndexedDB', async () => {
    expect(createIndexedDbPersistence(undefined)).toBeNull();
    const store = new ChannelDraftAttachments(null);
    store.set('a', [image('x')]);
    await store.hydrate('a');
    await store.flush();
    expect(store.get('a')).toHaveLength(1);
  });
});

describe('the composer hook', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let api: ReturnType<typeof useChannelAttachmentDrafts>;
  let store: ChannelDraftAttachments;

  function Probe({ channelId }: { channelId: string | undefined }) {
    api = useChannelAttachmentDrafts(channelId, store);
    return null;
  }

  const show = (channelId: string | undefined) => act(async () => { root.render(React.createElement(Probe, { channelId })); });

  beforeEach(() => {
    store = new ChannelDraftAttachments();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows each channel its own attachments as the user moves between them', async () => {
    await show('sg-1');
    await act(async () => { api.setAttachments([image('pasted')]); });
    expect(api.attachments.map(item => item.clientId)).toEqual(['pasted']);

    await show('quick-message-channel');
    expect(api.attachments).toEqual([]);                      // the image did not follow the user

    await show('sg-1');
    expect(api.attachments.map(item => item.clientId)).toEqual(['pasted']);   // and it is waiting in the draft
  });

  it('writes to the channel that is open now, so a message sent elsewhere carries nothing from the draft', async () => {
    await show('sg-1');
    await act(async () => { api.setAttachments([image('draft-image')]); });
    await show('other');
    await act(async () => { api.setAttachments(current => [...current, image('other-image')]); });
    expect(api.attachments.map(item => item.clientId)).toEqual(['other-image']);
    await act(async () => { store.clear('other'); });         // sending in the other channel
    expect(api.attachments).toEqual([]);
    await show('sg-1');
    expect(api.attachments.map(item => item.clientId)).toEqual(['draft-image']);
  });

  it('is updated when a slow read finishes for the channel that is open, and is not disturbed when it is another', async () => {
    await show('a');
    await act(async () => { store.beginReads('a', 1); });
    expect(api.reads).toBe(1);
    await show('b');
    expect(api.reads).toBe(0);
    await act(async () => { store.update('a', current => [...current, image('late')]); store.endReads('a', 1); });
    expect(api.attachments).toEqual([]);
    await show('a');
    expect(api.attachments.map(item => item.clientId)).toEqual(['late']);
    expect(api.reads).toBe(0);
  });

  it('loads a saved draft when the channel opens, and does nothing with no channel', async () => {
    const saved = new FakePersistence();
    saved.saved.set('a', { attachments: [image('from-last-session')], ordinal: 1, savedAt: Date.now() });
    store = new ChannelDraftAttachments(saved);
    await show('a');
    await act(async () => { await Promise.resolve(); });
    expect(api.attachments.map(item => item.clientId)).toEqual(['from-last-session']);
    await show(undefined);
    await act(async () => { api.setAttachments([image('ignored')]); });
    expect(api.attachments).toEqual([]);
  });
});
