import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { mockDrugsOf } from '@/mocks/handlers/drugs';
import { addMockSet, mockSetsOf, setMockFavourites } from '@/mocks/handlers/prescription-sets';
import { editMockAllergies } from '@/mocks/handlers/triage';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// A dense form under jsdom, with axe and the keyboard, is slow on a small machine.
vi.setConfig({ testTimeout: 30_000 });

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;

const medicine = (tenantId: string, generic: string) => {
  const found = mockDrugsOf(tenantId).find(
    (drug) => drug.type === 'medicine' && drug.genericName === generic,
  );
  if (!found) throw new Error(`No mock medicine ${generic}`);
  return found;
};

const line = (number: number) =>
  screen.getByRole('group', { name: `Medicine ${number}` }) as HTMLElement;

/** Opens a consultation and a new prescription, and waits for its first line. */
async function startWriting(id = 'enc_h_1') {
  renderApp({ entry: `/encounters/${id}` });
  await screen.findByRole('heading', { name: 'Consultation', level: 1 });
  const section = (await screen.findByRole('heading', { name: 'Prescriptions', level: 2 })).closest(
    'section',
  ) as HTMLElement;
  await userEvent.click(
    await within(section).findByRole('button', { name: 'Write a prescription' }),
  );
  await screen.findByRole('group', { name: 'Medicine 1' });
}

const loadSet = async (name: RegExp | string) => {
  await userEvent.click(screen.getByRole('button', { name: 'Load a set' }));
  await userEvent.click(await screen.findByRole('button', { name }));
};

