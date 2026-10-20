import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { moveMockOrder, mockPrescriptionsOf } from '@/mocks/handlers/clinical';
import { editMockAllergies } from '@/mocks/handlers/triage';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';
import { checkLines, matchesAllergy, sameGeneric } from './prescription-checks';
import type { Order } from './types';

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const CONSULTATION = { name: 'Consultation', level: 1 };
const PRESCRIPTIONS = { name: 'Prescriptions', level: 2 };

const openConsultation = async (id = 'enc_h_1') => {
  const app = renderApp({ entry: `/encounters/${id}` });
  await screen.findByRole('heading', CONSULTATION);
  return app;
};

const panel = async () =>
  (await screen.findByRole('heading', PRESCRIPTIONS)).closest('section') as HTMLElement;

/** Searches the catalog from a line's medicine box and takes the first medicine offered. */
async function chooseMedicine(line: HTMLElement, search: string): Promise<string> {
  await userEvent.type(within(line).getByRole('combobox', { name: 'Medicine' }), search);
  const [first] = await within(await within(line).findByRole('listbox')).findAllByRole('option');
  const name = first?.textContent ?? '';
  await userEvent.click(first as HTMLElement);
  return name;
}

/** Opens a new prescription and waits for its first line. */
async function startWriting() {
  const section = await panel();
  await userEvent.click(
    await within(section).findByRole('button', { name: 'Write a prescription' }),
  );
  await screen.findByRole('group', { name: 'Medicine 1' });
}

const line = (number: number) =>
  screen.getByRole('group', { name: `Medicine ${number}` }) as HTMLElement;

async function fillLine(number: number, search: string) {
  const name = await chooseMedicine(line(number), search);
  await userEvent.type(within(line(number)).getByRole('textbox', { name: /^Dose/ }), '1 tablet');
  await userEvent.type(within(line(number)).getByRole('textbox', { name: /^Frequency/ }), '1-0-1');
  return name;
}

