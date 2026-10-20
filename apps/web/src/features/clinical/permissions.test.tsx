import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setRolePermissions, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The permission matrix of the clinical screens (#84): each role's defaults, as the API seeds them
// (`apps/api/src/features/clinical/permissions.ts`, the "Clinical notes, diagnosis, orders" row of
// `docs/PRODUCT.md`), and a custom role, on the consultation, the list, the timeline and starting.
// The single permissions are tested beside each panel; this checks what each role sees as a whole.

const HOSPITAL = TENANT_IDS.hospital;
const CONSULTATION = { name: 'Consultation', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

type Grants = Parameters<typeof setRolePermissions>[2];

const grants = (...permissions: string[]): Grants =>
  permissions.map((permission) => ({ permission }));

/** What every role here holds outside the module: the patient, triage and the catalogs. */
const AROUND = [
  'patient:read',
  'appointment:read',
  'queue:read',
  'vitals:read',
  'allergy:read',
  'drug:read',
  'labTest:read',
  'service:read',
  'code:read',
];

const EVERY_CLINICAL = [
  'encounter:read',
  'encounter:create',
  'encounter:update',
  'clinicalNote:read',
  'clinicalNote:write',
  'diagnosis:read',
  'diagnosis:write',
  'order:read',
  'order:create',
  'order:update',
  'order:cancel',
  'prescription:read',
  'prescription:create',
  'encounter:print',
  // What happens next (#88).
  'referral:read',
  'referral:create',
  'followUp:read',
  'followUp:create',
];

interface View {
  notes: boolean;
  writeNote: boolean;
  diagnoses: boolean;
  recordDiagnosis: boolean;
  prescriptions: boolean;
  writePrescription: boolean;
  orders: boolean;
  placeOrder: boolean;
  cancelOrder: boolean;
  print: boolean;
  closeOrCancel: boolean;
  referrals: boolean;
  refer: boolean;
  followUp: boolean;
  setFollowUp: boolean;
}

const EVERYTHING: View = {
  notes: true,
  writeNote: true,
  diagnoses: true,
  recordDiagnosis: true,
  prescriptions: true,
  writePrescription: true,
  orders: true,
  placeOrder: true,
  cancelOrder: true,
  print: true,
  closeOrCancel: true,
  referrals: true,
  refer: true,
  followUp: true,
  setFollowUp: true,
};

const NOTHING: View = Object.fromEntries(
  Object.keys(EVERYTHING).map((key) => [key, false]),
) as unknown as View;

/** The nurse's defaults: the visit, its orders and prescriptions, printing and the follow-up. */
const NURSE = [
  'encounter:read',
  'order:read',
  'order:update',
  'prescription:read',
  'encounter:print',
  'followUp:read',
];

/** Roles that read consultations: what each sees on an open one. */
const READERS: { role: string; permissions: string[]; view: View }[] = [
  { role: 'admin', permissions: EVERY_CLINICAL, view: EVERYTHING },
  { role: 'doctor', permissions: EVERY_CLINICAL, view: EVERYTHING },
  {
    // The limited view: the visit, its orders and prescriptions, and printing, not what it was for.
    role: 'nurse',
    permissions: NURSE,
    view: { ...NOTHING, prescriptions: true, orders: true, print: true, followUp: true },
  },
  {
    // A custom role a hospital might make: writes the notes, never sees the diagnoses.
    role: 'scribe (custom)',
    permissions: ['encounter:read', 'clinicalNote:read', 'clinicalNote:write'],
    view: { ...NOTHING, notes: true, writeNote: true },
  },
];

/**
 * Roles with no way into a consultation by default (`docs/PRODUCT.md`: "no"). The receptionist
 * reads the follow-up due list (#88), which is not a consultation.
 */
const NON_READERS: { role: string; permissions: string[] }[] = [
  { role: 'receptionist', permissions: ['followUp:read', 'appointment:create'] },
  ...['pharmacist', 'lab_technician', 'radiologist', 'store_keeper'].map((role) => ({
    role,
    permissions: [],
  })),
];

/** The paths of every GET the screen sends. */
function watchReads(): string[] {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'GET') seen.push(new URL(request.url).pathname);
  });
  return seen;
}

afterEach(() => server.events.removeAllListeners());

const shown = (name: string, level = 2) => screen.queryByRole('heading', { name, level }) !== null;
const button = (name: string | RegExp) => screen.queryByRole('button', { name }) !== null;

