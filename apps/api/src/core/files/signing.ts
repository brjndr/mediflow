import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signs a download link: an HMAC-SHA256 of what the link is for and when it ends, so the link
 * cannot be made for another file or kept alive past its time. `subject` is the id of the file's
 * record; `expires` is epoch seconds.
 */
export function signDownload(secret: string, subject: string, expires: number): string {
  return createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`report-file.v1.${subject}.${expires}`)
    .digest('base64url');
}

/** Whether `signature` is the one for this subject and time, and the time has not passed. */
export function verifyDownload(
  secret: string,
  subject: string,
  expires: number,
  signature: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!Number.isSafeInteger(expires) || expires < nowSeconds) return false;
  const expected = Buffer.from(signDownload(secret, subject, expires));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
