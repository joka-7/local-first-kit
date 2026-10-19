import { DriveSyncError } from "./errors.js";

export const DOCUMENT_VERSION = 1;

/**
 * A device file nobody has written to for this long, all of whose records are
 * superseded by newer copies in other files, is deleted (see findCompactableFiles).
 */
export const STALE_DEVICE_FILE_MS = 90 * 24 * 60 * 60 * 1000;

export type JsonRecord = Record<string, unknown>;
export interface RecordEntry { item: (JsonRecord & { id: string | number }) | null; at: number }
export interface ProfileEntry { value: unknown; at: number }

/** One device's own file: every record and profile field it has ever written, stamped. */
export interface DeviceDocument {
  version: number;
  device: string;
  profile: Record<string, ProfileEntry>;
  collections: Record<string, Record<string, RecordEntry>>;
}

export type Operation =
  | { type: "upsert"; collection: string; item: JsonRecord & { id: string | number } }
  | { type: "delete"; collection: string; id: string | number }
  | { type: "profile"; data: JsonRecord };

export interface MergedView {
  profile: JsonRecord;
  collections: Record<string, JsonRecord[]>;
  /** Ids whose newest entry is a delete, so a stale local copy can be dropped. */
  deleted: Record<string, string[]>;
}

export const isPlainObject = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function emptyDocument(device: string): DeviceDocument {
  return { version: DOCUMENT_VERSION, device, profile: {}, collections: {} };
}

const isRecordEntry = (entry: unknown): boolean => isPlainObject(entry) && Number.isFinite(entry.at)
  && (entry.item === null || isPlainObject(entry.item));

const isProfileEntry = (entry: unknown): boolean =>
  isPlainObject(entry) && Number.isFinite(entry.at) && "value" in entry;

function keepEntries<T>(map: unknown, isValid: (entry: unknown) => boolean): Record<string, T> {
  return isPlainObject(map)
    ? (Object.fromEntries(Object.entries(map).filter(([, entry]) => isValid(entry))) as Record<string, T>)
    : {};
}

/**
 * Validate one device file. Throws rather than returning an empty document:
 * an unreadable file treated as empty would be overwritten and its data lost.
 */
export function parseDeviceDocument(raw: unknown): DeviceDocument {
  if (!isPlainObject(raw) || typeof raw.device !== "string") {
    throw new DriveSyncError("Drive sync file is not in the expected format.", { code: "corrupt-file" });
  }
  if (raw.version !== DOCUMENT_VERSION) {
    throw new DriveSyncError("Drive sync file was written by a newer version of the app. Update the app.", { code: "unsupported-version" });
  }
  const collections = isPlainObject(raw.collections)
    ? Object.fromEntries(Object.entries(raw.collections).map(([name, items]) => [name, keepEntries<RecordEntry>(items, isRecordEntry)]))
    : {};
  return { version: DOCUMENT_VERSION, device: raw.device, profile: keepEntries<ProfileEntry>(raw.profile, isProfileEntry), collections };
}

/**
 * Apply queued writes to this device's own document, stamping each with `at`.
 * Pure: returns a new document. Deletes are kept as tombstones (`item: null`)
 * so they win over an older copy of the record in another device's file.
 */
export function applyOperations(document: DeviceDocument, operations: Operation[], at: number): DeviceDocument {
  const next: DeviceDocument = {
    ...document,
    profile: { ...document.profile },
    collections: Object.fromEntries(
      Object.entries(document.collections).map(([name, items]) => [name, { ...items }]),
    ),
  };
  for (const op of operations) {
    if (op.type === "profile") {
      for (const [field, value] of Object.entries(op.data)) next.profile[field] = { value, at };
    } else {
      next.collections[op.collection] ??= {};
      const item = op.type === "upsert" ? op.item : null;
      const id = op.type === "upsert" ? op.item.id : op.id;
      next.collections[op.collection][String(id)] = { item, at };
    }
  }
  return next;
}

type Stamped<T> = T & { device: string };

