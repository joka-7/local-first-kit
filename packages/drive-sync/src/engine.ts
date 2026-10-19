import { DriveSyncError, isPermanentlyUnreadable, offlineError } from "./errors.js";
import {
  applyOperations, emptyDocument, findCompactableFiles, isPlainObject, latestStamp, mergeDeviceDocuments,
  nextStamp, parseDeviceDocument, parsingDroppedData,
  type DeviceDocument, type DeviceFileEntry, type JsonRecord, type MergedView, type Operation,
} from "./document.js";
import { browserStorage, readJson, writeJson, type KeyValueStorage } from "./storage.js";

const SCOPES = "https://www.googleapis.com/auth/drive.appdata openid email profile";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Treat a token as expired a little early so no request starts with one about to die. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/**
 * The Android app renews through the OS, which hands back the *same* token
 * until it has actually expired, so renewal must wait almost to the end.
 */
const NATIVE_TOKEN_EXPIRY_MARGIN_MS = 5_000;

/** The idle-file check runs at most this often, however many reads happen. */
const COMPACTION_MIN_INTERVAL_MS = 60 * 60 * 1000;

/** A pull deletes at most this many idle files; the rest wait for the next pass, so it never fans out. */
const MAX_DELETES_PER_PASS = 10;
/** Drive answers 429 and transient 5xx when it is busy; asking again a moment later usually works. */
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** How many device files download at once; a user with many devices would otherwise open them all together. */
const DOWNLOAD_CONCURRENCY = 4;

/** After a failed silent renewal, wait this long before trying again on its own. */
const RENEWAL_BACKOFF_MS = 5 * 60_000;

/** Coalesce bursts of edits (drag, typing) into one Drive upload. */
const DEFAULT_FLUSH_DELAY_MS = 1500;

export interface TokenResponse { access_token: string; expires_in: number }

/** The Android app's sign-in (see @joka-7/capacitor-auth); absent in a browser, which uses Google's popup. */
export interface NativeAuth {
  requestToken(options: { interactive: boolean }): Promise<TokenResponse | null>;
  signOut(): Promise<void>;
}

export interface DriveUser { uid: string; email: string; displayName: string }

interface Session {
  accessToken: string | null;
  expiresAt: number;
  user: DriveUser;
  renewalFailedAt?: number | null;
}

interface QueuedWrite { op: Operation; resolve: () => void; reject: (err: unknown) => void }

interface GoogleGlobal {
  accounts: {
    oauth2: {
      initTokenClient(config: object): GisTokenClient;
      revoke(token: string, done: (response: unknown) => void): void;
    };
  };
}
interface GisTokenClient {
  callback: (response: { error?: string; error_description?: string; access_token?: string; expires_in?: number }) => void;
  error_callback?: (err: { type?: string; message?: string }) => void;
  requestAccessToken(options: object): void;
}

export interface DriveSyncOptions {
  /** OAuth Web client ID; empty disables cloud sync. */
  clientId: string;
  /** Device files are named `${filePrefix}<deviceId>.json`, e.g. `myapp-`. */
  filePrefix: string;
  /** Web Locks name serialising writes across this browser's tabs. */
  lockName: string;
  /** localStorage keys: the stored Google session and the device id. */
  storageKeys: { session: string; device: string };
  fetchImpl: typeof fetch;
  /** Called once a write to `collection` has landed in Drive, so pending tracking can release those ids. */
  onWritesLanded?: (collection: string, ids: string[]) => void;
  nativeAuth?: NativeAuth | null;
  /** Resolves to the `google` global; defaults to loading Google's script. */
  loadGis?: () => Promise<GoogleGlobal>;
  storage?: KeyValueStorage | null;
  /** Per-tab storage (sessionStorage) for the device id when Web Locks are unavailable. */
  tabStorage?: KeyValueStorage | null;
  now?: () => number;
  newDeviceId?: () => string;
  withLock?: <T>(task: () => Promise<T>) => Promise<T>;
  /**
   * Share one device id (one file) across tabs. Only safe when `withLock` really
   * excludes other tabs; otherwise two tabs could read-then-write the same file
   * and drop each other's batch, so the id is kept per tab in `tabStorage`.
   */
  persistDeviceId?: boolean;
  flushDelayMs?: number;
  /** A failed request or renewal while the device has no network is "offline", never a sign-out. */
  isOnline?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

function loadGisScript(): Promise<GoogleGlobal> {
  if (typeof window === "undefined") {
    return Promise.reject(new DriveSyncError("Google sign-in needs a browser.", { code: "gis-load-failed" }));
  }
  const w = window as unknown as { google?: GoogleGlobal };
  if (w.google?.accounts?.oauth2) return Promise.resolve(w.google);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => resolve(w.google as GoogleGlobal);
    script.onerror = () => reject(new DriveSyncError("Could not load Google sign-in.", { code: "gis-load-failed" }));
    document.head.appendChild(script);
  });
}

