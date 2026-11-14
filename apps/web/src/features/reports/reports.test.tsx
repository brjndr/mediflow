import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import {
  setMockReportBusy,
  setMockReportFailure,
  setMockReportQuota,
} from '@/mocks/handlers/reports';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { startDownload } from './download';
import { pollDelay } from './hooks/use-reports';
import { daysIncluded, requestSchema, shiftDay } from './schemas';

// The browser's own download is not started in a test.
vi.mock('./download', () => ({ startDownload: vi.fn(), downloadAddress: (url: string) => url }));

// Reports (#121): a report shown on the spot, or exported as a stored run that is followed until
// it ends and then downloaded by a signed link. The mock's hospital has two earlier runs (a
// revenue report that succeeded and a laboratory one that failed); the clinic has one stock run.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const PAGE = { name: 'Reports', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
const SLOW = { timeout: 5000 };

afterEach(() => {
  server.events.removeAllListeners();
  vi.mocked(startDownload).mockClear();
});

const runs = () => screen.getByRole('table', { name: 'Exports' });
const status = () => screen.getByRole('status');

async function open() {
  renderApp({ entry: '/reports' });
  await screen.findByRole('heading', PAGE);
  await within(runs()).findByText('Revenue and collections');
}

describe('the days of a report', () => {
  it('counts both ends', () => {
    expect(daysIncluded('2026-11-01', '2026-11-01')).toBe(1);
    expect(daysIncluded('2026-11-01', '2026-11-07')).toBe(7);
    expect(shiftDay('2026-11-01', -1)).toBe('2026-10-31');
  });

  it('asks for days of every report but a snapshot, in order and within a year', () => {
    const ask = (values: object) => requestSchema.safeParse(values).success;
    expect(ask({ kind: 'stock', from: '', to: '' })).toBe(true);
    expect(ask({ kind: 'revenue', from: '2026-11-01', to: '2026-11-07' })).toBe(true);
    expect(ask({ kind: 'revenue', from: '', to: '2026-11-07' })).toBe(false);
    expect(ask({ kind: 'revenue', from: '2026-11-07', to: '2026-11-01' })).toBe(false);
    expect(ask({ kind: 'revenue', from: '2026-02-30', to: '2026-03-01' })).toBe(false);
    expect(ask({ kind: 'revenue', from: '2026-01-01', to: '2027-01-01' })).toBe(true);
    expect(ask({ kind: 'revenue', from: '2026-01-01', to: '2027-01-02' })).toBe(false);
  });

  it('asks about a working job soon at first and less often later, never past 15 seconds', () => {
    expect([0, 1, 2, 3].map(pollDelay)).toEqual([1000, 2000, 4000, 8000]);
    expect(pollDelay(4)).toBe(15_000);
    expect(pollDelay(20)).toBe(15_000);
  });
});

