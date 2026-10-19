import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { sessionKey } from '@/app/session';
import {
  grantPermission,
  revokePermission,
  sessionFor,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { editMockPatient } from '@/mocks/handlers/patients';
import { editMockAllergies, mockVitalsOf } from '@/mocks/handlers/triage';
import { server } from '@/mocks/node';
import { api } from '@/shared/api';
import { todayIn } from '@/shared/utils/timezone';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp, renderWithProviders } from '@/test/render';
import { TriageSummary } from '.';

const HOSPITAL = TENANT_IDS.hospital;
const RECORD = { name: 'Record vitals', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };
/** Waiting at the hospital today, in the first department: token 2, for pth_00102. */
const TOKEN = 'qt_tenant_1_dep_h_01_2';

const openForm = async (entry: string) => {
  const app = renderApp({ entry });
  await screen.findByRole('heading', RECORD);
  return app;
};

const field = (name: RegExp) => screen.getByRole('textbox', { name });

/** Every request to record a reading, with its idempotency key. */
function watchRecords(): { key: string | null; body: unknown }[] {
  const seen: { key: string | null; body: unknown }[] = [];
  server.events.on('request:start', ({ request }) => {
    if (
      request.method === 'POST' &&
      /\/api\/patients\/[^/]+\/vitals$/.test(new URL(request.url).pathname)
    ) {
      void request
        .clone()
        .json()
        .then((body: unknown) => seen.push({ key: request.headers.get('Idempotency-Key'), body }));
    }
  });
  return seen;
}

