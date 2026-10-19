#!/usr/bin/env bash
# Creates the app's permanent Android signing key and writes the three GitHub
# secret files into ./secrets/, then prints the SHA-1 for the Google Cloud
# Android OAuth client.
#   Usage: bash generate-keystore.sh <key-alias>
# Back up release.keystore somewhere safe and never commit it or ./secrets/.
set -euo pipefail

ALIAS="${1:?usage: generate-keystore.sh <key-alias>}"
KEYSTORE="release.keystore"
SECRETS_DIR="secrets"
# Some clipboards cut long lines at 2000 characters, so the keystore is pasted as two secrets.
CHUNK=1800

[ ! -e "$KEYSTORE" ] || { echo "$KEYSTORE already exists; refusing to overwrite the signing key." >&2; exit 1; }

# Passwords go through the environment, never on a command line other processes can read.
PASSWORD="$(openssl rand -hex 16)"
export PASSWORD
keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass:env PASSWORD -keypass:env PASSWORD -dname "CN=$ALIAS"

B64="$(base64 < "$KEYSTORE" | tr -d '\n')"
[ "${#B64}" -le $((CHUNK * 2)) ] || { echo "Keystore does not fit in two secrets of $CHUNK characters." >&2; exit 1; }

mkdir -p "$SECRETS_DIR"
umask 077
printf '%s' "${B64:0:CHUNK}" > "$SECRETS_DIR/ANDROID_KEYSTORE_B64"
printf '%s' "${B64:CHUNK}" > "$SECRETS_DIR/ANDROID_KEYSTORE_B64_2"
printf '%s' "$PASSWORD" > "$SECRETS_DIR/ANDROID_KEY_PASSWORD"

echo "Wrote $SECRETS_DIR/ANDROID_KEYSTORE_B64, ANDROID_KEYSTORE_B64_2 and ANDROID_KEY_PASSWORD."
echo "Paste each file's contents into a GitHub Actions secret of the same name."
echo "Key alias (set in .github/workflows/android.yml): $ALIAS"
echo "SHA-1 for the Google Cloud Android OAuth client:"
keytool -list -v -keystore "$KEYSTORE" -storepass:env PASSWORD -alias "$ALIAS" | grep 'SHA1'
