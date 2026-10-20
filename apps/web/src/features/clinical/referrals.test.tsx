import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { revokePermission, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { mockReferralsOf } from '@/mocks/handlers/clinical';
import { mockDoctor } from '@/mocks/handlers/doctors';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// Referrals (#88): to a department of the hospital, or one of its doctors, from the consultation,
// and cancelled with a reason. The role matrix is in `permissions.test.tsx`.

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
const CONSULTATION = { name: 'Consultation', level: 1 };
const REFERRALS = { name: 'Referrals', level: 2 };
/** doc_h_02 practises in Cardiology (dep_h_02). */
const CARDIOLOGIST = 'doc_h_02';

afterEach(() => server.events.removeAllListeners());

async function openConsultation(entry = '/encounters/enc_h_1') {
  const app = renderApp({ entry });
  await screen.findByRole('heading', CONSULTATION);
  await screen.findByRole('heading', REFERRALS);
  return app;
}

const panel = () => screen.getByRole('heading', REFERRALS).closest('section') as HTMLElement;
const grid = () => within(panel()).getByRole('table', { name: 'Referrals' });

async function chooseDepartment(name: string) {
  const department = await within(panel()).findByRole('combobox', { name: /^Department/ });
  await waitFor(() => expect(within(department).getAllByRole('option').length).toBeGreaterThan(1));
  await userEvent.selectOptions(department, name);
}

describe('referrals', () => {
  it(
    'refers the patient to a doctor of a department, said in words and listed',
    { timeout: 15_000 },
    async () => {
      await openConsultation();
      expect(await within(panel()).findByText('No referrals.')).toBeInTheDocument();
      await chooseDepartment('Cardiology');
      const cardiologist = mockDoctor(HOSPITAL, CARDIOLOGIST)?.name ?? '';
      // Only the department's doctors, or any of them.
      const doctor = await within(panel()).findByRole('combobox', { name: 'Doctor' });
      expect(
        within(doctor)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['Any doctor of the department', cardiologist]);
      await userEvent.selectOptions(doctor, cardiologist);
      await userEvent.selectOptions(
        within(panel()).getByRole('combobox', { name: /^Urgency/ }),
        'Urgent',
      );
      await userEvent.type(
        within(panel()).getByRole('textbox', { name: /^Referral reason/ }),
        'Murmur on auscultation',
      );
      await userEvent.click(within(panel()).getByRole('button', { name: 'Refer' }));

      expect(await within(panel()).findByRole('status')).toHaveTextContent('Referral made.');
      expect(await within(grid()).findByText(`Cardiology: ${cardiologist}`)).toBeInTheDocument();
      expect(within(grid()).getByText('Urgent')).toBeInTheDocument();
      expect(mockReferralsOf('enc_h_1')).toEqual([
        expect.objectContaining({
          departmentId: 'dep_h_02',
          doctorId: CARDIOLOGIST,
          urgency: 'urgent',
          reason: 'Murmur on auscultation',
        }),
      ]);
      // The form is ready for another.
      expect(within(panel()).getByRole('textbox', { name: /^Referral reason/ })).toHaveValue('');
      await expectNoAxeViolations();
    },
  );

  it('refers to a department alone, and asks for a department and a reason first', async () => {
    const sent: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/referrals')) sent.push(request.url);
    });
    await openConsultation();
    await userEvent.click(within(panel()).getByRole('button', { name: 'Refer' }));
    expect(await within(panel()).findByText('Choose a department.')).toBeInTheDocument();
    expect(within(panel()).getByText('This field is required.')).toBeInTheDocument();
    expect(within(panel()).getByRole('combobox', { name: /^Department/ })).toHaveFocus();
    expect(sent).toEqual([]);

    await chooseDepartment('Orthopaedics');
    await userEvent.type(
      within(panel()).getByRole('textbox', { name: /^Referral reason/ }),
      'Knee pain',
    );
    await userEvent.click(within(panel()).getByRole('button', { name: 'Refer' }));
    expect(await within(grid()).findByText('Orthopaedics')).toBeInTheDocument();
    expect(mockReferralsOf('enc_h_1')[0]).not.toHaveProperty('doctorId');
  });

  it('cancels a referral with a reason, and keeps it marked in words', async () => {
    await openConsultation();
    await chooseDepartment('Orthopaedics');
    await userEvent.type(
      within(panel()).getByRole('textbox', { name: /^Referral reason/ }),
      'Knee pain',
    );
    await userEvent.click(within(panel()).getByRole('button', { name: 'Refer' }));
    await within(grid()).findByText('Orthopaedics');

    await userEvent.click(
      within(grid()).getByRole('button', { name: /^Cancel referral: Orthopaedics/ }),
    );
    await screen.findByRole('heading', { name: 'Cancel the referral to Orthopaedics' });
    await userEvent.type(
      screen.getByRole('textbox', { name: /^Why it is cancelled/ }),
      'Wrong side',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel referral' }));
    expect(await within(grid()).findByText(/^Cancelled by .+: Wrong side$/)).toBeInTheDocument();
    expect(within(panel()).getByRole('status')).toHaveTextContent('Referral cancelled.');
    expect(
      within(grid()).getByRole('button', { name: /^Cancel referral: Orthopaedics/ }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('lists referrals without making them for referral:read alone', async () => {
    revokePermission(HOSPITAL, 'admin', 'referral:create');
    await openConsultation();
    expect(await within(panel()).findByText('No referrals.')).toBeInTheDocument();
    expect(within(panel()).queryByRole('heading', { name: 'Refer the patient' })).toBeNull();
  });

  it('says so when the departments cannot be read, and refers nobody', async () => {
    revokePermission(HOSPITAL, 'admin', 'department:read');
    await openConsultation();
    expect(
      await within(panel()).findByText(
        'Departments cannot be read here, so no referral can be made.',
      ),
    ).toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Refer' })).toBeNull();
  });

  it('keeps each hospital’s referrals to itself', async () => {
    const hospital = await openConsultation();
    await chooseDepartment('Orthopaedics');
    await userEvent.type(
      within(panel()).getByRole('textbox', { name: /^Referral reason/ }),
      'Knee pain',
    );
    await userEvent.click(within(panel()).getByRole('button', { name: 'Refer' }));
    await within(grid()).findByText('Orthopaedics');
    expect(mockReferralsOf('enc_h_1')).toHaveLength(1);
    hospital.unmount();

    signIn(USER_IDS.doctor, CLINIC);
    await openConsultation('/encounters/enc_c_1');
    expect(await within(panel()).findByText('No referrals.')).toBeInTheDocument();
    // The clinic's departments only.
    const department = within(panel()).getByRole('combobox', { name: /^Department/ });
    await waitFor(() =>
      expect(within(department).getAllByRole('option').length).toBeGreaterThan(1),
    );
    expect(within(department).queryByRole('option', { name: 'Orthopaedics' })).toBeNull();
  });
});