describe('recording vitals', () => {
  it('records a reading for a queue token, marks what is out of range, and confirms it', async () => {
    const records = watchRecords();
    await openForm(`/triage/pth_00102?token=${TOKEN}`);
    expect(await screen.findByText(/MRN MRN-PTH-00102/)).toBeInTheDocument();
    // The patient has never been asked about allergies.
    expect(await screen.findByText('Not asked yet.')).toBeInTheDocument();

    await userEvent.type(field(/^Systolic/), '150');
    // Marked as typed, in words: the hospital's high limit is 139.
    const pressure = screen.getByRole('group', { name: 'Blood pressure' });
    expect(await within(pressure).findByText('High')).toBeInTheDocument();
    await userEvent.type(field(/^Diastolic/), '95');
    await userEvent.type(field(/^Pulse/), '80');
    await userEvent.type(field(/^Temperature/), '37.2');
    await userEvent.type(field(/^Weight/), '70');
    await userEvent.type(field(/^Height/), '175');
    expect(screen.getByText('BMI: 22.9')).toBeInTheDocument();
    await userEvent.type(field(/^Chief complaint/), 'Cough for a week.');
    await userEvent.click(screen.getByRole('button', { name: 'Save vitals' }));

    const done = await screen.findByRole('heading', { name: 'Vitals saved' });
    expect(document.activeElement).toBe(done);
    expect(screen.getByText('Vitals saved. 1 value is outside the normal range.')).toHaveAttribute(
      'role',
      'status',
    );
    await waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]?.body).toEqual({
      systolic: 150,
      diastolic: 95,
      pulse: 80,
      temperature: 37.2,
      weight: 70,
      height: 175,
      chiefComplaint: 'Cough for a week.',
      queueTokenId: TOKEN,
    });
    expect(records[0]?.key).toMatch(/^[\w-]{8,}$/);
    expect(mockVitalsOf(HOSPITAL, 'pth_00102')).toHaveLength(1);
    await expectNoAxeViolations();

    await userEvent.click(screen.getByRole('link', { name: 'Back to the queue' }));
    expect(await screen.findByRole('heading', { name: 'OPD queue', level: 1 })).toBeInTheDocument();
  });

  it('refuses what a body cannot be, and sends nothing', async () => {
    const records = watchRecords();
    await openForm('/triage/pth_00102');
    const save = screen.getByRole('button', { name: 'Save vitals' });

    await userEvent.click(save);
    expect(
      await screen.findByText('Enter at least one measurement or the chief complaint.'),
    ).toBeInTheDocument();
    expect(field(/^Systolic/)).toHaveFocus();

    await userEvent.type(field(/^Systolic/), '120');
    await userEvent.click(save);
    expect(
      await screen.findByText('Enter both the systolic and the diastolic pressure.'),
    ).toBeInTheDocument();

    await userEvent.type(field(/^Diastolic/), '130');
    await userEvent.click(save);
    expect(
      await screen.findByText('The diastolic pressure must be below the systolic.'),
    ).toBeInTheDocument();

    await userEvent.clear(field(/^Diastolic/));
    await userEvent.type(field(/^Diastolic/), '80');
    // A comma is not read as a decimal point.
    await userEvent.type(field(/^Temperature/), '37,5');
    await userEvent.click(save);
    expect(
      await screen.findByText('Enter a temperature from 25 to 45, with at most one decimal.'),
    ).toBeInTheDocument();
    expect(records).toHaveLength(0);
  });

  it('says when vitals were already taken for the token, and adds a second reading', async () => {
    await api.POST('/patients/{patientId}/vitals', {
      params: {
        path: { patientId: 'pth_00102' },
        header: { 'idempotency-key': 'first-reading-1' },
      },
      body: { pulse: 70, queueTokenId: TOKEN },
    });
    await openForm(`/triage/pth_00102?token=${TOKEN}`);
    expect(
      await screen.findByText(/^Vitals were already recorded for this token at /),
    ).toBeInTheDocument();
  });

  it('refuses a token that is not the patient’s', async () => {
    await openForm(`/triage/pth_00103?token=${TOKEN}`);
    await userEvent.type(field(/^Pulse/), '72');
    await userEvent.click(screen.getByRole('button', { name: 'Save vitals' }));
    expect(
      await screen.findByText(
        "That queue token is not this patient's today. Open the patient from the queue again.",
      ),
    ).toHaveAttribute('role', 'alert');
    expect(mockVitalsOf(HOSPITAL, 'pth_00103')).toHaveLength(0);
  });

  it('marks nothing for a child, and says why', async () => {
    const today = todayIn('Asia/Kolkata');
    editMockPatient('pth_00002', { dob: `${Number(today.slice(0, 4)) - 5}${today.slice(4)}` });
    await openForm('/triage/pth_00002');
    expect(
      await screen.findByText(
        'Normal ranges are for adults: nothing is marked high or low for a patient under 18.',
      ),
    ).toBeInTheDocument();
    await userEvent.type(field(/^Pulse/), '130');
    expect(screen.queryByText('High')).not.toBeInTheDocument();
  });

  it('corrects a reading with a reason, keeping the original', async () => {
    const records = watchRecords();
    renderApp({ entry: '/triage/pth_00001?corrects=vit_h_2' });
    await screen.findByRole('heading', { name: 'Correct a vitals reading', level: 1 });
    // Starts from the reading it corrects.
    await waitFor(() => expect(field(/^Systolic/)).toHaveValue('152'));
    await userEvent.clear(field(/^Systolic/));
    await userEvent.type(field(/^Systolic/), '125');
    await userEvent.click(screen.getByRole('button', { name: 'Save vitals' }));
    expect(field(/^Reason for the correction/)).toHaveFocus();
    await userEvent.type(field(/^Reason for the correction/), 'Typed the wrong arm.');
    await userEvent.click(screen.getByRole('button', { name: 'Save vitals' }));
    await screen.findByRole('heading', { name: 'Vitals saved' });
    await waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]?.body).toMatchObject({
      systolic: 125,
      correctsId: 'vit_h_2',
      correctionReason: 'Typed the wrong arm.',
    });
    // Both are kept.
    expect(mockVitalsOf(HOSPITAL, 'pth_00001')).toHaveLength(3);
  });
});

