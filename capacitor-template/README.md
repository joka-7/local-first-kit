# capacitor-template

Wraps an app's existing web build (`dist/`) as an Android app (iOS workflow ready for later).

1. `bash scripts/setup.sh` from the app repo. Edit `capacitor.config.ts`.
2. `npx cap add android`, then add a `build` script that outputs `dist/`.
3. `bash scripts/generate-keystore.sh`: add the printed secrets to GitHub (`ANDROID_KEYSTORE_B64`, `_2`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEY_ALIAS`) and give the SHA-1 to the Android OAuth client in Google Cloud.
4. Native sign-in: initialise `@codetrix-studio/capacitor-google-auth` and pass its token to `createNativeAuth` from `@joka-7/drive-sync`.
5. Publish a GitHub release; the workflow attaches the signed APK.

Reminders on mobile: use `@capacitor/local-notifications` (scheduled on the phone, no server).