describe('loading a prescription set', () => {
  it('adds the lines of a shared set, checked like any others, and says how many', async () => {
    editMockAllergies(HOSPITAL, 'pth_00001', [
      { substance: 'Paracetamol', reaction: 'Rash', severity: 'severe' },
    ]);
    await startWriting();

    await loadSet(/Common cold/);

    expect(await screen.findByText(/2 medicines from Common cold were added/)).toBeInTheDocument();
    // The empty first line made room: two lines, no third.
    expect(within(line(1)).getByText(/^Paracetamol/)).toBeInTheDocument();
    expect(within(line(2)).getByText(/^Cetirizine/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Medicine 3' })).not.toBeInTheDocument();
    expect(within(line(1)).getByRole('textbox', { name: /^Dose/ })).toHaveValue('500 mg');
    // Still checked for allergies.
    expect(
      within(line(1)).getByText(/The patient is recorded as allergic to Paracetamol\./),
    ).toBeInTheDocument();
    // Loading wrote nothing: the prescription is written, and checked, by the doctor.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load a set' })).toHaveFocus());
    await expectNoAxeViolations();
  });

  it('adds to what the form holds, up to 30 lines, and says what was left out', async () => {
    const paracetamol = medicine(HOSPITAL, 'Paracetamol');
    addMockSet({
      tenantId: HOSPITAL,
      name: 'Thirty',
      ownerId: null,
      lines: Array.from({ length: 29 }, () => ({
        drugId: paracetamol.id,
        dose: '500 mg',
        route: 'oral' as const,
        frequency: '1-0-1',
      })),
    });
    await startWriting();
    await loadSet(/Thirty/);
    await screen.findByText(/29 medicines from Thirty were added/);

    await loadSet(/Common cold/);

    expect(
      await screen.findByText(
        /1 medicine from Common cold was added..* 1 was left out: a prescription holds at most 30 medicines\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Medicine 30' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Medicine 31' })).not.toBeInTheDocument();
  }, 60_000);

  it('works from the keyboard alone', async () => {
    await startWriting();
    const open = screen.getByRole('button', { name: 'Load a set' });
    open.focus();
    await userEvent.keyboard('{Enter}');
    expect(open).toHaveAttribute('aria-expanded', 'true');
    // Past "Save as a set", to the first set.
    await userEvent.tab();
    await userEvent.tab();
    await waitFor(() => expect(screen.getByRole('button', { name: /Common cold/ })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText(/2 medicines from Common cold were added/)).toBeInTheDocument();
    await waitFor(() => expect(open).toHaveFocus());
  });

  it('leaves out a medicine archived since, and says so', async () => {
    const paracetamol = medicine(HOSPITAL, 'Paracetamol');
    addMockSet({
      tenantId: HOSPITAL,
      name: 'Old and new',
      ownerId: null,
      lines: [
        { drugId: 'drg_h_old', dose: '5 ml', route: 'oral', frequency: '1-0-1' },
        { drugId: paracetamol.id, dose: '500 mg', route: 'oral', frequency: '1-0-1' },
      ],
    });
    await startWriting();
    await loadSet(/Old and new/);
    expect(
      await screen.findByText(
        /1 medicine from Old and new was added..* 1 was left out: the medicine is archived\./,
      ),
    ).toBeInTheDocument();
  });

  it('shows the hospital its own sets only, and a doctor their own', async () => {
    addMockSet({
      tenantId: HOSPITAL,
      name: 'Dr Own',
      ownerId: USER_IDS.doctor,
      lines: [
        {
          drugId: medicine(HOSPITAL, 'Paracetamol').id,
          dose: '1 g',
          route: 'oral',
          frequency: '1-0-1',
        },
      ],
    });
    await startWriting();
    await userEvent.click(screen.getByRole('button', { name: 'Load a set' }));
    expect(await screen.findByRole('button', { name: /Common cold/ })).toBeInTheDocument();
    // The admin does not see the doctor's own set.
    expect(screen.queryByRole('button', { name: /Dr Own/ })).not.toBeInTheDocument();
  });

  it('keeps each hospital’s sets to itself', async () => {
    signIn(USER_IDS.doctor, CLINIC);
    await startWriting('enc_c_1');
    await userEvent.click(screen.getByRole('button', { name: 'Load a set' }));
    expect(await screen.findByText(/No sets yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Common cold/ })).not.toBeInTheDocument();
  });
});

describe('saving the lines as a set', () => {
  async function fillFirstLine() {
    await userEvent.type(within(line(1)).getByRole('combobox', { name: 'Medicine' }), 'azithro');
    const [first] = await within(await within(line(1)).findByRole('listbox')).findAllByRole(
      'option',
    );
    await userEvent.click(first as HTMLElement);
    await userEvent.type(within(line(1)).getByRole('textbox', { name: /^Dose/ }), '500 mg');
    await userEvent.type(within(line(1)).getByRole('textbox', { name: /^Frequency/ }), '1-0-0');
  }

  it('asks for complete lines first', async () => {
    await startWriting();
    await userEvent.click(screen.getByRole('button', { name: 'Save as a set' }));
    expect(
      await screen.findByText(/Choose the medicine and write the dose, route and frequency/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('keeps the lines as the caller’s own set, named in a dialog', async () => {
    await startWriting();
    await fillFirstLine();
    await userEvent.click(screen.getByRole('button', { name: 'Save as a set' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Save as a set' });
    const name = within(dialog).getByRole('textbox', { name: /Name of the set/ });
    await waitFor(() => expect(name).toHaveFocus());
    await expectNoAxeViolations(dialog);
    await userEvent.type(name, '  Chest infection ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save the set' }));

    expect(await screen.findByText('Saved as your set: Chest infection.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const saved = mockSetsOf(HOSPITAL).find((set) => set.name === 'Chest infection');
    expect(saved).toMatchObject({ shared: false, lineCount: 1 });
    expect(mockSetsOf(CLINIC).find((set) => set.name === 'Chest infection')).toBeUndefined();
  });

  it('shares it with the hospital for whoever may, and offers that to no one else', async () => {
    await startWriting();
    await fillFirstLine();
    await userEvent.click(screen.getByRole('button', { name: 'Save as a set' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Name of the set/ }),
      'Shared',
    );
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Share with the whole hospital' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save the set' }));
    expect(
      await screen.findByText('Saved as a set shared with the hospital: Shared.'),
    ).toBeInTheDocument();
    expect(mockSetsOf(HOSPITAL).find((set) => set.name === 'Shared')?.shared).toBe(true);
  });

  it('offers a doctor no sharing, and refuses a name already used', async () => {
    signIn(USER_IDS.doctor, HOSPITAL);
    await startWriting();
    await fillFirstLine();
    await userEvent.click(screen.getByRole('button', { name: 'Save as a set' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Name of the set/ }), 'Mine');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save the set' }));
    await screen.findByText('Saved as your set: Mine.');

    await userEvent.click(screen.getByRole('button', { name: 'Save as a set' }));
    const again = await screen.findByRole('alertdialog');
    await userEvent.type(within(again).getByRole('textbox', { name: /Name of the set/ }), 'mine');
    await userEvent.click(within(again).getByRole('button', { name: 'Save the set' }));
    expect(await within(again).findByRole('alert')).toHaveTextContent(/already have a set/);
  });
});

describe('access to prescription sets', () => {
  it('offers no loading without prescriptionSet:read, and no saving without :manage', async () => {
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'encounter:read' },
      { permission: 'prescription:read' },
      { permission: 'prescription:create' },
      { permission: 'drug:read' },
      { permission: 'prescriptionSet:read' },
    ]);
    await startWriting();
    expect(screen.getByRole('button', { name: 'Load a set' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save as a set' })).not.toBeInTheDocument();
  });

  it('offers neither to a role without the permissions, and no favourites', async () => {
    revokePermission(HOSPITAL, 'admin', 'prescriptionSet:read');
    revokePermission(HOSPITAL, 'admin', 'prescriptionSet:manage');
    await startWriting();
    expect(screen.queryByRole('button', { name: 'Load a set' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save as a set' })).not.toBeInTheDocument();
    await userEvent.click(within(line(1)).getByRole('combobox', { name: 'Medicine' }));
    expect(screen.queryByText('Your favourites')).not.toBeInTheDocument();
  });
});

describe('favourite medicines', () => {
  it('are offered before anything is typed, and chosen with the keyboard', async () => {
    const paracetamol = medicine(HOSPITAL, 'Paracetamol');
    setMockFavourites(HOSPITAL, USER_IDS.admin, [paracetamol.id]);
    await startWriting();

    const box = within(line(1)).getByRole('combobox', { name: 'Medicine' });
    await userEvent.click(box);
    const list = await within(line(1)).findByRole('listbox', { name: 'Your favourites' });
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    await expectNoAxeViolations();

    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(await within(line(1)).findByText(/^Paracetamol/)).toBeInTheDocument();
  });

  it('are one hospital’s and one doctor’s: another hospital offers none', async () => {
    setMockFavourites(HOSPITAL, USER_IDS.doctor, [medicine(HOSPITAL, 'Paracetamol').id]);
    signIn(USER_IDS.doctor, CLINIC);
    await startWriting('enc_c_1');
    await userEvent.click(within(line(1)).getByRole('combobox', { name: 'Medicine' }));
    await waitFor(() =>
      expect(
        within(line(1)).getByText('Type a generic name or a brand.', {
          selector: 'p[aria-hidden]',
        }),
      ).toBeInTheDocument(),
    );
    expect(within(line(1)).queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('are starred and unstarred on a line, and announced', async () => {
    await startWriting();
    const box = within(line(1)).getByRole('combobox', { name: 'Medicine' });
    await userEvent.type(box, 'azithro');
    const [first] = await within(await within(line(1)).findByRole('listbox')).findAllByRole(
      'option',
    );
    await userEvent.click(first as HTMLElement);

    const star = await within(line(1)).findByRole('button', {
      name: /^Add Azithromycin.* to your favourites$/,
    });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(star);
    await waitFor(() =>
      expect(
        within(line(1)).getByRole('button', {
          name: /^Remove Azithromycin.* from your favourites$/,
        }),
      ).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(await within(line(1)).findByText(/is one of your favourites./)).toBeInTheDocument();
  });

  it('are not offered with the clinical switch off', async () => {
    setTenantFeature(HOSPITAL, 'clinical', false);
    renderApp({ entry: '/encounters/enc_h_1' });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
  });
});
