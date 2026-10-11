# local-first-kit

Shared foundation for making apps local-first (data on device, optional Google Drive or end-to-end encrypted sync) and shipping them as Android apps.

- `packages/drive-sync` (`@joka-7/drive-sync`): Google sign-in, `appDataFolder` storage, per-item merge, sync on open/focus/edit.
- `packages/e2ee` (`@joka-7/e2ee`): libsodium encryption, sealed boxes, share links, recovery keys.
- `capacitor-template/`: Capacitor config, Android signing and release workflow, iOS workflow stub.
- `docs/`: usage, privacy note, migration guide.

`npm install && npm test && npm run build`