const hasWebLocks = (): boolean => typeof navigator !== "undefined" && Boolean(navigator.locks?.request);

/**
 * Run `task` over `items`, at most `limit` at a time, and report each outcome
 * the way Promise.allSettled does, in input order.
 */
async function settleWithConcurrency<T, R>(
  items: T[], limit: number, task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Safe inside a single-quoted Drive query and a file name. */
const SAFE_NAME_PART = /^[A-Za-z0-9_-]+$/;

interface DriveFile { id: string; name: string; modifiedTime?: string }

/**
 * Build a Drive sync client. Dependencies are injected so tests run without
 * network, Google's script, timers, randomness or real storage.
 *
 * Data lives in the Drive *appDataFolder*, a hidden folder only this OAuth
 * client can read; there is no server of the app's own in the path. Each device
 * writes only its own file and reads everyone's, keeping the newest version of
 * each record. Drive v3 has no conditional write, so one shared file would let
 * two devices silently overwrite each other; with one writer per file there is
 * nothing to overwrite. Every write resolves only once it has landed in Drive.
 */
export function createDriveSync({
  clientId,
  filePrefix,
  lockName,
  storageKeys,
  fetchImpl,
  onWritesLanded = () => {},
  loadGis = loadGisScript,
  storage = browserStorage(),
  tabStorage = browserStorage("sessionStorage"),
  now = () => Date.now(),
  newDeviceId = () => crypto.randomUUID(),
  withLock = async (task) => (hasWebLocks() ? await navigator.locks.request(lockName, task) : task()),
  persistDeviceId = hasWebLocks(),
  flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  nativeAuth = null,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  random = Math.random,
  isOnline = () => globalThis.navigator?.onLine !== false,
}: DriveSyncOptions) {
  // Both end up inside Drive `q=` strings, so reject anything that could break or widen the query.
  if (!SAFE_NAME_PART.test(filePrefix)) {
    throw new DriveSyncError("filePrefix must be letters, digits, '_' or '-' only, and not empty.", { code: "invalid-config" });
  }
  let session = readJson<Session>(storage, storageKeys.session);
  let gis: GoogleGlobal | null = null;
  let gisLoading: Promise<GoogleGlobal> | null = null;
  let tokenClient: GisTokenClient | null = null;
  let pendingTokenRequest: Promise<TokenResponse> | null = null;
  let pendingRenewal: Promise<string> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(user: DriveUser | null) => void>();

  let queue: QueuedWrite[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushChain: Promise<void> = Promise.resolve();
  let ownFileId: string | null = null;
  let latestSeenAt = 0;
  let lastCompactionAt: number | null = null;
  // Files whose last read had entries the parser dropped (see parsingDroppedData).
  const lossyFileIds = new Set<string>();

  // A file whose modifiedTime has not changed since the last pull is not
  // downloaded again. Keyed by file id.
  const documentCache = new Map<string, { modifiedTime: string; document: DeviceDocument }>();
  // Counts uploads, so a read started before one is never handed to a caller
  // that asked after it.
  let writeEpoch = 0;
  let readInFlight: { epoch: number; promise: Promise<MergedView> } | null = null;

  const isConfigured = () => Boolean(clientId);
  const expiryMargin = nativeAuth ? NATIVE_TOKEN_EXPIRY_MARGIN_MS : TOKEN_EXPIRY_MARGIN_MS;

  const hasValidToken = (): boolean => Boolean(
    session?.accessToken && session.expiresAt - expiryMargin > now(),
  );

  /**
   * Who the header shows as connected. In a browser that is the token's
   * lifetime. In the app a lapsed token is renewed silently, so the user stays
   * connected until a renewal actually fails.
   */
  const currentUser = (): DriveUser | null => {
    if (!nativeAuth) return hasValidToken() ? session!.user : null;
    return session?.user && !session.renewalFailedAt ? session.user : null;
  };

  /** App only: a stored account whose token can be renewed without UI, outside the post-failure backoff. */
  const canRenewSilently = (): boolean => Boolean(
    nativeAuth && session?.user
      && (!session.renewalFailedAt || now() - session.renewalFailedAt >= RENEWAL_BACKOFF_MS),
  );

  let device: string | null = null;
  const deviceStorage = persistDeviceId ? storage : tabStorage;

  /** Stable per browser and shared by its tabs; per tab when that is unsafe or storage is blocked. */
  function deviceId(): string {
    if (device) return device;
    const stored = readJson<unknown>(deviceStorage, storageKeys.device);
    device = typeof stored === "string" && SAFE_NAME_PART.test(stored) ? stored : newDeviceId();
    writeJson(deviceStorage, storageKeys.device, device);
    return device;
  }

  /**
   * Leave an unreadable own file where it is (readers skip it) and continue in
   * a new one. Refusing to write forever would strand every later edit locally.
   */
  function abandonOwnFile(): DeviceDocument {
    console.warn("local-first-kit: own Drive sync file is unreadable; continuing in a new one.");
    device = null;
    writeJson(deviceStorage, storageKeys.device, null);
    ownFileId = null;
    documentCache.clear();
    return emptyDocument(deviceId());
  }

  const ownFileName = () => `${filePrefix}${deviceId()}.json`;

  let lastReportedUid = currentUser()?.uid ?? null;

  /**
   * Report only a change of *who is connected*. A token swap for the same user
   * is not one: apps answer every report with a full pull-and-merge.
   */
  function notifyListeners(): void {
    const user = currentUser();
    if ((user?.uid ?? null) === lastReportedUid) return;
    lastReportedUid = user?.uid ?? null;
    for (const listener of listeners) listener(user);
  }

  /**
   * Browser only: tell the header the moment the token lapses, not on the
   * next failed save. The app renews lazily on the next Drive call instead.
   */
  function scheduleExpiryNotice(): void {
    clearTimeout(expiryTimer);
    if (nativeAuth || !hasValidToken()) return;
    expiryTimer = setTimeout(notifyListeners, session!.expiresAt - expiryMargin - now());
  }

  function setSession(next: Session | null): void {
    session = next;
    writeJson(storage, storageKeys.session, next);
    scheduleExpiryNotice();
    notifyListeners();
  }

  function ensureGis(): Promise<GoogleGlobal> {
    if (gis) return Promise.resolve(gis);
    gisLoading ??= loadGis().then((loaded) => { gis = loaded; return loaded; })
      .catch((err) => { gisLoading = null; throw err; });
    return gisLoading;
  }

  function getTokenClient(): GisTokenClient {
    tokenClient ??= gis!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: () => {},
    });
    return tokenClient;
  }

  function requireToken(response: TokenResponse | null): TokenResponse {
    if (!response?.access_token) {
      throw new DriveSyncError("Google did not grant access to Drive.", { code: "access_denied" });
    }
    return response;
  }

  /**
   * Ask Google for an access token. When GIS is already loaded this opens the
   * popup synchronously, inside the click that called it: anything later and
   * the browser blocks the popup. That is why GIS is preloaded on startup.
   */
  function requestToken(): Promise<TokenResponse> {
    if (pendingTokenRequest) return pendingTokenRequest;
    if (nativeAuth) {
      pendingTokenRequest = nativeAuth.requestToken({ interactive: true })
        .then(requireToken)
        .finally(() => { pendingTokenRequest = null; });
      return pendingTokenRequest;
    }
    const run = (loaded: GoogleGlobal) => new Promise<TokenResponse>((resolve, reject) => {
      gis = loaded;
      const client = getTokenClient();
      client.callback = (response) => {
        if (response.error) {
          reject(new DriveSyncError(response.error_description || response.error, { code: response.error }));
          return;
        }
        resolve(response as TokenResponse);
      };
      client.error_callback = (err) => {
        reject(new DriveSyncError(err?.message || "Google sign-in was closed.", { code: err?.type || "popup_closed" }));
      };
      client.requestAccessToken({ prompt: "", login_hint: session?.user?.email || "" });
    });
    pendingTokenRequest = (gis ? run(gis) : ensureGis().then(run))
      .finally(() => { pendingTokenRequest = null; });
    return pendingTokenRequest;
  }

  const expiredSession = (): Session => ({ ...session!, accessToken: null, expiresAt: 0 });

  /**
   * App only: renew an expired token for the signed-in user without UI. A
   * failure marks the session so the header offers Connect Drive, and stops
   * every queued save from retrying the OS round-trip until the backoff ends.
   */
  function renewSilently(): Promise<string> {
    pendingRenewal ??= nativeAuth!.requestToken({ interactive: false })
      .then(requireToken)
      .then((response) => {
        setSession({
          ...session!,
          accessToken: response.access_token,
          expiresAt: now() + Number(response.expires_in) * 1000,
          renewalFailedAt: null,
        });
        return response.access_token;
      })
      .catch((err) => {
        // No network is not a lapsed sign-in: keep the session and try again when it returns.
        if (!isOnline()) throw offlineError(err);
        if (session) setSession({ ...expiredSession(), renewalFailedAt: now() });
        throw new DriveSyncError("Google Drive session expired.", { code: "signed-out", cause: err });
      })
      .finally(() => { pendingRenewal = null; });
    return pendingRenewal;
  }

  async function fetchUser(accessToken: string): Promise<DriveUser> {
    const res = await fetchImpl(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
      .catch((err) => { throw offlineError(err); });
    if (!res.ok) throw new DriveSyncError("Could not read the Google account.", { status: res.status });
    const info = await res.json();
    return { uid: info.sub, email: info.email || "", displayName: info.name || "" };
  }

  async function signIn(): Promise<DriveUser> {
    if (!isConfigured()) throw new DriveSyncError("Google Drive sync is not configured.", { code: "not-configured" });
    const response = await requestToken();
    const user = await fetchUser(response.access_token);
    if (session?.user?.uid !== user.uid) {
      ownFileId = null;
      documentCache.clear();
      latestSeenAt = 0;
    }
    setSession({
      accessToken: response.access_token,
      expiresAt: now() + Number(response.expires_in) * 1000,
      user,
    });
    return user;
  }

  /**
   * Never opens a popup: a background save is not a click, so the browser
   * would block it. In a browser an expired token instead reports "signed
   * out", the header offers Connect Drive, and pending tracking replays local
   * edits on reconnect. The app renews the token silently first.
   */
  async function accessToken(): Promise<string> {
    if (hasValidToken()) return session!.accessToken!;
    if (canRenewSilently()) return renewSilently();
    if (!isOnline()) throw offlineError();
    if (session?.accessToken) setSession(expiredSession());
    throw new DriveSyncError("Google Drive session expired.", { code: "signed-out" });
  }

  /**
   * Whether asking again can help. A 429 means the request was refused, so any
   * request may repeat. A 5xx may have been applied before it failed, and
   * repeating a file *creation* then could leave two files, so only requests
   * that are safe to repeat (reads, deletes, whole-file uploads) are retried.
   */
  function worthRetrying(status: number, method?: string): boolean {
    if (!RETRYABLE_STATUSES.has(status)) return false;
    return status === 429 || (method ?? "GET") !== "POST";
  }

  /** Exponential, jittered, and never shorter than the Retry-After the server sent. */
  function retryDelayMs(attempt: number, res: Response): number {
    const asked = Number(res.headers?.get?.("Retry-After"));
    const backoff = RETRY_BASE_MS * 2 ** attempt * (0.5 + random());
    return Math.min(RETRY_MAX_MS, Math.max(backoff, Number.isFinite(asked) ? asked * 1000 : 0));
  }

  async function driveFetch(url: string, init: RequestInit = {}, retried = false, attempt = 0): Promise<Response> {
    const token = await accessToken();
    const res = await fetchImpl(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    }).catch((err) => { throw offlineError(err); });
    if (res.status === 401 && session) {
      // Revoked or expired early: drop the token. A browser then offers to
      // reconnect; the app (still connected) renews and retries once.
      setSession(expiredSession());
      if (canRenewSilently() && !retried) return driveFetch(url, init, true, attempt);
    }
    if (!res.ok && attempt < MAX_ATTEMPTS - 1 && worthRetrying(res.status, init.method)) {
      await sleep(retryDelayMs(attempt, res));
      return driveFetch(url, init, retried, attempt + 1);
    }
    if (!res.ok) throw new DriveSyncError(`Google Drive request failed (${res.status}).`, { status: res.status });
    return res;
  }

  async function listFiles(query: string, pageToken = ""): Promise<DriveFile[]> {
    const params = new URLSearchParams({
      spaces: "appDataFolder",
      q: query,
      fields: "nextPageToken,files(id,name,modifiedTime)",
      pageSize: "1000",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await (await driveFetch(`${DRIVE_API}/files?${params}`)).json();
    const files: DriveFile[] = page.files ?? [];
    return page.nextPageToken ? [...files, ...await listFiles(query, page.nextPageToken)] : files;
  }

  const listDeviceFiles = async (): Promise<DriveFile[]> =>
    (await listFiles(`name contains '${filePrefix}'`))
      .filter((file) => file.name.startsWith(filePrefix) && file.name.endsWith(".json"));

  async function readFile(id: string): Promise<DeviceDocument> {
    const res = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`);
    // Read the body first: a connection dropped mid-download must surface as a
    // network error, not be mistaken for a corrupt file and abandoned.
    const text = await res.text().catch((err) => { throw offlineError(err); });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new DriveSyncError("Drive sync file is not valid JSON.", { code: "corrupt-file" });
    }
    const document = parseDeviceDocument(raw);
    if (parsingDroppedData(raw as JsonRecord, document)) lossyFileIds.add(id);
    else lossyFileIds.delete(id);
    return document;
  }

  /** The device file's parsed content, from the cache while its modifiedTime has not moved. */
  async function readFileUnlessUnchanged(file: DriveFile): Promise<DeviceDocument> {
    const cached = documentCache.get(file.id);
    if (file.modifiedTime && cached?.modifiedTime === file.modifiedTime) return cached.document;
    const document = await readFile(file.id);
    if (file.modifiedTime) documentCache.set(file.id, { modifiedTime: file.modifiedTime, document });
    return document;
  }

  /**
   * Housekeeping that must never get in the way of a pull: a failure is logged
   * and the read still succeeds. Runs at most once an hour. Each file is looked
   * at again right before its delete, and skipped if anything wrote to it since
   * the pull read it. A 404 means another device removed it first.
   */
  async function deleteIdleFiles(readable: DeviceFileEntry[]): Promise<void> {
    const started = now();
    // A clock that moved backwards must not block the check until it catches up.
    if (lastCompactionAt !== null && started >= lastCompactionAt
      && started - lastCompactionAt < COMPACTION_MIN_INTERVAL_MS) return;
    lastCompactionAt = started;
    try {
      const idle = findCompactableFiles(readable, {
        now: started,
        isOwn: (entry) => entry.id === ownFileId || entry.name === ownFileName(),
      });
      const outcomes = await Promise.allSettled(idle.slice(0, MAX_DELETES_PER_PASS).map(async (entry) => {
        const url = `${DRIVE_API}/files/${encodeURIComponent(entry.id)}`;
        const current = await (await driveFetch(`${url}?fields=modifiedTime`)).json();
        if (current.modifiedTime === entry.modifiedTime) await driveFetch(url, { method: "DELETE" });
      }));
      const failed = outcomes.filter((o) => o.status === "rejected" && (o.reason as DriveSyncError)?.status !== 404).length;
      if (failed) console.warn(`local-first-kit: could not remove ${failed} idle Drive sync file(s).`);
    } catch (err) {
      console.warn("local-first-kit: could not check for idle Drive sync files.", (err as Error)?.message);
    }
  }

  /**
   * Every device's file, merged. A file that can never be read (corrupt,
   * written by a newer version, deleted since the listing) is skipped: one bad
   * file must not stop every device from syncing. Any other failure (network,
   * rate limit, auth) fails the whole read: a merge missing a device's newer
   * edits and deletes would let this device re-upload stale copies over them.
   */
  async function readMergedFresh(): Promise<MergedView> {
    const files = await listDeviceFiles();
    const listed = new Set(files.map((file) => file.id));
    for (const id of documentCache.keys()) if (!listed.has(id)) documentCache.delete(id);
    const results = await settleWithConcurrency(files, DOWNLOAD_CONCURRENCY, readFileUnlessUnchanged);
    const fatal = results.find((r) => r.status === "rejected" && !isPermanentlyUnreadable(r.reason));
    if (fatal) throw (fatal as PromiseRejectedResult).reason;
    const skipped = results.filter((r) => r.status === "rejected");
    if (skipped.length) console.warn(`local-first-kit: skipped ${skipped.length} unreadable Drive sync file(s).`);
    const readable = files.flatMap((file, index): DeviceFileEntry[] => {
      const result = results[index];
      return result.status === "fulfilled"
        ? [{ id: file.id, name: file.name, modifiedTime: file.modifiedTime, lossy: lossyFileIds.has(file.id), document: result.value }]
        : [];
    });
    const documents = readable.map((entry) => entry.document);
    latestSeenAt = Math.max(latestSeenAt, ...documents.map(latestStamp));
    const merged = mergeDeviceDocuments(documents);
    await deleteIdleFiles(readable);
    return merged;
  }

  /** Concurrent callers share one read; a read from before an upload is never reused after it. */
  function readMerged(): Promise<MergedView> {
    if (readInFlight?.epoch !== writeEpoch) {
      const entry = { epoch: writeEpoch } as { epoch: number; promise: Promise<MergedView> };
      entry.promise = readMergedFresh().finally(() => { if (readInFlight === entry) readInFlight = null; });
      readInFlight = entry;
    }
    return readInFlight!.promise;
  }

  async function readOwnDocument(): Promise<DeviceDocument> {
    if (!ownFileId) {
      const [file] = await listFiles(`name = '${ownFileName()}'`);
      ownFileId = file?.id ?? null;
    }
    if (!ownFileId) return emptyDocument(deviceId());
    try {
      const own = await readFile(ownFileId);
      latestSeenAt = Math.max(latestSeenAt, latestStamp(own));
      return own;
    } catch (err) {
      const e = err as DriveSyncError;
      if (e.code === "corrupt-file") return abandonOwnFile();
      // Deleted from Drive's "Manage apps → Delete hidden app data": start a new file.
      if (e.status !== 404) throw err;
      ownFileId = null;
      return emptyDocument(deviceId());
    }
  }

  async function writeOwnDocument(document: DeviceDocument): Promise<void> {
    const body = JSON.stringify(document);
    writeEpoch += 1;
    if (ownFileId) {
      documentCache.delete(ownFileId);
      await driveFetch(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(ownFileId)}?uploadType=media`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
      });
      writeEpoch += 1;
      return;
    }
    const boundary = `local-first-kit-${now()}`;
    const metadata = JSON.stringify({ name: ownFileName(), parents: ["appDataFolder"] });
    const multipart = [
      `--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", metadata,
      `--${boundary}`, "Content-Type: application/json", "", body,
      `--${boundary}--`, "",
    ].join("\r\n");
    const res = await driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    ownFileId = (await res.json()).id;
    writeEpoch += 1;
  }

  async function flush(): Promise<void> {
    flushTimer = null;
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    try {
      await withLock(async () => {
        // Re-read under the lock: another tab of this browser shares the file.
        const own = await readOwnDocument();
        const at = nextStamp(now(), latestSeenAt);
        await writeOwnDocument(applyOperations(own, batch.map((entry) => entry.op), at));
        latestSeenAt = at;
      });
      for (const entry of batch) entry.resolve();
    } catch (err) {
      for (const entry of batch) entry.reject(err);
    }
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushChain = flushChain.then(flush);
    }, flushDelayMs);
  }

  function enqueue(op: Operation): Promise<void> {
    if (!session) return Promise.reject(new DriveSyncError("Not connected to Google Drive.", { code: "signed-out" }));
    return new Promise<void>((resolve, reject) => {
      queue.push({ op, resolve, reject });
      scheduleFlush();
    });
  }

  const opId = (op: Operation): string => String(op.type === "upsert" ? op.item.id : (op as { id: string | number }).id);

  /**
   * Release only ids with no newer write still queued: if that later write then
   * failed, a released id would let the next pull overwrite it with this older copy.
   */
  function releaseLandedIds(collection: string, ids: Array<string | number>): void {
    const stillQueued = new Set(queue
      .filter(({ op }) => op.type !== "profile" && op.collection === collection)
      .map(({ op }) => opId(op)));
    onWritesLanded(collection, ids.map(String).filter((id) => !stillQueued.has(id)));
  }

  /** Browser: revoke through Google's script, loaded before anything is deleted. */
  async function gisRevoker(): Promise<(token: string) => Promise<unknown>> {
    const loaded = await ensureGis();
    return (token) => new Promise((resolve) => loaded.accounts.oauth2.revoke(token, resolve));
  }

  /**
   * App: Google's script is not used there, so revoke with the plain OAuth
   * endpoint. The files are already gone by now, so a failure only leaves the
   * (now empty) grant in the user's Google account, which they can remove there.
   */
  async function revokeOverHttp(token: string): Promise<void> {
    const res = await fetchImpl(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    if (!res.ok) console.warn(`local-first-kit: revoking Drive access failed (${res.status})`);
  }

  /** Cancel every queued write, telling each caller it never reached Drive. */
  function dropQueuedWrites(): void {
    clearTimeout(flushTimer ?? undefined);
    flushTimer = null;
    const dropped = queue;
    queue = [];
    for (const entry of dropped) entry.reject(new DriveSyncError("Signed out before sync.", { code: "signed-out" }));
  }

  /** Drop queued writes and forget the session; local data is the caller's to clear. */
  function endSession(): void {
    dropQueuedWrites();
    ownFileId = null;
    latestSeenAt = 0;
    lastCompactionAt = null;
    lossyFileIds.clear();
    documentCache.clear();
    writeEpoch += 1;
    setSession(null);
  }

  /** Also forget the account on the device, so the next Connect asks again. A failure is not fatal: the app is already signed out locally. */
  async function deviceSignOut(): Promise<void> {
    if (!nativeAuth) return;
    await nativeAuth.signOut().catch((err) => console.warn("local-first-kit: device sign-out failed", err?.message));
  }

  return {
    isCloudConfigured: isConfigured,

    /**
     * True when a usable token is stored, or (app only) when an expired one can
     * be renewed silently. In a browser an expired one is not restorable
     * without a click, so the header should offer Connect Drive, not "Reconnecting…".
     */
    hasRestorableSession: async (): Promise<boolean> => isConfigured() && (hasValidToken() || canRenewSilently()),

    /**
     * Reports the connected user on subscribing, then on every change. In the
     * app a stored session whose token has lapsed still reports the user: the
     * first Drive call renews it, and only a failed renewal reports signed out.
     * In a browser it also starts loading Google's script, so a Connect Drive
     * click can open the popup synchronously.
     */
    onAuthChange(callback: (user: DriveUser | null) => void): () => void {
      listeners.add(callback);
      scheduleExpiryNotice();
      const user = isConfigured() ? currentUser() : null;
      lastReportedUid = user?.uid ?? null;
      callback(user);
      if (isConfigured() && !nativeAuth) ensureGis().catch(() => {});
      return () => { listeners.delete(callback); };
    },

    signInWithGoogle: signIn,

    async signOut(): Promise<void> {
      endSession();
      await deviceSignOut();
    },

    /**
     * Delete every sync file from the user's Drive and revoke this app's
     * access, then sign out. Google must be reachable *before* anything is
     * deleted: losing the data but keeping the grant would be the worse half.
     * A device that is still signed in uploads its local copy again on its next
     * sync, so other devices need signing out first.
     */
    async deleteAllSyncedData(): Promise<void> {
      if (!session?.user) throw new DriveSyncError("Not connected to Google Drive.", { code: "signed-out" });
      const revoke = nativeAuth ? revokeOverHttp : await gisRevoker();
      await accessToken();
      dropQueuedWrites();
      await flushChain;
      const files = await listDeviceFiles();
      await Promise.all(files.map((file) => driveFetch(
        `${DRIVE_API}/files/${encodeURIComponent(file.id)}`,
        { method: "DELETE" },
      )));
      await revoke(session.accessToken!);
      endSession();
      await deviceSignOut();
    },

    async loadProfile(): Promise<JsonRecord> {
      return (await readMerged()).profile;
    },

    saveProfile: (data: JsonRecord): Promise<void> => enqueue({ type: "profile", data }),

    /**
     * Live records plus the ids whose newest version is a delete, or null when
     * Drive has never held a record of this collection (first sign-in).
     */
    async pullCollection<T extends JsonRecord = JsonRecord>(collection: string): Promise<{ items: T[]; deletedIds: string[] } | null> {
      const merged = await readMerged();
      const items = (merged.collections[collection] ?? []) as T[];
      const deletedIds = merged.deleted[collection] ?? [];
      return items.length === 0 && deletedIds.length === 0 ? null : { items, deletedIds };
    },

    async upsert(collection: string, item: JsonRecord & { id: string | number }): Promise<void> {
      await enqueue({ type: "upsert", collection, item });
      releaseLandedIds(collection, [item.id]);
    },

    async remove(collection: string, id: string | number): Promise<void> {
      await enqueue({ type: "delete", collection, id });
      releaseLandedIds(collection, [id]);
    },

    async upsertMany(collection: string, items: Array<JsonRecord & { id: string | number }>): Promise<void> {
      if (!items.length) return;
      await Promise.all(items.map((item) => enqueue({ type: "upsert", collection, item })));
      releaseLandedIds(collection, items.map((item) => item.id));
    },
  };
}

export type DriveSync = ReturnType<typeof createDriveSync>;
