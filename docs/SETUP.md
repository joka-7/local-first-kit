# Setup: the clicks only you can do

Do these once per app. Where a step needs a value from an earlier one, it says so.

## 1. Google Cloud project

1. Open [console.cloud.google.com](https://console.cloud.google.com) and create a project (or pick the app's existing one).
2. **APIs & Services → Library →** search **Google Drive API → Enable**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform → Data Access):
   - Add the scope `https://www.googleapis.com/auth/drive.appdata`. Also keep `openid`, `email` and `profile`.
   - Fill in the app name, support email and (when asked) the privacy-policy link.
   - **Publish** the app (Publishing status → **In production**). While it stays in *Testing*, only listed test users can sign in and their grants expire after 7 days.

## 2. Web client (the browser sign-in)

1. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.**
2. **Authorized JavaScript origins:** add every origin the app is served from, for example `https://your-app.vercel.app`, your custom domain, and `http://localhost:5173` for development. Origins are exact: no path, no trailing slash.
3. Leave redirect URIs empty (the token popup does not use them).
4. Copy the **Client ID**. It is public by design (it is in every sign-in URL), not a secret.

## 3. Vercel

1. Project → **Settings → Environment Variables** → add `VITE_GOOGLE_CLIENT_ID` with the client ID, **type Config** (a plain variable, not Secret), for Production, Preview and Development.
2. **Redeploy** (Deployments → the latest → Redeploy). Vite reads the variable at build time, so an existing build keeps the old value.
3. Vercel preview URLs need a Vercel login, so they cannot be opened on a phone. To test on a phone, use **Share** (a shareable link) from the preview deployment.

## 4. Android signing key (GitHub)

1. In the app repo, run `bash path/to/local-first-kit/capacitor-template/scripts/generate-keystore.sh <key-alias>`. It writes `release.keystore` and `secrets/ANDROID_KEYSTORE_B64`, `secrets/ANDROID_KEYSTORE_B64_2` and `secrets/ANDROID_KEY_PASSWORD`, and prints the **SHA-1**.
2. Back up `release.keystore` and `secrets/` outside the repo (a password manager). **Lose the key and installed apps can no longer be updated or signed in.** Never commit either.
3. GitHub → repo → **Settings → Secrets and variables → Actions → New repository secret**: create `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_B64_2` and `ANDROID_KEY_PASSWORD`, pasting each file's contents. The keystore is split in two because some clipboards cut lines at 2000 characters.
4. Make sure `KEY_ALIAS` in `.github/workflows/android.yml` matches the alias you passed.

## 5. Android OAuth client

1. **Credentials → Create credentials → OAuth client ID → Android.**
2. **Package name:** the app's `appId` from `capacitor.config.ts` (for example `io.github.joka7.myapp`).
3. **SHA-1 certificate fingerprint:** the SHA-1 printed in step 4. It must be the key the CI signs with.
4. No client ID from this one goes into the app: Android matches it to the *Web* client ID by package and key.

## 6. npm (publishing the kit itself)

The packages live under the npm scope `@joka-07`, which is the npm username; the GitHub account is `joka-7`, so the Trusted Publisher below uses `joka-7` while package names use `joka-07`. The three packages publish from CI on a version tag through npm Trusted Publishing (OIDC), the same setup as ModelDispatcher, so no token is stored in the repo. Trusted publishing cannot do a package's first publish, so for each of `@joka-07/e2ee`, `@joka-07/drive-sync` and `@joka-07/capacitor-auth`:

1. Once, from a clone of this repo: `npm ci && npm run build`, then `npm publish --access public --workspace packages/<name>` (log in with an account that owns the `@joka-7` scope; an automation token also works for this one-off step).
2. On npmjs.com → the package → **Settings → Trusted Publisher** → GitHub Actions: owner `joka-7`, repository `local-first-kit`, workflow `release.yml`.
3. Later releases: bump all three `package.json` versions to the same number and push the tag `vX.Y.Z`. The workflow fails if any version differs from the tag.

## 7. Check it works

1. Push to the app's `main`: the Android workflow builds, signs and publishes `<App>.apk` to the repo's Releases.
2. Install the APK on the phone, tap **Connect Drive**, accept Google's consent sheet.
3. Make an edit, open the app on another device or in the browser, connect the same account, and confirm the edit appears.
