#!/usr/bin/env bash
# Generates an Android signing key and prints the GitHub secrets plus the SHA-1 for the OAuth Android client.
set -euo pipefail
ALIAS="${1:-release}"; PASS="$(openssl rand -hex 16)"; KS="release.keystore"
keytool -genkeypair -v -keystore "$KS" -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PASS" -keypass "$PASS" -dname "CN=App, O=joka-7"
B64="$(base64 -w0 "$KS")"
echo "ANDROID_KEY_ALIAS=$ALIAS"
echo "ANDROID_KEY_PASSWORD=$PASS"
echo "ANDROID_KEYSTORE_B64 (split into two secrets if over the 48KB limit):"
echo "$B64"
echo "SHA-1 for Google Cloud Android OAuth client:"
keytool -list -v -keystore "$KS" -alias "$ALIAS" -storepass "$PASS" | grep 'SHA1'
echo "Store release.keystore safely and do NOT commit it."
