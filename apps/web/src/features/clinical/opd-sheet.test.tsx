import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrints } from '@/mocks/handlers/clinical';
import { revokePermission, setTenantFeature, TENANT_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { expectNoAxeViolations } from '@/test/axe';
import { renderApp } from '@/test/render';

// The paper OPD sheet of a queue token (#1201).

const HOSPITAL = TENANT_IDS.hospital;
const NAME = /^Print OPD sheet, token/;

beforeEach(() => {
  vi.stubGlobal('print', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('printing the OPD sheet of a token', () => {
  it('records the print, then prints the patient, token and blank spaces', async () => {
    renderApp({ entry: '/queue' });
    const [button] = await screen.findAllByRole('button', { name: NAME });
    expect(mockPrints()).toHaveLength(0);
    await expectNoAxeViolations();
    await userEvent.click(button!);

    await waitFor(() => expect(window.print).toHaveBeenCalled());
    expect(mockPrints()).toEqual([expect.objectContaining({ entity: 'queue_token' })]);
    const sheet = within(document.body);
    expect(sheet.getByText('OPD sheet')).toBeInTheDocument();
    expect(sheet.getByText('Medicines and tests')).toBeInTheDocument();
  });

  it('leaves a blank for what the caller may not read', async () => {
    revokePermission(HOSPITAL, 'admin', 'vitals:read');
    revokePermission(HOSPITAL, 'admin', 'allergy:read');
    renderApp({ entry: '/queue' });
    const [button] = await screen.findAllByRole('button', { name: NAME });
    await userEvent.click(button!);
    await waitFor(() => expect(window.print).toHaveBeenCalled());
    expect(within(document.body).getByText('Blood pressure')).toBeInTheDocument();
    expect(within(document.body).getByText('Allergies')).toBeInTheDocument();
  });

  it('says so on paper when allergies cannot be read', async () => {
    server.use(
      http.get(
        '*/api/patients/:patientId/allergies',
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    renderApp({ entry: '/queue' });
    const [button] = await screen.findAllByRole('button', { name: NAME });
    await userEvent.click(button!);
    await waitFor(() => expect(window.print).toHaveBeenCalled());
    expect(within(document.body).getByText(/Allergies could not be read/)).toBeInTheDocument();
  });

  it('prints nothing when the print is refused', async () => {
    server.use(
      http.post('*/api/queue/tokens/:tokenId/opd-sheet', () =>
        HttpResponse.json(
          { error: { code: 'permission_denied', message: 'no', requestId: 'r' } },
          { status: 403 },
        ),
      ),
    );
    renderApp({ entry: '/queue' });
    const [button] = await screen.findAllByRole('button', { name: NAME });
    await userEvent.click(button!);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(window.print).not.toHaveBeenCalled();
  });

  it('is not offered without opdSheet:print', async () => {
    revokePermission(HOSPITAL, 'admin', 'opdSheet:print');
    renderApp({ entry: '/queue' });
    await screen.findByRole('heading', { level: 1 });
    await screen.findAllByRole('row');
    expect(screen.queryByRole('button', { name: NAME })).toBeNull();
  });

  it('is gone with the clinical module off', async () => {
    setTenantFeature(HOSPITAL, 'clinical', false);
    renderApp({ entry: '/queue' });
    await screen.findAllByRole('row');
    expect(screen.queryByRole('button', { name: NAME })).toBeNull();
  });
});
