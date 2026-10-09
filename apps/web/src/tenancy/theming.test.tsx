import { fireEvent, screen, waitFor } from '@testing-library/react';
import { plainSpaces } from '@/test/text';
import userEvent from '@testing-library/user-event';
import { sessionFor, signIn, signOut, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { contrastRatio, themeFromBrandColor } from '@/shared/lib/theme';
import { renderApp, renderWithProviders } from '@/test/render';
import { http, HttpResponse } from 'msw';
import { useFormatters } from '.';
import { safeLogoUrl } from './logo-url';

const cssVar = (name: string) => document.documentElement.style.getPropertyValue(name);
const home = () => screen.findByRole('heading', { name: 'Hospital management system' });
const switchTo = (tenantId: string) =>
  userEvent.selectOptions(screen.getByRole('combobox', { name: 'Hospital' }), tenantId);
const plain = plainSpaces;

/** A screen that shows values the way any feature would, through the tenant formatters. */
function Sample() {
  const format = useFormatters();
  return (
    <dl>
      <dd data-testid="date">{format.dateTime('2026-10-14T20:15:00Z')}</dd>
      <dd data-testid="number">{format.number(1234567.5)}</dd>
      <dd data-testid="money">{format.money(12345678)}</dd>
    </dl>
  );
}
const shown = (id: string) => plain(screen.getByTestId(id).textContent);

/** Serves a session whose active hospital has the given theme. */
function withTheme(theme: { primary: string; logoUrl?: string }) {
  const session = sessionFor(USER_IDS.admin);
  server.use(
    http.get('*/api/session', () =>
      HttpResponse.json({ ...session, activeTenant: { ...session.activeTenant, theme } }),
    ),
  );
}

describe('two hospitals', () => {
  it('look different: each applies its own colour, and none is left behind', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    renderApp();
    await home();
    expect(cssVar('--primary')).toBe('#0f766e');
    expect(cssVar('--ring')).toBe('#0f766e');
    expect(cssVar('--primary-foreground')).toBe('#ffffff');
    // No logo at the hospital: the product name stands in.
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    await switchTo(TENANT_IDS.clinic);
    await waitFor(() => expect(cssVar('--primary')).toBe('#4338ca'));
    expect(cssVar('--ring')).toBe('#4338ca');
    // The clinic has a logo, named after the hospital for screen readers.
    expect(screen.getAllByRole('img', { name: 'Riverside Clinic' })[0]).toHaveAttribute(
      'src',
      expect.stringMatching(/\/favicon\.svg$/),
    );

    await switchTo(TENANT_IDS.hospital);
    await waitFor(() => expect(cssVar('--primary')).toBe('#0f766e'));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('format differently: the same values follow each hospital’s locale, timezone and currency', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const { unmount } = renderWithProviders(<Sample />);
    await screen.findByTestId('date');
    expect(shown('date')).toBe('15 Oct 2026, 1:45 am');
    expect(shown('number')).toBe('12,34,567.5');
    expect(shown('money')).toBe('₹1,23,456.78');
    unmount();

    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderWithProviders(<Sample />);
    await screen.findByTestId('date');
    expect(shown('date')).toBe('15 Oct 2026, 00:15');
    expect(shown('number')).toBe('1,234,567.5');
    expect(shown('money')).toBe('AED 123,456.78');
  });

  it('show notice dates on each hospital’s own clock', async () => {
    renderApp({ entry: '/notices' });
    // 04:30 UTC is 10:00 in Kolkata.
    expect(await screen.findByText(/Posted 1 Oct 2026, 10:00/)).toBeInTheDocument();
  });
});

describe('theme', () => {
  it('is removed when nobody is signed in, so the login page is generic', async () => {
    const app = renderApp();
    await home();
    expect(cssVar('--primary')).toBe('#0f766e');
    app.unmount();
    expect(cssVar('--primary')).toBe('');

    signOut();
    renderApp();
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(cssVar('--primary')).toBe('');
    expect(cssVar('--primary-foreground')).toBe('');
  });

  it('puts black text on a colour where white would be hard to read', async () => {
    // Mid orange: readable as text on white (just), but white on it is weaker than black on it.
    withTheme({ primary: '#a35200' });
    renderApp();
    await home();
    expect(cssVar('--primary')).toBe('#a35200');
    expect(themeFromBrandColor('#767676')).toMatchObject({ 'primary-foreground': '#000000' });
    expect(themeFromBrandColor('#0f766e')).toMatchObject({ 'primary-foreground': '#ffffff' });
  });

  it.each([
    ['too pale to read as text', '#fde047'],
    ['not a hex colour', 'oklch(0.5 0.15 265)'],
    ['a three-digit shorthand', '#07c'],
    ['an attempt to inject CSS', '#000000; background: url(https://evil.test)'],
  ])('keeps the default theme when the colour is %s', async (_reason, primary) => {
    withTheme({ primary });
    renderApp();
    await home();
    expect(cssVar('--primary')).toBe('');
    expect(cssVar('--ring')).toBe('');
    expect(themeFromBrandColor(primary)).toBeNull();
  });

  it('measures contrast the WCAG way', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
    expect(contrastRatio('red', '#ffffff')).toBeUndefined();
  });
});

describe('logo', () => {
  it('falls back to the product name when the image fails to load', async () => {
    withTheme({ primary: '#0f766e', logoUrl: 'https://cdn.example.test/missing.svg' });
    renderApp();
    await home();
    const [logo] = screen.getAllByRole('img', { name: 'Sample Hospital' });
    if (!logo) throw new Error('logo not rendered');
    expect(screen.getByRole('banner')).not.toHaveTextContent('Mediflow');

    fireEvent.error(logo);
    fireEvent.error(screen.getByRole('img', { name: 'Sample Hospital' }));

    await waitFor(() => expect(screen.queryByRole('img')).not.toBeInTheDocument());
    expect(screen.getByRole('banner')).toHaveTextContent('Mediflow');
  });

  it.each([
    'data:image/svg+xml,<svg onload=alert(1)>',
    'javascript:alert(1)',
    'http://insecure.example.test/logo.svg',
  ])('ignores an unsafe logo URL (%s)', async (logoUrl) => {
    withTheme({ primary: '#0f766e', logoUrl });
    renderApp();
    await home();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(safeLogoUrl(logoUrl)).toBeUndefined();
  });

  it('accepts https and same-origin URLs', () => {
    expect(safeLogoUrl('https://cdn.example.test/logo.svg')).toBe(
      'https://cdn.example.test/logo.svg',
    );
    expect(safeLogoUrl('/logos/a.svg')).toBe(`${window.location.origin}/logos/a.svg`);
    expect(safeLogoUrl(undefined)).toBeUndefined();
  });
});
