#!/usr/bin/env bash
# Run inside the target app repo: bash path/to/capacitor-template/scripts/setup.sh
set -euo pipefail
T="$(cd "$(dirname "$0")/.." && pwd)"
npm i @capacitor/core @capacitor/android @capacitor/local-notifications @codetrix-studio/capacitor-google-auth
npm i -D @capacitor/cli @capacitor/assets
cp -n "$T/capacitor.config.ts" .
mkdir -p .github/workflows resources
cp -n "$T"/.github/workflows/*.yml .github/workflows/
echo "Edit capacitor.config.ts (appId, appName, serverClientId), put resources/icon.png + splash.png, then:"
echo "  npx cap add android && npx capacitor-assets generate --android"
