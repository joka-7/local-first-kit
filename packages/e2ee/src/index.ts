import sodium from "libsodium-wrappers";

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export const ready = () => sodium.ready;

const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);
const unb64 = (s: string) => sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);

export const toBase64Url = b64;
export const fromBase64Url = unb64;

export function generateKey(): Uint8Array {
  return sodium.crypto_secretbox_keygen();
}

/** Encrypt bytes or text. Output is base64url(nonce || ciphertext). */
export function encrypt(key: Uint8Array, data: string | Uint8Array): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const box = sodium.crypto_secretbox_easy(data, nonce, key);
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce);
  out.set(box, nonce.length);
  return b64(out);
}

export function decryptBytes(key: Uint8Array, payload: string): Uint8Array {
  const all = unb64(payload);
  const n = sodium.crypto_secretbox_NONCEBYTES;
  if (all.length <= n) throw new Error("Invalid ciphertext");
  return sodium.crypto_secretbox_open_easy(all.slice(n), all.slice(0, n), key);
}

export const decrypt = (key: Uint8Array, payload: string) => sodium.to_string(decryptBytes(key, payload));

export function generateKeyPair(): KeyPair {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/** Anyone with the public key can seal; only the private key holder can open. */
export function sealTo(publicKey: Uint8Array, data: string | Uint8Array): string {
  return b64(sodium.crypto_box_seal(data, publicKey));
}

export function openSealed(kp: KeyPair, payload: string): string {
  return sodium.to_string(sodium.crypto_box_seal_open(unb64(payload), kp.publicKey, kp.privateKey));
}

/** Wrap a group/household key for a member's public key. */
export const wrapKey = (publicKey: Uint8Array, key: Uint8Array) => sealTo(publicKey, key);
export const unwrapKey = (kp: KeyPair, wrapped: string): Uint8Array =>
  sodium.crypto_box_seal_open(unb64(wrapped), kp.publicKey, kp.privateKey);

/** Share link with the key in the fragment, which browsers never send to servers. */
export function buildShareLink(baseUrl: string, key: Uint8Array): string {
  return `${baseUrl}#k=${b64(key)}`;
}

export function parseShareKey(url: string): Uint8Array | null {
  const m = /#k=([A-Za-z0-9_-]+)$/.exec(url);
  return m ? unb64(m[1]) : null;
}

const GROUP = 4;

/** Human-friendly recovery key: base64url split in groups. Show it, save as a file, or render as QR. */
export function exportRecoveryKey(key: Uint8Array): string {
  return b64(key).match(new RegExp(`.{1,${GROUP}}`, "g"))!.join(" ");
}

export function importRecoveryKey(text: string): Uint8Array {
  return unb64(text.replace(/\s/g, ""));
}
