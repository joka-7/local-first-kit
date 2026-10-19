import type { PendingChanges } from "./pending.js";

export interface ResolveResult<T> {
  merged: T[];
  pushToCloud: boolean;
  /** Ids of local records the cloud lacks or has stale; only these are written back. */
  pushIds: string[];
  /** Ids with a pending local delete that the pull still returned; replay the delete upstream. */
  deleteFromCloud: string[];
}

const defaultIdOf = (item: { id?: unknown }): string => String(item.id);

/**
 * Union-merge a pull into local records by id. Cloud is authoritative by
 * default, with two exceptions the local side owns, both drawn from `pending`
 * (the records whose local change has not been confirmed written to the cloud):
 *
 * - a record with a pending local edit keeps the local copy and is pushed up,
 *   because the pull's copy predates work the user can see on screen;
 * - a record with a pending local delete is dropped from the pull rather than
 *   resurrected, and the delete is reported so it can be replayed upstream.
 *
 * A record the cloud has never seen at all is kept regardless: it was created
 * while offline, or before the session was restored. A record another device
 * deleted (`cloudDeletedIds`) is dropped here too, unless this device has an
 * unsynced edit to it, since re-uploading a stale copy would undo the delete.
 *
 * Only `pushIds` are written back: every write is stamped as the newest, so
 * re-sending a record the cloud already has would let this device's copy beat
 * an edit another device makes in the meantime. With `pending` empty the result
 * is plain cloud-wins, so a storage-blocked browser degrades to that.
 */
export function resolveOnPull<T extends object>(
  local: T[],
  cloud: T[],
  pending?: PendingChanges,
  cloudDeletedIds: Iterable<string | number> = [],
  idOf: (item: T) => string = defaultIdOf as (item: T) => string,
): ResolveResult<T> {
  const editedLocally = pending?.edited ?? new Set<string>();
  const deletedLocally = pending?.deleted ?? new Set<string>();
  const deletedInCloud = new Set([...cloudDeletedIds].map(String));

  const deleteFromCloud: string[] = [];
  const survivingCloud: T[] = [];
  for (const item of cloud) {
    const id = String(idOf(item));
    if (deletedLocally.has(id)) deleteFromCloud.push(id);
    else survivingCloud.push(item);
  }

  const unmatchedLocal = new Map(local.map((item) => [String(idOf(item)), item]));
  const pushIds: string[] = [];
  const merged = survivingCloud.map((cloudItem) => {
    const id = String(idOf(cloudItem));
    const localItem = unmatchedLocal.get(id);
    unmatchedLocal.delete(id);
    if (localItem && editedLocally.has(id)) {
      pushIds.push(id);
      return localItem;
    }
    return cloudItem;
  });

  const localOnly = [...unmatchedLocal.entries()]
    .filter(([id]) => !deletedInCloud.has(id) || editedLocally.has(id))
    .map(([id, item]) => {
      pushIds.push(id);
      return item;
    });
  return {
    merged: [...merged, ...localOnly],
    pushToCloud: pushIds.length > 0,
    pushIds,
    deleteFromCloud,
  };
}
