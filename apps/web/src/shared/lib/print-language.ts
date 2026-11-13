import type { i18n as I18n } from 'i18next';

/** The language of a printed document asked for in Hindi (#771). English stays the default. */
export const HINDI = 'hi';

/**
 * An i18next instance for one printed document, in `language`, over the same resources as the
 * app's. The namespaces the document reads are loaded first, so the sheet never suspends; a
 * language with no file for one of them falls back to English per key. The app's own language
 * is not changed.
 */
export async function printInstance(
  i18n: I18n,
  language: string,
  namespaces: readonly string[],
): Promise<I18n> {
  const clone = i18n.cloneInstance({ lng: language });
  await clone.changeLanguage(language);
  await clone.loadNamespaces([...namespaces]);
  return clone;
}
