# local-first-kit

Shared foundation for making apps local-first (data on device, optional Google Drive sync, plus an e2ee toolbox for apps that need it) and shipping them as Android apps. Apps install the packages instead of copying code.

- `packages/drive-sync` (`@joka-7/drive-sync`): per-device Drive files in the hidden `appDataFolder`, newest-entry-wins merge with tombstones, pending-edit tracking, token handling for browser and Android. Generic over collections.
- `packages/capacitor-auth` (`@joka-7/capacitor-auth`): Google sign-in for the Android app through the OS, with silent token renewal.
- `packages/e2ee` (`@joka-7/e2ee`): libsodium encryption, sealed boxes, share links, recovery keys.
- `capacitor-template/`: `MainActivity`, versionCode snippet, signed-APK workflow, keystore and icon scripts.
- `docs/`: [`PLAYBOOK.md`](docs/PLAYBOOK.md) (the rules and how to adopt the kit), [`SETUP.md`](docs/SETUP.md) (Google, Vercel, GitHub, npm clicks).

`npm ci && npm run typecheck && npm test && npm run build`
