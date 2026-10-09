/** Only https and same-origin logos are loaded. Anything else (data:, http:, javascript:) is not. */
export function safeLogoUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, window.location.origin);
    const allowed = parsed.protocol === 'https:' || parsed.origin === window.location.origin;
    return allowed ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
