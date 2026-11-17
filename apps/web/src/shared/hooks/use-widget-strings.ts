import { useTranslation } from 'react-i18next';
import type { TranslationTree } from '@/registry';

/**
 * Translations for a dashboard widget that travel inside the widget's own chunk, so the home page
 * does not ask for a locale file per widget (#735). The widget imports its `widget-strings.json`
 * statically and passes it here with a namespace of its own (`<feature>-widget`, never the
 * feature's id, whose file i18next loads whole the first time a screen of the feature renders).
 * A widget that has Hindi passes its `widget-strings.hi.json` as the third argument (#969); other
 * languages, and a widget without one, fall back to English, as for any missing key.
 */
export function useWidgetStrings(
  namespace: string,
  english: TranslationTree,
  hindi?: TranslationTree,
) {
  const { i18n } = useTranslation();
  if (!i18n.hasResourceBundle('en', namespace)) {
    i18n.addResourceBundle('en', namespace, english);
  }
  if (hindi && !i18n.hasResourceBundle('hi', namespace)) {
    i18n.addResourceBundle('hi', namespace, hindi);
  }
  return useTranslation(namespace);
}
