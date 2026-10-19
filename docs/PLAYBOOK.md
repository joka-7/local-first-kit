# Playbook: local-first apps with Drive sync

Every rule below is a bug KanDOne hit on a real phone. Rules 1-12 each have a test in this repo that fails without the fix (checked by mutating the code, see "Mutation checks" at the end). Rule 13 is the Android shell, which is checked on a device instead.

## The 13 rules

| # | Rule | Where | Test |
|---|---|---|---|
| 1 | **One file per device** (`<prefix>-<deviceId>.json`). A device writes only its own file and reads all of them. Drive v3 has no conditional write, so one shared file loses edits. | `engine.ts` `ownFileName`, `readMergedFresh` | `engine.test.ts` "coalesces a burst of writes into one upload of this device's own file" |
| 2 | **Newest entry wins per record; deletes are tombstones** (`{ item: null, at }`). A pull returns `{ items, deletedIds }`, and `resolveOnPull` drops stale local copies unless they have a pending local edit. | `document.ts` `applyOperations`, `mergeDeviceDocuments`; `resolve.ts` | `document.test.ts`, `resolve.test.ts`, `engine.test.ts` "hides the record even though another device still holds an older copy" |
| 3 | **Stamp guard:** `at = max(now, newest seen + 1)`. Device clocks drift. | `document.ts` `nextStamp` | `document.test.ts` `nextStamp`, `engine.test.ts` "stamps a write after the newest entry already in Drive" |
| 4 | **Pending tracking:** local edits not yet confirmed in Drive win over a pull, and local deletes are replayed. | `pending.ts`, `resolve.ts`, `engine.ts` `releaseLandedIds` | `pending.test.ts`, `resolve.test.ts`, `engine.test.ts` "clears a pending id once its upload lands, but not while a newer edit of it is still queued" |
| 5 | **Unreadable files:** skip only 404, corrupt and newer-version files. A network error, 429, 5xx or 401 fails the whole pull, never a partial merge. | `errors.ts` `isPermanentlyUnreadable`, `engine.ts` `readMergedFresh` | `engine.test.ts` `pullCollection` tables |
| 6 | **Corrupt own file:** leave it in place and continue under a new device id. | `engine.ts` `abandonOwnFile` | "leaves an unreadable own file untouched and continues in a new one" |
| 7 | **Listing:** paginate with `nextPageToken`, `pageSize` 1000. | `engine.ts` `listFiles` | "reads every page of the file listing", "asks Drive for 1000 files per listing page" |
| 8 | **Tabs:** with Web Locks, tabs share one device file. Without them each tab gets its own id in `sessionStorage`. | `engine.ts` `persistDeviceId`, `withLock` | "by default shares one device file across tabs only when …" |
| 9 | **Web token** is kept in `localStorage` with its expiry, so a reload within the hour stays connected. Google's script is preloaded so the Connect click opens the popup synchronously. | `engine.ts` `setSession`, `onAuthChange` | "opens the Google popup synchronously once the script has preloaded", "reports a stored session only while its token is valid" |
| 10 | **Android token** comes from the OS (`refresh` then `getAuthorizationCode`); the real expiry comes from `tokeninfo`; renewal is lazy, 5 s before expiry (a 60 s margin gets the same token back); on a 401, renew and retry once; after a failed renewal the user shows as signed out and renewal backs off for 5 minutes. | `capacitor-auth/src/index.ts`; `engine.ts` `renewSilently`, `driveFetch` | `capacitor-auth/src/index.test.ts`, `engine.test.ts` "in the Android app" |
| 11 | **Auth listeners** hear only a change of the connected uid, never a token swap, and the dedupe is re-seeded on every subscribe. | `engine.ts` `notifyListeners`, `onAuthChange` | "reports the user once, through a lapsed token, a rejected token and their silent renewals", "reports a sign-in to a subscriber whose first report was signed out" |
| 12 | **Data owner:** sign-out clears local data and the owner marker (the app does this: the kit supplies `clearLocalSyncState` and `ownedByAnother`, see step 8). Connecting with a different account discards the previous account's local data; it is never merged. `deleteAllSyncedData()` deletes every file, then revokes (GIS on the web; `POST oauth2.googleapis.com/revoke` plus device sign-out on Android). | `pending.ts` `ownedByAnother`, `clearLocalSyncState`; `engine.ts` `deleteAllSyncedData` | `pending.test.ts`, `engine.test.ts` `deleteAllSyncedData` |
| 13 | **Android shell:** no service worker and no install button inside the app; `versionCode` comes from `-PversionCode`; `MainActivity` forwards Google's consent result to the plugin. | `capacitor-template/` | Not unit-testable; checked on a device (see "Android shell" below) |

## How to adopt the kit in an app