/** Newest entry wins; a tie goes to the higher device id so every reader agrees. */
function newer<T extends { at: number }>(current: Stamped<T> | undefined, candidate: Stamped<T>): Stamped<T> {
  if (!current) return candidate;
  if (candidate.at !== current.at) return candidate.at > current.at ? candidate : current;
  return candidate.device > current.device ? candidate : current;
}

/** Latest `at` in a document, so the next write can be stamped after it. */
export function latestStamp(document: DeviceDocument): number {
  const stamps = [
    ...Object.values(document.profile).map((entry) => entry.at),
    ...Object.values(document.collections).flatMap((items) => Object.values(items).map((entry) => entry.at)),
  ];
  return Math.max(0, ...stamps);
}

/**
 * Stamp for the next write: the wall clock, but never earlier than anything
 * already read. A device whose clock runs behind would otherwise lose every
 * edit to an older one written by a device whose clock runs ahead.
 */
export function nextStamp(now: number, latestSeen: number): number {
  return Math.max(now, latestSeen + 1);
}

/**
 * Merge every device's file into one view. `collections` holds the live
 * records; `deleted` holds the ids whose newest entry is a delete, so a
 * device still holding an old local copy can drop it instead of re-uploading it.
 */
export function mergeDeviceDocuments(documents: DeviceDocument[]): MergedView {
  const profile: Record<string, Stamped<ProfileEntry>> = {};
  const collections: Record<string, Record<string, Stamped<RecordEntry>>> = {};
  for (const doc of documents) {
    for (const [field, entry] of Object.entries(doc.profile)) {
      profile[field] = newer(profile[field], { ...entry, device: doc.device });
    }
    for (const [name, items] of Object.entries(doc.collections)) {
      collections[name] ??= {};
      for (const [id, entry] of Object.entries(items)) {
        collections[name][id] = newer(collections[name][id], { ...entry, device: doc.device });
      }
    }
  }
  const pick = (keepDeleted: boolean) => Object.entries(collections).map(([name, items]) => [
    name,
    Object.entries(items).filter(([, entry]) => (entry.item === null) === keepDeleted),
  ] as const);
  return {
    profile: Object.fromEntries(Object.entries(profile).map(([field, entry]) => [field, entry.value])),
    collections: Object.fromEntries(pick(false).map(([name, entries]) => [
      name, entries.map(([, entry]) => entry.item as JsonRecord),
    ])),
    deleted: Object.fromEntries(pick(true).map(([name, entries]) => [
      name, entries.map(([id]) => id),
    ])),
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameJson(value, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameJson(a[key], b[key]));
  }
  return false;
}

const KNOWN_DOCUMENT_KEYS = new Set(["version", "device", "profile", "collections"]);

/** The parser keeps an entry's extra fields as they are, so they must be looked for separately. */
function hasUnknownEntryKeys(document: DeviceDocument): boolean {
  const unknown = (entry: object, known: string[]) => Object.keys(entry).some((key) => !known.includes(key));
  return Object.values(document.profile).some((entry) => unknown(entry, ["at", "value"]))
    || Object.values(document.collections).some(
      (items) => Object.values(items).some((entry) => unknown(entry, ["at", "item"])),
    );
}

/**
 * True when parsing a device file threw something away: an entry that failed
 * validation, or a field this version does not know. The file still reads fine,
 * but it is not safe to delete on the strength of what was understood.
 */
export function parsingDroppedData(raw: JsonRecord, document: DeviceDocument): boolean {
  return Object.keys(raw).some((key) => !KNOWN_DOCUMENT_KEYS.has(key))
    || hasUnknownEntryKeys(document)
    || !sameJson(raw.profile ?? {}, document.profile)
    || !sameJson(raw.collections ?? {}, document.collections);
}

interface Winner { at: number; device: string; fileId: string; content: string }

