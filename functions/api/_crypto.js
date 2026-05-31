/**
 * AES-256-GCM encryption for IG access tokens at rest in D1.
 *
 * The IG long-lived access_token is publish-capable for ~60 days and must remain
 * reversible (the cron presents it to Meta), so it can't be hashed like the
 * desktop_token — it's encrypted instead. Key = env.TOKEN_ENC_KEY (base64 of 32
 * random bytes), held only as a Cloudflare secret.
 *
 * Stored format:  "v1:<base64(iv)>:<base64(ciphertext+tag)>"
 * decryptToken() returns any non-"v1:" value unchanged, so pre-existing plaintext
 * rows keep working until they're next refreshed (graceful migration).
 *
 * NOTE: an identical copy lives in cron-worker/_crypto.js — the cron Worker is a
 * separate deployment and cannot import from functions/. Keep the two in sync.
 */

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function importKey(env) {
  if (!env.TOKEN_ENC_KEY) throw new Error('TOKEN_ENC_KEY is not set');
  const raw = base64ToBytes(env.TOKEN_ENC_KEY);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptToken(plaintext, env) {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ctBuf))}`;
}

export async function decryptToken(stored, env) {
  // Backward-compat: legacy plaintext rows (pre-encryption) pass through untouched.
  if (!stored || !stored.startsWith('v1:')) return stored;
  const [, ivB64, ctB64] = stored.split(':');
  const key = await importKey(env);
  const ptBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ctB64)
  );
  return new TextDecoder().decode(ptBuf);
}
