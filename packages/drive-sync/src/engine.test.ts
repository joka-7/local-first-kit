import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDriveSync, createPendingTracker, mergeDeviceDocuments, parseDeviceDocument, STALE_DEVICE_FILE_MS,
} from './index.js';

let tracker;
const NOW = 1_700_000_000_000;
const USER = { sub: 'google-sub-1', email: 'user@example.com', name: 'Dana Levi' };
const SESSION_KEY = 'app_drive_session_v1';
const IDENTITY = {
  filePrefix: 'kandone-',
  lockName: 'app-drive-write',
  storageKeys: { session: SESSION_KEY, device: 'app_drive_device_v1' },
};

const deviceFile = (device, collections = {}, profile = {}) => ({
  name: `kandone-${device}.json`,
  body: JSON.stringify({ version: 1, device, profile, collections }),
});

/** In-memory stand-in for the Drive v3 + userinfo endpoints this module calls. */
function fakeGoogle({
  files = {}, failWith = null, pageLimit = Infinity, failRead = {}, revokedTokens = [], flaky = null,
} = {}) {
  const state = {
    files: { ...files }, nextId: 1, patched: [], deleted: [], listings: 0, pageSizes: [], reads: [], clock: 0, active: 0, maxActive: 0,
  };
  // Files without their own modifiedTime get an increasing one, as Drive would give them.
  const touch = (file) => { file.modifiedTime = new Date(NOW + ++state.clock).toISOString(); return file; };
  Object.values(state.files).forEach((file) => { if (!file.modifiedTime) touch(file); });
  const json = (body, status = 200, headers = {}) => ({
    ok: status < 400, status, json: async () => body, headers: { get: (name) => headers[name] ?? null },
  });
  const raw = (text) => ({ ok: true, status: 200, text: async () => text });
  let flakyLeft = flaky?.times ?? 0;

  const fetchImpl = vi.fn(async (url, init = {}) => {
    if (state.offline) throw new TypeError('Failed to fetch');
    if (failWith) return json({}, failWith);
    if (flakyLeft > 0 && url !== 'https://openidconnect.googleapis.com/v1/userinfo'
      && (!flaky.method || (init.method ?? 'GET') === flaky.method)) {
      flakyLeft -= 1;
      return json({}, flaky.status, flaky.retryAfter ? { 'Retry-After': flaky.retryAfter } : {});
    }
    if (revokedTokens.some((t) => init.headers?.Authorization === `Bearer ${t}`)) return json({}, 401);
    if (url === 'https://oauth2.googleapis.com/revoke') {
      state.revoked = new URLSearchParams(init.body).get('token');
      state.revokeMethod = init.method;
      return json({});
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return json(USER);
    if (url.includes('/upload/drive/v3/files?uploadType=multipart')) {
      const parts = init.body.split('\r\n');
      const id = `new-${state.nextId++}`;
      state.files[id] = touch({ name: JSON.parse(parts[3]).name, body: parts[7] });
      return json({ id });
    }
    const patch = url.match(/\/upload\/drive\/v3\/files\/([^?]+)\?uploadType=media/);
    if (patch) {
      if (!state.files[patch[1]]) return json({}, 404);
      state.files[patch[1]].body = init.body;
      touch(state.files[patch[1]]);
      state.patched.push(patch[1]);
      return json({});
    }
    const del = init.method === 'DELETE' && url.match(/\/drive\/v3\/files\/([^?]+)$/);
    if (del) {
      if (!state.files[del[1]]) return json({}, 404);
      delete state.files[del[1]];
      state.deleted.push(del[1]);
      return json({}, 204);
    }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files?')) {
      state.listings += 1;
      const params = new URL(url).searchParams;
      state.pageSizes.push(params.get('pageSize'));
      const exact = params.get('q').match(/^name = '(.+)'$/)?.[1];
      const list = Object.entries(state.files)
        .filter(([, f]) => (exact ? f.name === exact : f.name.startsWith('kandone-')))
        .map(([id, f]) => ({ id, name: f.name, modifiedTime: f.modifiedTime }));
      const start = Number(params.get('pageToken') || 0);
      const end = start + Math.min(pageLimit, Number(params.get('pageSize')));
      return json(end < list.length
        ? { files: list.slice(start, end), nextPageToken: String(end) }
        : { files: list.slice(start) });
    }
    const modified = url.match(/\/drive\/v3\/files\/([^?]+)\?fields=modifiedTime/);
    if (modified) {
      return state.files[modified[1]] ? json({ modifiedTime: state.files[modified[1]].modifiedTime }) : json({}, 404);
    }
    const media = url.match(/\/drive\/v3\/files\/([^?]+)\?alt=media/);
    if (media) {
      state.reads.push(media[1]);
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      for (let tick = 0; tick < 3; tick += 1) await Promise.resolve();
      state.active -= 1;
    }
    if (media && failRead[media[1]] === 'network') return { ok: true, status: 200, text: async () => { throw new TypeError('network error'); } };
    if (media && failRead[media[1]]) return json({}, failRead[media[1]]);
    if (media) return state.files[media[1]] ? raw(state.files[media[1]].body) : json({}, 404);
    throw new Error(`unexpected request ${url}`);
  });

  const stored = (id) => JSON.parse(state.files[id].body);
  return { state, fetchImpl, stored };
}

