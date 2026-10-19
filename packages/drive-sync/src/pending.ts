import { browserStorage, type KeyValueStorage } from "./storage.js";

/** Cap the bookkeeping so a runaway local session can't exhaust localStorage. */
const MAX_TRACKED_IDS = 10000;

export interface PendingChanges {
  edited: Set<string>;
  deleted: Set<string>;
}

export interface PendingTrackerOptions {
  /** Pending sets are stored under `${keyPrefix}:${collection}`. */
  keyPrefix: string;
  /** Where the uid owning the local data is recorded. */
  ownerKey: string;
  storage?: KeyValueStorage | null;
}

const toIdSet = (ids: unknown): Set<string> =>
  new Set(Array.isArray(ids) ? ids.map(String) : []);

const capped = (ids: string[]): string[] => (ids.length > MAX_TRACKED_IDS ? ids.slice(-MAX_TRACKED_IDS) : ids);

/**
 * Content fingerprint per id. Comparing two of these is how a save detects
 * which records the user actually touched, without every mutation call site
 * having to remember to report itself.
 */
export function fingerprintItems<T extends object>(
  items: T[],
  idOf: (item: T) => string | number = (item) => (item as { id: string | number }).id,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(items)) return map;
  for (const item of items) map.set(String(idOf(item)), JSON.stringify(item));
  return map;
}

/** Ids added or changed, and ids removed, between two fingerprints. */
export function diffFingerprints(before: Map<string, string>, after: Map<string, string>) {
  const edited: string[] = [];
  for (const [id, hash] of after) {
    if (before.get(id) !== hash) edited.push(id);
  }
  const deleted: string[] = [];
  for (const id of before.keys()) {
    if (!after.has(id)) deleted.push(id);
  }
  return { edited, deleted };
}

/**
 * Tracks which locally-changed records have not been confirmed written to the
 * cloud yet, so a later pull can tell "the user edited this while we believed
 * we were offline" apart from "this is just an older copy of a record another
 * device has since changed". Writes are keyed per collection because each
 * collection syncs independently. Also owns the data-owner marker: whose
 * account the local data belongs to.
 */
export function createPendingTracker({ keyPrefix, ownerKey, storage = browserStorage() }: PendingTrackerOptions) {
  const keyFor = (collection: string) => `${keyPrefix}:${collection}`;

  function readPending(collection: string): PendingChanges {
    const empty = { edited: new Set<string>(), deleted: new Set<string>() };
    if (!storage) return empty;
    try {
      const raw = storage.getItem(keyFor(collection));
      if (!raw) return empty;
      const parsed = JSON.parse(raw);
      return { edited: toIdSet(parsed?.edited), deleted: toIdSet(parsed?.deleted) };
    } catch {
      return empty;
    }
  }

  function writePending(collection: string, pending: PendingChanges): void {
    if (!storage) return;
    const edited = capped([...pending.edited]);
    const deleted = capped([...pending.deleted]);
    try {
      if (edited.length === 0 && deleted.length === 0) {
        storage.removeItem(keyFor(collection));
        return;
      }
      storage.setItem(keyFor(collection), JSON.stringify({ edited, deleted }));
    } catch {
      // Storage full or blocked. The pull then falls back to preferring cloud for
      // shared ids: degraded, not broken.
    }
  }

  /** The uid whose data is in local storage, or null for data created while signed out. */
  function readDataOwner(): string | null {
    if (!storage) return null;
    try {
      return storage.getItem(ownerKey) || null;
    } catch {
      return null;
    }
  }

  return {
    keyFor,
    readPending,

    /** How many records are waiting for a cloud write, for the header to show. */
    countPending(collection: string): number {
      const { edited, deleted } = readPending(collection);
      return edited.size + deleted.size;
    },

    /**
     * Fold one save's changes into the pending set. An id is only ever in one of
     * the two sets: re-creating a deleted id makes it an edit again, and deleting
     * an edited id makes it a delete.
     */
    recordLocalChanges(collection: string, { edited = [], deleted = [] }: { edited?: Array<string | number>; deleted?: Array<string | number> }): void {
      if (edited.length === 0 && deleted.length === 0) return;
      const pending = readPending(collection);
      for (const id of edited) {
        pending.deleted.delete(String(id));
        pending.edited.add(String(id));
      }
      for (const id of deleted) {
        pending.edited.delete(String(id));
        pending.deleted.add(String(id));
      }
      writePending(collection, pending);
    },

    /** Drop ids whose cloud write has actually landed: they are no longer at risk. */
    clearPendingIds(collection: string, ids: Array<string | number>): void {
      if (!ids || ids.length === 0) return;
      const pending = readPending(collection);
      let changed = false;
      for (const id of ids) {
        const key = String(id);
        if (pending.edited.delete(key)) changed = true;
        if (pending.deleted.delete(key)) changed = true;
      }
      if (changed) writePending(collection, pending);
    },

    readDataOwner,

    writeDataOwner(uid: string): void {
      if (!storage) return;
      try {
        storage.setItem(ownerKey, String(uid));
      } catch {
        // Unrecorded ownership degrades to treating the data as signed-out data.
      }
    },

    /**
     * True when the local data belongs to another account than `uid`. The app
     * must then discard it before pulling: it is never merged into this account.
     * Data created while signed out (no owner) belongs to whoever connects first.
     */
    ownedByAnother(uid: string): boolean {
      const owner = readDataOwner();
      return owner !== null && owner !== String(uid);
    },

    /** Forget owner and pending state, as sign-out must before another account signs in. */
    clearLocalSyncState(collections: string[]): void {
      if (!storage) return;
      try {
        storage.removeItem(ownerKey);
        collections.forEach((collection) => storage.removeItem(keyFor(collection)));
      } catch {
        // Blocked storage has nothing persisted to clear.
      }
    },
  };
}

export type PendingTracker = ReturnType<typeof createPendingTracker>;