1. **Set up Google and GitHub first** (`docs/SETUP.md`): you need the Web client ID and, for Android, the keystore secrets.
2. **Install:** `npm i @joka-07/drive-sync` (plus `@joka-07/capacitor-auth @capgo/capacitor-social-login @capacitor/core` for the Android app).
3. **Create the client once**, in one module. The app supplies the file prefix, storage keys and lock name; nothing in the kit is app-specific:

   ```ts
   import { Capacitor } from "@capacitor/core";
   import { createNativeGoogleAuth } from "@joka-07/capacitor-auth";
   import { createDriveSync, createPendingTracker } from "@joka-07/drive-sync";

   const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
   const fetchImpl: typeof fetch = (...args) => fetch(...args);

   export const pending = createPendingTracker({ keyPrefix: "myapp_pending_sync_v1", ownerKey: "myapp_data_owner_v1" });

   export const driveSync = createDriveSync({
     clientId,
     filePrefix: "myapp-",              // files are myapp-<deviceId>.json
     lockName: "myapp-drive-write",
     storageKeys: { session: "myapp_drive_session_v1", device: "myapp_drive_device_v1" },
     fetchImpl,
     onWritesLanded: pending.clearPendingIds,
     nativeAuth: Capacitor.isNativePlatform()
       ? createNativeGoogleAuth({ webClientId: clientId, fetchImpl })
       : null,
   });
   ```

4. **Pick your collections.** A collection is any string you choose; records need an `id`. KanDOne uses `tasks`; JobFlowTracker uses one per mode; StepByLearn uses `paths`. An app that keeps several lists in one state object (HighFive) stores that object as a single record, or uses `saveProfile` for per-field values.
5. **Record local changes** on every save, so a pull can tell a pending edit from a stale copy:

   ```ts
   const diff = diffFingerprints(fingerprintItems(before), fingerprintItems(after));
   pending.recordLocalChanges("tasks", diff);
   ```

6. **Pull and merge** on sign-in, on reconnect and whenever `onAuthChange` reports a user. Read local state *after* the pull returns, never before: people keep typing while it runs.

   ```ts
   const cloud = await driveSync.pullCollection("tasks");           // null on a first sign-in
   const { merged, pushIds, deleteFromCloud } = resolveOnPull(
     getLocal(), cloud?.items ?? [], pending.readPending("tasks"), cloud?.deletedIds,
   );
   apply(merged);
   await driveSync.upsertMany("tasks", merged.filter((r) => pushIds.includes(String(r.id))));
   await Promise.all(deleteFromCloud.map((id) => driveSync.remove("tasks", id)));
   ```

   Only `pushIds` are written back. Every write is stamped as the newest, so re-sending a record the cloud already holds would let this device's stale copy beat another device's concurrent edit.
7. **Write** with `upsert`, `upsertMany` and `remove`. Each resolves only once the write has landed in Drive, and releases its pending ids then.
8. **Data owner (rule 12).** Right after `signInWithGoogle()` resolves, before the first pull:

   ```ts
   const user = await driveSync.signInWithGoogle();
   if (pending.ownedByAnother(user.uid)) clearLocalData();   // your storage: never merge another account's data
   pending.writeDataOwner(user.uid);
   ```

   On sign-out, clear your local data and call `pending.clearLocalSyncState(["tasks"])`. The kit cannot clear your storage for you, so this step stays in the app.
9. **Android shell (rule 13).** Skip service-worker registration and hide the install button inside the app:

   ```ts
   if (import.meta.env.PROD && !Capacitor.isNativePlatform()) registerSW({ immediate: true });
   const canInstall = !isStandalone && !Capacitor.isNativePlatform();
   ```

   Then run `capacitor-template/scripts/setup.sh` (see `capacitor-template/README.md`).
10. **CSP.** If the app sets a Content-Security-Policy, mirror KanDOne's working policy (`index.html`): `script-src` needs `https://apis.google.com https://accounts.google.com https://www.gstatic.com https://www.google.com https://www.googleapis.com`; `connect-src` needs `https://*.googleapis.com https://oauth2.googleapis.com https://www.googleapis.com`; `frame-src` needs `https://accounts.google.com https://www.google.com`. Google's script loads from `accounts.google.com/gsi/client`, and the engine calls the Drive, userinfo, tokeninfo and revoke endpoints.
11. **Tests.** Inject fakes: `createDriveSync` takes `fetchImpl`, `loadGis`, `storage`, `tabStorage`, `now`, `newDeviceId`, `withLock`, `sleep`, `random` and `isOnline`. `packages/drive-sync/src/engine.test.ts` has a fake Drive, fake GIS and fake native auth to copy.

## Android shell

The three parts of rule 13 live in `capacitor-template/`: `android/MainActivity.java` (without it `@capgo/capacitor-social-login` refuses the Drive scope), `android/versionCode.gradle.snippet` and `.github/workflows/android.yml` (passes `-PversionCode=${{ github.run_number }}`). The signing step fails loudly on a missing or wrong key instead of falling back to a temporary one, because Google sign-in only works for the key whose SHA-1 is registered.

## Session rules

- Commit as `joka-7` (`255956958+joka-7@users.noreply.github.com`); no Claude attribution.
- Open PRs through the REST API (`gh pr create` is blocked).
- Pin npm versions to ones at least two weeks old, and pin GitHub Actions by commit SHA.
- Run `gen_tree --check` from a folder named like the repo.

## Mutation checks

Rules 1-12 were verified by breaking the code one way per rule (for example `nextStamp` returning `now`, the pageSize set to 100, the revoke sent as `GET`) and confirming the suite fails; this was done by hand for this release (there is no script or CI step behind it), so repeat it when you change the engine.
