import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revokePermission, setRolePermissions, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { mockPrescriptionsOf, mockPrints, moveMockOrder } from '@/mocks/handlers/clinical';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const CONSULTATION = { name: 'Consultation', level: 1 };

let print: ReturnType<typeof vi.fn>;
beforeEach(() => {
  print = vi.fn();
  vi.stubGlobal('print', print);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const openConsultation = async (id = 'enc_h_1') => {
  renderApp({ entry: `/encounters/${id}` });
  await screen.findByRole('heading', CONSULTATION);
};

/** The printed page, once the print dialog was asked for. */
async function printedSheet(): Promise<HTMLElement> {
  await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  const sheet = document.querySelector<HTMLElement>('[data-print-sheet]');
  if (!sheet) throw new Error('nothing to print');
  return sheet;
}

const closeDialog = () => window.dispatchEvent(new Event('afterprint'));

describe('printing a prescription', () => {
  it('records the print, then prints the letterhead, the patient and the lines to take', async () => {
    await openConsultation();
    await userEvent.click(
      await screen.findByRole('button', { name: /^Print the prescription written/ }),
    );
    const sheet = await printedSheet();
    expect(mockPrints()).toEqual([
      { tenantId: HOSPITAL, entity: 'prescription', id: 'rx_h_1', userId: USER_IDS.admin },
    ]);
    expect(within(sheet).getByText('Sample Hospital')).toBeInTheDocument();
    expect(within(sheet).getByRole('heading', { name: 'Prescription' })).toBeInTheDocument();
    expect(within(sheet).getByText(/pth_00001|MRN/)).toBeInTheDocument();
    expect(within(sheet).getByText('Paracetamol 500 mg (ParaCare)')).toBeInTheDocument();
    expect(within(sheet).getByText(/Drink plenty of fluids/)).toBeInTheDocument();
    expect(within(sheet).getByText(/^Printed .* by Sample Admin$/)).toBeInTheDocument();

    closeDialog();
    await waitFor(() => expect(document.querySelector('[data-print-sheet]')).toBeNull());
    await expectNoAxeViolations();
  });

  it('prints nothing and says why when the print could not be recorded', async () => {
    server.use(
      http.post('*/api/prescriptions/:id/print', () =>
        HttpResponse.json(
          { error: { code: 'prescription_not_found', message: 'No such prescription' } },
          { status: 404 },
        ),
      ),
    );
    await openConsultation();
    const button = await screen.findByRole('button', { name: /^Print the prescription written/ });
    await userEvent.click(button);
    // The refusal is said in the alert the button is described by.
    await screen.findByText('This item could not be found.');
    expect(button).toHaveAccessibleDescription('This item could not be found.');
    expect(print).not.toHaveBeenCalled();
    expect(document.querySelector('[data-print-sheet]')).toBeNull();
    expect(mockPrints()).toEqual([]);
  });
});

describe('printing a prescription changed since the screen loaded', () => {
  it('refuses, in words, one whose every line was cancelled meanwhile', async () => {
    await openConsultation();
    const button = await screen.findByRole('button', {
      name: /^Print the prescription written/,
    });
    for (const line of mockPrescriptionsOf('enc_h_1')[0]?.lines ?? []) {
      moveMockOrder(line.id, 'cancelled');
    }
    await userEvent.click(button);
    expect(
      await screen.findByText(/This is no longer to be printed: it was replaced or cancelled/),
    ).toBeInTheDocument();
    expect(print).not.toHaveBeenCalled();
    expect(mockPrints()).toEqual([]);
  });
});

describe('printing the visit summary', () => {
  it('records the print and prints what stands of the visit', async () => {
    await openConsultation();
    await userEvent.click(await screen.findByRole('button', { name: 'Print summary' }));
    const sheet = await printedSheet();
    expect(mockPrints()).toEqual([
      { tenantId: HOSPITAL, entity: 'encounter', id: 'enc_h_1', userId: USER_IDS.admin },
    ]);
    expect(within(sheet).getByRole('heading', { name: 'Visit summary' })).toBeInTheDocument();
    expect(within(sheet).getByRole('heading', { name: 'Diagnoses' })).toBeInTheDocument();
    expect(within(sheet).getByText(/J06\.9/)).toBeInTheDocument();
    expect(within(sheet).getByRole('heading', { name: 'Notes' })).toBeInTheDocument();
    expect(within(sheet).getByRole('heading', { name: 'Prescriptions' })).toBeInTheDocument();
    expect(within(sheet).getByText('Cetirizine 10 mg (CetiCare)')).toBeInTheDocument();
  });

  it('leaves out what the caller may not read, with no trace of it', async () => {
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'encounter:read' },
      { permission: 'encounter:print' },
      { permission: 'prescription:read' },
    ]);
    await openConsultation();
    await userEvent.click(await screen.findByRole('button', { name: 'Print summary' }));
    const sheet = await printedSheet();
    expect(within(sheet).queryByRole('heading', { name: 'Diagnoses' })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('heading', { name: 'Notes' })).not.toBeInTheDocument();
    expect(within(sheet).queryByText(/J06\.9/)).not.toBeInTheDocument();
    expect(within(sheet).getByRole('heading', { name: 'Prescriptions' })).toBeInTheDocument();
  });

  it('prints under each hospital’s own letterhead and records it there', async () => {
    signIn(USER_IDS.doctor, CLINIC);
    await openConsultation('enc_c_1');
    await userEvent.click(await screen.findByRole('button', { name: 'Print summary' }));
    const sheet = await printedSheet();
    expect(within(sheet).getByText('Riverside Clinic')).toBeInTheDocument();
    expect(within(sheet).queryByText('Sample Hospital')).not.toBeInTheDocument();
    expect(within(sheet).getByText('No prescription.')).toBeInTheDocument();
    expect(mockPrints()).toEqual([
      { tenantId: CLINIC, entity: 'encounter', id: 'enc_c_1', userId: USER_IDS.doctor },
    ]);
  });
});

describe('access to printing', () => {
  it('offers no printing without encounter:print', async () => {
    revokePermission(HOSPITAL, 'admin', 'encounter:print');
    await openConsultation();
    await screen.findByText(/ParaCare/);
    expect(screen.queryByRole('button', { name: 'Print summary' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Print the prescription/ }),
    ).not.toBeInTheDocument();
  });
});
