import { describe, it, expect } from 'vitest';
import { createPendingTracker, diffFingerprints, fingerprintItems } from './pending.js';

/** In-memory stand-in for localStorage — keeps these tests off real storage. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    has: (k) => map.has(k),
  };
}

/** Storage that rejects every write, as a full or blocked quota does. */
const blockedStorage = {
  getItem: () => null,
  setItem: () => { throw new Error('QuotaExceededError'); },
  removeItem: () => { throw new Error('QuotaExceededError'); },
};

const MODE = 'tasks';
const sorted = (set) => [...set].sort();

const OWNER_KEY = 'app_owner';
const tracker = (storage) => createPendingTracker({ keyPrefix: 'app_pending', ownerKey: OWNER_KEY, storage });

describe('fingerprintItems', () => {
  it('keys records by id and detects content, not just membership', () => {
    const before = fingerprintItems([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
    expect(sorted(before.keys())).toEqual(['1', '2']);
    expect(before.get('1')).not.toBe(before.get('2'));
    expect(fingerprintItems(null).size).toBe(0);
  });
});

describe('diffFingerprints', () => {
  it('reports added, changed and removed ids', () => {
    const before = fingerprintItems([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
    const after = fingerprintItems([{ id: 1, name: 'A edited' }, { id: 3, name: 'C' }]);
    const { edited, deleted } = diffFingerprints(before, after);
    expect(edited.sort()).toEqual(['1', '3']);
    expect(deleted).toEqual(['2']);
  });

  it('reports nothing when the collection is untouched', () => {
    const items = [{ id: 1, name: 'A' }];
    const { edited, deleted } = diffFingerprints(fingerprintItems(items), fingerprintItems(items));
    expect(edited).toEqual([]);
    expect(deleted).toEqual([]);
  });
});

describe('pending record bookkeeping', () => {
  it('accumulates local changes and clears them only once the cloud write lands', () => {
    const storage = fakeStorage();
    tracker(storage).recordLocalChanges(MODE, { edited: ['1', '2'] });
    expect(sorted(tracker(storage).readPending(MODE).edited)).toEqual(['1', '2']);

    tracker(storage).clearPendingIds(MODE, ['1']);
    expect(sorted(tracker(storage).readPending(MODE).edited)).toEqual(['2']);
  });

  it('holds an id in exactly one of edited/deleted as it changes state', () => {
    const storage = fakeStorage();
    tracker(storage).recordLocalChanges(MODE, { edited: ['1'] });
    tracker(storage).recordLocalChanges(MODE, { deleted: ['1'] });
    expect(sorted(tracker(storage).readPending(MODE).edited)).toEqual([]);
    expect(sorted(tracker(storage).readPending(MODE).deleted)).toEqual(['1']);

    tracker(storage).recordLocalChanges(MODE, { edited: ['1'] });
    expect(sorted(tracker(storage).readPending(MODE).edited)).toEqual(['1']);
    expect(sorted(tracker(storage).readPending(MODE).deleted)).toEqual([]);
  });

  it('removes the storage entry once nothing is pending', () => {
    const storage = fakeStorage();
    tracker(storage).recordLocalChanges(MODE, { edited: ['1'] });
    tracker(storage).clearPendingIds(MODE, ['1']);
    expect(storage.has(tracker(null).keyFor(MODE))).toBe(false);
  });

  it('keeps collections separate so one cannot pin another', () => {
    const storage = fakeStorage();
    tracker(storage).recordLocalChanges('tasks', { edited: ['1'] });
    tracker(storage).recordLocalChanges('other', { edited: ['2'] });
    expect(sorted(tracker(storage).readPending('tasks').edited)).toEqual(['1']);
    expect(sorted(tracker(storage).readPending('other').edited)).toEqual(['2']);
  });

  it('reads empty rather than throwing on malformed, missing or blocked storage', () => {
    expect(sorted(tracker(fakeStorage({ [tracker(null).keyFor(MODE)]: '{oops' })).readPending(MODE).edited)).toEqual([]);
    expect(sorted(tracker(fakeStorage()).readPending(MODE).edited)).toEqual([]);
    expect(sorted(tracker(null).readPending(MODE).edited)).toEqual([]);
    expect(() => tracker(blockedStorage).recordLocalChanges(MODE, { edited: ['1'] })).not.toThrow();
  });
});

describe('local data ownership', () => {
  it('remembers which account the local data belongs to', () => {
    const storage = fakeStorage();
    expect(tracker(storage).readDataOwner()).toBeNull();
    tracker(storage).writeDataOwner('uid-a');
    expect(tracker(storage).readDataOwner()).toBe('uid-a');
  });

  it('clears owner and pending state on sign-out', () => {
    const storage = fakeStorage();
    tracker(storage).writeDataOwner('uid-a');
    tracker(storage).recordLocalChanges(MODE, { edited: ['2'] });
    tracker(storage).clearLocalSyncState([MODE]);
    expect(tracker(storage).readDataOwner()).toBeNull();
    expect(tracker(storage).readPending(MODE).edited.size).toBe(0);
  });

  it('survives blocked storage', () => {
    expect(() => tracker(blockedStorage).writeDataOwner('uid-a')).not.toThrow();
    expect(() => tracker(blockedStorage).clearLocalSyncState([MODE])).not.toThrow();
  });
});

describe('countPending', () => {
  it('counts edits and deletes, and is zero for empty, missing or blocked storage', () => {
    const storage = fakeStorage();
    expect(tracker(storage).countPending(MODE)).toBe(0);

    tracker(storage).recordLocalChanges(MODE, { edited: ['1', '2'], deleted: ['3'] });

    expect(tracker(storage).countPending(MODE)).toBe(3);
    expect(tracker(null).countPending(MODE)).toBe(0);
    expect(tracker(blockedStorage).countPending(MODE)).toBe(0);
  });
});

describe('ownedByAnother', () => {
  it.each([
    ['data created while signed out belongs to whoever connects first', null, 'uid-b', false],
    ['the same account keeps its data', 'uid-a', 'uid-a', false],
    ['a different account must not inherit the previous account\'s data', 'uid-a', 'uid-b', true],
  ])('%s', (_name, owner, connecting, expected) => {
    const storage = fakeStorage();
    if (owner) tracker(storage).writeDataOwner(owner);
    expect(tracker(storage).ownedByAnother(connecting)).toBe(expected);
  });
});