describe('showing a report now', () => {
  it('shows the table with its totals line and says so', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));

    const table = await screen.findByRole('table', { name: 'OPD census' });
    expect(within(table).getAllByText('General Medicine').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('Total').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('95').length).toBeGreaterThan(0);
    expect(await screen.findByText('Report shown, 3 lines.')).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('shows money in the hospital’s currency from minor units, and minutes in words', async () => {
    await open();
    await userEvent.selectOptions(screen.getByLabelText(/^Report/), 'revenue');
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    const revenue = await screen.findByRole('table', { name: 'Revenue and collections' });
    // 1,250,000 paise.
    expect(within(revenue).getByText(/12,500\.00/)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/^Report/), 'lab_turnaround');
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    const lab = await screen.findByRole('table', { name: 'Laboratory turnaround' });
    expect(within(lab).getByText('48 minutes')).toBeInTheDocument();
  });

  it('shows doctor-wise activity and pharmacy sales with their own columns', async () => {
    await open();
    await userEvent.selectOptions(screen.getByLabelText(/^Report/), 'doctor_activity');
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    const doctors = await screen.findByRole('table', { name: 'Doctor-wise activity' });
    expect(within(doctors).getByText('Dr Asha Rao')).toBeInTheDocument();
    expect(within(doctors).getByText('No-shows')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/^Report/), 'pharmacy_sales');
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    const sales = await screen.findByRole('table', { name: 'Pharmacy sales' });
    // 185,000 paise sold on the first day.
    expect(within(sales).getByText(/1,850.00/)).toBeInTheDocument();
  });

  it('shows collections with the payment method in words, and outstanding invoices by age', async () => {
    await open();
    await userEvent.selectOptions(screen.getByLabelText(/^Report/), 'collections');
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    const money = await screen.findByRole('table', { name: 'Collections by payment method' });
    expect(within(money).getByText('Cash')).toBeInTheDocument();
    expect(within(money).getByText('UPI')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/^Report/), 'outstanding');
    expect(screen.queryByLabelText(/^From/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    const owed = await screen.findByRole('table', { name: 'Outstanding invoices' });
    expect(within(owed).getByText('Over 30 days')).toBeInTheDocument();
  });

  it('takes no days for a snapshot', async () => {
    await open();
    await userEvent.selectOptions(screen.getByLabelText(/^Report/), 'stock');
    expect(screen.queryByLabelText(/^From/)).toBeNull();
    expect(screen.getByText(/takes no days/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    expect(await screen.findByRole('table', { name: 'Stock on hand' })).toBeInTheDocument();
  });

  it('refuses more than 31 days to show and points to the export, without asking the server', async () => {
    const sent: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST') sent.push(request.url);
    });
    await open();
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-03-01' } });
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    expect(
      await screen.findByText('Showing a report covers at most 31 days. Use Export for longer.'),
    ).toBeInTheDocument();
    expect(sent).toEqual([]);
  });

  it('refuses days the wrong way round on the form and focuses the field', async () => {
    await open();
    const to = screen.getByLabelText(/^To/);
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2026-03-01' } });
    fireEvent.change(to, { target: { value: '2026-01-01' } });
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    expect(await screen.findByText('The last day cannot be before the first.')).toBeInTheDocument();
    expect(to).toHaveFocus();
  });

  it('tells how long to wait when a report is already being worked out', async () => {
    setMockReportBusy(true);
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    expect(
      await screen.findByText('A report is already being worked out. Try again in 5 seconds.'),
    ).toBeInTheDocument();
  });
});

describe('exporting a report', () => {
  it(
    'follows the run until it is ready without blocking, then downloads it by a signed link',
    { timeout: 15_000 },
    async () => {
      const start = vi.mocked(startDownload);
      await open();
      await userEvent.selectOptions(screen.getByLabelText(/^Report/), 'revenue');
      await userEvent.click(screen.getByRole('button', { name: 'Export' }));

      // The page stays usable while the job works.
      expect(await screen.findByText(/^Export requested/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show report' })).toBeEnabled();
      expect(
        await screen.findByText('The export is ready. Download it from the list below.', {}, SLOW),
      ).toBeInTheDocument();
      // Its result is shown, and the list says it is ready.
      expect(
        await screen.findByRole('table', { name: 'Revenue and collections' }),
      ).toBeInTheDocument();
      await waitFor(() => expect(within(runs()).getAllByText('Ready')).toHaveLength(2));

      await userEvent.click(
        within(runs()).getAllByRole('button', { name: /^Download CSV/ })[0] as HTMLElement,
      );
      await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      const [url] = start.mock.calls[0] as [string];
      expect(url).toMatch(/^\/report-files\/rep_h_\d+\?expires=\d+&signature=/);
      expect(await screen.findByText('Download started.')).toBeInTheDocument();
    },
  );

  it('says in words that an export failed, and why', { timeout: 15_000 }, async () => {
    setMockReportFailure('timeout');
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(
      await screen.findByText(
        'The export failed. It took too long. Ask again for fewer days.',
        {},
        SLOW,
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(within(runs()).getAllByText('Failed').length).toBeGreaterThan(1));
  });

  it('sends a repeat of a refused request with the same key, so it is done once', async () => {
    const keys: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/runs')) {
        keys.push(request.headers.get('Idempotency-Key') ?? '');
      }
    });
    setMockReportQuota(true);
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByText(/^Your hospital has asked for as many exports/);
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).toHaveLength(36);
    expect(keys[1]).toBe(keys[0]);
  });
  it('says when to try again after the hospital’s quota is used up', async () => {
    setMockReportQuota(true);
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(
      await screen.findByText(
        'Your hospital has asked for as many exports as it may for now. Try again in 60 minutes.',
      ),
    ).toBeInTheDocument();
  });

  it('opens a finished run from the list without announcing it', async () => {
    await open();
    const view = within(runs()).getAllByRole('button', { name: /^View/ })[0] as HTMLElement;
    await userEvent.click(view);
    expect(
      await screen.findByRole('table', { name: 'Revenue and collections' }),
    ).toBeInTheDocument();
    expect(status()).toHaveTextContent('');
  });

  it('shows the quota the hospital has used', async () => {
    await open();
    expect(
      await screen.findByText(/^Exports: 0 of 2 at a time, 2 of 50 today\. Kept for 30 days\./),
    ).toBeInTheDocument();
  });
});

