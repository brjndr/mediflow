import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Megaphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { setTenantLocale, signIn, signOut, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { createRegistry, type FeatureManifest, type TranslationTree } from '@/registry';
import { missingTranslationKeys, renderApp, renderWithProviders } from '@/test/render';
import type { CoreLocales } from './i18n';
import en from './locales/en/common.json';

const HOME_EN = 'Hospital management system';
const HOME_HI = 'अस्पताल प्रबंधन प्रणाली';

/** A partial Hindi translation of core, as a second locale file would provide. */
const withHindi: CoreLocales = {
  hi: () => Promise.resolve({ default: { home: { title: HOME_HI } } }),
};

const switchTo = (tenantId: string) =>
  userEvent.selectOptions(screen.getByRole('combobox', { name: 'Hospital' }), tenantId);

/** A feature with its own translations, as a manifest.ts would declare them. */
function makeNoticesFeature() {
  const screens: Record<string, TranslationTree> = {
    en: { heading: 'Staff notices', empty: 'No notices yet' },
    hi: { heading: 'कर्मचारी सूचनाएँ' },
  };
  const load = vi.fn((language: string) => {
    const strings = screens[language];
    return strings ? Promise.resolve({ default: strings }) : Promise.reject(new Error('no file'));
  });
  function NoticesPage() {
    const { t } = useTranslation('notices');
    return (
      <>
        <h1>{t('heading')}</h1>
        <p>{t('empty')}</p>
      </>
    );
  }
  const feature: FeatureManifest = {
    id: 'notices',
    titleKey: 'title',
    i18n: { titles: { en: { title: 'Notices' }, hi: { title: 'सूचनाएँ' } }, load },
    featureFlag: 'patients',
    routes: [
      {
        path: 'notices',
        lazy: () => Promise.resolve({ default: NoticesPage }),
        requires: ['patient:read'],
      },
    ],
    nav: { icon: Megaphone, order: 10, requires: ['patient:read'] },
    permissions: ['patient:read'],
  };
  return { feature, load };
}

describe('language from the hospital', () => {
  it('changes the UI language when the user switches to a hospital with another locale', async () => {
    setTenantLocale(TENANT_IDS.clinic, 'hi-IN');
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp({ coreLocales: withHindi });

    expect(await screen.findByRole('heading', { name: HOME_EN })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en-IN');

    await switchTo(TENANT_IDS.clinic);

    expect(await screen.findByRole('heading', { name: HOME_HI })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('hi-IN');
    // A string the Hindi file does not have falls back to English, key by key.
    expect(screen.getByRole('button', { name: 'Recheck' })).toBeInTheDocument();

    await switchTo(TENANT_IDS.hospital);
    expect(await screen.findByRole('heading', { name: HOME_EN })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en-IN');
  });

  it('falls back to English for a locale with no translation', async () => {
    setTenantLocale(TENANT_IDS.hospital, 'fr-FR');
    renderApp({ coreLocales: withHindi });
    expect(await screen.findByRole('heading', { name: HOME_EN })).toBeInTheDocument();
    // The document still declares the hospital's locale, which formatting uses.
    expect(document.documentElement.lang).toBe('fr-FR');
  });

  it('uses the default language when nobody is signed in', async () => {
    signOut();
    renderApp({ coreLocales: withHindi });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });
});

describe('feature translations', () => {
  it('bundles titles with the manifest and loads screen strings only when a screen opens', async () => {
    const { feature, load } = makeNoticesFeature();
    renderApp({ registry: createRegistry([feature]) });

    // The nav title is available at once, with nothing loaded.
    const link = await screen.findByRole('link', { name: 'Notices' });
    expect(load).not.toHaveBeenCalled();

    await userEvent.click(link);
    expect(await screen.findByRole('heading', { name: 'Staff notices' })).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith('en');
  });

  it('follows the hospital language, falling back to English per key', async () => {
    const { feature, load } = makeNoticesFeature();
    setTenantLocale(TENANT_IDS.hospital, 'hi-IN');
    renderApp({ registry: createRegistry([feature]), coreLocales: withHindi, entry: '/notices' });

    expect(await screen.findByRole('heading', { name: 'कर्मचारी सूचनाएँ' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'सूचनाएँ' })).toBeInTheDocument();
    expect(screen.getByText('No notices yet')).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith('hi');
  });

  it('falls back to English when the feature has no file for the language', async () => {
    const { feature } = makeNoticesFeature();
    setTenantLocale(TENANT_IDS.hospital, 'ta-IN');
    const tamilCore: CoreLocales = { ta: () => Promise.resolve({ default: {} }) };
    renderApp({ registry: createRegistry([feature]), coreLocales: tamilCore, entry: '/notices' });
    expect(await screen.findByRole('heading', { name: 'Staff notices' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Notices' })).toBeInTheDocument();
  });

  it('rejects a manifest with no English title or a reserved id', () => {
    const { feature } = makeNoticesFeature();
    const noEnglish = { ...feature, titleKey: 'heading' };
    expect(() => createRegistry([noEnglish])).toThrow(
      'has no English title for "heading" in i18n.titles',
    );
    expect(() => createRegistry([{ ...feature, id: 'common' }])).toThrow(
      'uses an id reserved as an i18n namespace',
    );
  });
});

describe('missing keys', () => {
  it('records a key that has no text in any language, which fails the test that used it', async () => {
    function Typo() {
      const { t } = useTranslation();
      return <p>{t('home.titel')}</p>;
    }
    renderWithProviders(<Typo />, { session: null });
    await screen.findByText('home.titel');
    await waitFor(() => expect(missingTranslationKeys).toContain('common:home.titel'));
    // Clear it so the shared check in test/setup.ts does not fail this test, which meant to.
    missingTranslationKeys.length = 0;
  });

  it('every literal key used in core source exists in the English file', () => {
    const sources = import.meta.glob<string>('/src/**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const has = (key: string) => {
      let node: unknown = en;
      for (const part of key.split('.')) {
        if (typeof node !== 'object' || node === null || !(part in node)) return false;
        node = (node as Record<string, unknown>)[part];
      }
      return typeof node === 'string';
    };

    const missing: string[] = [];
    let checked = 0;
    for (const [path, source] of Object.entries(sources)) {
      if (/\.test\.|\/test\/|\/mocks\//.test(path)) continue;
      // Screens with their own namespace are checked by their feature's tests.
      if (/useTranslation\(\s*['"]/.test(source)) continue;
      // Usage examples in comments are not code.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const [, key] of code.matchAll(/\bt\(\s*['"]([\w.-]+)['"]/g)) {
        if (!key) continue;
        checked++;
        if (!has(key)) missing.push(`${path}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
    // Guards the scan itself: if the pattern stops matching, this fails instead of passing empty.
    expect(checked).toBeGreaterThan(20);
  });
});
