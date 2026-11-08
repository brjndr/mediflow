import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { revokePermission, TENANT_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

const TARGET = 'pth_00001';
const SOURCE = 'pth_00002';
const CLINIC = 'ptc_00001';
const NO_ACCESS = { name: 'You do not have access to this page' };

const openMerge = (id = TARGET) => renderApp({ entry: `/patients/${id}/merge` });

/** Records the bodies of merges sent. */
function watchMerges() {
  const sent: Array<Record<string, unknown>> = [];
  server.use(
    http.post('*/api/patients/:id/merge', async ({ request }) => {
      sent.push((await request.clone().json()) as Record<string, unknown>);
      return undefined;
    }),
  );
  return sent;
}

async function chooseDuplicate() {
  await userEvent.type(await screen.findByRole('combobox'), 'MRN-PTH-00002');
  await userEvent.click(await screen.findByRole('option', { name: /Bilal Silva2/ }));
  expect(await screen.findByText('Duplicate to merge')).toBeInTheDocument();
}

describe('merging a duplicate patient', () => {
  it('shows both records and what moves, then merges after a confirmation and a reason', async () => {
    const sent = watchMerges();
    openMerge();
    await chooseDuplicate();

    const keeps = screen.getByRole('region', { name: 'Record that stays' });
    expect(within(keeps).getByText('MRN-PTH-00001')).toBeInTheDocument();
    const merged = screen.getByRole('region', { name: 'Duplicate to merge' });
    expect(within(merged).getByText('MRN-PTH-00002')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'What moves to the record that stays' })).getByText(
        'Documents',
      ),
    ).toBeInTheDocument();
    await expectNoAxeViolations(document.body);

    // No reason, no merge.
    await userEvent.click(screen.getByRole('button', { name: 'Merge records' }));
    expect(await screen.findByText(/required/i)).toBeInTheDocument();
    expect(sent).toHaveLength(0);

    await userEvent.type(
      screen.getByLabelText(/^Why these records/),
      'Same person, registered twice',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Merge records' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Merge these records?' });
    // Nothing is sent until the person confirms.
    expect(sent).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));

    expect(await screen.findByText('The records were merged.')).toBeInTheDocument();
    expect(sent).toEqual([
      {
        sourcePatientId: SOURCE,
        reason: 'Same person, registered twice',
        expectedVersion: 1,
        expectedSourceVersion: 1,
      },
    ]);
  });

  it('shows the merge in the history, and the merged record as read-only', async () => {
    openMerge();
    await chooseDuplicate();
    await userEvent.type(screen.getByLabelText(/^Why these records/), 'Same person');
    await userEvent.click(screen.getByRole('button', { name: 'Merge records' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Merge' }),
    );
    await userEvent.click(await screen.findByRole('link', { name: 'Open the patient' }));

    await userEvent.click(await screen.findByRole('tab', { name: 'Merge history' }));
    const history = await screen.findByRole('region', { name: 'Records merged into this one' });
    expect(await within(history).findByText('Same person')).toBeInTheDocument();
    expect(within(history).getByText(/Documents: 0/)).toBeInTheDocument();
  });

  it('says so when a record changed since it was read', async () => {
    server.use(
      http.post('*/api/patients/:id/merge', () =>
        HttpResponse.json(
          { error: { code: 'conflict', message: 'changed', requestId: 'req_mock' } },
          { status: 409 },
        ),
      ),
    );
    openMerge();
    await chooseDuplicate();
    await userEvent.type(screen.getByLabelText(/^Why these records/), 'Same person');
    await userEvent.click(screen.getByRole('button', { name: 'Merge records' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Merge' }),
    );

    expect(await screen.findByText(/changed since you opened it/)).toBeInTheDocument();
    expect(screen.queryByText('The records were merged.')).not.toBeInTheDocument();
  });

  it('is offered on the record to patient:merge, and not to a role without it', async () => {
    const record = renderApp({ entry: `/patients/${TARGET}` });
    expect(await screen.findByRole('link', { name: 'Merge a duplicate' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'Merge history' })).toBeInTheDocument();
    record.unmount();

    revokePermission(TENANT_IDS.hospital, 'admin', 'patient:merge');
    const without = renderApp({ entry: `/patients/${TARGET}` });
    await screen.findByRole('heading', { name: 'Asha Verma1' });
    expect(screen.queryByRole('link', { name: 'Merge a duplicate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Merge history' })).not.toBeInTheDocument();
    without.unmount();

    openMerge();
    expect(await screen.findByRole('heading', NO_ACCESS)).toBeInTheDocument();
  });

  it('cannot reach another hospital patient', async () => {
    openMerge(CLINIC);
    expect(await screen.findByRole('heading', { name: 'Patient not found' })).toBeInTheDocument();
    await waitFor(() => expect(document.body.textContent).not.toContain('MRN-PTC'));
  });
});
