import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { addMockQueueToken, mockQueueToken } from '@/mocks/handlers/queue';
import { server } from '@/mocks/node';
import { renderApp } from '@/test/render';

// A scanned OPD sheet attached to a visit from the queue (#1202).

const HOSPITAL = TENANT_IDS.hospital;
const NAME = /^Attach OPD sheet, token/;
const photo = () => new File(['sheet'], 'sheet.jpg', { type: 'image/jpeg' });

async function openDialog(token = 'Attach OPD sheet, token 1') {
  renderApp({ entry: '/queue' });
  const [button] = await screen.findAllByRole('button', { name: token });
  await userEvent.click(button!);
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('Check that the name and token match the paper.');
  return dialog;
}

describe('attaching a scanned OPD sheet', () => {
  afterEach(() => {
    server.events.removeAllListeners();
  });

  it('names the patient and token, attaches the file and closes the visit', async () => {
    const dialog = await openDialog();
    const submit = within(dialog).getByRole('button', { name: /^Attach to .+, token 1$/ });
    expect(within(dialog).queryByRole('button', { name: 'Close visit' })).toBeNull();
    await expectNoAxeViolations();

    await userEvent.upload(within(dialog).getByLabelText('Choose a file'), photo());
    await userEvent.click(submit);
    expect(await within(dialog).findByText(/The sheet was attached/)).toBeVisible();
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Close visit' }));
    expect(await within(dialog).findByText('The visit is closed.')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Close visit' })).toBeNull();
    // Nothing of the file or the patient is kept in the browser.
    expect(window.localStorage).toHaveLength(0);
    expect(window.sessionStorage).toHaveLength(0);
  });

  /** The reads of paper visits from here on, each of them audited by the server. */
  function countReads() {
    const reads: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'GET' && request.url.endsWith('/paper-visit')) reads.push(request.url);
    });
    return reads;
  }

  it('shows what a change answered with, without reading the visit again', async () => {
    const reads = countReads();
    const dialog = await openDialog();
    expect(reads).toHaveLength(1);

    await userEvent.upload(within(dialog).getByLabelText('Choose a file'), photo());
    await userEvent.click(within(dialog).getByRole('button', { name: /^Attach to/ }));
    expect(await within(dialog).findByText(/The sheet was attached/)).toBeVisible();
    // The upload answers with a document, not the visit: one read shows the new sheet.
    await waitFor(() => expect(reads).toHaveLength(2));

    await userEvent.click(await within(dialog).findByRole('button', { name: 'Close visit' }));
    expect(await within(dialog).findByText('The visit is closed.')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Close visit' })).toBeNull();

    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Wrong sheet: retire sheet.jpg' }),
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Why it is retired/ }),
      'Wrong visit',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retire sheet' }));
    expect(await within(dialog).findByText(/The sheet was retired/)).toBeVisible();
    expect(
      within(dialog).queryByRole('button', { name: 'Wrong sheet: retire sheet.jpg' }),
    ).toBeNull();
    // The token asked about stays named.
    expect(dialog).toHaveTextContent(/Token\s*1/);
    expect(reads).toHaveLength(2);
  });

  it('reads the visit again after a refused change', async () => {
    server.use(
      http.post('*/api/encounters/:encounterId/paper-visit/close', () =>
        HttpResponse.json(
          { error: { code: 'conflict', message: 'no', requestId: 'r' } },
          { status: 409 },
        ),
      ),
    );
    const reads = countReads();
    const dialog = await openDialog();
    await userEvent.upload(within(dialog).getByLabelText('Choose a file'), photo());
    await userEvent.click(within(dialog).getByRole('button', { name: /^Attach to/ }));
    await within(dialog).findByText(/The sheet was attached/);
    await waitFor(() => expect(reads).toHaveLength(2));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Close visit' }));
    expect(await within(dialog).findByRole('alert')).toBeVisible();
    await waitFor(() => expect(reads).toHaveLength(3));
  });

  it('retires a wrong sheet with a reason, after which the visit cannot be closed', async () => {
    const dialog = await openDialog();
    await userEvent.upload(within(dialog).getByLabelText('Take a photo of the sheet'), photo());
    await userEvent.click(within(dialog).getByRole('button', { name: /^Attach to/ }));
    await userEvent.click(
      await within(dialog).findByRole('button', { name: 'Wrong sheet: retire sheet.jpg' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retire sheet' }));
    const reason = within(dialog).getByRole('textbox', { name: /Why it is retired/ });
    expect(reason).toHaveFocus();
    await userEvent.type(reason, 'Wrong visit');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retire sheet' }));
    expect(await within(dialog).findByText(/The sheet was retired/)).toBeVisible();
    await waitFor(() =>
      expect(within(dialog).queryByRole('button', { name: 'Close visit' })).toBeNull(),
    );
  });

  /** Attaches to token 1, which opens its visit, then retires the sheet as wrong. */
  async function openedByMistake() {
    const dialog = await openDialog();
    await userEvent.upload(within(dialog).getByLabelText('Choose a file'), photo());
    await userEvent.click(within(dialog).getByRole('button', { name: /^Attach to/ }));
    await within(dialog).findByText(/The sheet was attached/);
    const wrong = await within(dialog).findByRole('button', {
      name: 'Wrong sheet: retire sheet.jpg',
    });
    // A visit with a file on it is not cancelled.
    expect(within(dialog).queryByRole('button', { name: 'Cancel visit' })).toBeNull();
    await userEvent.click(wrong);
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Why it is retired/ }),
      'Wrong token',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retire sheet' }));
    await within(dialog).findByText(/The sheet was retired/);
    return dialog;
  }

  it('cancels an empty visit opened for the wrong token, with a reason', async () => {
    const dialog = await openedByMistake();
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Cancel visit' }));
    expect(within(dialog).getByRole('heading', { name: 'Cancel this visit' })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep the visit' }));
    const cancel = within(dialog).getByRole('button', { name: 'Cancel visit' });
    expect(cancel).toHaveFocus();
    await userEvent.click(cancel);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel this visit' }));
    const reason = within(dialog).getByRole('textbox', { name: /Why it is cancelled/ });
    expect(reason).toHaveFocus();
    await expectNoAxeViolations();
    await userEvent.type(reason, 'Wrong token');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel this visit' }));
    const done = await within(dialog).findByText('The visit was cancelled.');
    await waitFor(() => expect(done).toHaveFocus());
    expect(within(dialog).queryByRole('button', { name: /^Attach to/ })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Cancel visit' })).toBeNull();
  });

  it('says why a cancel is refused, and reads the visit again', async () => {
    server.use(
      http.post('*/api/encounters/:encounterId/paper-visit/cancel', () =>
        HttpResponse.json(
          { error: { code: 'visit_not_empty', message: 'no', requestId: 'r' } },
          { status: 409 },
        ),
      ),
    );
    const dialog = await openedByMistake();
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Cancel visit' }));
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Why it is cancelled/ }),
      'Wrong token',
    );
    const reads = countReads();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel this visit' }));
    await waitFor(() =>
      expect(
        within(dialog)
          .getAllByRole('status')
          .some((each) => each.textContent?.includes('cannot be cancelled from here')),
      ).toBe(true),
    );
    await waitFor(() => expect(reads).toHaveLength(1));
  });

  it('does not offer cancelling a visit that was not opened from paper', async () => {
    renderApp({ entry: '/encounters/enc_h_1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Attach OPD sheet' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: /^Attach to / });
    expect(within(dialog).queryByRole('button', { name: 'Cancel visit' })).toBeNull();
  });

  it('asks for a file, and refuses a type that cannot be attached', async () => {
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: /^Attach to/ }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose a file or take a photo');
    await userEvent.upload(
      within(dialog).getByLabelText('Choose a file'),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
      { applyAccept: false },
    );
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Only a JPEG, PNG or PDF');
  });

  it.each([
    ['encounter:recordPaper', () => revokePermission(HOSPITAL, 'admin', 'encounter:recordPaper')],
    ['document:upload', () => revokePermission(HOSPITAL, 'admin', 'document:upload')],
    ['the documents module', () => setTenantFeature(HOSPITAL, 'documents', false)],
    ['the clinical module', () => setTenantFeature(HOSPITAL, 'clinical', false)],
  ])('is not offered without %s', async (_name, take) => {
    take();
    renderApp({ entry: '/queue' });
    await screen.findAllByRole('row');
    expect(screen.queryByRole('button', { name: NAME })).toBeNull();
  });

  it('is offered on an open visit, naming its patient', async () => {
    renderApp({ entry: '/encounters/enc_h_1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Attach OPD sheet' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('button', { name: /^Attach to / })).toBeVisible();
  });

  it('refuses to close a visit that is written up on screen', async () => {
    renderApp({ entry: '/encounters/enc_h_1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Attach OPD sheet' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.upload(await within(dialog).findByLabelText('Choose a file'), photo());
    await userEvent.click(within(dialog).getByRole('button', { name: /^Attach to/ }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Close visit' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'closes it from the consultation',
    );
  });

  it('works at another hospital, on its own patient and visit', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    setTenantFeature(TENANT_IDS.clinic, 'documents', true);
    grantPermission(TENANT_IDS.clinic, 'doctor', 'document:upload');
    renderApp({ entry: '/encounters/enc_c_1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Attach OPD sheet' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: /^Attach to / });
    // The clinic's patient, never one of the hospital.
    expect(dialog).toHaveTextContent('MRN-PTC-00001');
  });

  it('stays open, with the chosen file, when the token moves to another list', async () => {
    const dialog = await openDialog();
    await userEvent.upload(within(dialog).getByLabelText('Choose a file'), photo());
    // Another desk: the token is served, and the board hears of it.
    const token = mockQueueToken('qt_tenant_1_dep_h_01_1')!;
    token.status = 'served';
    addMockQueueToken({
      id: 'qt_moved',
      tenantId: HOSPITAL,
      departmentId: 'dep_h_02',
      patientId: 'pth_00004',
      status: 'waiting',
      issuedAt: new Date().toISOString(),
      callCount: 0,
      version: 1,
    });
    await waitFor(() => expect(screen.queryByText('Nobody is being served.')).not.toBeNull());
    expect(screen.getByRole('dialog')).toHaveTextContent('Chosen: sheet.jpg');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.body).not.toHaveFocus());
  });

  it('is offered on a served token', async () => {
    mockQueueToken('qt_tenant_1_dep_h_01_1')!.status = 'served';
    renderApp({ entry: '/queue' });
    await userEvent.click(await screen.findByRole('button', { name: 'Show served today' }));
    const served = await screen.findByRole('region', { name: 'Served' });
    expect(
      await within(served).findAllByRole('button', { name: 'Attach OPD sheet, token 1' }),
    ).not.toHaveLength(0);
  });

  it.each([
    ['conflict', 409, 'changed meanwhile'],
    ['opd_sheet_required', 409, 'Attach the OPD sheet before closing'],
    ['unsigned_notes', 409, 'not signed'],
  ])('says why closing is refused (%s)', async (code, status, words) => {
    server.use(
      http.post('*/api/encounters/:encounterId/paper-visit/close', () =>
        HttpResponse.json({ error: { code, message: 'no', requestId: 'r' } }, { status }),
      ),
    );
    const dialog = await openDialog();
    await userEvent.upload(within(dialog).getByLabelText('Choose a file'), photo());
    await userEvent.click(within(dialog).getByRole('button', { name: /^Attach to/ }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Close visit' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(words);
  });

  it('says a token without a doctor opens no visit', async () => {
    mockQueueToken('qt_tenant_1_dep_h_01_1')!.doctorId = undefined;
    renderApp({ entry: '/queue' });
    const [button] = await screen.findAllByRole('button', { name: 'Attach OPD sheet, token 1' });
    await userEvent.click(button!);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/no visit can be opened/);
    expect(within(dialog).queryByLabelText('Choose a file')).toBeNull();
  });

  it('sends the file again after a failed upload', async () => {
    server.use(
      http.put(
        '*/api/document-uploads/:documentId',
        () => new HttpResponse(null, { status: 500 }),
        { once: true },
      ),
    );
    const dialog = await openDialog();
    await userEvent.upload(within(dialog).getByLabelText('Choose a file'), photo());
    await userEvent.click(within(dialog).getByRole('button', { name: /^Attach to/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('could not be sent');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Attach to/ }));
    expect(await within(dialog).findByText(/The sheet was attached/)).toBeVisible();
  });

  it('shows the served tokens when asked for', async () => {
    renderApp({ entry: '/queue' });
    const show = await screen.findByRole('button', { name: 'Show served today' });
    await userEvent.click(show);
    expect(await screen.findByRole('heading', { name: 'Served' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide served' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
