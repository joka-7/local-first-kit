# capacitor-template

Wraps an app's existing web build (`dist/`) as a signed Android app that signs in to Google Drive through the OS. iOS workflow stays disabled until an Apple Developer account exists.

| File | Purpose |
|---|---|
| `scripts/setup.sh` | Installs the packages, fills in the config and workflow, adds the Android project and `MainActivity` |
| `android/MainActivity.java` | Forwards Google's consent result to the plugin; without it Drive access is refused (`__PACKAGE__` is replaced) |
| `android/versionCode.gradle.snippet` | Lines for `build.gradle` so CI's run number becomes `versionCode` |
| `.github/workflows/android.yml` | Lint, test, build, sign with the permanent key, publish the APK as a release |
| `scripts/generate-keystore.sh` | Creates the key, writes the 3 secret files, prints the SHA-1 |
| `scripts/generate-assets.mjs` | Icon and splash for every density from one 512 px icon |
| `.github/workflows/ios-release.yml` | Disabled stub |

Full steps: `docs/PLAYBOOK.md` (adopting the kit) and `docs/SETUP.md` (Google, Vercel and GitHub clicks).