describe('prescriptions on the consultation', () => {
  it('shows each prescription with its lines in the order written and its advice', async () => {
    await openConsultation();
    const section = await panel();
    expect(await within(section).findByText('Paracetamol 500 mg (ParaCare)')).toBeInTheDocument();
    const lines = within(section)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    const paracetamol = lines.findIndex((text) => text.startsWith('Paracetamol 500 mg'));
    const cetirizine = lines.findIndex((text) => text.startsWith('Cetirizine 10 mg'));
    expect(paracetamol).toBeGreaterThan(-1);
    expect(cetirizine).toBeGreaterThan(paracetamol);
    expect(
      within(section).getByText('1 tablet · Oral · 1-0-1 · for 3 days · 6 units to dispense'),
    ).toBeInTheDocument();
    expect(within(section).getByText('After food')).toBeInTheDocument();
    expect(within(section).getByText(/Drink plenty of fluids/)).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('writes a prescription from the catalog, after checking the dosage fields', async () => {
    await openConsultation();
    const section = await panel();
    await startWriting();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'New prescription' })).toHaveFocus(),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Write the prescription' }));
    expect(await screen.findByText('Choose a medicine from the search.')).toBeInTheDocument();
    expect(within(line(1)).getAllByText('This field is required.')).toHaveLength(2);
    await waitFor(() =>
      expect(within(line(1)).getByRole('combobox', { name: 'Medicine' })).toHaveFocus(),
    );

    const name = await fillLine(1, 'azithro');
    expect(name).toMatch(/^Azithromycin/);
    const days = within(line(1)).getByRole('textbox', { name: /^Days/ });
    await userEvent.type(days, '400');
    await userEvent.tab();
    expect(
      await within(line(1)).findByText('A whole number of days from 1 to 365.'),
    ).toBeInTheDocument();
    await userEvent.clear(days);
    await userEvent.type(days, '5');
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Advice for the patient/ }),
      'Rest well.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Write the prescription' }));
    expect(await screen.findByText('Prescription written.')).toBeInTheDocument();

    const written = mockPrescriptionsOf('enc_h_1').at(-1);
    expect(written?.advice).toBe('Rest well.');
    expect(written?.lines).toMatchObject([
      { dose: '1 tablet', frequency: '1-0-1', route: 'oral', durationDays: 5, status: 'placed' },
    ]);
    expect(await within(section).findAllByText(/^Azithromycin/)).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'New prescription' })).not.toBeInTheDocument();
  });

  it('warns of a medicine the patient is allergic to, and asks once before writing it', async () => {
    editMockAllergies(HOSPITAL, 'pth_00001', [
      { substance: 'Azithromycin', reaction: 'Rash', severity: 'severe' },
    ]);
    await openConsultation();
    await startWriting();
    await fillLine(1, 'azithro');
    expect(
      within(line(1)).getByText(/The patient is recorded as allergic to Azithromycin\./),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Write the prescription' }));
    const question = await screen.findByRole('heading', {
      name: 'Prescribe with these warnings?',
    });
    await waitFor(() => expect(question).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Review the lines' }));
    expect(
      screen.queryByRole('heading', { name: 'Prescribe with these warnings?' }),
    ).not.toBeInTheDocument();
    const before = mockPrescriptionsOf('enc_h_1').length;

    await userEvent.click(screen.getByRole('button', { name: 'Write the prescription' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Prescribe anyway' }));
    expect(await screen.findByText('Prescription written.')).toBeInTheDocument();
    expect(mockPrescriptionsOf('enc_h_1')).toHaveLength(before + 1);
  });

  it('warns of a medicine already prescribed, here or in this prescription', async () => {
    await openConsultation();
    await startWriting();
    await fillLine(1, 'paracetamol');
    expect(
      within(line(1)).getByText(
        /Already prescribed in this consultation: Paracetamol 500 mg \(ParaCare\)\./,
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add a medicine' }));
    await waitFor(() =>
      expect(within(line(2)).getByRole('combobox', { name: 'Medicine' })).toHaveFocus(),
    );
    await fillLine(2, 'paracetamol');
    expect(
      within(line(2)).getByText(/Another line of this prescription is the same medicine\./),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove medicine 2' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add a medicine' })).toHaveFocus(),
    );
    expect(
      within(line(1)).queryByText(/Another line of this prescription/),
    ).not.toBeInTheDocument();
  });

  it('revises a prescription: the lines not started are written again, and the old one stays', async () => {
    moveMockOrder('ord_h_1', 'in_progress');
    await openConsultation();
    const section = await panel();
    await userEvent.click(
      await within(section).findByRole('button', { name: /^Revise the prescription written/ }),
    );
    await screen.findByRole('heading', { name: 'Revise the prescription' });
    expect(
      screen.getByText('1 line already in progress or completed stays as it is.'),
    ).toBeInTheDocument();
    // Only cetirizine, which has not started, is carried over; no duplicate is warned of.
    expect(within(line(1)).getByText('Cetirizine 10 mg (CetiCare)')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Medicine 2' })).not.toBeInTheDocument();
    expect(within(line(1)).queryByText(/Already prescribed/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Write the revision' }));
    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
    await userEvent.clear(within(line(1)).getByRole('textbox', { name: /^Frequency/ }));
    await userEvent.type(within(line(1)).getByRole('textbox', { name: /^Frequency/ }), '1-0-0');
    await userEvent.type(screen.getByRole('textbox', { name: /^Why it is revised/ }), 'Drowsy');
    await userEvent.click(screen.getByRole('button', { name: 'Write the revision' }));
    expect(await screen.findByText(/^Prescription revised\./)).toBeInTheDocument();

    const [old, revision] = mockPrescriptionsOf('enc_h_1');
    expect(old?.replacedById).toBe(revision?.id);
    expect(old?.lines.map((each) => each.status)).toEqual(['in_progress', 'cancelled']);
    expect(revision?.lines).toMatchObject([{ drugId: 'drg_h_0805', frequency: '1-0-0' }]);
    expect(
      await within(section).findByText(/^Replaced by the prescription of/),
    ).toBeInTheDocument();
    expect(within(section).getByText('Cancelled: Drowsy')).toBeInTheDocument();
    expect(within(section).getByText('In progress')).toBeInTheDocument();
    expect(
      within(section).getByText(/^Revises the prescription of .+: Drowsy$/),
    ).toBeInTheDocument();
    // A replaced prescription is not revised again; its revision may be.
    expect(
      within(section).getAllByRole('button', { name: /^Revise the prescription/ }),
    ).toHaveLength(1);
  });

  it('says why the server refused, and keeps what was typed', async () => {
    server.use(
      http.post('*/api/encounters/:encounterId/prescriptions', () =>
        HttpResponse.json(
          { error: { code: 'encounter_not_open', message: 'The encounter is not open' } },
          { status: 409 },
        ),
      ),
    );
    await openConsultation();
    await startWriting();
    await fillLine(1, 'azithro');
    await userEvent.click(screen.getByRole('button', { name: 'Write the prescription' }));
    expect(
      await screen.findByText(
        'The consultation is no longer open, so nothing can be prescribed in it.',
      ),
    ).toBeInTheDocument();
    expect(within(line(1)).getByRole('textbox', { name: /^Dose/ })).toHaveValue('1 tablet');
  });

  it('says when allergies were never asked, or are not shown to this person', async () => {
    server.use(
      http.get('*/api/patients/:patientId/allergies', ({ params }) =>
        HttpResponse.json({
          patientId: String(params.patientId),
          tenantId: HOSPITAL,
          status: 'unknown',
          items: [],
          version: 0,
        }),
      ),
    );
    const app = await openConsultation();
    await startWriting();
    expect(
      await screen.findByText(
        'Allergies have not been asked yet. Ask the patient before prescribing.',
      ),
    ).toBeInTheDocument();
    app.unmount();

    revokePermission(HOSPITAL, 'admin', 'allergy:read');
    await openConsultation();
    await startWriting();
    expect(await screen.findByText(/allergies are not shown to you here/)).toBeInTheDocument();
  });
});

describe('access to prescriptions', () => {
  it('shows nothing of prescriptions without prescription:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'prescription:read');
    await openConsultation();
    await screen.findByRole('heading', { name: 'Notes' });
    expect(screen.queryByRole('heading', PRESCRIPTIONS)).not.toBeInTheDocument();
    expect(screen.queryByText(/ParaCare/)).not.toBeInTheDocument();
  });

  it('reads prescriptions without writing or revising them for prescription:read alone', async () => {
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'encounter:read' },
      { permission: 'prescription:read' },
    ]);
    await openConsultation();
    const section = await panel();
    expect(await within(section).findByText(/ParaCare/)).toBeInTheDocument();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers no writing on a closed consultation', async () => {
    await openConsultation('enc_h_2');
    const section = await panel();
    expect(await within(section).findByText('No prescription written yet.')).toBeInTheDocument();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says the medicine search is closed when the drug catalog is off', async () => {
    setTenantFeature(HOSPITAL, 'drugs', false);
    await openConsultation();
    await startWriting();
    expect(within(line(1)).getByRole('combobox', { name: 'Medicine' })).toBeDisabled();
    expect(
      within(line(1)).getByText('The drug catalog is not open to you at this hospital.'),
    ).toBeInTheDocument();
  });

  it('keeps each hospital’s prescriptions and catalog to itself', async () => {
    signIn(USER_IDS.doctor, CLINIC);
    await openConsultation('enc_c_1');
    const section = await panel();
    expect(await within(section).findByText('No prescription written yet.')).toBeInTheDocument();
    await startWriting();
    await userEvent.type(within(line(1)).getByRole('combobox', { name: 'Medicine' }), 'para');
    const options = await within(await within(line(1)).findByRole('listbox')).findAllByRole(
      'option',
    );
    expect(options.map((option) => option.textContent)).toEqual(['Paracetamol 500 mg Tablet']);
  });

  it('is unreachable with the module off', async () => {
    setTenantFeature(HOSPITAL, 'clinical', false);
    renderApp({ entry: '/encounters/enc_h_1' });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', PRESCRIPTIONS)).not.toBeInTheDocument();
  });
});

describe('prescribing in harder cases', () => {
  it('says so when someone else revised the prescription first', async () => {
    server.use(
      http.post('*/api/encounters/:encounterId/prescriptions', () =>
        HttpResponse.json(
          { error: { code: 'already_replaced', message: 'Replaced' } },
          { status: 409 },
        ),
      ),
    );
    await openConsultation();
    await userEvent.click(
      await within(await panel()).findByRole('button', {
        name: /^Revise the prescription written/,
      }),
    );
    await screen.findByRole('group', { name: 'Medicine 1' });
    await userEvent.type(screen.getByRole('textbox', { name: /^Why it is revised/ }), 'Drowsy');
    await userEvent.click(screen.getByRole('button', { name: 'Write the revision' }));
    expect(
      await screen.findByText(/Someone else revised this prescription first/),
    ).toBeInTheDocument();
  });

  it('writes for a custom role, asking first when the allergies cannot be checked', async () => {
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'encounter:read' },
      { permission: 'prescription:read' },
      { permission: 'prescription:create' },
      { permission: 'drug:read' },
    ]);
    await openConsultation();
    await startWriting();
    expect(screen.getByText(/allergies are not shown to you here/)).toBeInTheDocument();
    await fillLine(1, 'azithro');
    await userEvent.click(screen.getByRole('button', { name: 'Write the prescription' }));
    expect(
      await screen.findByRole('heading', { name: 'Prescribe with these warnings?' }),
    ).toHaveAccessibleDescription(/not checked against the patient’s allergies/);
    await userEvent.click(screen.getByRole('button', { name: 'Prescribe anyway' }));
    expect(await screen.findByText('Prescription written.')).toBeInTheDocument();
  });

  it('says when the allergies could not be read', async () => {
    server.use(
      http.get('*/api/patients/:patientId/allergies', () =>
        HttpResponse.json({ error: { code: 'internal', message: 'Down' } }, { status: 500 }),
      ),
    );
    await openConsultation();
    await startWriting();
    expect(
      await screen.findByText(/allergies could not be read, so medicines are not checked/),
    ).toBeInTheDocument();
  });

  it('closes the medicine search without choosing, and never submits from it', async () => {
    await openConsultation();
    await startWriting();
    const search = within(line(1)).getByRole('combobox', { name: 'Medicine' });
    await userEvent.type(search, 'azithro');
    await within(line(1)).findByRole('listbox');
    await expectNoAxeViolations();
    await userEvent.keyboard('{ArrowUp}');
    await userEvent.keyboard('{Escape}');
    expect(within(line(1)).queryByRole('listbox')).not.toBeInTheDocument();
    expect(search).toHaveValue('azithro');
    await userEvent.keyboard('{ArrowDown}');
    await within(line(1)).findByRole('listbox');
    await userEvent.keyboard('{Enter}');
    // Enter chose a medicine; nothing was sent and no field was checked.
    expect(
      await within(line(1)).findByRole('button', { name: /^Change the medicine/ }),
    ).toBeVisible();
    expect(screen.queryByText('This field is required.')).not.toBeInTheDocument();
  });

  it('offers no medicine search without drug:read', async () => {
    revokePermission(HOSPITAL, 'admin', 'drug:read');
    await openConsultation();
    await startWriting();
    expect(within(line(1)).getByRole('combobox', { name: 'Medicine' })).toBeDisabled();
  });
});

