import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  mockTenantTimezone,
  revokePermission,
  setRolePermissions,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { addMockAppointment } from '@/mocks/handlers/appointments';
import { editMockNote, mockEncounter, mockNotesOf } from '@/mocks/handlers/clinical';
import { server } from '@/mocks/node';
import { richTextToPlainText, sanitizeRichText } from '@/shared/ui/rich-text';
import { todayIn, zonedToUtc } from '@/shared/utils/timezone';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const HOSPITAL = TENANT_IDS.hospital;
const CLINIC = TENANT_IDS.clinic;
/** Being served at the hospital today by doc_h_01: token 1, for pth_00101. */
const CALLED_TOKEN = 'qt_tenant_1_dep_h_01_1';
const CONSULTATION = { name: 'Consultation', level: 1 };
const NO_ACCESS = { name: 'You do not have access to this page' };

// The editor scrolls the cursor into view after a command, which needs layout measurements jsdom
// does not have. Empty measurements are enough: nothing here depends on positions.
beforeAll(() => {
  const noRects = () => [] as unknown as DOMRectList;
  const noRect = () => new DOMRect(0, 0, 0, 0);
  for (const prototype of [Range.prototype, Element.prototype, Text.prototype] as object[]) {
    const target = prototype as { getClientRects?: unknown; getBoundingClientRect?: unknown };
    target.getClientRects ??= noRects;
    target.getBoundingClientRect ??= noRect;
  }
  document.elementFromPoint ??= () => null;
});

/** An appointment of doc_h_02 late today at the hospital, so it is still today. */
function addAppointment(id: string, status: 'scheduled' | 'cancelled' = 'scheduled') {
  const timezone = mockTenantTimezone(HOSPITAL);
  const day = todayIn(timezone);
  addMockAppointment({
    id,
    tenantId: HOSPITAL,
    patientId: 'pth_00002',
    doctorId: 'doc_h_02',
    startsAt: zonedToUtc(day, '23:30', timezone),
    endsAt: zonedToUtc(day, '23:45', timezone),
    status,
    version: 1,
  });
}

/** Every request opening an encounter, with its idempotency key. */
function watchOpens(): { key: string | null; body: unknown }[] {
  const seen: { key: string | null; body: unknown }[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/api/encounters')) {
      void request
        .clone()
        .json()
        .then((body: unknown) => seen.push({ key: request.headers.get('Idempotency-Key'), body }));
    }
  });
  return seen;
}

const openConsultation = async (id = 'enc_h_1') => {
  const app = renderApp({ entry: `/encounters/${id}` });
  await screen.findByRole('heading', CONSULTATION);
  return app;
};

const noteText = (encounterId: string, status: 'draft' | 'signed') =>
  mockNotesOf(encounterId)
    .filter((note) => note.status === status)
    .map((note) => richTextToPlainText(sanitizeRichText(note.body)));

/** Starts a draft and types into it. */
async function writeDraft(text: string) {
  await userEvent.click(await screen.findByRole('button', { name: 'Write a note' }));
  const editor = await screen.findByRole('textbox', { name: 'Note' });
  await userEvent.click(editor);
  await userEvent.keyboard(text);
  return editor;
}

