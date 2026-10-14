import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a Shopify webhook: base64(HMAC-SHA256(rawBody, secret)) must equal the X-Shopify-Hmac-Sha256 header.
 * `rawBody` must be the exact bytes received (before any JSON parsing). Constant-time comparison.
 */
export function verifyShopifyWebhook(rawBody: Buffer, hmacHeader: string, secret: string): boolean {
  if (!secret || typeof hmacHeader !== 'string' || !hmacHeader) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(hmacHeader.trim(), 'base64');
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
