import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { contrastRatio, themeFromBrandColor } from '@/shared/lib/theme';
import { expectNoAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';
import { CategoryBarChart, TimeSeriesChart, type ChartPoint } from '.';

const data: ChartPoint[] = [
  { label: 'Mon', value: 12 },
  { label: 'Tue', value: 1834 },
  { label: 'Wed', value: 7 },
];

const common = {
  title: 'Appointments per day',
  labelHeader: 'Day',
  valueHeader: 'Appointments',
  data,
};

describe('charts', () => {
  beforeEach(() => {
    // jsdom has no layout engine. The chart library only needs the observer to exist.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['time series', TimeSeriesChart],
    ['bar', CategoryBarChart],
  ])('%s: gives the same numbers as a table for assistive technology', async (_kind, Chart) => {
    renderWithProviders(<Chart {...common} formatValue={(value) => `${value} visits`} />, {
      session: null,
    });
    const table = await screen.findByRole('table', { name: 'Appointments per day' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Day', 'Appointments']);
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Mon', 'Tue', 'Wed']);
    // Values go through the formatter the screen supplies (the hospital's number format).
    expect(
      within(table)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['12 visits', '1834 visits', '7 visits']);
  });

  it('is a figure named by its title and a one-line summary', async () => {
    renderWithProviders(
      <main>
        <TimeSeriesChart {...common} formatValue={(value) => `${value} visits`} />
      </main>,
      { session: null },
    );
    // Said without a summary from the screen: how many, the highest and the lowest.
    expect(
      await screen.findByRole('figure', {
        name: 'Appointments per day. 3 values. Highest: Tue, 1834 visits. Lowest: Wed, 7 visits.',
      }),
    ).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('says the screen’s own summary when it gives one, and that there is nothing when empty', async () => {
    const first = renderWithProviders(
      <CategoryBarChart {...common} summary="Busiest on Tuesday." />,
      { session: null },
    );
    expect(
      await screen.findByRole('figure', { name: 'Appointments per day. Busiest on Tuesday.' }),
    ).toBeInTheDocument();
    first.unmount();

    renderWithProviders(<CategoryBarChart {...common} data={[]} />, { session: null });
    expect(
      await screen.findByRole('figure', { name: 'Appointments per day. No values to show.' }),
    ).toBeInTheDocument();
  });

  it('shows the numbers as a table on screen when asked, from the keyboard', async () => {
    const { container } = renderWithProviders(<CategoryBarChart {...common} />, {
      session: null,
    });
    const table = await screen.findByRole('table', { name: 'Appointments per day' });
    expect(table).toHaveClass('sr-only');
    const toggle = screen.getByRole('button', { name: 'Show as table' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    toggle.focus();
    await userEvent.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // The same table, now for everyone, in place of the picture.
    expect(screen.getByRole('table', { name: 'Appointments per day' })).not.toHaveClass('sr-only');
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(toggle).toHaveFocus();

    await userEvent.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('table', { name: 'Appointments per day' })).toHaveClass('sr-only');
  });

  it('draws in a colour that stands out 3:1 against the page, whatever the hospital’s brand', () => {
    // The series uses the primary token. A hospital's colour is taken only when it reads as text
    // on white (4.5:1), which is more than the 3:1 a chart's marks need.
    for (const brand of ['#0b5394', '#7a1f5c', '#2e7d32', '#ffcc00', '#9e9e9e']) {
      const theme = themeFromBrandColor(brand);
      if (theme) expect(contrastRatio(theme.primary!, '#ffffff')).toBeGreaterThanOrEqual(3);
    }
    expect(themeFromBrandColor('#ffcc00')).toBeNull();
  });

  it('hides the picture itself from assistive technology', async () => {
    const { container } = renderWithProviders(<TimeSeriesChart {...common} />, { session: null });
    await screen.findByRole('table', { name: 'Appointments per day' });
    const picture = container.querySelector('figure > div[aria-hidden]');
    expect(picture).toHaveAttribute('aria-hidden', 'true');
  });

  it('takes its height from the caller', async () => {
    const { container } = renderWithProviders(<CategoryBarChart {...common} height={320} />, {
      session: null,
    });
    await screen.findByRole('table');
    expect(container.querySelector('figure > div[aria-hidden]')).toHaveStyle({ height: '320px' });
  });

  it('uses theme tokens, never fixed colours', async () => {
    // Read from the source: a hex or rgb colour in the chart module would not follow a
    // hospital's theme.
    const source = (await import('./charts?raw')).default as string;
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
    expect(source).toContain('var(--primary)');
  });
});