describe('the clinical permission matrix', () => {
  it.each(READERS)(
    'shows the $role what the role holds, and no trace of the rest',
    async ({ permissions, view }) => {
      const reads = watchReads();
      // The signed-in admin's role stands for each role in turn.
      setRolePermissions(HOSPITAL, 'admin', grants(...AROUND, ...permissions));
      renderApp({ entry: '/encounters/enc_h_1' });
      await screen.findByRole('heading', CONSULTATION);
      // Who the visit is for and what triage found, which every reader of a visit sees.
      expect(await screen.findByText(/MRN MRN-PTH-00001/)).toBeInTheDocument();
      expect(await screen.findByText(/Penicillin/)).toBeInTheDocument();

      // Wait for what is shown to arrive, so a panel that is absent is absent, not still loading.
      if (view.notes) expect(await screen.findByText(/Cough for a week/)).toBeInTheDocument();
      if (view.diagnoses) expect(await screen.findAllByText(/J06\.9/)).not.toHaveLength(0);
      if (view.prescriptions) expect(await screen.findByText(/ParaCare/)).toBeInTheDocument();
      if (view.orders) {
        expect(await screen.findByText('Complete blood count')).toBeInTheDocument();
        expect(await screen.findByText('Chest X-ray')).toBeInTheDocument();
      }

      expect({
        notes: shown('Notes'),
        writeNote: button('Write a note'),
        diagnoses: shown('Diagnoses'),
        recordDiagnosis: shown('Record a diagnosis', 3) || shown('Record a diagnosis'),
        prescriptions: shown('Prescriptions'),
        writePrescription: button('Write a prescription'),
        orders: shown('Lab orders') && shown('Imaging orders') && shown('Procedure orders'),
        placeOrder:
          screen.queryAllByRole('combobox', { name: /^(Test|Study|Procedure)/ }).length > 0,
        cancelOrder: screen.queryAllByRole('button', { name: /^Cancel order/ }).length > 0,
        print: button('Print summary'),
        closeOrCancel: button('Close consultation') || button('Cancel consultation'),
        referrals: shown('Referrals'),
        refer: shown('Refer the patient', 3),
        followUp: shown('Follow-up'),
        setFollowUp: shown('Set a follow-up', 3),
      }).toEqual(view);

      // What is hidden is never asked for, so nothing of it reaches the browser.
      const asked = (part: string) => reads.some((path) => path.endsWith(`/enc_h_1/${part}`));
      expect({
        notes: asked('notes'),
        diagnoses: asked('diagnoses'),
        prescriptions: asked('prescriptions'),
        orders: asked('orders'),
        referrals: asked('referrals'),
        followUps: asked('follow-ups'),
      }).toEqual({
        notes: view.notes,
        diagnoses: view.diagnoses,
        prescriptions: view.prescriptions,
        orders: view.orders,
        referrals: view.referrals,
        followUps: view.followUp,
      });
      if (!view.diagnoses) expect(screen.queryByText(/J06\.9|Acute upper respiratory/)).toBeNull();
      if (!view.notes) expect(screen.queryByText(/Cough for a week/)).toBeNull();
      await expectNoAxeViolations();
    },
  );

  it.each(READERS)('lists consultations for the $role', async ({ permissions }) => {
    setRolePermissions(HOSPITAL, 'admin', grants(...AROUND, ...permissions));
    renderApp({ entry: '/encounters' });
    await screen.findByRole('heading', { name: 'Consultations', level: 1 });
    const grid = await screen.findByRole('table', { name: 'Consultations' });
    expect(await within(grid).findAllByRole('link')).not.toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Consultations' })).toBeInTheDocument();
  });

  it.each(NON_READERS)('gives the $role no way into a consultation', async ({ permissions }) => {
    const reads = watchReads();
    // Their defaults hold no consultation permission; what they do hold elsewhere is around it.
    setRolePermissions(HOSPITAL, 'admin', grants(...AROUND, ...permissions));
    const consultation = renderApp({ entry: '/encounters/enc_h_1' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Consultations' })).not.toBeInTheDocument();
    consultation.unmount();

    // No timeline on the patient's screen, and no start on the board.
    const patient = renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('tab', { name: 'Vitals and allergies' });
    expect(screen.queryByRole('tab', { name: 'Clinical timeline' })).not.toBeInTheDocument();
    patient.unmount();

    renderApp({ entry: '/queue' });
    await screen.findAllByText(/^Token \d+$/);
    expect(screen.queryByRole('button', { name: /^Start consultation/ })).not.toBeInTheDocument();
    expect(reads.some((path) => /\/encounters/.test(path))).toBe(false);
    // The due list is theirs only with followUp:read.
    expect(screen.queryByRole('link', { name: 'Follow-ups' }) !== null).toBe(
      permissions.includes('followUp:read'),
    );
  });

  it('lets the nurse read the timeline, but not start a consultation', async () => {
    setRolePermissions(HOSPITAL, 'admin', grants(...AROUND, ...NURSE));
    const patient = renderApp({ entry: '/patients/pth_00001?tab=timeline' });
    expect(await screen.findByRole('table', { name: 'Visits' })).toBeInTheDocument();
    patient.unmount();

    renderApp({ entry: '/queue' });
    await screen.findAllByText(/^Token \d+$/);
    expect(screen.queryByRole('button', { name: /^Start consultation/ })).not.toBeInTheDocument();
  });

  it('gives no role anything with the module off', async () => {
    setTenantFeature(HOSPITAL, 'clinical', false);
    setRolePermissions(HOSPITAL, 'admin', grants(...AROUND, ...EVERY_CLINICAL));
    renderApp({ entry: '/encounters/enc_h_1' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Consultations' })).not.toBeInTheDocument(),
    );
  });
});