describe('who may do what', () => {
  it('shows a report but offers no export or download without report:export', async () => {
    revokePermission(HOSPITAL, 'admin', 'report:export');
    await open();
    expect(screen.getByRole('button', { name: 'Show report' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
    expect(within(runs()).queryByRole('button', { name: /^Download CSV/ })).toBeNull();
    expect(within(runs()).getAllByRole('button', { name: /^View/ }).length).toBeGreaterThan(0);
  });

  it('leaves no trace without report:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'report:read');
    renderApp({ entry: '/reports' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Reports' })).toBeNull();
  });

  it('is unreachable when the hospital has the module switched off', async () => {
    setTenantFeature(HOSPITAL, 'reports', false);
    renderApp({ entry: '/reports' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Reports' })).toBeNull();
  });

  it('is in the navigation for a role that holds the permission', async () => {
    renderApp({ entry: '/' });
    expect(await screen.findByRole('link', { name: 'Reports' })).toBeInTheDocument();
  });

  it('serves a custom grant at another hospital with only its own exports', async () => {
    setTenantFeature(CLINIC, 'reports', true);
    grantPermission(CLINIC, 'doctor', 'report:read');
    grantPermission(CLINIC, 'doctor', 'report:export');
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/reports' });
    await screen.findByRole('heading', PAGE);
    expect(await within(runs()).findByText('Stock on hand')).toBeInTheDocument();
    expect(within(runs()).queryByText('Revenue and collections')).toBeNull();
    expect(within(runs()).queryByText('Laboratory turnaround')).toBeNull();
  });
});

describe('the invoices behind an age band', () => {
  async function showOutstanding() {
    await open();
    await userEvent.selectOptions(screen.getByLabelText(/^Report/), 'outstanding');
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    return screen.findByRole('table', { name: 'Outstanding invoices' });
  }

  it('opens a band to its invoices, a page at a time, with no patient', async () => {
    const owed = await showOutstanding();
    const row = within(owed).getByText('0 to 7 days').closest('tr');
    await userEvent.click(
      within(row as HTMLElement).getByRole('button', { name: /Show invoices/ }),
    );

    const list = await screen.findByRole('table', {
      name: 'Invoices outstanding: 0 to 7 days',
    });
    await within(list).findByText('INV/days_0_7/001');
    expect(within(list).queryByText('INV/days_0_7/026')).toBeNull();
    expect(within(list).queryByText(/patient/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /load more|show more/i }));
    expect(await within(list).findByText('INV/days_0_7/026')).toBeInTheDocument();
  });

  it('shows only the hospital’s own invoices', async () => {
    setTenantFeature(CLINIC, 'reports', true);
    grantPermission(CLINIC, 'doctor', 'report:read');
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/reports' });
    await screen.findByRole('heading', PAGE);
    await userEvent.selectOptions(screen.getByLabelText(/^Report/), 'outstanding');
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }));
    const owed = await screen.findByRole('table', { name: 'Outstanding invoices' });
    const row = within(owed).getByText('Over 30 days').closest('tr');
    await userEvent.click(
      within(row as HTMLElement).getByRole('button', { name: /Show invoices/ }),
    );

    const list = await screen.findByRole('table', { name: 'Invoices outstanding: Over 30 days' });
    expect(await within(list).findByText('CL/over_30/001')).toBeInTheDocument();
    expect(within(list).queryByText(/^INV\//)).toBeNull();
  });
});
