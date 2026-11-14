import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { revokePermission, TENANT_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const TARGET = 'pth_00001';

/** Merges the second sample patient into the first through the screen, ending on its history. */
async function mergeAndOpenHistory() {
  renderApp({ entry: `/patients/${TARGET}/merge` });
  await userEvent.type(await screen.findByRole('combobox'), 'MRN-PTH-00002');
  await userEvent.click(await screen.findByRole('option', { name: /Bilal Silva2/ }));
  await screen.findByText('Duplicate to merge');
  await userEvent.type(screen.getByLabelText(/^Why these records/), 'Same person');
  await userEvent.click(screen.getByRole('button', { name: 'Merge records' }));
  await userEvent.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Merge' }),
  );
  await userEvent.click(await screen.findByRole('link', { name: 'Open the patient' }));
  await userEvent.click(await screen.findByRole('tab', { name: 'Merge history' }));
  const history = await screen.findByRole('region', { name: 'Records merged into this one' });
  await within(history).findByText('Same person');
  return history;
}

const undoButton = (scope: HTMLElement) =>
  within(scope).getByRole('button', { name: /Undo merge/ });

describe('undoing a merge (#870)', { timeout: 30_000 }, () => {
  it('undoes a merge with a reason and shows the result', async () => {
    const sent: Array<{ body: Record<string, unknown>; key: string | null }> = [];
    server.use(
      http.post('*/api/patients/:id/unmerge', async ({ request }) => {
        sent.push({
          body: (await request.clone().json()) as Record<string, unknown>,
          key: request.headers.get('Idempotency-Key'),
        });
        return undefined;
      }),
    );
    const history = await mergeAndOpenHistory();
    await waitFor(() => expect(undoButton(history)).not.toHaveAttribute('aria-disabled', 'true'));
    await userEvent.click(undoButton(history));

    const dialog = await screen.findByRole('alertdialog', { name: 'Undo this merge?' });
    // No reason, no request.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Undo merge' }));
    expect(sent).toHaveLength(0);
    await userEvent.type(within(dialog).getByLabelText(/^Why the merge/), 'Wrong person');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Undo merge' }));

    expect(await screen.findByText('The merge was undone.')).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ reason: 'Wrong person' });
    expect(sent[0]?.key).toBeTruthy();
    expect(await within(history).findByText(/Undone on .* Wrong person/)).toBeInTheDocument();
    expect(undoButton(history)).toHaveAttribute('aria-disabled', 'true');
    await expectNoAxeViolations(document.body);
  });

  it('says a refusal in words', async () => {
    server.use(
      http.post('*/api/patients/:id/unmerge', () =>
        HttpResponse.json(
          { error: { code: 'unmerge_unsupported', message: 'x', requestId: 'req_mock' } },
          { status: 409 },
        ),
      ),
    );
    const history = await mergeAndOpenHistory();
    await waitFor(() => expect(undoButton(history)).not.toHaveAttribute('aria-disabled', 'true'));
    await userEvent.click(undoButton(history));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByLabelText(/^Why the merge/), 'Mistake');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Undo merge' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/cannot give them back/);
  });

  it('turns the action off once the window is set to zero, and saves the setting', async () => {
    const history = await mergeAndOpenHistory();
    const field = await screen.findByLabelText('Days a merge can be undone');
    await waitFor(() => expect(field).toHaveValue('30'));
    await userEvent.clear(field);
    await userEvent.type(field, '400');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/whole number of days/)).toBeInTheDocument();

    await userEvent.clear(field);
    await userEvent.type(field, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The setting was saved.')).toBeInTheDocument();
    await waitFor(() => expect(undoButton(history)).toHaveAttribute('aria-disabled', 'true'));
    expect(within(history).getByText(/turned off/)).toBeInTheDocument();
  });

  it('offers nothing to a role without patient:unmerge, which still reads the history', async () => {
    revokePermission(TENANT_IDS.hospital, 'admin', 'patient:unmerge');
    const history = await mergeAndOpenHistory();
    expect(within(history).queryByRole('button', { name: /Undo merge/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Days a merge can be undone')).not.toBeInTheDocument();
  });
});
