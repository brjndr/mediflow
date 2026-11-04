import { env } from '@/shared/config/env';

/**
 * The address a signed link opens at. The API gives a path on itself (`/report-files/...`), so it
 * is resolved against the API's own base, whatever that is in this environment.
 */
export function downloadAddress(url: string): string {
  // A link to object storage (later) is an https address. Any other absolute address is not
  // trusted to be where a signed link goes, and is read as a path on the API.
  if (/^https:\/\//i.test(url)) return url;
  const path = url.replace(/^[a-z][a-z0-9+.-]*:\/*/i, '/').replace(/^\/+/, '/');
  const base = env.apiBaseUrl.replace(/\/+$/, '');
  return new URL(`${base}${path.startsWith('/') ? '' : '/'}${path}`, window.location.origin).href;
}

/**
 * Starts the browser's own download of a signed link. The link is the credential and lasts a few
 * minutes, so it is used at once and kept nowhere: not in the cache, a log or the page.
 */
export function startDownload(url: string): void {
  const link = document.createElement('a');
  link.href = downloadAddress(url);
  link.rel = 'noopener';
  // A file is saved, never navigated to: the page and what is on it stay where they are.
  link.download = '';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
}
