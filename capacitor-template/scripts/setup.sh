#!/usr/bin/env bash
# Run inside the target app repo: bash path/to/capacitor-template/scripts/setup.sh
set -euo pipefail
T="$(cd "$(dirname "$0")/.." && pwd)"
npm i @capacitor/core @capacitor/android @capacitor/local-notifications @capgo/capacitor-social-login
npm i -D @capacitor/cli @capacitor/assets
cp --update=none "$T/capacitor.config.ts" "$T/native-auth.ts" .
mkdir -p .github/workflows resources
cp --update=none "$T"/.github/workflows/*.yml .github/workflows/
echo "Edit capacitor.config.ts (appId, appName) and native-auth.ts (web client ID), put resources/icon.png + splash.png, then:"
echo "  npx cap add android && npx capacitor-assets generate --android"
