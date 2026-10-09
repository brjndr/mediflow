import { screen, within } from '@testing-library/react';
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

  it('hides the picture itself from assistive technology', async () => {
    const { container } = renderWithProviders(<TimeSeriesChart {...common} />, { session: null });
    await screen.findByRole('table', { name: 'Appointments per day' });
    const picture = container.querySelector('figure > div');
    expect(picture).toHaveAttribute('aria-hidden', 'true');
  });

  it('takes its height from the caller', async () => {
    const { container } = renderWithProviders(<CategoryBarChart {...common} height={320} />, {
      session: null,
    });
    await screen.findByRole('table');
    expect(container.querySelector('figure > div')).toHaveStyle({ height: '320px' });
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
