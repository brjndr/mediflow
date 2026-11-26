import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  grantPermission,
  revokePermission,
  setTenantFeature,
  signIn,
  TENANT_IDS,
  USER_IDS,
} from '@/mocks/db';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// A scanned OPD sheet attached to a visit from the queue (#1202).

const HOSPITAL = TENANT_IDS.hospital;
const NAME = /^Attach OPD sheet, token/;
const SLOW = { timeout: 8000 };
const photo = () => new File(['sheet'], 'sheet.jpg', { type: 'image/jpeg' });

async function openDialog(token = 'Attach OPD sheet, token 1') {
  renderApp({ entry: '/queue' });
  const [button] = await screen.findAllByRole('button', { name: token }, SLOW);
  await userEvent.click(button!);
  const dialog = await screen.findByRole('dialog', {}, SLOW);
  await within(dialog).findByText('Check that the name and token match the paper.', {}, SLOW);
  return dialog;
}

describe('attaching a scanned OPD sheet', { timeout: 30000 }, () => {
  it('names the patient and token, attaches the file and closes the visit', async () => {
    const dialog = await openDialog();
    const submit = within(dialog).getByRole('button', { name: /^Attach to .+, token 1$/ });
    expect(within(dialog).queryByRole('button', { name: 'Close visit' })).toBeNull();
    await expectNoAxeViolations();

    await userEvent.upload(within(dialog).getByLabelText('Choose a file'), photo());
    await userEvent.click(submit);
    expect(await within(dialog).findByText(/The sheet was attached/, {}, SLOW)).toBeVisible();
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Close visit' }, SLOW));
    expect(await within(dialog).findByText('The visit is closed.', {}, SLOW)).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Close visit' })).toBeNull();
    // Nothing of the file or the patient is kept in the browser.
    expect(window.localStorage).toHaveLength(0);
    expect(window.sessionStorage).toHaveLength(0);
  });

  it('retires a wrong sheet with a reason, after which the visit cannot be closed', async () => {
    const dialog = await openDialog();
    await userEvent.upload(within(dialog).getByLabelText('Take a photo of the sheet'), photo());
    await userEvent.click(within(dialog).getByRole('button', { name: /^Attach to/ }));
    await userEvent.click(
      await within(dialog).findByRole('button', { name: 'Wrong sheet: retire sheet.jpg' }, SLOW),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retire sheet' }));
    const reason = within(dialog).getByRole('textbox', { name: /Why it is retired/ });
    expect(reason).toHaveFocus();
    await userEvent.type(reason, 'Wrong visit');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retire sheet' }));
    expect(await within(dialog).findByText(/The sheet was retired/, {}, SLOW)).toBeVisible();
    await waitFor(() =>
      expect(within(dialog).queryByRole('button', { name: 'Close visit' })).toBeNull(),
    );
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
    await screen.findAllByRole('row', {}, SLOW);
    expect(screen.queryByRole('button', { name: NAME })).toBeNull();
  });

  it('is offered on an open visit, naming its patient', async () => {
    renderApp({ entry: '/encounters/enc_h_1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Attach OPD sheet' }, SLOW));
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    expect(await within(dialog).findByRole('button', { name: /^Attach to / }, SLOW)).toBeVisible();
  });

  it('refuses to close a visit that is written up on screen', async () => {
    renderApp({ entry: '/encounters/enc_h_1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Attach OPD sheet' }, SLOW));
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    await userEvent.upload(
      await within(dialog).findByLabelText('Choose a file', {}, SLOW),
      photo(),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: /^Attach to/ }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Close visit' }, SLOW));
    expect(await within(dialog).findByRole('alert', {}, SLOW)).toHaveTextContent(
      'closes it from the consultation',
    );
  });

  it('works at another hospital, on its own patient and visit', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.clinic);
    setTenantFeature(TENANT_IDS.clinic, 'documents', true);
    grantPermission(TENANT_IDS.clinic, 'doctor', 'document:upload');
    renderApp({ entry: '/encounters/enc_c_1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Attach OPD sheet' }, SLOW));
    const dialog = await screen.findByRole('dialog', {}, SLOW);
    await within(dialog).findByRole('button', { name: /^Attach to / }, SLOW);
    // The clinic's patient, never one of the hospital.
    expect(dialog).toHaveTextContent('MRN-PTC-00001');
  });

  it('shows the served tokens when asked for', async () => {
    renderApp({ entry: '/queue' });
    const show = await screen.findByRole('button', { name: 'Show served today' }, SLOW);
    await userEvent.click(show);
    expect(await screen.findByRole('heading', { name: 'Served' }, SLOW)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide served' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
