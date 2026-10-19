/** The slice of Web Storage the kit needs; tests pass an in-memory one. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage/sessionStorage are unavailable in private modes and blocked-storage browsers. */
export function browserStorage(kind: "localStorage" | "sessionStorage" = "localStorage"): KeyValueStorage | null {
  try {
    return typeof window !== "undefined" ? window[kind] : null;
  } catch {
    return null;
  }
}

export function readJson<T = unknown>(storage: KeyValueStorage | null | undefined, key: string): T | null {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(storage: KeyValueStorage | null | undefined, key: string, value: unknown): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked or full: the value just will not survive a reload.
  }
}
