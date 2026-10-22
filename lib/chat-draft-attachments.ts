/**
 * Pasted and dropped attachments belong to the draft of the channel they were added in.
 *
 * Until now the composer held them in one piece of component state, so an image pasted into a draft in channel A was still
 * attached after switching to channel B, and a quick message sent there carried it away. The text draft was already kept per
 * channel (localStorage `devflow-draft-<channelId>`); this store gives the attachments the same life: they stay with the channel,
 * come back when the channel is reopened, survive a page reload, and are cleared only when that channel's draft is sent.
 *
 * Everything is keyed by channel id and kept in memory first (the source of truth while the page is open). A browser adapter
 * mirrors it to IndexedDB, which holds image data far larger than localStorage can; persistence failures never lose the
 * in-memory draft or throw into the UI.
 */

export interface DraftAttachment {
  data: string;
  name: string;
  type: string;
  size?: number;
  clientId: string;
}

export interface DraftEntry {
  attachments: DraftAttachment[];
  /** Highest "Image N" number handed out in this draft; continues after a removal so labels never repeat. */
  ordinal: number;
  savedAt: number;
}

export interface DraftPersistence {
  load(channelId: string): Promise<DraftEntry | null>;
  save(channelId: string, entry: DraftEntry): Promise<void>;
  remove(channelId: string): Promise<void>;
}

const NONE: DraftAttachment[] = [];
export const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 250;

export class ChannelDraftAttachments {
  private entries = new Map<string, DraftEntry>();
  private reads = new Map<string, number>();
  private settled = new Set<string>();                       // channels whose saved copy has been loaded, or must not be
  private sends = new Map<string, number>();                 // how many times each channel's draft has been sent or discarded
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<(channelId: string) => void>();

  constructor(private persistence: DraftPersistence | null = null, private saveDelayMs: number = SAVE_DELAY_MS) {}

  /** The channel's attachments. The same array is returned until they change, so React can compare it. */
  get(channelId: string): DraftAttachment[] {
    return this.entries.get(channelId)?.attachments ?? NONE;
  }

  set(channelId: string, attachments: DraftAttachment[]): void {
    const current = this.entries.get(channelId);
    if (current?.attachments === attachments) return;
    if (!current && attachments.length === 0) return;
    this.entries.set(channelId, { attachments, ordinal: current?.ordinal ?? 0, savedAt: Date.now() });
    this.changed(channelId);
  }

  update(channelId: string, change: (current: DraftAttachment[]) => DraftAttachment[]): void {
    this.set(channelId, change(this.get(channelId)));
  }

  /** The draft was sent (or discarded): its attachments and numbering go, other channels are untouched. */
  clear(channelId: string): void {
    this.settled.add(channelId);
    this.sends.set(channelId, (this.sends.get(channelId) ?? 0) + 1);   // a load already under way must not bring the old copy back
    if (!this.entries.delete(channelId)) {
      this.persist(channelId);
      return;
    }
    this.changed(channelId);
  }

  /** Next "Image N" number for this channel's draft. */
  nextOrdinal(channelId: string): number {
    const current = this.entries.get(channelId);
    const ordinal = (current?.ordinal ?? 0) + 1;
    this.entries.set(channelId, { attachments: current?.attachments ?? NONE, ordinal, savedAt: Date.now() });
    this.persist(channelId);
    return ordinal;
  }

  readsInFlight(channelId: string): number {
    return this.reads.get(channelId) ?? 0;
  }

  beginReads(channelId: string, count: number): void {
    this.reads.set(channelId, this.readsInFlight(channelId) + count);
    this.notify(channelId);
  }

  endReads(channelId: string, count: number): void {
    const left = Math.max(0, this.readsInFlight(channelId) - count);
    if (left === 0) this.reads.delete(channelId);
    else this.reads.set(channelId, left);
    this.notify(channelId);
  }

