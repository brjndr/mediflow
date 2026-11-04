import type { TFunction } from 'i18next';
import { errorMessageKey, isApiError } from '@/shared/api';

/** Codes the reporting API gives that say what to do next, not only that something failed. */
const KNOWN = [
  'range_too_long',
  'report_too_large',
  'report_timeout',
  'report_busy',
  'report_quota',
  'report_not_ready',
] as const;

/**
 * The words for a refused or failed request: the API's own code when the module has a sentence
 * for it (and how long to wait, when it said), otherwise the general sentence for the kind of
 * error. The server's text is never shown.
 */
export function reportErrorText(error: unknown, t: TFunction, tCommon: TFunction): string {
  if (isApiError(error) && error.serverCode !== undefined) {
    const code = KNOWN.find((known) => known === error.serverCode);
    if (code) {
      const seconds = error.retryAfterMs === undefined ? 0 : Math.ceil(error.retryAfterMs / 1000);
      return t(`errors.${code}`, { seconds, minutes: Math.ceil(seconds / 60) });
    }
  }
  return tCommon(errorMessageKey(error));
}
