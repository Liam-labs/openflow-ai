import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  type ChannelDraftAttachments,
  type DraftAttachment,
  getChannelDraftAttachments,
} from '@/lib/chat-draft-attachments';

const NONE: DraftAttachment[] = [];

/**
 * The pasted/dropped attachments of one channel's draft. Switching channels shows that channel's own attachments, and
 * `setAttachments` always writes to the channel that is active now. Work that finishes later for another channel (a slow file
 * read) must write through the returned `store` with the channel id it started in.
 */
export function useChannelAttachmentDrafts(
  channelId: string | undefined,
  store: ChannelDraftAttachments = getChannelDraftAttachments(),
) {
  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe(changed => { if (changed === channelId) onChange(); }),
    [store, channelId],
  );
  const attachments = useSyncExternalStore(
    subscribe,
    () => (channelId ? store.get(channelId) : NONE),
    () => NONE,
  );
  const reads = useSyncExternalStore(
    subscribe,
    () => (channelId ? store.readsInFlight(channelId) : 0),
    () => 0,
  );

  useEffect(() => {
    if (channelId) void store.hydrate(channelId);
  }, [store, channelId]);

  // The writer is the same function on every render and reads the active channel when it is CALLED. Callers keep it inside
  // long-lived callbacks (the image markup editor's Save, a paste that finishes later); a writer tied to the channel of the
  // render it came from silently did nothing once that callback outlived the first render, when no channel was open yet.
  const channelRef = useRef(channelId);
  channelRef.current = channelId;
  const setAttachments = useCallback(
    (value: DraftAttachment[] | ((current: DraftAttachment[]) => DraftAttachment[])) => {
      const active = channelRef.current;
      if (!active) return;
      store.update(active, current => (typeof value === 'function' ? value(current) : value));
    },
    [store],
  );

  return { attachments, reads, setAttachments, store };
}
