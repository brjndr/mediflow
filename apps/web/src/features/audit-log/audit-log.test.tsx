import { screen, waitFor, within } from '@testing-library/react';
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
import { server } from '@/mocks/node';
import { startDownload } from '@/features/reports';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { daysIncluded, filterSchema, shiftDay } from './schemas';
import en from './locales/en.json';
import hi from './locales/hi.json';

// The browser's own download is not started in a test.
vi.mock('@/features/reports', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startDownload: vi.fn(),
}));

// The hospital's audit log (#1066): a search of who did what to which record, its filters and
// days, an export followed until ready, and who may see it.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const PAGE = { name: 'Audit log', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

afterEach(() => {
  server.events.removeAllListeners();
  vi.mocked(startDownload).mockClear();
});

const entries = () => screen.getByRole('table', { name: 'Entries' });
const bodyRows = () => within(entries()).getAllByRole('row').slice(1);

async function open() {
  renderApp({ entry: '/audit-log' });
  await screen.findByRole('heading', PAGE);
  await within(entries()).findByText('rec_1');
}

const leaves = (tree: unknown, prefix = ''): string[] =>
  typeof tree === 'string'
    ? [prefix]
    : Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) =>
        leaves(value, prefix ? `${prefix}.${key}` : key),
      );

describe('the filter days', () => {
  it('counts both ends and refuses a range past 92 days or backwards', () => {
    expect(daysIncluded('2026-11-01', '2026-11-01')).toBe(1);
    expect(shiftDay('2026-11-01', -1)).toBe('2026-10-31');
    const blank = { actorId: '', entity: '', entityId: '', action: '' };
    const ask = (from: string, to: string) =>
      filterSchema.safeParse({ from, to, ...blank }).success;
    expect(ask('2026-01-01', '2026-04-02')).toBe(true);
    expect(ask('2026-01-01', '2026-04-03')).toBe(false);
    expect(ask('2026-02-02', '2026-02-01')).toBe(false);
    expect(ask('2026-02-30', '2026-03-01')).toBe(false);
  });

  it('has the same Hindi strings as English, so no key shows raw', () => {
    expect(leaves(hi).sort()).toEqual(leaves(en).sort());
  });
});

describe('the audit log screen', () => {
  it('lists the entries newest first, by record id, a page at a time', async () => {
    await open();
    expect(bodyRows()).toHaveLength(50);
    expect(within(bodyRows()[0] as HTMLElement).getByText('Sample Admin')).toBeInTheDocument();
    expect(within(entries()).queryByText('rec_51')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /load more|show more/i }));
    expect(await within(entries()).findByText('rec_51')).toBeInTheDocument();
  });

  it('narrows the list by the filters', async () => {
    await open();
    await userEvent.type(screen.getByRole('textbox', { name: /^Kind of record/ }), 'invoice');
    await userEvent.type(screen.getByRole('textbox', { name: /^Action/ }), 'update');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(4));
    expect(within(entries()).getByText('rec_1')).toBeInTheDocument();
    expect(within(entries()).queryByText('rec_2')).toBeNull();
  });

  it('says so when nothing matches', async () => {
    await open();
    await userEvent.type(screen.getByRole('textbox', { name: /^Record id/ }), 'nothing-here');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No entries match these days and filters.')).toBeInTheDocument();
  });

  it('refuses a range of more than 92 days on the form, without asking the server', async () => {
    await open();
    const from = screen.getByLabelText(/^From/);
    await userEvent.clear(from);
    await userEvent.type(from, '2025-01-01');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('A search covers at most 92 days.')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    await open();
    await expectNoAxeViolations();
  });

  it('exports the days, follows the run and offers the download', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Export these days (CSV)' }));
    expect(await screen.findByText('The export is ready.', {}, { timeout: 8000 })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(1));
  }, 15_000);
});

describe('who may see it', () => {
  it('offers no export without auditLog:export', async () => {
    revokePermission(HOSPITAL, 'admin', 'auditLog:export');
    await open();
    expect(screen.queryByRole('button', { name: 'Export these days (CSV)' })).toBeNull();
  });

  it('leaves no trace without auditLog:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'auditLog:read');
    renderApp({ entry: '/audit-log' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit log' })).toBeNull();
  });

  it('is unreachable when the hospital has the module switched off', async () => {
    setTenantFeature(HOSPITAL, 'audit_log', false);
    renderApp({ entry: '/audit-log' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit log' })).toBeNull();
  });

  it('is in the navigation for a role that holds the permission', async () => {
    renderApp({ entry: '/' });
    expect(await screen.findByRole('link', { name: 'Audit log' })).toBeInTheDocument();
  });

  it('shows another hospital only its own entries, through a custom grant', async () => {
    setTenantFeature(CLINIC, 'audit_log', true);
    grantPermission(CLINIC, 'doctor', 'auditLog:read');
    signIn(USER_IDS.doctor, CLINIC);
    renderApp({ entry: '/audit-log' });
    await screen.findByRole('heading', PAGE);
    expect(await within(entries()).findByText('rec_clinic')).toBeInTheDocument();
    expect(within(entries()).queryByText('rec_1')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export these days (CSV)' })).toBeNull();
  });
});
