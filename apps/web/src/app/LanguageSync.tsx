import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTenant } from '@/tenancy';
import { DEFAULT_LANGUAGE } from './i18n';

/**
 * Makes the UI language follow the active hospital's locale, and goes back to the default when
 * there is none (the login page is generic). i18next maps a locale such as `hi-IN` to the `hi`
 * translations and falls back to English when a language has none.
 */
export function LanguageSync() {
  const { i18n } = useTranslation();
  const locale = useTenant()?.locale ?? DEFAULT_LANGUAGE;

  useEffect(() => {
    document.documentElement.lang = locale;
    if (i18n.language !== locale) void i18n.changeLanguage(locale);
  }, [i18n, locale]);

  return null;
}
