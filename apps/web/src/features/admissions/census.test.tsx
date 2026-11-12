import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { closeMockBedStreams, mockBedStreams } from '@/mocks/handlers/admissions';
import { revokePermission, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HEADING = { name: 'Inpatient census', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

const countOf = (status: string) =>
  Number(
    within(screen.getByText(status, { selector: 'dt' }).parentElement as HTMLElement).getByText(
      /^\d+$/,
    ).textContent,
  );

const openCensus = async () => {
  const app = renderApp({ entry: '/census' });
  await screen.findByRole('heading', HEADING);
  await screen.findByText(/usable beds occupied/);
  return app;
};

/**
 * Closes the screen's live stream before leaving it: a stream the browser aborts and the mock
 * closes afterwards trips an assertion in Node's fetch (undici, #740).
 */
const closeStreamBeforeLeaving = async () => {
  await waitFor(() => expect(mockBedStreams(TENANT_IDS.hospital)).toBe(1));
  closeMockBedStreams(TENANT_IDS.hospital);
};

describe('the inpatient census', () => {
  it('counts the beds by status and says how full the hospital is', async () => {
    await openCensus();
    const total = ['Available', 'Occupied', 'Being cleaned', 'Blocked'].reduce(
      (sum, status) => sum + countOf(status),
      0,
    );
    const usable = total - countOf('Blocked');
    expect(screen.getByText(new RegExp(`of ${usable} usable beds occupied`))).toBeInTheDocument();
    expect(await screen.findByText('Nobody is admitted.')).toBeInTheDocument();
    await expectNoAxeViolations();
  }, 20_000);

  it('matches the bed board: the occupied count is the board’s occupied beds', async () => {
    await openCensus();
    const occupied = countOf('Occupied');
    await closeStreamBeforeLeaving();
    await userEvent.click(
      within(screen.getByRole('main')).getByRole('link', { name: 'Bed board' }),
    );
    await screen.findByRole('heading', { name: 'Bed board', level: 1 });
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Status' }),
      'Occupied',
    );
    const grid = screen.getByRole('table', { name: 'Beds' });
    await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(occupied + 1));
  }, 20_000);

  it('narrows the counts to one ward', async () => {
    await openCensus();
    const all = countOf('Available');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Ward' }), [
      (await screen.findAllByRole('option'))[1] as HTMLOptionElement,
    ]);
    await waitFor(() => expect(countOf('Available')).toBeLessThanOrEqual(all));
  });

  it('is reached from the bed board', async () => {
    renderApp({ entry: '/beds' });
    const census = await screen.findByRole('link', { name: 'Census' });
    await closeStreamBeforeLeaving();
    await userEvent.click(census);
    expect(await screen.findByRole('heading', HEADING)).toBeInTheDocument();
  });
});

describe('access to the census', () => {
  it('is closed without admission:read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'admission:read');
    renderApp({ entry: '/census' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('is unreachable when the hospital has the module off', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'admissions', false);
    renderApp({ entry: '/census' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });
});