  /** Bring back what was saved for this channel (a reload, or a first visit since). Safe to call repeatedly. */
  async hydrate(channelId: string): Promise<void> {
    if (!this.persistence || this.settled.has(channelId)) return;
    this.settled.add(channelId);
    const sentBefore = this.sends.get(channelId) ?? 0;
    let saved: DraftEntry | null = null;
    try {
      saved = await this.persistence.load(channelId);
    } catch {
      return;
    }
    if ((this.sends.get(channelId) ?? 0) !== sentBefore) return;          // sent while it was loading: that draft is gone
    if (!saved || !Array.isArray(saved.attachments) || (saved.attachments.length === 0 && !saved.ordinal)) return;
    const current = this.entries.get(channelId);
    if (!current) {
      this.entries.set(channelId, { attachments: saved.attachments, ordinal: saved.ordinal || 0, savedAt: saved.savedAt });
    } else {                                                 // the user already added something while this was loading
      const have = new Set(current.attachments.map(item => item.clientId));
      this.entries.set(channelId, {
        attachments: [...saved.attachments.filter(item => !have.has(item.clientId)), ...current.attachments],
        ordinal: Math.max(saved.ordinal || 0, current.ordinal),
        savedAt: Date.now(),
      });
    }
    this.notify(channelId);
  }

  subscribe(listener: (channelId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Write anything waiting to be saved now (page hiding, tests). */
  async flush(): Promise<void> {
    const waiting = [...this.timers.keys()];
    for (const channelId of waiting) {
      clearTimeout(this.timers.get(channelId)!);
      this.timers.delete(channelId);
    }
    await Promise.all(waiting.map(channelId => this.write(channelId)));
  }

  private changed(channelId: string): void {
    this.notify(channelId);
    this.persist(channelId);
  }

  private notify(channelId: string): void {
    for (const listener of [...this.listeners]) listener(channelId);
  }

  private persist(channelId: string): void {
    if (!this.persistence) return;
    const waiting = this.timers.get(channelId);
    if (waiting) clearTimeout(waiting);
    this.timers.set(channelId, setTimeout(() => {
      this.timers.delete(channelId);
      void this.write(channelId);
    }, this.saveDelayMs));
  }

  private async write(channelId: string): Promise<void> {
    if (!this.persistence) return;
    const entry = this.entries.get(channelId);
    try {
      if (entry && (entry.attachments.length > 0 || entry.ordinal > 0)) {
        await this.persistence.save(channelId, { ...entry, savedAt: Date.now() });
      } else {
        await this.persistence.remove(channelId);
      }
    } catch {
      // The in-memory draft is intact; a failed save only means it would not survive a reload.
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Browser persistence (IndexedDB)
// ---------------------------------------------------------------------------------------------------------------------

const DB_NAME = 'devflow-chat-drafts';
const STORE = 'drafts';

export function createIndexedDbPersistence(factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB): DraftPersistence | null {
  if (!factory) return null;
  let opening: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        pruneOld(request.result);
        resolve(request.result);
      };
    }).catch(error => { opening = null; throw error; });
    return opening;
  };

  const pruneOld = (db: IDBDatabase): void => {
    try {
      const cursorRequest = db.transaction(STORE, 'readwrite').objectStore(STORE).openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (Date.now() - ((cursor.value as DraftEntry)?.savedAt ?? 0) > DRAFT_MAX_AGE_MS) cursor.delete();
        cursor.continue();
      };
    } catch {
      // Pruning is housekeeping only.
    }
  };

  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  };

  return {
    load: async channelId => ((await run('readonly', store => store.get(channelId))) as DraftEntry | undefined) ?? null,
    save: async (channelId, entry) => { await run('readwrite', store => store.put(entry, channelId)); },
    remove: async channelId => { await run('readwrite', store => store.delete(channelId)); },
  };
}

let shared: ChannelDraftAttachments | null = null;

/** The one store the composer uses in the browser. Created on first use so server rendering never touches IndexedDB. */
export function getChannelDraftAttachments(): ChannelDraftAttachments {
  if (!shared) {
    shared = new ChannelDraftAttachments(createIndexedDbPersistence());
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => { void shared?.flush(); });
    }
  }
  return shared;
}
