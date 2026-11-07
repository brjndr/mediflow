import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { revokePermission, setTenantFeature, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { mockDrugsOf } from '@/mocks/handlers/drugs';
import {
  addMockSet,
  mockFavouritesOf,
  mockSetsOf,
  setMockFavourites,
} from '@/mocks/handlers/prescription-sets';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

vi.setConfig({ testTimeout: 30_000 });

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;

const medicine = (generic: string) => {
  const found = mockDrugsOf(HOSPITAL).find(
    (drug) => drug.type === 'medicine' && drug.genericName === generic,
  );
  if (!found) throw new Error(`No mock medicine ${generic}`);
  return found;
};

const open = async () => {
  renderApp({ entry: '/prescription-sets' });
  await screen.findByRole('heading', { name: 'Prescription sets and favourites', level: 1 });
};

/** The row action named for a set (a table or a card, whichever the width gives). */
const action = async (label: string, set: string) =>
  (
    await screen.findAllByRole('button', { name: new RegExp(`^${label}.*${set}`) })
  )[0] as HTMLElement;

describe('managing prescription sets', () => {
  it('renames a set and takes a medicine out of it', async () => {
    await open();
    await userEvent.click(await action('Edit', 'Common cold'));
    const dialog = await screen.findByRole('alertdialog');
    const name = within(dialog).getByRole('textbox', { name: /Name of the set/ });
    await userEvent.clear(name);
    await userEvent.type(name, 'Winter cold');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Remove Cetirizine/ }));
    // The last medicine stays.
    expect(within(dialog).getByText(/keeps at least one medicine/)).toBeInTheDocument();
    await expectNoAxeViolations();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Winter cold was saved.')).toBeInTheDocument();
    const saved = mockSetsOf(HOSPITAL).find((set) => set.name === 'Winter cold');
    expect(saved?.lineCount).toBe(1);
    expect(saved?.version).toBe(2);
  });

  it('refuses a name already used and keeps what was typed', async () => {
    signIn(USER_IDS.doctor, HOSPITAL);
    addMockSet({
      tenantId: HOSPITAL,
      name: 'Mine',
      ownerId: USER_IDS.doctor,
      lines: [
        { drugId: medicine('Paracetamol').id, dose: '1 g', route: 'oral', frequency: '1-0-1' },
      ],
    });
    await open();
    await userEvent.click(await action('Edit', 'Mine'));
    const dialog = await screen.findByRole('alertdialog');
    const name = within(dialog).getByRole('textbox', { name: /Name of the set/ });
    await userEvent.clear(name);
    await userEvent.type(name, 'common cold');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/already have a set/);
    expect(name).toHaveValue('common cold');
  });

  it('archives a set, lists it among the archived and restores it', async () => {
    await open();
    await userEvent.click(await action('Archive', 'Common cold'));
    expect(await screen.findByText('Common cold was archived.')).toBeInTheDocument();
    expect(mockSetsOf(HOSPITAL)[0]?.archived).toBe(true);

    await userEvent.click(screen.getByRole('checkbox', { name: 'Show archived sets' }));
    await userEvent.click(await action('Restore', 'Common cold'));
    expect(await screen.findByText('Common cold was restored.')).toBeInTheDocument();
    expect(mockSetsOf(HOSPITAL)[0]?.archived).toBe(false);
  });

  it('lets a doctor change their own set but not a shared one', async () => {
    signIn(USER_IDS.doctor, HOSPITAL);
    addMockSet({
      tenantId: HOSPITAL,
      name: 'Dr Own',
      ownerId: USER_IDS.doctor,
      lines: [
        { drugId: medicine('Paracetamol').id, dose: '1 g', route: 'oral', frequency: '1-0-1' },
      ],
    });
    await open();
    const shared = await action('Edit', 'Common cold');
    expect(shared).toHaveAttribute('aria-disabled', 'true');
    expect(await action('Edit', 'Dr Own')).not.toHaveAttribute('aria-disabled');
  });

  it('keeps each hospital’s sets to itself', async () => {
    signIn(USER_IDS.doctor, CLINIC);
    await open();
    expect(await screen.findByText(/No sets yet/)).toBeInTheDocument();
    expect(screen.queryByText('Common cold')).not.toBeInTheDocument();
  });

  it('offers no change without prescriptionSet:manage', async () => {
    revokePermission(HOSPITAL, 'admin', 'prescriptionSet:manage');
    await open();
    await screen.findAllByText('Common cold');
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Archive/ })).not.toBeInTheDocument();
  });

  it('is unreachable with the clinical module off', async () => {
    setTenantFeature(HOSPITAL, 'clinical', false);
    renderApp({ entry: '/prescription-sets' });
    expect(
      screen.queryByRole('heading', { name: 'Prescription sets and favourites' }),
    ).not.toBeInTheDocument();
  });
});

describe('managing favourite medicines', () => {
  it('removes a favourite from the list itself', async () => {
    const paracetamol = medicine('Paracetamol');
    const cetirizine = medicine('Cetirizine');
    setMockFavourites(HOSPITAL, USER_IDS.admin, [paracetamol.id, cetirizine.id]);
    await open();
    await userEvent.click(await screen.findByRole('button', { name: /^Remove Paracetamol/ }));
    expect(
      await screen.findByText(/Paracetamol.* is no longer one of your favourites/),
    ).toBeInTheDocument();
    expect(mockFavouritesOf(HOSPITAL, USER_IDS.admin)).toEqual([cetirizine.id]);
    expect(screen.queryByRole('button', { name: /^Remove Paracetamol/ })).not.toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('shows an empty list, and another hospital’s favourites never', async () => {
    setMockFavourites(CLINIC, USER_IDS.admin, [medicine('Paracetamol').id]);
    await open();
    expect(await screen.findByText(/No favourites yet/)).toBeInTheDocument();
  });
});