describe('the prescribing checks', () => {
  const order = (drugId: string, itemName: string): Order =>
    ({ drugId, itemName, status: 'placed' }) as Order;

  it('matches an allergy by a word that begins a name, never by a drug class', () => {
    expect(matchesAllergy('Amoxicillin', ['Amoxicillin', 'AmoxCare'])).toBe(true);
    expect(matchesAllergy('sulfa drugs', ['Sulfamethoxazole'])).toBe(true);
    expect(matchesAllergy('Penicillin', ['Amoxicillin'])).toBe(false);
    // Short words and numbers are not matched on their own.
    expect(matchesAllergy('egg', ['Eggplant extract'])).toBe(false);
    expect(matchesAllergy('500 mg', ['Paracetamol 500 mg'])).toBe(false);
  });

  it('takes a generic name and the same one with a strength and brand as one medicine', () => {
    expect(sameGeneric('Paracetamol', 'Paracetamol 500 mg (ParaCare)')).toBe(true);
    expect(sameGeneric('Paracetamol', 'Paracetamol')).toBe(true);
    expect(sameGeneric('Levocetirizine', 'Cetirizine 10 mg')).toBe(false);
    expect(sameGeneric('', 'Paracetamol')).toBe(false);
  });

  it('warns of each line on its own', () => {
    const warnings = checkLines(
      [
        { drugId: 'a', genericName: 'Paracetamol', brandName: 'ParaCare' },
        { drugId: '', genericName: '', brandName: '' },
        { drugId: 'b', genericName: 'Cetirizine', brandName: '' },
      ],
      [{ substance: 'Cetirizine', severity: 'mild' }],
      [order('c', 'Paracetamol 650 mg (ParaMed)')],
    );
    expect(warnings).toEqual([
      { allergies: [], repeated: false, prescribed: ['Paracetamol 650 mg (ParaMed)'] },
      { allergies: [], repeated: false, prescribed: [] },
      { allergies: ['Cetirizine'], repeated: false, prescribed: [] },
    ]);
  });
});
