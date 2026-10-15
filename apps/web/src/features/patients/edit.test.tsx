import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  signOut as signOutOnServer,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { editMockPatient } from '@/mocks/handlers/patients';
import { server } from '@/mocks/node';
import { renderApp } from '@/test/render';

/** The first synthetic patient of the hospital: Asha Verma1, version 1. */
const ID = 'pth_00001';
const RECORD = { name: 'Asha Verma1' };
const EDITING = { name: 'Edit Asha Verma1' };
const NO_ACCESS = { name: 'You do not have access to this page' };

const openRecord = () => renderApp({ entry: `/patients/${ID}` });
const openEdit = (id = ID) => renderApp({ entry: `/patients/${id}/edit` });
const save = () => userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
const details = () => within(screen.getByRole('tabpanel'));

async function retype(label: RegExp, text: string) {
  const field = await screen.findByLabelText(label);
  await userEvent.clear(field);
  if (text) {
    await userEvent.click(field);
    await userEvent.paste(text);
  }
}

/** Records what each save sends, then lets the mock backend answer. */
function watchSaves() {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.patch('*/api/patients/:id', async ({ request }) => {
      bodies.push((await request.clone().json()) as Record<string, unknown>);
      return undefined;
    }),
  );
  return bodies;
}

/** Holds every save until the test lets it through, so "before the server answers" is a state. */
function holdSaves() {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.patch('*/api/patients/:id', async () => {
      await held;
      return undefined;
    }),
  );
  return () => release();
}

const serverError = () =>
  HttpResponse.json(
    { error: { code: 'internal_error', message: 'boom', requestId: 'req_mock' } },
    { status: 500 },
  );

