import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/app/session';
import { useTenant } from '@/tenancy';
import { DEFAULT_LANGUAGE } from './i18n';

/**
 * Makes the UI language follow the signed-in person's own choice, then the active hospital's
 * locale, and goes back to the default when
 * there is none (the login page is generic). i18next maps a locale such as `hi-IN` to the `hi`
 * translations and falls back to English when a language has none.
 */
export function LanguageSync() {
  const { i18n } = useTranslation();
  const own = useSession()?.user.language ?? null;
  const hospital = useTenant()?.locale;
  const locale = own ?? hospital ?? DEFAULT_LANGUAGE;

  useEffect(() => {
    document.documentElement.lang = locale;
    if (i18n.language !== locale) void i18n.changeLanguage(locale);
  }, [i18n, locale]);

  return null;
}
