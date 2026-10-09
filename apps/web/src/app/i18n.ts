import { createInstance, type i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import common from './locales/en/common.json';

export const DEFAULT_LANGUAGE = 'en';

/**
 * Minimal i18n: one bundled `common` namespace in English. F-09 adds per-feature namespaces loaded
 * on demand and the language from tenant config.
 */
export function createI18n(): i18n {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    defaultNS: 'common',
    resources: { [DEFAULT_LANGUAGE]: { common } },
    // React already escapes rendered values.
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return instance;
}