describe('editing a patient', () => {
  it('is offered on the record to a role that may change it, and opens the form with the record', async () => {
    openRecord();
    await userEvent.click(await screen.findByRole('link', { name: 'Edit' }));

    expect(await screen.findByRole('heading', EDITING)).toBeInTheDocument();
    expect(screen.getByLabelText(/^First name/)).toHaveValue('Asha');
    expect(screen.getByLabelText(/^Last name/)).toHaveValue('Verma1');
    expect(screen.getByLabelText(/^Date of birth/)).toHaveValue('1950-01-01');
    expect(screen.getByLabelText(/^Phone number/)).toHaveValue('+91 98000 10000');
    expect(screen.getByLabelText(/^Email/)).toHaveValue('patient1@example.test');
    expect(screen.getByLabelText(/^Address/)).toHaveValue('1 Sample Street');
    expect(screen.getByText('MRN MRN-PTH-00001. The MRN cannot be changed.')).toBeInTheDocument();
  });

  it('is not offered to a role that may only read', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient:update');
    const record = openRecord();
    await screen.findByRole('heading', RECORD);
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    record.unmount();

    openEdit();
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('saves only what changed, from the version it read, and shows the change before the server answers', async () => {
    const saves = watchSaves();
    const release = holdSaves();
    const { router } = openEdit();
    await screen.findByRole('heading', EDITING);

    await retype(/^First name/, 'Aasha');
    await retype(/^Email/, '');
    await save();

    // Back on the record at once, already showing the change, with the server still to answer.
    expect(await screen.findByRole('heading', { name: 'Aasha Verma1' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/patients/${ID}`);
    expect(details().getByText('Not recorded')).toBeInTheDocument();
    // One save at a time: no second edit until this one is in.
    const saving = await screen.findByText('Saving your changes…');
    // Said from a status region, which stays to say how it ended.
    expect(saving).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();

    release();

    // It stays once the server has answered, with nothing left over to review.
    const editAgain = await screen.findByRole('link', { name: 'Edit' });
    expect(saving).toHaveTextContent('Your changes were saved.');
    expect(saves).toEqual([{ expectedVersion: 1, firstName: 'Aasha', email: null }]);
    expect(screen.getByRole('heading', { name: 'Aasha Verma1' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // A later edit starts from the saved record, at its new version.
    await userEvent.click(editAgain);
    expect(await screen.findByLabelText(/^First name/)).toHaveValue('Aasha');
    await retype(/^Last name/, 'Varma1');
    await save();
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]).toEqual({ expectedVersion: 2, lastName: 'Varma1' });
  });

  it('sends a changed date of birth, gender and consent, and submits from the keyboard', async () => {
    const saves = watchSaves();
    openEdit();
    await screen.findByRole('heading', EDITING);

    await retype(/^Date of birth/, '1950-02-03');
    await userEvent.selectOptions(screen.getByLabelText(/^Gender/), 'Other');
    await userEvent.click(screen.getByLabelText(/agrees to be contacted/));
    screen.getByLabelText(/^First name/).focus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toEqual({
      expectedVersion: 1,
      dob: '1950-02-03',
      gender: 'other',
      contactConsent: { given: false },
    });
    expect(await details().findByText(/^Declined, recorded /)).toBeInTheDocument();
  });

  it('goes back without asking the server when nothing was changed', async () => {
    const saves = watchSaves();
    const { router } = openEdit();
    await screen.findByRole('heading', EDITING);

    await save();

    expect(await screen.findByRole('heading', RECORD)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/patients/${ID}`);
    expect(saves).toEqual([]);
  });

  it('checks the details before sending anything', async () => {
    const saves = watchSaves();
    openEdit();
    await screen.findByRole('heading', EDITING);

    await retype(/^First name/, '');
    await retype(/^Phone number/, 'abc');
    await save();

    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
    expect(screen.getByRole('heading', EDITING)).toBeInTheDocument();
    expect(saves).toEqual([]);
  });

  it('keeps what is being typed when the record is refreshed in the background', async () => {
    const saves = watchSaves();
    const { queryClient } = openEdit();
    await screen.findByRole('heading', EDITING);
    await retype(/^Address/, '9 New Lane');

    // Someone else saves, and this screen's copy of the record is refreshed while typing.
    editMockPatient(ID, { firstName: 'Ashaa' });
    await act(() => queryClient.refetchQueries({ queryKey: ['tenant'] }));

    // Nothing typed is lost, and the form still works from the record it opened with: the
    // server, not a silent swap, is what tells the person that the record has moved on.
    expect(screen.getByLabelText(/^Address/)).toHaveValue('9 New Lane');
    expect(screen.getByLabelText(/^First name/)).toHaveValue('Asha');
    await save();
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toEqual({ expectedVersion: 1, address: '9 New Lane' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else changed this record');
  });

  it('puts the record back and keeps the typing when the server refuses the change', async () => {
    let failing = true;
    server.use(http.patch('*/api/patients/:id', () => (failing ? serverError() : undefined)));
    openEdit();
    await screen.findByRole('heading', EDITING);

    await retype(/^First name/, 'Aasha');
    await save();

    // The record is as it was, and says the change did not go through.
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Your changes to this record were not saved.');
    expect(screen.getByRole('heading', RECORD)).toBeInTheDocument();
    // The alert says it once; nothing claims it was saved.
    expect(screen.queryByText('Your changes were saved.')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Aasha Verma1' })).not.toBeInTheDocument();

    // What was typed is still there to send again.
    await userEvent.click(within(banner).getByRole('link', { name: 'Review your changes' }));
    expect(await screen.findByLabelText(/^First name/)).toHaveValue('Aasha');
    expect(screen.getByRole('alert')).toHaveTextContent('Your changes were not saved.');

    failing = false;
    await save();
    expect(await screen.findByRole('heading', { name: 'Aasha Verma1' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('lets the typing be discarded from the record', async () => {
    server.use(http.patch('*/api/patients/:id', serverError));
    openEdit();
    await screen.findByRole('heading', EDITING);
    await retype(/^First name/, 'Aasha');
    await save();

    await userEvent.click(await screen.findByRole('button', { name: 'Discard them' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Thrown away is not saved: nothing may say it was.
    expect(screen.queryByText('Your changes were saved.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Edit' }));
    expect(await screen.findByLabelText(/^First name/)).toHaveValue('Asha');
  });

  it('writes nothing back when the answer arrives after signing out', async () => {
    const release = holdSaves();
    const { queryClient } = openEdit();
    await screen.findByRole('heading', EDITING);
    await retype(/^First name/, 'Aasha');
    await save();
    await screen.findByRole('heading', { name: 'Aasha Verma1' });

    // The person signs out with the save still on its way.
    signOutOnServer();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    release();
    // Long enough for the held answer to have arrived and been handled.
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)));

    // Nothing of the patient, the edit or the hospital is left for whoever signs in next.
    const left = queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[0] === 'tenant');
    expect(left).toEqual([]);
  });
});

describe('two people editing the same patient', () => {
  it('refuses the later save, then saves it on top of the other person’s changes without undoing them', async () => {
    const saves = watchSaves();
    openEdit();
    await screen.findByRole('heading', EDITING);
    await retype(/^Address/, '9 New Lane');

    // Meanwhile someone else corrects the phone number and the first name.
    editMockPatient(ID, { phone: '+91 98000 55555', firstName: 'Ashaa' });
    await save();

    // Not saved, and the record now shows the other person's version.
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Someone else changed this record while you were editing it');
    expect(await screen.findByRole('heading', { name: 'Ashaa Verma1' })).toBeInTheDocument();
    expect(details().getByText('1 Sample Street')).toBeInTheDocument();

    await userEvent.click(within(banner).getByRole('link', { name: 'Review your changes' }));

    // The address typed here is intact. The fields this person never touched hold what the other
    // person saved, so saving again cannot undo it. Nothing was changed by both, so no field is
    // marked.
    expect(await screen.findByLabelText(/^Address/)).toHaveValue('9 New Lane');
    expect(screen.getByLabelText(/^First name/)).toHaveValue('Ashaa');
    expect(screen.getByLabelText(/^Phone number/)).toHaveValue('+91 98000 55555');
    expect(screen.queryByText(/^Now saved as/)).not.toBeInTheDocument();

    await save();

    expect(await details().findByText('9 New Lane')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ashaa Verma1' })).toBeInTheDocument();
    expect(details().getByText('+91 98000 55555')).toBeInTheDocument();
    // Only the address, from the version now on record.
    expect(saves.at(-1)).toEqual({ expectedVersion: 2, address: '9 New Lane' });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('marks a field both people changed, keeping what was typed and showing what is saved', async () => {
    openEdit();
    await screen.findByRole('heading', EDITING);
    await retype(/^First name/, 'Aasha');
    await retype(/^Email/, 'asha@example.test');

    editMockPatient(ID, { firstName: 'Ashaa', email: null, dob: '1950-01-02' });
    await save();
    const banner = await screen.findByRole('alert');
    await userEvent.click(within(banner).getByRole('link', { name: 'Review your changes' }));

    expect(await screen.findByLabelText(/^First name/)).toHaveValue('Aasha');
    expect(screen.getByText('Now saved as: Ashaa')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email/)).toHaveValue('asha@example.test');
    expect(screen.getByText('Now saved as empty')).toBeInTheDocument();
    // The date of birth was changed by the other person only: taken, and not marked.
    expect(screen.getByLabelText(/^Date of birth/)).toHaveValue('1950-01-02');
    expect(screen.getAllByText(/^Now saved as/)).toHaveLength(2);
    expect(screen.getByRole('alert')).toHaveTextContent('Where you both changed the same field');
  });

  it('drops the unsaved edit when the person accepts the record as it now is', async () => {
    openEdit();
    await screen.findByRole('heading', EDITING);
    await retype(/^First name/, 'Aasha');
    editMockPatient(ID, { lastName: 'Varma1' });
    await save();
    const banner = await screen.findByRole('alert');
    await userEvent.click(within(banner).getByRole('link', { name: 'Review your changes' }));

    // They decide the saved first name was right after all, and save with nothing to change.
    await retype(/^First name/, 'Asha');
    await save();

    expect(await screen.findByRole('heading', { name: 'Asha Varma1' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('editing without access to contact details', () => {
  it('shows no contact fields, says why, and never sends one', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient.contact:read');
    const saves = watchSaves();
    openEdit();
    await screen.findByRole('heading', EDITING);

    expect(screen.queryByLabelText(/^Phone number/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Email/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Address/)).not.toBeInTheDocument();
    expect(screen.getByText(/^Your role does not include contact details/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('example.test');
    expect(document.body.textContent).not.toContain('98000 10000');

    await retype(/^Last name/, 'Varma1');
    await save();

    expect(await screen.findByRole('heading', { name: 'Asha Varma1' })).toBeInTheDocument();
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toEqual({ expectedVersion: 1, lastName: 'Varma1' });
  });

  it('does not clear contact details when an edit typed without access is reopened with it', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient.contact:read');
    let failing = true;
    server.use(http.patch('*/api/patients/:id', () => (failing ? serverError() : undefined)));
    const saves = watchSaves();
    const first = openEdit();
    await screen.findByRole('heading', EDITING);
    await retype(/^Last name/, 'Varma1');
    await save();
    await screen.findByRole('alert');

    // The role is given access to contact details before the edit is looked at again.
    grantPermission(TENANT_IDS.hospital, 'admin', 'patient.contact:read');
    await act(() => first.queryClient.refetchQueries());
    await userEvent.click(await screen.findByRole('link', { name: 'Review your changes' }));

    // The contact fields show the real values, not the blanks of a form that had hidden them.
    expect(await screen.findByLabelText(/^Email/)).toHaveValue('patient1@example.test');
    expect(screen.getByLabelText(/^Address/)).toHaveValue('1 Sample Street');
    expect(screen.getByLabelText(/^Last name/)).toHaveValue('Varma1');

    failing = false;
    await save();
    await waitFor(() => expect(saves.at(-1)).toEqual({ expectedVersion: 1, lastName: 'Varma1' }));
  });
});

describe('who can reach the edit screen', () => {
  it('is closed with the module off, and shows nothing of another hospital’s patient', async () => {
    setTenantFeature(TENANT_IDS.hospital, 'patients', false);
    const closed = openEdit();
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
    closed.unmount();

    // The doctor at the clinic, with the address of a hospital patient.
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    openEdit();
    expect(await screen.findByRole('heading', { name: 'Patient not found' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Asha Verma1');
  });
});
