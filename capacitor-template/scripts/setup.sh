#!/usr/bin/env bash
# Run inside the target app repo:
#   bash path/to/capacitor-template/scripts/setup.sh <app-name> <key-alias> <web-client-id> [android-package]
# Example: bash .../setup.sh MyApp myapp 123-abc.apps.googleusercontent.com io.github.joka7.myapp
set -euo pipefail

APP_NAME="${1:?usage: setup.sh <app-name> <key-alias> <web-client-id> [android-package]}"
KEY_ALIAS="${2:?missing key alias}"
CLIENT_ID="${3:?missing OAuth web client id}"
PACKAGE="${4:-io.github.joka7.$(printf '%s' "$APP_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')}"
[[ "$APP_NAME" =~ ^[A-Za-z][A-Za-z0-9]*$ ]] || { echo "app-name must be letters and digits, starting with a letter (it names the APK and the package)." >&2; exit 1; }
[[ "$KEY_ALIAS" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "key-alias must be letters, digits, '_' or '-'." >&2; exit 1; }
[[ "$CLIENT_ID" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "web-client-id contains unexpected characters." >&2; exit 1; }
[[ "$PACKAGE" =~ ^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$ ]] || { echo "android-package must look like io.github.joka7.myapp." >&2; exit 1; }
T="$(cd "$(dirname "$0")/.." && pwd)"

npm i @capacitor/core @capacitor/android @capgo/capacitor-social-login \
  @joka-7/drive-sync @joka-7/capacitor-auth
npm i -D @capacitor/cli playwright

if [ -e capacitor.config.ts ] || [ -e capacitor.config.json ]; then
  echo "A Capacitor config already exists; keeping it. Its appId must equal $PACKAGE (pass the real one as the 4th argument)."
else
  cp "$T/capacitor.config.ts" .
  sed -i "s/app.joka7.REPLACE_ME/$PACKAGE/; s/REPLACE_ME/$APP_NAME/" capacitor.config.ts
  npm i -D typescript
fi

mkdir -p .github/workflows
sed "s/__APP_NAME__/$APP_NAME/g; s/__KEY_ALIAS__/$KEY_ALIAS/g; s/__GOOGLE_CLIENT_ID__/$CLIENT_ID/g" \
  "$T/.github/workflows/android.yml" > .github/workflows/android.yml
[ -e .github/workflows/ios-release.yml ] || cp "$T/.github/workflows/ios-release.yml" .github/workflows/

# The signing key and the secret files generate-keystore.sh writes must never be committed.
for entry in release.keystore secrets/; do
  grep -qxF "$entry" .gitignore 2>/dev/null || printf '%s\n' "$entry" >> .gitignore
done

mkdir -p scripts
cp "$T/scripts/generate-assets.mjs" scripts/generate-assets.mjs

npx cap add android
PKG_DIR="android/app/src/main/java/$(printf '%s' "$PACKAGE" | tr . /)"
mkdir -p "$PKG_DIR"
sed "s/__PACKAGE__/$PACKAGE/" "$T/android/MainActivity.java" > "$PKG_DIR/MainActivity.java"

echo "Done. Two manual steps remain:"
echo "  1. In android/app/build.gradle, replace versionCode/versionName with $T/android/versionCode.gradle.snippet"
echo "  2. npx playwright install chromium && node scripts/generate-assets.mjs <icon-512.png> <background-hex>"
echo "Then: bash $T/scripts/generate-keystore.sh $KEY_ALIAS   (and add the versionCode lines, or every APK keeps versionCode 1)"