describe('starting a consultation', () => {
  it('opens the encounter from the token being served, and finds it again the next time', async () => {
    const opens = watchOpens();
    const app = renderApp({ entry: '/queue' });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Start consultation, token 1' }),
    );

    await screen.findByRole('heading', CONSULTATION);
    const encounterPath = app.router.state.location.pathname;
    expect(encounterPath).toMatch(/^\/encounters\/enc_mock_\d+$/);
    await waitFor(() => expect(opens).toHaveLength(1));
    expect(opens[0]).toEqual({
      key: expect.stringMatching(/^[\w-]{8,}$/) as string,
      body: { patientId: 'pth_00101', queueTokenId: CALLED_TOKEN },
    });
    // Who the visit is for, with whom, and what is still to write.
    expect(await screen.findByText(/MRN MRN-PTH-00101/)).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('No notes yet.')).toBeInTheDocument();

    await app.router.navigate('/queue');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Start consultation, token 1' }),
    );
    await screen.findByRole('heading', CONSULTATION);
    expect(app.router.state.location.pathname).toBe(encounterPath);
    await expectNoAxeViolations();
  });

  it('opens the encounter from today’s appointment', async () => {
    const opens = watchOpens();
    addAppointment('apt_consult_1');
    const app = renderApp({ entry: '/appointments/apt_consult_1' });
    await userEvent.click(
      await screen.findByRole('button', { name: /^Start consultation, appointment at / }),
    );
    await screen.findByRole('heading', CONSULTATION);
    expect(app.router.state.location.pathname).toMatch(/^\/encounters\/enc_mock_\d+$/);
    await waitFor(() => expect(opens).toHaveLength(1));
    expect(opens[0]?.body).toEqual({ patientId: 'pth_00002', appointmentId: 'apt_consult_1' });
  });

  it('is not offered for a cancelled appointment, without patient:read, or with the module off', async () => {
    addAppointment('apt_consult_2', 'cancelled');
    const appointment = renderApp({ entry: '/appointments/apt_consult_2' });
    await screen.findByRole('heading', { name: 'Appointment', level: 1 });
    expect(screen.queryByRole('button', { name: /^Start consultation/ })).not.toBeInTheDocument();
    appointment.unmount();

    revokePermission(HOSPITAL, 'admin', 'patient:read');
    const board = renderApp({ entry: '/queue' });
    await screen.findAllByText(/^Token \d+$/);
    expect(screen.queryByRole('button', { name: /^Start consultation/ })).not.toBeInTheDocument();
    board.unmount();

    setTenantFeature(HOSPITAL, 'clinical', false);
    renderApp({ entry: '/queue' });
    await screen.findAllByText(/^Token \d+$/);
    expect(screen.queryByRole('button', { name: /^Start consultation/ })).not.toBeInTheDocument();
  });

  it('says why the server refused, beside the button', async () => {
    server.use(
      http.post('*/api/encounters', () =>
        HttpResponse.json(
          { error: { code: 'unknown_doctor', message: 'No such doctor', requestId: 'r' } },
          { status: 422 },
        ),
      ),
    );
    renderApp({ entry: '/queue' });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Start consultation, token 1' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No doctor you may consult for is set for this visit.',
    );
  });
});

