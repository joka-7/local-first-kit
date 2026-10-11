import type { DriveFileStore } from "./drive.js";
import { mergeItems, type SyncItem } from "./merge.js";

export type SyncStatus = "idle" | "syncing" | "synced" | "offline";

export interface LocalStore<T extends SyncItem> {
  getAll(): Promise<T[]>;
  replaceAll(items: T[]): Promise<void>;
}

export interface SyncOptions<T extends SyncItem> {
  drive: DriveFileStore;
  local: LocalStore<T>;
  fileName: string;
  onStatus?: (s: SyncStatus) => void;
  /** Optional transform, e.g. @joka-7/e2ee encrypt/decrypt of the serialized payload. */
  encode?: (json: string) => Promise<string> | string;
  decode?: (payload: string) => Promise<string> | string;
}

export interface Syncer {
  sync(): Promise<void>;
  /** Debounced sync for after local edits. */
  schedule(delayMs?: number): void;
  /** Sync on open, tab focus and when the network returns. Returns a disposer. */
  start(): () => void;
}

export function createSyncer<T extends SyncItem>(opts: SyncOptions<T>): Syncer {
  const encode = opts.encode ?? ((s: string) => s);
  const decode = opts.decode ?? ((s: string) => s);
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function run() {
    opts.onStatus?.("syncing");
    try {
      const raw = await opts.drive.read(opts.fileName);
      const remote: T[] = raw ? JSON.parse(await decode(raw)) : [];
      const merged = mergeItems(await opts.local.getAll(), remote);
      await opts.local.replaceAll(merged);
      await opts.drive.write(opts.fileName, await encode(JSON.stringify(merged)));
      opts.onStatus?.("synced");
    } catch (e) {
      opts.onStatus?.("offline");
      throw e;
    }
  }

  const sync = () => (running ??= run().finally(() => (running = null)));
  const quiet = () => sync().catch(() => {});

  return {
    sync,
    schedule(delayMs = 2000) {
      clearTimeout(timer);
      timer = setTimeout(quiet, delayMs);
    },
    start() {
      void quiet();
      const onVisible = () => document.visibilityState === "visible" && void quiet();
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("online", quiet);
      return () => {
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("online", quiet);
        clearTimeout(timer);
      };
    },
  };
}
