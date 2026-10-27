/**
 * Encryption for credentials entered in the app (e.g. the Shopify app's Client secret and the OAuth access token):
 * AES-256-GCM with a random 96-bit IV per value and associated data binding each value to its website + field, so a
 * value copied to another record does not decrypt. The key is derived with HKDF-SHA256 from CREDENTIALS_ENCRYPTION_KEY,
 * or — when that is not set — from SESSION_SECRET, which every production server already has (no new setting needed).
 * Changing that secret makes stored credentials unreadable: they are then reported as such and must be entered again.
 * Plain values never leave the API: not in responses, logs, audit entries or exports (only the ciphertext is stored).
 */
import crypto from 'node:crypto';

export interface SealedValue { v: 1; iv: string; tag: string; data: string }

export interface SecretBox {
  /** Which server setting the key comes from (name only). */
  keySource: 'CREDENTIALS_ENCRYPTION_KEY' | 'SESSION_SECRET';
  seal(plain: string, aad: string): SealedValue;
  /** Throws SecretBoxError when the value was tampered with or the key changed. */
  open(sealed: SealedValue, aad: string): string;
}

export class SecretBoxError extends Error {}

export function isSealed(v: unknown): v is SealedValue {
  const s = v as SealedValue | undefined;
  return !!s && s.v === 1 && typeof s.iv === 'string' && typeof s.tag === 'string' && typeof s.data === 'string';
}

/** undefined when no key material is configured (credentials then cannot be stored). */
export function createSecretBox(env: { CREDENTIALS_ENCRYPTION_KEY?: string; SESSION_SECRET?: string }): SecretBox | undefined {
  const own = env.CREDENTIALS_ENCRYPTION_KEY?.trim();
  const ikm = own || env.SESSION_SECRET?.trim();
  if (!ikm || ikm.length < 32) return undefined;
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ikm, 'utf8'), Buffer.from('deodap-seo-sentinel', 'utf8'), Buffer.from('integration-credentials-v1', 'utf8'), 32));
  return {
    keySource: own ? 'CREDENTIALS_ENCRYPTION_KEY' : 'SESSION_SECRET',
    seal(plain, aad) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(aad, 'utf8'));
      const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    open(sealed, aad) {
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
        d.setAAD(Buffer.from(aad, 'utf8'));
        d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()]).toString('utf8');
      } catch {
        throw new SecretBoxError('The stored credential could not be decrypted (the encryption key changed, or the record was altered).');
      }
    },
  };
}
