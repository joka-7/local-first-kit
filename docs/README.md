# local-first-kit docs

- [`PLAYBOOK.md`](PLAYBOOK.md): the 13 rules that keep Drive sync correct, and how to adopt the kit in an app step by step.
- [`SETUP.md`](SETUP.md): the Google Cloud, Vercel, GitHub and npm clicks.

## e2ee

`@joka-7/e2ee`: libsodium secretbox for blobs, sealed boxes for submissions to a public key, `wrapKey` for group keys, `buildShareLink` (key in the `#fragment`), `exportRecoveryKey` / `importRecoveryKey`. A lost recovery key plus lost devices means lost data; say so in the UI.

## Privacy note template

> Your data is stored on your device. If you turn on sync, it is saved in a hidden folder in your own Google Drive that only this app can open. We run no database of your data and cannot read it. Use "Export my data" and "Delete my data" in settings at any time.

## Hardening checklist

CSP, HSTS, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`; keep AI keys out of logs.