function fakeGis({ error = null } = {}) {
  const revoke = vi.fn((token, done) => done({ successful: true }));
  const client = {
    requestAccessToken: vi.fn(() => {
      if (error) client.callback({ error });
      else client.callback({ access_token: 'token-1', expires_in: 3600 });
    }),
  };
  return { accounts: { oauth2: { initTokenClient: vi.fn(() => client), revoke } }, client, revoke };
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function validSession(overrides = {}) {
  return JSON.stringify({
    accessToken: 'token-1',
    expiresAt: NOW + 3_600_000,
    user: { uid: USER.sub, email: USER.email, displayName: USER.name },
    ...overrides,
  });
}

const signedIn = () => memoryStorage({ [SESSION_KEY]: validSession() });

function build({
  google = fakeGoogle(), gis = fakeGis(), storage = memoryStorage(), clientId = 'client-id',
  withLock = (task) => task(), persistDeviceId, deviceIds = ['this', 'next'], tabStorage = memoryStorage(),
  nativeAuth = null, isOnline = () => true,
} = {}) {
  const ids = [...deviceIds];
  const sleeps = [];
  const sync = createDriveSync({ ...IDENTITY,
    clientId,
    fetchImpl: google.fetchImpl,
    loadGis: async () => gis,
    storage,
    tabStorage,
    now: () => Date.now(),
    newDeviceId: () => ids.shift(),
    ...IDENTITY,
    onWritesLanded: tracker.clearPendingIds,
    withLock,
    ...(persistDeviceId === undefined ? {} : { persistDeviceId }),
    flushDelayMs: 100,
    nativeAuth,
    isOnline,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
  });
  return { sync, google, gis, storage, sleeps };
}

/** Stand-in for the Android sign-in: hands out `app-token-1`, `app-token-2`, … */
function fakeNativeAuth({ silent = 'grant', interactive = 'grant' } = {}) {
  let issued = 0;
  const grant = (mode) => {
    if (mode === 'fail') return Promise.reject(new Error('needs the user'));
    if (mode === 'none') return Promise.resolve(null);
    issued += 1;
    return Promise.resolve({ access_token: `app-token-${issued}`, expires_in: 3600 });
  };
  return {
    requestToken: vi.fn(({ interactive: isInteractive }) => grant(isInteractive ? interactive : silent)),
    signOut: vi.fn(async () => {}),
  };
}

const expiredSession = () => memoryStorage({ [SESSION_KEY]: validSession({ accessToken: null, expiresAt: 0 }) });

/** Let the debounce fire and the queued Drive round-trips finish. */
async function settle() {
  await vi.advanceTimersByTimeAsync(150);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  tracker = createPendingTracker({ keyPrefix: 'app_pending', ownerKey: 'app_owner', storage: memoryStorage() });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDriveSync', () => {
  describe('in a browser', () => {
    describe('signInWithGoogle', () => {
      it('stores the session and reports the user to listeners', async () => {
        const { sync, storage } = build();
        const seen = [];
        sync.onAuthChange((u) => seen.push(u));

        const user = await sync.signInWithGoogle();

        expect(user).toEqual({ uid: USER.sub, email: USER.email, displayName: USER.name });
        expect(seen).toEqual([null, user]);
        expect(JSON.parse(storage.getItem(SESSION_KEY)).user).toEqual(user);
      });

      it('opens the Google popup synchronously once the script has preloaded, so the click is not blocked', async () => {
        const { sync, gis } = build();
        sync.onAuthChange(() => {});
        await vi.advanceTimersByTimeAsync(0);

        const pending = sync.signInWithGoogle();
        const openedInClick = gis.client.requestAccessToken.mock.calls.length;
        await pending;

        expect(openedInClick).toBe(1);
      });

      it.each([
        ['a denied consent', { gis: fakeGis({ error: 'access_denied' }) }, 'access_denied'],
        ['a build with no client id', { clientId: '' }, 'not-configured'],
      ])('rejects on %s', async (_name, options, code) => {
        const { sync } = build(options);

        await expect(sync.signInWithGoogle()).rejects.toMatchObject({ code });
      });
    });

    describe('onAuthChange', () => {
      it('reports a stored session only while its token is valid, and its expiry when it lapses', async () => {
        const { sync } = build({ storage: signedIn() });
        const seen = [];

        sync.onAuthChange((u) => seen.push(u?.email ?? null));
        await vi.advanceTimersByTimeAsync(3_600_000);

        expect(seen).toEqual([USER.email, null]);
      });
    });

    describe('hasRestorableSession', () => {
      it.each([
        ['a valid token', validSession(), 'client-id', true],
        ['an expired token', validSession({ expiresAt: NOW - 1 }), 'client-id', false],
        ['no session', null, 'client-id', false],
        ['no client id', validSession(), '', false],
      ])('is %s → %s', async (_name, stored, clientId, expected) => {
        const storage = memoryStorage(stored ? { [SESSION_KEY]: stored } : {});
        const { sync } = build({ storage, clientId });

        expect(await sync.hasRestorableSession()).toBe(expected);
      });
    });

    describe('upsertMany', () => {
      it('coalesces a burst of writes into one upload of this device\'s own file', async () => {
        const google = fakeGoogle({ files: { other: deviceFile('other', { tasks: { 9: { item: { id: 9 }, at: 1 } } }) } });
        const { sync } = build({ google, storage: signedIn() });
        const otherBefore = google.state.files.other.body;

        const done = Promise.all([
          sync.upsertMany('tasks', [{ id: 1, title: 'a' }]),
          sync.upsertMany('tasks', [{ id: 2, title: 'b' }]),
        ]);
        await settle();
        await done;

        expect(google.state.files['new-1'].name).toBe('kandone-this.json');
        expect(Object.keys(google.stored('new-1').collections.tasks)).toEqual(['1', '2']);
        expect(google.state.files.other.body).toBe(otherBefore);
      });

      it('clears a pending id once its upload lands, but not while a newer edit of it is still queued', async () => {
        tracker.recordLocalChanges('tasks', { edited: ['1', '2'] });
        let openGate;
        const gate = new Promise((resolve) => { openGate = resolve; });
        const { sync } = build({ storage: signedIn(), withLock: (task) => gate.then(task) });

        const first = sync.upsertMany('tasks', [{ id: 1, v: 1 }, { id: 2, v: 1 }]);
        await vi.advanceTimersByTimeAsync(100);
        const second = sync.upsert('tasks', { id: 1, v: 2 });
        second.catch(() => {});
        openGate();
        await first;
        const afterFirst = [...tracker.readPending('tasks').edited];
        await settle();
        await second;

        expect([afterFirst, [...tracker.readPending('tasks').edited]]).toEqual([['1'], []]);
      });

      it('recreates its file when Drive no longer has it', async () => {
        const google = fakeGoogle();
        const { sync } = build({ google, storage: signedIn() });
        const created = sync.upsert('tasks', { id: 1 });
        await settle();
        await created;
        delete google.state.files['new-1'];

        const recreated = sync.upsert('tasks', { id: 2 });
        await settle();
        await recreated;

        expect(Object.keys(google.stored('new-2').collections.tasks)).toEqual(['2']);
      });

      it.each([
        ['signed out', null, null, { code: 'signed-out' }],
        ['the token has expired', validSession({ expiresAt: NOW - 1 }), null, { code: 'signed-out' }],
        ['Drive fails', validSession(), 500, { status: 500 }],
      ])('rejects when %s', async (_name, stored, failWith, expected) => {
        const storage = memoryStorage(stored ? { [SESSION_KEY]: stored } : {});
        const { sync } = build({ google: fakeGoogle({ failWith }), storage });

        const done = sync.upsertMany('tasks', [{ id: 1 }]);
        done.catch(() => {});
        await settle();

        await expect(done).rejects.toMatchObject(expected);
      });

      it('leaves an unreadable own file untouched and continues in a new one', async () => {
        const corrupt = { name: 'kandone-this.json', body: '{"version":1' };
        const google = fakeGoogle({ files: { mine: { ...corrupt } } });
        const { sync } = build({ google, storage: signedIn() });

        const done = sync.upsert('tasks', { id: 1 });
        await settle();
        await done;

        expect([google.state.files.mine.body, google.state.files['new-1'].name]).toEqual([corrupt.body, 'kandone-next.json']);
      });

      it('stamps a write after the newest entry already in Drive, even if another device\'s clock runs ahead', async () => {
        const ahead = NOW + 3_600_000;
        const google = fakeGoogle({ files: { other: deviceFile('other', { tasks: { 1: { item: { id: 1, v: 'theirs' }, at: ahead } } }) } });
        const { sync } = build({ google, storage: signedIn() });
        await sync.pullCollection('tasks');

        const done = sync.upsert('tasks', { id: 1, v: 'mine' });
        await settle();
        await done;

        expect((await sync.pullCollection('tasks')).items).toEqual([{ id: 1, v: 'mine' }]);
      });

      it('shares one device file across tabs only when tabs can be locked against each other, and keeps it across a reload', async () => {
        const results = [];
        for (const persistDeviceId of [true, false]) {
          const storage = signedIn();
          const google = fakeGoogle();
          const firstTab = memoryStorage();
          const opens = [[firstTab, ['tab-1']], [memoryStorage(), ['tab-2']], [firstTab, ['tab-1-reloaded']]];
          for (const [tabStorage, deviceIds] of opens) {
            const { sync } = build({ google, storage, persistDeviceId, deviceIds, tabStorage });
            const done = sync.upsert('tasks', { id: 1 });
            await settle();
            await done;
          }
          results.push(Object.values(google.state.files).map((f) => f.name));
        }

        expect(results).toEqual([['kandone-tab-1.json'], ['kandone-tab-1.json', 'kandone-tab-2.json']]);
      });

      it.each([
        ['Web Locks exist', { locks: { request: vi.fn((_name, task) => task()) } }, ['kandone-tab-1.json']],
        ['Web Locks are missing', {}, ['kandone-tab-1.json', 'kandone-tab-2.json']],
      ])('by default shares one device file across tabs only when %s', async (_name, navigatorStub, expected) => {
        vi.stubGlobal('navigator', navigatorStub);
        const storage = signedIn();
        const google = fakeGoogle();
        for (const deviceId of ['tab-1', 'tab-2']) {
          const sync = createDriveSync({
            ...IDENTITY, clientId: 'client-id', fetchImpl: google.fetchImpl, storage, tabStorage: memoryStorage(),
            newDeviceId: () => deviceId, flushDelayMs: 100,
          });
          const done = sync.upsert('tasks', { id: 1 });
          await settle();
          await done;
        }
        vi.unstubAllGlobals();

        expect(Object.values(google.state.files).map((f) => f.name)).toEqual(expected);
      });

      it('writes under the app\'s own lock name when Web Locks exist', async () => {
        const request = vi.fn((_name, task) => task());
        vi.stubGlobal('navigator', { locks: { request } });
        const google = fakeGoogle();
        const sync = createDriveSync({
          ...IDENTITY, clientId: 'client-id', fetchImpl: google.fetchImpl, storage: signedIn(), tabStorage: memoryStorage(),
          newDeviceId: () => 'this', flushDelayMs: 100,
        });
        const done = sync.upsert('tasks', { id: 1 });
        await settle();
        await done;
        vi.unstubAllGlobals();

        expect(request.mock.calls.map(([name]) => name)).toEqual([IDENTITY.lockName]);
      });
    });

    describe('remove', () => {
      it('hides the record even though another device still holds an older copy', async () => {
        const google = fakeGoogle({ files: { other: deviceFile('other', { tasks: { 1: { item: { id: 1 }, at: NOW - 10 } } }) } });
        const { sync } = build({ google, storage: signedIn() });

        const done = sync.remove('tasks', 1);
        await settle();
        await done;

        expect(await sync.pullCollection('tasks')).toEqual({ items: [], deletedIds: ['1'] });
      });
    });

    describe('pullCollection', () => {
      it.each([
        ['no files yet', {}, null],
        ['two devices', {
          a: deviceFile('a', { tasks: { 1: { item: { id: 1 }, at: 1 } } }),
          b: deviceFile('b', { tasks: { 2: { item: { id: 2 }, at: 1 } } }),
        }, { items: [{ id: 1 }, { id: 2 }], deletedIds: [] }],
        ['another device\'s file is corrupt or from a newer version', {
          a: deviceFile('a', { tasks: { 1: { item: { id: 1 }, at: 1 } } }),
          bad: { name: 'kandone-bad.json', body: 'not json' },
          newer: { name: 'kandone-newer.json', body: JSON.stringify({ version: 2, device: 'newer' }) },
        }, { items: [{ id: 1 }], deletedIds: [] }],
      ])('returns %s as %j', async (_name, files, expected) => {
        const { sync } = build({ google: fakeGoogle({ files }), storage: signedIn() });

        expect(await sync.pullCollection('tasks')).toEqual(expected);
      });

      it.each([
        ['is rate limited', 429],
        ['fails on the server', 503],
        ['is rejected as unauthorised', 401],
        ['is forbidden', 403],
        ['drops the connection mid-download', 'network'],
      ])('fails the whole read when one device\'s file %s, rather than merging without it', async (_name, failure) => {
        const files = {
          a: deviceFile('a', { tasks: { 1: { item: { id: 1 }, at: 1 } } }),
          b: deviceFile('b', { tasks: { 2: { item: null, at: 2 } } }),
        };
        const { sync } = build({ google: fakeGoogle({ files, failRead: { b: failure } }), storage: signedIn() });

        await expect(sync.pullCollection('tasks')).rejects.toBeDefined();
      });

      it('reads every page of the file listing', async () => {
        const files = Object.fromEntries([1, 2, 3].map((n) => [`f${n}`, deviceFile(`d${n}`, { tasks: { [n]: { item: { id: n }, at: 1 } } })]));
        const { sync } = build({ google: fakeGoogle({ files, pageLimit: 2 }), storage: signedIn() });

        expect((await sync.pullCollection('tasks')).items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      });

      it.each([[''], ["a'b"], ['a b'], ['a/b']])('refuses the file prefix %j, which would break the Drive query', (filePrefix) => {
        expect(() => createDriveSync({ ...IDENTITY, filePrefix, clientId: 'client-id', fetchImpl: fakeGoogle().fetchImpl }))
          .toThrow(expect.objectContaining({ code: 'invalid-config' }));
      });

      it('replaces a stored device id that is not a safe file name part', async () => {
        const storage = memoryStorage({ [SESSION_KEY]: validSession(), app_drive_device_v1: JSON.stringify("x' or 'a'='a") });
        const google = fakeGoogle();
        const { sync } = build({ google, storage, persistDeviceId: true, deviceIds: ['fresh'] });
        const done = sync.upsert('tasks', { id: 1 });
        await settle();
        await done;

        expect(Object.values(google.state.files).map((f) => f.name)).toEqual(['kandone-fresh.json']);
      });

      it('asks Drive for 1000 files per listing page', async () => {
        const google = fakeGoogle({ files: { a: deviceFile('a') } });
        const { sync } = build({ google, storage: signedIn() });

        await sync.pullCollection('tasks');

        expect(google.state.pageSizes).toEqual(['1000']);
      });

      it('signs the user out in the header when Google rejects the token', async () => {
        const { sync } = build({ google: fakeGoogle({ failWith: 401 }), storage: signedIn() });
        const seen = [];
        sync.onAuthChange((u) => seen.push(u?.email ?? null));

        await expect(sync.pullCollection('tasks')).rejects.toMatchObject({ status: 401 });
        expect(seen).toEqual([USER.email, null]);
      });
    });

    describe('loadProfile', () => {
      it('round-trips profile fields saved with saveProfile and is null before any are saved', async () => {
        const { sync } = build({ storage: signedIn() });
        const empty = await sync.loadProfile().then((profile) => profile.tasksLabels ?? null);

        const saved = sync.saveProfile({ tasksLabels: [{ id: 'l1', text: 'Home' }] });
        await settle();
        await saved;

        expect([empty, await sync.loadProfile().then((profile) => profile.tasksLabels ?? null)]).toEqual([null, [{ id: 'l1', text: 'Home' }]]);
      });
    });

    describe('signOut', () => {
      it('drops queued writes and forgets the session', async () => {
        const { sync, storage } = build({ storage: signedIn() });
        const queued = sync.upsert('tasks', { id: 1 });

        await sync.signOut();

        await expect(queued).rejects.toMatchObject({ code: 'signed-out' });
        expect(storage.getItem(SESSION_KEY)).toBeNull();
      });
    });
  });

  describe('in the Android app', () => {
    describe('signInWithGoogle', () => {
      it('signs in through Android, never loading Google\'s browser script', async () => {
        const nativeAuth = fakeNativeAuth();
        const loadGis = vi.fn();
        const google = fakeGoogle();
        const sync = createDriveSync({ ...IDENTITY, clientId: 'client-id', fetchImpl: google.fetchImpl, loadGis, storage: memoryStorage(), tabStorage: memoryStorage(), nativeAuth });
        sync.onAuthChange(() => {});

        const user = await sync.signInWithGoogle();

        expect([user.email, nativeAuth.requestToken.mock.calls[0][0], loadGis.mock.calls.length]).toEqual([USER.email, { interactive: true }, 0]);
      });

      it('rejects when Android returns no Drive token', async () => {
        const { sync } = build({ nativeAuth: fakeNativeAuth({ interactive: 'none' }) });

        await expect(sync.signInWithGoogle()).rejects.toMatchObject({ code: 'access_denied' });
      });
    });

    describe('onAuthChange', () => {
      it.each([
        ['can be renewed', 'grant', [USER.email]],
        ['cannot be renewed without the user', 'fail', [USER.email, null]],
      ])('reports a stored session with a lapsed token as connected, and signed out only once it %s', async (_name, silent, expected) => {
        const { sync } = build({ storage: expiredSession(), nativeAuth: fakeNativeAuth({ silent }) });
        const seen = [];
        sync.onAuthChange((u) => seen.push(u?.email ?? null));

        await sync.pullCollection('tasks').catch(() => {});

        expect(seen).toEqual(expected);
      });

      it('reports a sign-in to a subscriber whose first report was "signed out"', async () => {
        const { sync } = build({ storage: memoryStorage({ [SESSION_KEY]: validSession({ expiresAt: NOW + 120_000 }) }) });
        vi.setSystemTime(NOW + 120_000);
        const seen = [];
        sync.onAuthChange((u) => seen.push(u?.email ?? null));

        await sync.signInWithGoogle();

        expect(seen).toEqual([null, USER.email]);
      });

      it('reports the user once, through a lapsed token, a rejected token and their silent renewals', async () => {
        const google = fakeGoogle({ revokedTokens: ['app-token-1'] });
        const { sync } = build({ google, storage: signedIn(), nativeAuth: fakeNativeAuth() });
        const seen = [];
        sync.onAuthChange((u) => seen.push(u?.email ?? null));

        await vi.advanceTimersByTimeAsync(3_600_000);
        await sync.pullCollection('tasks');

        expect(seen).toEqual([USER.email]);
      });

      it('keeps using a token in its last minute, because Android only renews one that has really expired', async () => {
        const nativeAuth = fakeNativeAuth();
        const storage = memoryStorage({ [SESSION_KEY]: validSession({ expiresAt: NOW + 30_000 }) });
        const { sync } = build({ storage, nativeAuth });

        const done = sync.upsert('tasks', { id: 1 });
        await settle();
        await done;

        expect(nativeAuth.requestToken).not.toHaveBeenCalled();
      });

      it('reports signed out when renewal fails, and does not retry it on every save until the backoff ends', async () => {
        const nativeAuth = fakeNativeAuth({ silent: 'fail' });
        const { sync } = build({ storage: expiredSession(), nativeAuth });
        const seen = [];
        sync.onAuthChange((u) => seen.push(u?.email ?? null));

        for (const id of [1, 2]) {
          const done = sync.upsert('tasks', { id });
          done.catch(() => {});
          await settle();
        }
        const duringBackoff = nativeAuth.requestToken.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        const late = sync.upsert('tasks', { id: 3 });
        late.catch(() => {});
        await settle();

        expect([seen, duringBackoff, nativeAuth.requestToken.mock.calls.length]).toEqual([[USER.email, null], 1, 2]);
      });
    });

    describe('hasRestorableSession', () => {
      it('treats an expired stored session as restorable, since the app can renew it', async () => {
        const { sync } = build({ storage: expiredSession(), nativeAuth: fakeNativeAuth() });

        expect(await sync.hasRestorableSession()).toBe(true);
      });
    });

    describe('upsert', () => {
      it.each([
        ['the stored token has expired', expiredSession(), []],
        ['Google rejects the stored token', signedIn(), ['token-1']],
      ])('renews silently and lands the write when %s', async (_name, storage, revokedTokens) => {
        const google = fakeGoogle({ revokedTokens });
        const { sync } = build({ google, storage, nativeAuth: fakeNativeAuth() });

        const done = sync.upsert('tasks', { id: 1 });
        await settle();
        await done;

        expect(Object.keys(google.stored('new-1').collections.tasks)).toEqual(['1']);
      });

      it('rejects as signed out when silent renewal needs the user', async () => {
        const { sync } = build({ storage: expiredSession(), nativeAuth: fakeNativeAuth({ silent: 'fail' }) });

        const done = sync.upsert('tasks', { id: 1 });
        done.catch(() => {});
        await settle();

        await expect(done).rejects.toMatchObject({ code: 'signed-out' });
      });
    });

    describe('signOut', () => {
      it('also signs the account out on the device', async () => {
        const nativeAuth = fakeNativeAuth();
        const { sync } = build({ storage: signedIn(), nativeAuth });

        await sync.signOut();

        expect(nativeAuth.signOut).toHaveBeenCalledTimes(1);
      });
    });

    describe('deleteAllSyncedData', () => {
      it('deletes the files, revokes over HTTP without Google\'s browser script and signs out on the device', async () => {
        const nativeAuth = fakeNativeAuth();
        const loadGis = vi.fn();
        const google = fakeGoogle({ files: { a: deviceFile('this') } });
        const sync = createDriveSync({ ...IDENTITY, clientId: 'client-id', fetchImpl: google.fetchImpl, loadGis, storage: expiredSession(), tabStorage: memoryStorage(), nativeAuth });

        await sync.deleteAllSyncedData();

        expect([google.state.deleted, google.state.revoked, google.state.revokeMethod, nativeAuth.signOut.mock.calls.length, loadGis.mock.calls.length])
          .toEqual([['a'], 'app-token-1', 'POST', 1, 0]);
      });
    });
  });

  describe('Drive rate limits and errors', () => {
    it.each([
      ['a 429', 429],
      ['a 503', 503],
    ])('retries %s with a growing wait, then succeeds', async (_name, status) => {
      const google = fakeGoogle({ files: { a: deviceFile('this') }, flaky: { status, times: 2 } });
      const { sync, sleeps } = build({ google, storage: signedIn() });

      await expect(sync.pullCollection('tasks')).resolves.toBeNull();

      expect(sleeps).toHaveLength(2);
      expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
    });

    it('waits at least as long as Retry-After asks', async () => {
      const google = fakeGoogle({ flaky: { status: 429, times: 1, retryAfter: '7' } });
      const { sync, sleeps } = build({ google, storage: signedIn() });

      await sync.pullCollection('tasks');

      expect(sleeps).toEqual([7000]);
    });

    it('gives up after a few attempts and reports the status', async () => {
      const google = fakeGoogle({ flaky: { status: 429, times: 99 } });
      const { sync, sleeps } = build({ google, storage: signedIn() });

      await expect(sync.pullCollection('tasks')).rejects.toMatchObject({ status: 429 });

      expect(sleeps).toHaveLength(3);
    });

    it('does not retry an error that will not change', async () => {
      const google = fakeGoogle({ flaky: { status: 403, times: 99 } });
      const { sync, sleeps } = build({ google, storage: signedIn() });

      await expect(sync.pullCollection('tasks')).rejects.toMatchObject({ status: 403 });

      expect(sleeps).toEqual([]);
    });

    it('does not repeat a file creation after a 5xx, which may already have created it', async () => {
      const google = fakeGoogle({ flaky: { status: 500, times: 1, method: 'POST' } });
      const { sync, sleeps } = build({ google, storage: signedIn() });
      const saved = sync.upsert('tasks', { id: 1, name: 'x' });
      saved.catch(() => {});

      await vi.advanceTimersByTimeAsync(200);

      await expect(saved).rejects.toMatchObject({ status: 500 });
      expect(sleeps).toEqual([]);
      expect(Object.keys(google.state.files)).toEqual([]);
    });
  });

  describe('working offline', () => {
    it('reports an unreachable Drive as offline, not as a sign-in problem', async () => {
      const google = fakeGoogle();
      google.state.offline = true;
      const { sync } = build({ google, storage: signedIn() });

      await expect(sync.pullCollection('tasks')).rejects.toMatchObject({ name: 'DriveSyncError', code: 'offline' });
    });

    it('stays connected through an offline start with a lapsed token, then renews once back online', async () => {
      let online = false;
      const nativeAuth = fakeNativeAuth();
      nativeAuth.requestToken.mockImplementationOnce(() => Promise.reject(new Error('network')));
      const { sync } = build({ storage: expiredSession(), nativeAuth, isOnline: () => online });
      const seen = [];
      sync.onAuthChange((u) => seen.push(u?.email ?? null));

      await expect(sync.pullCollection('tasks')).rejects.toMatchObject({ code: 'offline' });
      online = true;
      await expect(sync.pullCollection('tasks')).resolves.toBeNull();

      expect(seen).toEqual([USER.email]);
    });

    it('tells a browser with a lapsed token that it is offline while it is, and signed out once it is not', async () => {
      let online = false;
      const { sync } = build({ storage: expiredSession(), isOnline: () => online });

      const whileOffline = await sync.pullCollection('tasks').catch((e) => e.code);
      online = true;
      const whileOnline = await sync.pullCollection('tasks').catch((e) => e.code);

      expect([whileOffline, whileOnline]).toEqual(['offline', 'signed-out']);
    });
  });

  describe('pull cost', () => {
    it('shares one read between a tasks pull and a labels pull started together', async () => {
      const google = fakeGoogle({ files: { a: deviceFile('a'), b: deviceFile('b') } });
      const { sync } = build({ google, storage: signedIn() });

      await Promise.all([sync.pullCollection('tasks'), sync.loadProfile().then((profile) => profile.tasksLabels ?? null)]);

      expect(google.state.listings).toBe(1);
      expect(google.state.reads.sort()).toEqual(['a', 'b']);
    });

    it('downloads only the files that changed since the last pull', async () => {
      const google = fakeGoogle({ files: { a: deviceFile('a'), b: deviceFile('b') } });
      const { sync } = build({ google, storage: signedIn() });

      await sync.pullCollection('tasks');
      google.state.reads.length = 0;
      await sync.pullCollection('tasks');
      expect(google.state.reads).toEqual([]);

      google.state.files.b.body = deviceFile('b', { tasks: { 1: { item: { id: 1 }, at: 5 } } }).body;
      google.state.files.b.modifiedTime = '2030-01-01T00:00:00.000Z';
      const cloud = await sync.pullCollection('tasks');

      expect(google.state.reads).toEqual(['b']);
      expect(cloud.items.map((t) => t.id)).toEqual([1]);
    });

    it('never serves a stale copy of a file this device just rewrote', async () => {
      const google = fakeGoogle({ files: { a: deviceFile('this') } });
      const { sync } = build({ google, storage: signedIn() });
      await sync.pullCollection('tasks');

      const saved = sync.upsert('tasks', { id: 7, name: 'fresh' });
      await vi.advanceTimersByTimeAsync(200);
      await saved;
      const cloud = await sync.pullCollection('tasks');

      expect(cloud.items.map((t) => t.id)).toEqual([7]);
    });

    it('does not keep the cached files after signing out', async () => {
      const google = fakeGoogle({ files: { a: deviceFile('a') } });
      const { sync } = build({ google, storage: signedIn() });
      await sync.pullCollection('tasks');
      await sync.signOut();
      google.state.reads.length = 0;

      await build({ google, storage: signedIn() }).sync.pullCollection('tasks');

      expect(google.state.reads).toEqual(['a']);
    });

    it('limits how many files download at once', async () => {
      const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, deviceFile(`d${i}`)]));
      const google = fakeGoogle({ files });
      const { sync } = build({ google, storage: signedIn() });

      await sync.pullCollection('tasks');

      expect(google.state.reads).toHaveLength(12);
      expect(google.state.maxActive).toBeLessThanOrEqual(4);
    });
  });

  describe('compacting idle device files', () => {
    const DAY = 86_400_000;
    const idle = (days) => new Date(NOW - days * DAY).toISOString();
    const task = (id, at, name = `task ${id}`) => ({ [id]: { item: { id, name }, at } });
    /** A device file as Drive lists it: `days` since its last write. */
    const file = (device, { days, tasks = {}, profile = {} }) => ({
      ...deviceFile(device, { tasks }, profile),
      modifiedTime: idle(days),
    });
    const names = (google) => Object.values(google.state.files).map((f) => f.name).sort();
    const pull = (google, options) => build({ google, storage: signedIn(), ...options }).sync.pullCollection('tasks');
    const deletes = (google) => google.fetchImpl.mock.calls.filter(([, init]) => init?.method === 'DELETE');

    /** Same Drive, but `intercept(url, init)` may answer a request itself (return undefined to pass it on). */
    function withInterceptor(google, intercept) {
      const real = google.fetchImpl.getMockImplementation();
      google.fetchImpl.mockImplementation(async (url, init = {}) => (await intercept(url, init)) ?? real(url, init));
    }
    const refused = (status) => ({ ok: false, status, json: async () => ({}), headers: { get: () => null } });
    /** A signed-in session that outlives the clock changes some tests make. */
    const longSession = () => memoryStorage({ [SESSION_KEY]: validSession({ expiresAt: NOW + 20 * 365 * DAY }) });

    afterEach(() => { vi.restoreAllMocks(); });

    it('deletes a file idle for 90 days whose every record is older elsewhere, and changes nothing anyone sees', async () => {
      const google = fakeGoogle({
        files: {
          old: file('old', { days: 120, tasks: { ...task(1, 10), ...task(2, 10) } }),
          live: file('live', { days: 1, tasks: { ...task(1, 20, 'edited'), ...task(2, 30) } }),
        },
      });
      const before = mergeDeviceDocuments([parseDeviceDocument(JSON.parse(google.state.files.old.body)),
        parseDeviceDocument(JSON.parse(google.state.files.live.body))]);

      const cloud = await pull(google);

      expect(names(google)).toEqual(['kandone-live.json']);
      expect(cloud.items).toEqual(before.collections.tasks);
    });

    it('keeps an idle file that holds the newest copy of any record', async () => {
      const google = fakeGoogle({
        files: {
          old: file('old', { days: 400, tasks: { ...task(1, 10), ...task(2, 99) } }),
          live: file('live', { days: 1, tasks: task(1, 20) }),
        },
      });

      await pull(google);

      expect(names(google)).toEqual(['kandone-live.json', 'kandone-old.json']);
    });

    it.each([
      ['89 days idle is kept', 89, true],
      ['one tick under 90 days idle is kept', STALE_DEVICE_FILE_MS / DAY - 1 / DAY, true],
      ['exactly 90 days idle is deleted', 90, false],
      ['a year idle is deleted', 365, false],
    ])('%s', async (_label, days, kept) => {
      const google = fakeGoogle({
        files: {
          old: file('old', { days, tasks: task(1, 10) }),
          live: file('live', { days: 0, tasks: task(1, 20) }),
        },
      });

      await pull(google);

      expect(names(google).includes('kandone-old.json')).toBe(kept);
    });

    it("never deletes this device's own file, however idle and superseded it is", async () => {
      const google = fakeGoogle({
        files: {
          mine: file('this', { days: 500, tasks: task(1, 10) }),
          live: file('live', { days: 1, tasks: task(1, 20) }),
        },
      });

      await pull(google);

      expect(names(google)).toEqual(['kandone-live.json', 'kandone-this.json']);
    });

    it('deletes an idle file with no records at all', async () => {
      const google = fakeGoogle({
        files: { empty: file('empty', { days: 200 }), live: file('live', { days: 1, tasks: task(1, 20) }) },
      });

      await pull(google);

      expect(names(google)).toEqual(['kandone-live.json']);
    });

    it.each([
      ['a profile field only it has is kept', { labels: { value: ['x'], at: 5 } }, {}, true],
      ['a profile field newer than elsewhere is kept', { labels: { value: ['x'], at: 50 } }, { labels: { value: ['y'], at: 40 } }, true],
      ['a profile field older than elsewhere is deleted', { labels: { value: ['x'], at: 5 } }, { labels: { value: ['y'], at: 40 } }, false],
    ])('an idle file with %s', async (_label, oldProfile, liveProfile, kept) => {
      const google = fakeGoogle({
        files: {
          old: file('old', { days: 200, tasks: task(1, 10), profile: oldProfile }),
          live: file('live', { days: 1, tasks: task(1, 20), profile: liveProfile }),
        },
      });

      await pull(google);

      expect(names(google).includes('kandone-old.json')).toBe(kept);
    });

    it.each([
      ['a delete older than a newer edit elsewhere is deleted', { 1: { item: null, at: 10 } }, task(1, 20), false],
      ['a delete newer than the copy elsewhere is kept', { 1: { item: null, at: 30 } }, task(1, 20), true],
      ['an edit older than a newer delete elsewhere is deleted', task(1, 10), { 1: { item: null, at: 20 } }, false],
    ])('an idle file with %s', async (_label, oldTasks, liveTasks, kept) => {
      const google = fakeGoogle({
        files: {
          old: file('old', { days: 200, tasks: oldTasks }),
          live: file('live', { days: 1, tasks: liveTasks }),
        },
      });

      await pull(google);

      expect(names(google).includes('kandone-old.json')).toBe(kept);
    });

    it('breaks a tie between devices the way the merge does, so the winner is never deleted', async () => {
      const google = fakeGoogle({
        files: {
          low: file('aaa', { days: 200, tasks: task(1, 10, 'from aaa') }),
          high: file('zzz', { days: 200, tasks: task(1, 10, 'from zzz') }),
          live: file('live', { days: 0, tasks: task(2, 50) }),
        },
      });

      const cloud = await pull(google);

      expect(names(google)).toEqual(['kandone-live.json', 'kandone-zzz.json']);
      expect(cloud.items.find((t) => t.id === 1)).toEqual({ id: 1, name: 'from zzz' });
    });

    it('keeps exactly one of two identical idle files', async () => {
      const twin = (id) => ({ ...file('same', { days: 200, tasks: task(1, 10) }), id });
      const google = fakeGoogle({ files: { a: twin('a'), b: twin('b'), live: file('live', { days: 0, tasks: task(2, 50) }) } });

      await pull(google);

      expect(Object.keys(google.state.files).sort()).toEqual(['b', 'live']);
    });

    it('keeps both files when one device id wrote different content at the same stamp, since the merge cannot say which wins', async () => {
      const google = fakeGoogle({
        files: {
          a: file('same', { days: 200, tasks: task(1, 10, 'first') }),
          b: file('same', { days: 200, tasks: task(1, 10, 'second') }),
          live: file('live', { days: 0, tasks: task(2, 50) }),
        },
      });

      await pull(google);

      expect(Object.keys(google.state.files).sort()).toEqual(['a', 'b', 'live']);
    });

    it('leaves files with no modifiedTime and files it cannot read alone', async () => {
      const google = fakeGoogle({
        files: {
          unknown: deviceFile('unknown', { tasks: task(1, 10) }),
          corrupt: { name: 'kandone-bad.json', body: '{"version":1', modifiedTime: idle(300) },
          live: file('live', { days: 1, tasks: task(1, 20) }),
        },
      });

      await pull(google);

      expect(names(google)).toEqual(['kandone-bad.json', 'kandone-live.json', 'kandone-unknown.json']);
    });

    it.each([
      ['an entry whose stamp is not a number', { version: 1, device: 'old', profile: {}, collections: { tasks: { 1: { item: { id: 1 }, at: 'x' } } } }],
      ['an entry whose record is not an object', { version: 1, device: 'old', profile: {}, collections: { tasks: { 1: { item: 'oops', at: 5 } } } }],
      ['a field this version does not know', { version: 1, device: 'old', profile: {}, collections: {}, addedLater: { keep: true } }],
      ['a record entry with a field this version does not know', { version: 1, device: 'old', profile: {}, collections: { tasks: { 1: { item: { id: 1 }, at: 5, editedBy: 'phone' } } } }],
    ])('keeps an idle file holding %s, which parsing would drop without a trace', async (_label, raw) => {
      const google = fakeGoogle({
        files: {
          old: { name: 'kandone-old.json', body: JSON.stringify(raw), modifiedTime: idle(300) },
          live: file('live', { days: 1, tasks: task(1, 20) }),
        },
      });

      await pull(google);

      expect(names(google)).toEqual(['kandone-live.json', 'kandone-old.json']);
    });

    it('keeps an idle file whose profile entry has a field this version does not know, even when a newer copy exists elsewhere', async () => {
      const raw = { version: 1, device: 'old', profile: { labels: { value: ['x'], at: 5, editedBy: 'phone' } }, collections: {} };
      const google = fakeGoogle({
        files: {
          old: { name: 'kandone-old.json', body: JSON.stringify(raw), modifiedTime: idle(300) },
          live: file('live', { days: 1, tasks: task(1, 20), profile: { labels: { value: ['y'], at: 50 } } }),
        },
      });

      await pull(google);

      expect(names(google)).toEqual(['kandone-live.json', 'kandone-old.json']);
    });

    it('does not delete a file that was written to after the pull read it', async () => {
      const google = fakeGoogle({
        files: {
          old: file('old', { days: 200, tasks: task(1, 10) }),
          live: file('live', { days: 1, tasks: task(1, 20) }),
        },
      });
      // The owner comes back and writes between our read and the delete.
      withInterceptor(google, (url) => {
        if (url.includes('/files/old?fields=modifiedTime')) google.state.files.old.modifiedTime = idle(0);
      });

      await pull(google);

      expect(deletes(google)).toHaveLength(0);
      expect(names(google)).toEqual(['kandone-live.json', 'kandone-old.json']);
    });

    it.each([
      ['a device whose clock is years ahead', 5 * 365 * DAY],
      ['a device whose clock is years behind', -5 * 365 * DAY],
    ])('does not delete a recently written file on %s', async (_label, skew) => {
      const google = fakeGoogle({
        files: {
          old: file('old', { days: 20, tasks: task(1, 10) }),
          live: file('live', { days: 0, tasks: task(1, 20) }),
        },
      });
      vi.setSystemTime(NOW + skew);

      await pull(google, { storage: longSession() });

      expect(names(google)).toEqual(['kandone-live.json', 'kandone-old.json']);
    });

    it('checks for idle files at most once an hour, however many reads happen', async () => {
      const google = fakeGoogle({ files: { live: file('live', { days: 1, tasks: task(1, 20) }) } });
      const { sync } = build({ google, storage: longSession() });
      await sync.pullCollection('tasks');

      google.state.files.old = file('old', { days: 200, tasks: task(1, 10) });
      await sync.pullCollection('tasks');
      expect(names(google)).toEqual(['kandone-live.json', 'kandone-old.json']);

      vi.advanceTimersByTime(60 * 60 * 1000);
      await sync.pullCollection('tasks');
      expect(names(google)).toEqual(['kandone-live.json']);
    });

    it('deletes at most ten files per pass and the rest an hour later, so one pull never fans out into dozens of requests', async () => {
      const stale = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`old${i}`, file(`d${String(i).padStart(2, '0')}`, { days: 200, tasks: task(1, i + 1) })]));
      const google = fakeGoogle({ files: { ...stale, live: file('live', { days: 0, tasks: task(1, 1000) }) } });
      const { sync } = build({ google, storage: longSession() });

      await sync.pullCollection('tasks');
      expect(Object.keys(google.state.files)).toHaveLength(1 + 2);

      vi.advanceTimersByTime(60 * 60 * 1000);
      await sync.pullCollection('tasks');
      expect(names(google)).toEqual(['kandone-live.json']);
    });

    it('runs one pass when tasks and labels are pulled together', async () => {
      const google = fakeGoogle({
        files: {
          old: file('old', { days: 200, tasks: task(1, 10) }),
          live: file('live', { days: 1, tasks: task(1, 20) }),
        },
      });
      const { sync } = build({ google, storage: signedIn() });

      await Promise.all([sync.pullCollection('tasks'), sync.loadProfile().then((profile) => profile.tasksLabels ?? null)]);

      expect(deletes(google)).toHaveLength(1);
    });

    it('still completes the pull when Drive refuses the delete, and says so', async () => {
      const google = fakeGoogle({
        files: {
          old: file('old', { days: 200, tasks: task(1, 10) }),
          live: file('live', { days: 1, tasks: task(1, 20) }),
        },
      });
      withInterceptor(google, (url, init) => (init.method === 'DELETE' ? refused(403) : undefined));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const cloud = await pull(google);

      expect(cloud.items.map((t) => t.id)).toEqual([1]);
      expect(deletes(google)).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not remove 1 idle/i));
      expect(names(google)).toEqual(['kandone-live.json', 'kandone-old.json']);
    });

    it('treats a file another device already deleted as done, without a warning', async () => {
      const google = fakeGoogle({
        files: {
          old: file('old', { days: 200, tasks: task(1, 10) }),
          live: file('live', { days: 1, tasks: task(1, 20) }),
        },
      });
      withInterceptor(google, (url, init) => (init.method === 'DELETE' ? refused(404) : undefined));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const cloud = await pull(google);

      expect(cloud.items.map((t) => t.id)).toEqual([1]);
      expect(deletes(google)).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('deleteAllSyncedData', () => {
    it('deletes every device file, revokes the Google grant and signs out, leaving unrelated files alone', async () => {
      const google = fakeGoogle({
        files: {
          a: deviceFile('this'),
          b: deviceFile('other'),
          c: { name: 'unrelated.json', body: '{}' },
        },
      });
      const { sync, storage, gis } = build({ google, storage: signedIn() });
      const queued = sync.upsert('tasks', { id: 1 });
      queued.catch(() => {});

      await sync.deleteAllSyncedData();

      expect(google.state.deleted.sort()).toEqual(['a', 'b']);
      expect(Object.keys(google.state.files)).toEqual(['c']);
      expect(gis.revoke).toHaveBeenCalledWith('token-1', expect.any(Function));
      expect(storage.getItem(SESSION_KEY)).toBeNull();
      await expect(queued).rejects.toMatchObject({ code: 'signed-out' });
    });

    it('deletes nothing when Google cannot be reached to revoke access afterwards', async () => {
      const google = fakeGoogle({ files: { a: deviceFile('this') } });
      const failingLoad = createDriveSync({ ...IDENTITY,
        clientId: 'client-id',
        fetchImpl: google.fetchImpl,
        loadGis: async () => { throw new Error('blocked'); },
        storage: signedIn(),
        tabStorage: memoryStorage(),
        now: () => Date.now(),
        newDeviceId: () => 'this',
        withLock: (task) => task(),
        flushDelayMs: 100,
      });

      await expect(failingLoad.deleteAllSyncedData()).rejects.toThrow('blocked');

      expect(google.state.deleted).toEqual([]);
    });

    it('fails without deleting when not connected to Drive', async () => {
      const { sync, google } = build({ google: fakeGoogle({ files: { a: deviceFile('this') } }) });

      await expect(sync.deleteAllSyncedData()).rejects.toMatchObject({ code: 'signed-out' });

      expect(google.state.deleted).toEqual([]);
    });
  });

});