/**
 * Whether `a` is the winning entry over `b`: newest stamp, then higher device
 * id (the merge's own rule), then higher file id so that two files that are
 * exact copies of each other still have one winner. The last step makes every
 * device agree on which file to keep, so none of them deletes both.
 */
function beats(a: Winner, b: Winner | undefined): boolean {
  if (!b) return true;
  if (a.at !== b.at) return a.at > b.at;
  if (a.device !== b.device) return a.device > b.device;
  return a.fileId > b.fileId;
}

export interface DeviceFileEntry {
  id: string;
  name: string;
  modifiedTime?: string;
  /** Parsing dropped something from this file, so it is never deleted. */
  lossy?: boolean;
  document: DeviceDocument;
}

/**
 * Which device files can be deleted without anyone losing a record.
 *
 * Each file is a device's own history, and nothing ever shrinks it: deletes stay
 * as tombstones and a device that is gone for good leaves its file behind. A file
 * qualifies only when it has had no writes for `maxIdleMs` *and* it holds the
 * winning entry for none of its records or profile fields — every one has a newer
 * copy in some other file. Files holding winners are never listed, so deleting the
 * rest cannot change what the merge returns.
 *
 * That guarantee needs three things this function checks or assumes:
 * - Every entry was understood. A file whose entries parsing dropped is `lossy`
 *   and is never listed: deleting it would destroy data nobody can see.
 * - Two files never tie on (stamp, device) with different content. When they do,
 *   the merge cannot say which is right, so both are kept.
 * - Nothing wrote to the file since it was read. That is a race this function
 *   cannot see; the caller re-checks right before deleting, which narrows it to
 *   the gap between that check and the delete but cannot close it (Drive has no
 *   conditional delete).
 *
 * "Idle" is judged against the newest write Drive itself reports, and never later
 * than the local clock. A device whose clock is far ahead would otherwise see
 * every superseded file as idle; one far behind sees none, which is the safe side.
 *
 * `isOwn` marks this device's own file, which is never listed. It is asked
 * only about files that would otherwise be deleted.
 */
export function findCompactableFiles(
  entries: DeviceFileEntry[],
  { now, isOwn, maxIdleMs = STALE_DEVICE_FILE_MS }: { now: number; isOwn: (entry: DeviceFileEntry) => boolean; maxIdleMs?: number },
): DeviceFileEntry[] {
  const modifiedAt = (entry: DeviceFileEntry) => Date.parse(entry.modifiedTime ?? "");
  const newestWrite = Math.max(-Infinity, ...entries.map(modifiedAt).filter(Number.isFinite));
  // No usable modification time anywhere means no evidence of idleness at all.
  if (!Number.isFinite(newestWrite)) return [];
  const reference = Math.min(now, newestWrite);

  const winners = new Map<string, Winner>();
  const ambiguous = new Set<string>();
  const consider = (key: string, at: number, document: DeviceDocument, fileId: string, content: string) => {
    const candidate: Winner = { at, device: document.device, fileId, content };
    const current = winners.get(key);
    if (current && current.at === at && current.device === document.device && current.content !== content) {
      ambiguous.add(current.fileId).add(fileId);
    }
    if (beats(candidate, current)) winners.set(key, candidate);
  };
  for (const { id, document } of entries) {
    for (const [field, entry] of Object.entries(document.profile)) {
      consider(JSON.stringify(["profile", field]), entry.at, document, id, JSON.stringify(entry.value));
    }
    for (const [name, items] of Object.entries(document.collections)) {
      for (const [recordId, entry] of Object.entries(items)) {
        consider(JSON.stringify(["record", name, recordId]), entry.at, document, id, JSON.stringify(entry.item));
      }
    }
  }
  const needed = new Set([...ambiguous, ...[...winners.values()].map((winner) => winner.fileId)]);
  return entries.filter((entry) => {
    const modified = modifiedAt(entry);
    if (!Number.isFinite(modified) || reference - modified < maxIdleMs) return false;
    if (entry.lossy || needed.has(entry.id)) return false;
    return !isOwn(entry);
  });
}
