# Applying the kit to an app

Follows `privacy-and-mobile-work-plan.md` §5 (one commit per step).

## drive-sync
```ts
import { createWebAuth, createDriveStore, createSyncer } from "@joka-7/drive-sync";
const auth = createWebAuth(GOOGLE_WEB_CLIENT_ID);
const drive = createDriveStore(() => auth.getToken());
const syncer = createSyncer({ drive, fileName: "tasks.json", local: dexieAdapter, onStatus: setStatus });
const stop = syncer.start();          // on open, focus, online
// after each local edit: syncer.schedule();
```
Items need `id` and `updatedAt` (ms); deletions are tombstones (`deleted: true`). Merge is last-write-wins per item. Only scope used: `drive.appdata`.

For encrypted Drive sync pass `encode`/`decode` built on `@joka-7/e2ee` `encrypt`/`decrypt`.

## e2ee
libsodium secretbox for blobs, sealed boxes for submissions to a public key, `wrapKey` for group keys, `buildShareLink` (key in `#fragment`), `exportRecoveryKey`/`importRecoveryKey`. Lost recovery key plus lost devices means lost data; say so in the UI.

## Privacy note template
> Your data is stored on your device. If you turn on sync, it is saved in a hidden folder in your own Google Drive that only this app can open. We run no database of your data and cannot read it. Use "Export my data" and "Delete my data" in settings at any time.

## Migration for existing Firebase users
On first open: if a Firebase session exists, import Firestore data to the device, offer Drive sync, delete the Firestore data, keep the path for one release cycle, then remove Firebase.

## Hardening checklist
CSP, HSTS, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`; keep AI keys out of logs.
