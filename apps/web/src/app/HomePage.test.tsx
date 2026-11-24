import { screen } from '@testing-library/react';
import { signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { renderWithProviders } from '@/test/render';
import { expectNoAxeViolations } from '@/test/axe';
import { HomePage } from './HomePage';

// 20:15 UTC on a Wednesday is already Thursday morning in India and in Dubai (#1123).
const setClock = (utc: string) => vi.useFakeTimers({ toFake: ['Date'], now: new Date(utc) });

describe('HomePage', () => {
  afterEach(() => vi.useRealTimers());

  it('greets with the part of the day and the date at the hospital, not in the browser', async () => {
    setClock('2026-10-14T20:15:00Z');
    signIn(USER_IDS.admin, TENANT_IDS.hospital);
    const { container } = renderWithProviders(<HomePage />);

    expect(await screen.findByText('Good morning')).toBeInTheDocument();
    const day = await screen.findByText(/^Thursday, 15 October,? 2026$/);
    expect(day).toHaveAttribute('dateTime', '2026-10-15');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Hospital management system' }),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('follows the clock of the hospital that is open', async () => {
    setClock('2026-10-14T13:30:00Z');
    signIn(USER_IDS.admin, TENANT_IDS.clinic);
    renderWithProviders(<HomePage />);

    // 17:30 in Dubai.
    expect(await screen.findByText('Good evening')).toBeInTheDocument();
    expect(await screen.findByText('Wednesday, 14 October 2026')).toBeInTheDocument();
  });

  it('no longer shows the API status line', async () => {
    renderWithProviders(<HomePage />);
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId('api-status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recheck' })).not.toBeInTheDocument();
  });
});