describe('the patient’s tab', () => {
  const openTab = async (id = 'pth_00001') => {
    const app = renderApp({ entry: `/patients/${id}?tab=vitals` });
    await screen.findByRole('tab', { name: 'Vitals and allergies', selected: true });
    return app;
  };

  it('shows the allergies and the readings, newest first, with what is out of range', async () => {
    await openTab();
    expect(await screen.findByText('Penicillin')).toBeInTheDocument();
    expect(screen.getByText(/Severe · Rash/)).toBeInTheDocument();
    expect(await screen.findByText('2 readings')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Vitals readings' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    // The newer reading: 152/94 and a pulse of 108 are above the hospital's limits.
    expect(within(rows[0]!).getAllByText('High')).toHaveLength(2);
    expect(within(rows[1]!).queryByText('High')).not.toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('edits the allergies in place, and keeps what was typed when someone saved first', async () => {
    await openTab();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit allergies' }));
    expect(await screen.findByRole('heading', { name: 'Allergies' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Add an allergy' }));
    const second = screen.getByRole('group', { name: 'Allergy 2' });
    await userEvent.type(within(second).getByRole('textbox', { name: /^Substance/ }), 'Peanuts');

    // Someone else changes them meanwhile.
    editMockAllergies(HOSPITAL, 'pth_00001', [{ substance: 'Latex', severity: 'mild' }]);
    await userEvent.click(screen.getByRole('button', { name: 'Save allergies' }));
    expect(
      await screen.findByText(/Someone else changed these allergies first/),
    ).toBeInTheDocument();
    expect(await screen.findByText('Latex')).toBeInTheDocument();
    // What was typed is still there, and saving again replaces from the newest version.
    expect(
      within(screen.getByRole('group', { name: 'Allergy 2' })).getByRole('textbox', {
        name: /^Substance/,
      }),
    ).toHaveValue('Peanuts');
    await userEvent.click(screen.getByRole('button', { name: 'Save allergies' }));
    expect(await screen.findByText('Allergies saved.')).toBeInTheDocument();
    expect(screen.getByText('Peanuts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit allergies' })).toHaveFocus();
  });

  it('records "no known allergies" apart from "not asked"', async () => {
    await openTab('pth_00002');
    expect(await screen.findByText('Not asked yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Record allergies' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Allergies/ }), 'none');
    await userEvent.click(screen.getByRole('button', { name: 'Save allergies' }));
    expect(await screen.findByText('No known allergies.')).toBeInTheDocument();
  });
});

describe('the queue board', () => {
  it('offers Record vitals on tokens still to be seen, and opens the form for that patient', async () => {
    renderApp({ entry: '/queue' });
    // Two departments have a token 2: this one is for pth_00102.
    const link = (await screen.findAllByRole('link', { name: 'Record vitals for token 2' })).find(
      (each) => each.getAttribute('href')?.startsWith('/triage/pth_00102?'),
    );
    if (!link) throw new Error('No link for pth_00102');
    // Being served and waiting have it; the skipped patient does not.
    const targets = screen
      .getAllByRole('link', { name: /^Record vitals for token/ })
      .map((each) => each.getAttribute('href')?.split('?')[0]);
    expect(targets).toContain('/triage/pth_00101');
    expect(targets).not.toContain('/triage/pth_00105');
    await userEvent.click(link);
    await screen.findByRole('heading', RECORD);
    expect(await screen.findByText(/MRN MRN-PTH-00102/)).toBeInTheDocument();
  });

  it('offers nothing without vitals:record', async () => {
    revokePermission(HOSPITAL, 'admin', 'vitals:record');
    renderApp({ entry: '/queue' });
    await screen.findAllByRole('table');
    expect(
      screen.queryByRole('link', { name: /^Record vitals for token/ }),
    ).not.toBeInTheDocument();
  });
});

describe('access', () => {
  it('turns the screen off with the switch', async () => {
    setTenantFeature(HOSPITAL, 'triage', false);
    renderApp({ entry: '/triage/pth_00102' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('takes the board link away with the switch', async () => {
    setTenantFeature(HOSPITAL, 'triage', false);
    renderApp({ entry: '/queue' });
    await screen.findAllByRole('table');
    expect(
      screen.queryByRole('link', { name: /^Record vitals for token/ }),
    ).not.toBeInTheDocument();
  });

  it('hides the tab with the switch off', async () => {
    setTenantFeature(HOSPITAL, 'triage', false);
    renderApp({ entry: '/patients/pth_00001' });
    await screen.findByRole('tab', { name: 'Details' });
    expect(screen.queryByRole('tab', { name: 'Vitals and allergies' })).not.toBeInTheDocument();
  });

  it('refuses the form without vitals:record', async () => {
    revokePermission(HOSPITAL, 'admin', 'vitals:record');
    renderApp({ entry: '/triage/pth_00102' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('shows only the allergies to a role that may not read vitals', async () => {
    revokePermission(HOSPITAL, 'admin', 'vitals:read');
    renderApp({ entry: '/patients/pth_00001?tab=vitals' });
    await screen.findByRole('tab', { name: 'Vitals and allergies', selected: true });
    expect(await screen.findByText('Penicillin')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Vitals readings' })).not.toBeInTheDocument();
  });

  it('works for a custom role given a permission, and not without it', async () => {
    signIn(USER_IDS.billingClerk, TENANT_IDS.clinic);
    const first = renderApp({ entry: '/patients/ptc_00001' });
    await screen.findByRole('tab', { name: 'Details' });
    expect(screen.queryByRole('tab', { name: 'Vitals and allergies' })).not.toBeInTheDocument();
    first.unmount();

    grantPermission(TENANT_IDS.clinic, 'billing_clerk', 'allergy:read');
    renderApp({ entry: '/patients/ptc_00001?tab=vitals' });
    await screen.findByRole('tab', { name: 'Vitals and allergies', selected: true });
    expect(await screen.findByText('No known allergies.')).toBeInTheDocument();
    // Seen, not changed, and no readings.
    expect(screen.queryByRole('button', { name: 'Edit allergies' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Vitals readings' })).not.toBeInTheDocument();
  });
});

describe('two hospitals', () => {
  it('shows the clinic its own patient and never the hospital’s', async () => {
    // The doctor works at both; the clinic is active.
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    renderApp({ entry: '/patients/ptc_00001?tab=vitals' });
    await screen.findByRole('tab', { name: 'Vitals and allergies', selected: true });
    expect(await screen.findByText('No known allergies.')).toBeInTheDocument();
    expect(await screen.findByText('1 reading')).toBeInTheDocument();
    // 37.6 °C is above the clinic's own limit of 37.5.
    const table = screen.getByRole('table', { name: 'Vitals readings' });
    expect(within(table).getByText('High')).toBeInTheDocument();
  });

  it('says a patient of another hospital is not available', async () => {
    // The doctor works at both; the clinic is active.
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    await openForm('/triage/pth_00001');
    expect(
      await screen.findByText('Vitals can be recorded only for a patient you may see.'),
    ).toHaveAttribute('role', 'alert');
    expect(screen.queryByRole('button', { name: 'Save vitals' })).not.toBeInTheDocument();
  });
});

describe('saving, when things go wrong', () => {
  it('records a retry after a failure once, with the same key, and a new reading with a new one', async () => {
    const records = watchRecords();
    let failNext = true;
    server.use(
      http.post('*/api/patients/:patientId/vitals', () => {
        if (!failNext) return undefined;
        failNext = false;
        return HttpResponse.error();
      }),
    );
    await openForm('/triage/pth_00102');
    await userEvent.type(field(/^Pulse/), '72');
    const save = screen.getByRole('button', { name: 'Save vitals' });
    await userEvent.click(save);
    expect(await screen.findByText(/connection|network|reach/i)).toBeInTheDocument();
    await userEvent.click(save);
    await screen.findByRole('heading', { name: 'Vitals saved' });
    await waitFor(() => expect(records).toHaveLength(2));
    expect(records[1]?.key).toBe(records[0]?.key);
    expect(mockVitalsOf(HOSPITAL, 'pth_00102')).toHaveLength(1);
  });

  it('says a server failure, and keeps what was typed', async () => {
    server.use(
      http.post('*/api/patients/:patientId/vitals', () =>
        HttpResponse.json(
          { error: { code: 'internal', message: 'x', requestId: 'r' } },
          { status: 500 },
        ),
      ),
    );
    await openForm('/triage/pth_00102');
    await userEvent.type(field(/^Pulse/), '72');
    await userEvent.click(screen.getByRole('button', { name: 'Save vitals' }));
    expect(
      await screen.findByText('Something went wrong on our side. Try again.'),
    ).toBeInTheDocument();
    expect(field(/^Pulse/)).toHaveValue('72');
  });

  it('refuses a second correction of the same reading', async () => {
    await api.POST('/patients/{patientId}/vitals', {
      params: { path: { patientId: 'pth_00001' }, header: { 'idempotency-key': 'first-fix-1' } },
      body: { pulse: 90, correctsId: 'vit_h_2', correctionReason: 'Recounted.' },
    });
    renderApp({ entry: '/triage/pth_00001?corrects=vit_h_2' });
    await screen.findByRole('heading', { name: 'Correct a vitals reading', level: 1 });
    await waitFor(() => expect(field(/^Systolic/)).toHaveValue('152'));
    await userEvent.type(field(/^Reason for the correction/), 'Again.');
    await userEvent.click(screen.getByRole('button', { name: 'Save vitals' }));
    expect(
      await screen.findByText(
        'That reading was already corrected. Correct its correction instead.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps an allergies edit open on the screen while vitals are saved', async () => {
    await openForm('/triage/pth_00102');
    await userEvent.click(await screen.findByRole('button', { name: 'Record allergies' }));
    const first = screen.getByRole('group', { name: 'Allergy 1' });
    await userEvent.type(within(first).getByRole('textbox', { name: /^Substance/ }), 'Latex');
    await userEvent.type(field(/^Pulse/), '72');
    await userEvent.click(screen.getByRole('button', { name: 'Save vitals' }));
    await screen.findByRole('heading', { name: 'Vitals saved' });
    expect(
      within(screen.getByRole('group', { name: 'Allergy 1' })).getByRole('textbox', {
        name: /^Substance/,
      }),
    ).toHaveValue('Latex');
  });
});

describe('the allergies form', () => {
  const openEditor = async (patientId = 'pth_00001') => {
    renderApp({ entry: `/patients/${patientId}?tab=vitals` });
    await userEvent.click(await screen.findByRole('button', { name: /^(Edit|Record) allergies$/ }));
  };

  it('asks for a substance, and for a row when the patient has allergies', async () => {
    await openEditor();
    await userEvent.clear(
      within(screen.getByRole('group', { name: 'Allergy 1' })).getByRole('textbox', {
        name: /^Substance/,
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save allergies' }));
    expect(await screen.findByText('This field is required.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove allergy 1' }));
    // The row's button went with it: focus moves on, not to the page.
    expect(screen.getByRole('button', { name: 'Add an allergy' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Save allergies' }));
    expect(
      await screen.findByText('Add at least one allergy, or choose No known allergies.'),
    ).toBeInTheDocument();
  });

  it('sends what was typed, trimmed, and no reaction of spaces', async () => {
    const sent: unknown[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PUT')
        void request
          .clone()
          .json()
          .then((body: unknown) => sent.push(body));
    });
    await openEditor('pth_00002');
    const row = screen.getByRole('group', { name: 'Allergy 1' });
    await userEvent.type(within(row).getByRole('textbox', { name: /^Substance/ }), '  Aspirin  ');
    await userEvent.type(within(row).getByRole('textbox', { name: /^Reaction/ }), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Save allergies' }));
    expect(await screen.findByText('Allergies saved.')).toBeInTheDocument();
    expect(sent[0]).toEqual({
      version: 0,
      status: 'listed',
      items: [{ substance: 'Aspirin', severity: 'unknown' }],
    });
  });

  it('says a failure that is not a conflict, and lets Save be pressed again', async () => {
    server.use(
      http.put('*/api/patients/:patientId/allergies', () =>
        HttpResponse.json(
          { error: { code: 'internal', message: 'x', requestId: 'r' } },
          { status: 500 },
        ),
      ),
    );
    await openEditor();
    await userEvent.click(screen.getByRole('button', { name: 'Save allergies' }));
    expect(
      await screen.findByText('Something went wrong on our side. Try again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save allergies' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('writes nothing when the answer arrives after another person signed in', async () => {
    let release: () => void = () => {};
    server.use(
      http.put('*/api/patients/:patientId/allergies', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return undefined;
      }),
    );
    const { queryClient } = renderApp({ entry: '/patients/pth_00001?tab=vitals' });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit allergies' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add an allergy' }));
    await userEvent.type(
      within(screen.getByRole('group', { name: 'Allergy 2' })).getByRole('textbox', {
        name: /^Substance/,
      }),
      'Peanuts',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save allergies' }));
    // The session now belongs to someone else at the same hospital.
    queryClient.setQueryData(sessionKey, sessionFor(USER_IDS.doctor, HOSPITAL));
    release();
    await delay(50);
    const held = queryClient
      .getQueryCache()
      .findAll({ queryKey: ['tenant', HOSPITAL, 'triage'] })
      .map((query) => JSON.stringify(query.state.data));
    expect(held.join()).not.toContain('Peanuts');
  });
});

describe('the history after a correction', () => {
  it('labels the correction and the reading it corrects, which cannot be corrected again', async () => {
    await api.POST('/patients/{patientId}/vitals', {
      params: { path: { patientId: 'pth_00001' }, header: { 'idempotency-key': 'history-fix-1' } },
      body: { pulse: 90, correctsId: 'vit_h_2', correctionReason: 'Recounted.' },
    });
    renderApp({ entry: '/patients/pth_00001?tab=vitals' });
    expect(await screen.findByText('3 readings')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Vitals readings' });
    expect(within(table).getByText('Correction')).toBeInTheDocument();
    expect(within(table).getByText('Corrected')).toBeInTheDocument();
    const corrects = within(table).getAllByRole('button', { name: /^Correct: / });
    expect(
      corrects.filter((button) => button.getAttribute('aria-disabled') === 'true'),
    ).toHaveLength(1);
  });
});

describe('switching hospital', () => {
  it('leaves none of the first hospital’s triage data behind', async () => {
    signIn(USER_IDS.doctor, HOSPITAL);
    const { queryClient } = renderApp({ entry: '/patients/pth_00001?tab=vitals' });
    expect(await screen.findByText('Penicillin')).toBeInTheDocument();
    expect(await screen.findByText('2 readings')).toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Hospital' }),
      TENANT_IDS.clinic,
    );
    await waitFor(() =>
      expect(queryClient.getQueryCache().findAll({ queryKey: ['tenant', HOSPITAL] })).toHaveLength(
        0,
      ),
    );
    expect(screen.queryByText('Penicillin')).not.toBeInTheDocument();
  });
});

describe('TriageSummary', () => {
  it('shows the allergies and the newest reading, marked', async () => {
    renderWithProviders(<TriageSummary patientId="pth_00001" />);
    expect(await screen.findByText('Penicillin')).toBeInTheDocument();
    expect(await screen.findByText('152/94 mmHg')).toBeInTheDocument();
    expect(screen.getAllByText('High')).toHaveLength(2);
    await expectNoAxeViolations();
  });

  it('says when no vitals were recorded', async () => {
    renderWithProviders(<TriageSummary patientId="pth_00002" />);
    expect(await screen.findByText('No vitals recorded.')).toBeInTheDocument();
    expect(screen.getByText('Not asked yet.')).toBeInTheDocument();
  });

  it('shows each part only to whoever may read it', async () => {
    revokePermission(HOSPITAL, 'admin', 'allergy:read');
    renderWithProviders(<TriageSummary patientId="pth_00001" />);
    expect(await screen.findByText('152/94 mmHg')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Allergies' })).not.toBeInTheDocument();
  });

  it('renders nothing with the switch off', async () => {
    setTenantFeature(HOSPITAL, 'triage', false);
    renderWithProviders(
      <>
        <h1>Consultation</h1>
        <TriageSummary patientId="pth_00001" />
      </>,
    );
    await screen.findByRole('heading', { name: 'Consultation' });
    expect(screen.queryByRole('heading', { name: 'Latest vitals' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Allergies' })).not.toBeInTheDocument();
  });
});