describe('the consultation', () => {
  it('shows what triage found, the signed notes and the diagnoses', async () => {
    await openConsultation();
    expect(await screen.findByText(/MRN MRN-PTH-00001/)).toBeInTheDocument();
    // Triage's allergy, beside the notes.
    expect(await screen.findByText(/Penicillin/)).toBeInTheDocument();
    expect(
      await screen.findByText('Cough for a week, no fever. Chest clear on examination.'),
    ).toBeInTheDocument();
    expect(await screen.findAllByText(/J06\.9/)).not.toHaveLength(0);
    expect(screen.getAllByText('Provisional').length).toBeGreaterThan(0);
    await expectNoAxeViolations();
  });

  it(
    'keeps a draft on the server as it is written, never in browser storage, then signs it',
    { timeout: 15_000 },
    async () => {
      await openConsultation();
      const editor = await writeDraft('Improving on fluids.');
      // The new draft's heading took focus when it opened; the editor has it now.
      expect(editor).toHaveFocus();

      // Leaving the editor saves at once.
      await userEvent.tab();
      await waitFor(() => expect(noteText('enc_h_1', 'draft')).toEqual(['Improving on fluids.']));
      expect(await screen.findByText(/^Draft saved at /)).toBeInTheDocument();
      expect(window.localStorage).toHaveLength(0);
      expect(window.sessionStorage).toHaveLength(0);

      // More typing is saved over the same draft, after a pause.
      await userEvent.click(editor);
      await userEvent.keyboard(' Review tomorrow.');
      // What the editor holds, wherever jsdom put the cursor.
      const typed = editor.textContent ?? '';
      expect(typed).toContain('Review tomorrow.');
      await waitFor(() => expect(noteText('enc_h_1', 'draft')).toEqual([typed]), {
        timeout: 4000,
      });
      expect(mockNotesOf('enc_h_1').filter((note) => note.status === 'draft')).toHaveLength(1);

      await userEvent.click(screen.getByRole('button', { name: 'Sign note' }));
      const status = await screen.findByText('Note signed.');
      expect(status).toHaveAttribute('role', 'status');
      await waitFor(() => expect(status).toHaveFocus());
      expect(noteText('enc_h_1', 'draft')).toEqual([]);
      expect(noteText('enc_h_1', 'signed')).toContain(typed);
      expect(await screen.findByText(typed.trim())).toBeInTheDocument();
      expect(window.localStorage).toHaveLength(0);
      expect(window.sessionStorage).toHaveLength(0);
    },
  );

  it('pauses saving when the draft was saved from another window, and keeps the text chosen', async () => {
    await openConsultation();
    const editor = await writeDraft('First words.');
    await userEvent.tab();
    await waitFor(() => expect(noteText('enc_h_1', 'draft')).toEqual(['First words.']));
    const id = mockNotesOf('enc_h_1').find((note) => note.status === 'draft')?.id ?? '';
    editMockNote(id, 'Typed in another window.');

    await userEvent.click(editor);
    await userEvent.keyboard(' More here.');
    await userEvent.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent(/saved from another window/);
    expect(noteText('enc_h_1', 'draft')).toEqual(['Typed in another window.']);

    await userEvent.click(screen.getByRole('button', { name: 'Keep the text here' }));
    // What the editor holds, wherever the cursor put the new words.
    const typed = editor.textContent ?? '';
    expect(typed).toContain('More here.');
    await waitFor(() => expect(noteText('enc_h_1', 'draft')).toEqual([typed]));
  });

  it('refuses closing while a draft is unsigned, and closes once it is discarded', async () => {
    await openConsultation();
    await writeDraft('Not finished.');
    await userEvent.tab();
    await waitFor(() => expect(noteText('enc_h_1', 'draft')).toHaveLength(1));

    await userEvent.click(screen.getByRole('button', { name: 'Close consultation' }));
    expect(await screen.findByText(/A note is still a draft/)).toHaveAttribute('role', 'alert');

    await userEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    // The question takes the button's place; its safe answer has focus.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep it' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(await screen.findByText('Draft discarded.')).toBeInTheDocument();
    await waitFor(() => expect(noteText('enc_h_1', 'draft')).toEqual([]));

    await userEvent.click(screen.getByRole('button', { name: 'Close consultation' }));
    const closed = await screen.findByText('Consultation closed.');
    await waitFor(() => expect(closed).toHaveFocus());
    expect(mockEncounter('enc_h_1')?.status).toBe('closed');
    expect(screen.queryByRole('button', { name: 'Write a note' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Record a diagnosis' })).not.toBeInTheDocument();
  });

  it('amends a signed note with a reason, keeping the note it corrects', async () => {
    await openConsultation();
    await userEvent.click(await screen.findByRole('button', { name: 'Amend' }));
    const heading = await screen.findByRole('heading', { name: 'Amend this note' });
    await waitFor(() => expect(heading).toHaveFocus());
    const editor = await screen.findByRole('textbox', { name: 'Corrected note' });
    expect(editor).toHaveTextContent('Cough for a week');

    await userEvent.click(screen.getByRole('button', { name: 'Sign amendment' }));
    expect(await screen.findByText('This field is required.')).toBeInTheDocument();

    await userEvent.click(editor);
    await userEvent.keyboard(' Mild wheeze.');
    await userEvent.type(
      screen.getByRole('textbox', { name: /What the amendment corrects/ }),
      'Wheeze missed',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign amendment' }));
    expect(await screen.findByText('Amendment signed.')).toBeInTheDocument();
    expect(await screen.findByText('Amended: the amendment follows.')).toBeInTheDocument();
    expect(
      await screen.findByText(/^Amends the note signed .+ Reason: Wheeze missed$/),
    ).toBeInTheDocument();
    expect(noteText('enc_h_1', 'signed')).toHaveLength(2);
  });

  it('records a diagnosis from a code or words, and retracts one with a reason', async () => {
    await openConsultation();
    await screen.findByRole('heading', { name: 'Record a diagnosis' });
    await userEvent.click(screen.getByRole('button', { name: 'Record diagnosis' }));
    expect(
      await screen.findByText('Choose a code or write the diagnosis in words.'),
    ).toBeInTheDocument();

    await userEvent.type(screen.getByRole('combobox', { name: 'ICD-10 code' }), 'A90');
    await userEvent.click(await screen.findByRole('option', { name: /A90/ }));
    expect(screen.getByText('A90 Dengue fever')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Kind/ }), 'Final');
    await userEvent.click(screen.getByRole('button', { name: 'Record diagnosis' }));
    expect(await screen.findByText('Diagnosis recorded.')).toBeInTheDocument();
    const grid = screen.getByRole('table', { name: 'Diagnoses' });
    expect(await within(grid).findByText('A90 Dengue fever')).toBeInTheDocument();

    await userEvent.click(within(grid).getByRole('button', { name: /^Retract: J06\.9/ }));
    await screen.findByRole('heading', { name: /^Retract J06\.9/ });
    await userEvent.type(
      screen.getByRole('textbox', { name: /Why it no longer stands/ }),
      'Ruled out',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retract diagnosis' }));
    expect(await screen.findByText('Diagnosis retracted.')).toBeInTheDocument();
    expect(await within(grid).findByText(/^Retracted .+: Ruled out$/)).toBeInTheDocument();
  });

  it('cancels an encounter opened by mistake, and refuses one with records', async () => {
    await openConsultation();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel consultation' }));
    await userEvent.type(screen.getByRole('textbox', { name: /^Reason/ }), 'Wrong patient');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel consultation' }));
    expect(await screen.findByText(/Something is already recorded/)).toBeInTheDocument();
    expect(mockEncounter('enc_h_1')?.status).toBe('open');
  });
});

describe('access to the consultation', () => {
  it('shows a role without the note and diagnosis permissions the visit, not what it was for', async () => {
    setRolePermissions(HOSPITAL, 'admin', [
      { permission: 'encounter:read' },
      { permission: 'patient:read' },
      { permission: 'allergy:read' },
      { permission: 'vitals:read' },
    ]);
    await openConsultation();
    expect(await screen.findByText(/MRN MRN-PTH-00001/)).toBeInTheDocument();
    expect(await screen.findByText(/Penicillin/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Notes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Diagnoses' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Cough for a week/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close consultation' })).not.toBeInTheDocument();
  });

  it('reads notes without writing them for clinicalNote:read alone', async () => {
    revokePermission(HOSPITAL, 'admin', 'clinicalNote:write');
    revokePermission(HOSPITAL, 'admin', 'diagnosis:write');
    await openConsultation();
    expect(await screen.findByText(/Cough for a week/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write a note' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Amend' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Record a diagnosis' })).not.toBeInTheDocument();
  });

  it('is unreachable with the module off', async () => {
    setTenantFeature(HOSPITAL, 'clinical', false);
    renderApp({ entry: '/encounters/enc_h_1' });
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Consultations' })).not.toBeInTheDocument();
  });

  it('keeps each hospital’s consultations to itself', async () => {
    signIn(USER_IDS.doctor, CLINIC);
    const list = renderApp({ entry: '/encounters' });
    await screen.findByRole('heading', { name: 'Consultations', level: 1 });
    // Every doctor's, not only the signed-in doctor's own.
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Doctor' }),
      'Every doctor',
    );
    const grid = await screen.findByRole('table', { name: 'Consultations' });
    const links = await within(grid).findAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/encounters/enc_c_1']);
    expect(within(grid).queryByText(/PTH/)).not.toBeInTheDocument();
    list.unmount();

    renderApp({ entry: '/encounters/enc_h_1' });
    expect(await screen.findByText('This consultation is not available.')).toBeInTheDocument();
  });
});

describe('the consultations list', () => {
  it('lists the open consultations, and the closed ones when asked', async () => {
    const app = renderApp({ entry: '/encounters' });
    await screen.findByRole('heading', { name: 'Consultations', level: 1 });
    const grid = await screen.findByRole('table', { name: 'Consultations' });
    const open = await within(grid).findAllByRole('link');
    expect(open).toHaveLength(1);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Closed');
    await waitFor(() => expect(within(grid).getAllByText('Closed').length).toBeGreaterThan(0));
    await userEvent.click(within(grid).getAllByRole('link')[0]!);
    await screen.findByRole('heading', CONSULTATION);
    expect(app.router.state.location.pathname).toBe('/encounters/enc_h_2');
    await expectNoAxeViolations();
  });
});
