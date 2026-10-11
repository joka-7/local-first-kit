import { describe, expect, it } from "vitest";
import { createSyncer, mergeItems, type DriveFileStore, type SyncItem } from "./index";

const memDrive = (): DriveFileStore & { files: Map<string, string> } => {
  const files = new Map<string, string>();
  return {
    files,
    read: async (n) => files.get(n) ?? null,
    write: async (n, c) => void files.set(n, c),
    remove: async (n) => void files.delete(n),
  };
};

describe("mergeItems", () => {
  it("newest write wins per item and unions the rest", () => {
    const m = mergeItems(
      [{ id: "a", updatedAt: 2, v: "local" }, { id: "b", updatedAt: 1 }],
      [{ id: "a", updatedAt: 1, v: "remote" }, { id: "c", updatedAt: 1 }],
    );
    expect(m.find((i) => i.id === "a")?.v).toBe("local");
    expect(m.map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
  });
  it("tombstone newer than edit wins", () => {
    const m = mergeItems([{ id: "a", updatedAt: 5, deleted: true }], [{ id: "a", updatedAt: 3 }]);
    expect(m[0].deleted).toBe(true);
  });
});

describe("createSyncer", () => {
  it("syncs two devices through one drive", async () => {
    const drive = memDrive();
    const mk = (items: SyncItem[]) => {
      let data = items;
      const syncer = createSyncer({
        drive,
        fileName: "d.json",
        local: { getAll: async () => data, replaceAll: async (i) => void (data = i) },
      });
      return { syncer, get: () => data };
    };
    const a = mk([{ id: "1", updatedAt: 1 }]);
    const b = mk([{ id: "2", updatedAt: 1 }]);
    await a.syncer.sync();
    await b.syncer.sync();
    await a.syncer.sync();
    expect(a.get().length).toBe(2);
    expect(b.get().length).toBe(2);
  });
  it("reports offline on failure", async () => {
    const statuses: string[] = [];
    const s = createSyncer({
      drive: { read: async () => { throw new Error("x"); }, write: async () => {}, remove: async () => {} },
      fileName: "d.json",
      local: { getAll: async () => [], replaceAll: async () => {} },
      onStatus: (x) => statuses.push(x),
    });
    await expect(s.sync()).rejects.toThrow();
    expect(statuses).toEqual(["syncing", "offline"]);
  });
});
