export interface SyncItem {
  id: string;
  updatedAt: number;
  deleted?: boolean;
  [key: string]: unknown;
}

/** Per-item last-write-wins. Ties keep the local copy. Tombstones win like any other write. */
export function mergeItems<T extends SyncItem>(local: T[], remote: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of remote) byId.set(item.id, item);
  for (const item of local) {
    const other = byId.get(item.id);
    if (!other || item.updatedAt >= other.updatedAt) byId.set(item.id, item);
  }
  return [...byId.values()];
}
