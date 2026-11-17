import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TranslationTree } from '@/registry';

/**
 * Translations for a dashboard widget that travel inside the widget's own chunk, so the home page
 * does not ask for a locale file per widget (#735). The widget imports its `widget-strings.json`
 * statically and passes it here with a namespace of its own (`<feature>-widget`, never the
 * feature's id, whose file i18next loads whole the first time a screen of the feature renders).
 * A widget that has Hindi passes a loader for its `widget-strings.hi.json`, a dynamic import that
 * runs only when the language is Hindi, so nobody else downloads it (#969). Other languages, and
 * a widget without a loader, fall back to English, as for any missing key.
 */
export function useWidgetStrings(
  namespace: string,
  english: TranslationTree,
  loadHindi?: () => Promise<{ default: TranslationTree }>,
) {
  const { i18n } = useTranslation();
  const [, setLoaded] = useState(false);
  if (!i18n.hasResourceBundle('en', namespace)) {
    i18n.addResourceBundle('en', namespace, english);
  }
  const wantsHindi = Boolean(loadHindi) && i18n.language.split('-')[0] === 'hi';
  useEffect(() => {
    if (!wantsHindi || !loadHindi || i18n.hasResourceBundle('hi', namespace)) return;
    let live = true;
    void loadHindi().then((module) => {
      if (!i18n.hasResourceBundle('hi', namespace)) {
        i18n.addResourceBundle('hi', namespace, module.default);
      }
      if (live) setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [wantsHindi, loadHindi, i18n, namespace]);
  return useTranslation(namespace);
}
