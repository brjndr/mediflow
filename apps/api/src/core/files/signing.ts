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

/**
 * Links for imaging files (#99), signed for their own purpose so a download link cannot be used
 * to upload and neither can be made from a report link. `subject` is the image's id.
 */
const signFor = (purpose: string, secret: string, subject: string, expires: number) =>
  createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${purpose}.v1.${subject}.${expires}`)
    .digest('base64url');

const verifyFor = (
  purpose: string,
  secret: string,
  subject: string,
  expires: number,
  signature: string,
  nowSeconds: number,
) => {
  if (!Number.isSafeInteger(expires) || expires < nowSeconds) return false;
  const expected = Buffer.from(signFor(purpose, secret, subject, expires));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

export const signImageUpload = (secret: string, subject: string, expires: number) =>
  signFor('imaging-upload', secret, subject, expires);
export const verifyImageUpload = (
  secret: string,
  subject: string,
  expires: number,
  signature: string,
  nowSeconds = Math.floor(Date.now() / 1000),
) => verifyFor('imaging-upload', secret, subject, expires, signature, nowSeconds);
/** Links for patient documents (#194), each signed for its own purpose; `subject` is the document id. */
export const signDocumentUpload = (secret: string, subject: string, expires: number) =>
  signFor('document-upload', secret, subject, expires);
export const verifyDocumentUpload = (
  secret: string,
  subject: string,
  expires: number,
  signature: string,
  nowSeconds = Math.floor(Date.now() / 1000),
) => verifyFor('document-upload', secret, subject, expires, signature, nowSeconds);
export const signDocumentDownload = (secret: string, subject: string, expires: number) =>
  signFor('document-file', secret, subject, expires);
export const verifyDocumentDownload = (
  secret: string,
  subject: string,
  expires: number,
  signature: string,
  nowSeconds = Math.floor(Date.now() / 1000),
) => verifyFor('document-file', secret, subject, expires, signature, nowSeconds);

export const signImageDownload = (secret: string, subject: string, expires: number) =>
  signFor('imaging-image', secret, subject, expires);
export const verifyImageDownload = (
  secret: string,
  subject: string,
  expires: number,
  signature: string,
  nowSeconds = Math.floor(Date.now() / 1000),
) => verifyFor('imaging-image', secret, subject, expires, signature, nowSeconds);
