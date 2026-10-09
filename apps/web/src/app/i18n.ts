import { createInstance, type BackendModule, type i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { FEATURE_TITLES_NS, type FeatureTranslations, type TranslationTree } from '@/registry';
import common from './locales/en/common.json';

export const DEFAULT_LANGUAGE = 'en';
const COMMON_NS = 'common';

type LocaleLoader = () => Promise<{ default: TranslationTree }>;

/** Core `common` translations by language. English is bundled; the others load on demand. */
export type CoreLocales = Record<string, LocaleLoader>;

const coreLocaleFiles = import.meta.glob<{ default: TranslationTree }>('./locales/*/common.json');

/** `./locales/hi/common.json` -> `hi` */
const defaultCoreLocales: CoreLocales = Object.fromEntries(
  Object.entries(coreLocaleFiles).flatMap(([path, load]) => {
    const language = path.split('/')[2];
    return language ? [[language, load]] : [];
  }),
);

interface I18nOptions {
  /** Titles and loaders of the registered features. Omit for an app with no feature strings. */
  features?: FeatureTranslations;
  /** Override the core locale files (tests add a language this way). */
  coreLocales?: CoreLocales;
  /** Called with `namespace:key` when a key has no translation in any language. */
  onMissingKey?: (key: string) => void;
}

/**
 * The app's i18next instance.
 *
 * - `common` holds core strings. English is bundled so the login page and shell paint at once.
 * - `features` holds each feature's titles, bundled with its manifest, for the nav and settings.
 * - Every feature has its own namespace (its id), loaded the first time one of its screens
 *   renders. Screens suspend while it loads; routes and slots already sit inside Suspense.
 *
 * The language follows the active hospital (see LanguageSync) and falls back to English, both
 * for a language with no translation and for a single missing key.
 */
export function createI18n({
  features = { titles: {}, loaders: {} },
  coreLocales = defaultCoreLocales,
  onMissingKey,
}: I18nOptions = {}): i18n {
  const languages = new Set([DEFAULT_LANGUAGE, ...Object.keys(coreLocales)]);

  const backend: BackendModule = {
    type: 'backend',
    init() {},
    read(language, namespace, callback) {
      const loadFeature = features.loaders[namespace];
      const load: LocaleLoader | undefined =
        namespace === COMMON_NS
          ? coreLocales[language]
          : loadFeature && (() => loadFeature(language));
      // No file for this language is not an error: the key falls back to English.
      if (!load) return callback(null, {});
      load().then(
        (module) => callback(null, module.default),
        () => callback(null, {}),
      );
    },
  };

  // Bundled up front: English core strings, and feature titles in every language they come in.
  const resources: Record<string, Record<string, TranslationTree>> = {
    [DEFAULT_LANGUAGE]: { [COMMON_NS]: common },
  };
  for (const [language, titles] of Object.entries(features.titles)) {
    resources[language] = { ...resources[language], [FEATURE_TITLES_NS]: titles };
    languages.add(language);
  }

  const instance = createInstance();
  void instance
    .use(backend)
    .use(initReactI18next)
    .init({
      lng: DEFAULT_LANGUAGE,
      fallbackLng: DEFAULT_LANGUAGE,
      // A hospital locale such as en-IN uses the `en` translations. Dates, numbers and money are
      // formatted separately with the full locale.
      supportedLngs: [...languages],
      nonExplicitSupportedLngs: true,
      load: 'languageOnly',
      ns: [COMMON_NS, FEATURE_TITLES_NS],
      defaultNS: COMMON_NS,
      resources,
      partialBundledLanguages: true,
      saveMissing: onMissingKey !== undefined,
      missingKeyHandler: (_languages, namespace, key) => onMissingKey?.(`${namespace}:${key}`),
      // React already escapes rendered values.
      interpolation: { escapeValue: false },
    });
  return instance;
}
