import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { sessionKey } from '@/app/session';
import { revokePermission, sessionFor, signIn, TENANT_IDS, USER_IDS } from '@/mocks/db';
import { server } from '@/mocks/node';
import { TENANT_HEADER } from '@/shared/api';
import { useSwitchTenant } from '@/tenancy';
import { renderWithProviders } from '@/test/render';
import { Can, useFeatureFlag, usePolicyRefresh } from '.';

/**
 * The less-travelled paths of policy refresh: a hidden tab, a failed refresh, an answer for the
 * wrong hospital, unmounting, and switching hospital. The main cases are in access.test.tsx.
 */

function Refresher(props: Parameters<typeof usePolicyRefresh>[0]) {
  usePolicyRefresh(props);
  return null;
}

function Gated() {
  const labOn = useFeatureFlag('laboratory');
  return (
    <div data-testid="screen">
      <Can permission="billing:refund">
        <button>Refund</button>
      </Can>
      <output>{labOn ? 'lab on' : 'lab off'}</output>
    </div>
  );
}

function SwitchToClinic() {
  const switchTenant = useSwitchTenant();
  return <button onClick={() => switchTenant.mutate(TENANT_IDS.clinic)}>Go to clinic</button>;
}

const refund = () => screen.queryByRole('button', { name: 'Refund' });
const ready = () => screen.findByTestId('screen');

interface PolicyRequest {
  ifNoneMatch: string | null;
  tenant: string | null;
}

/** Records every policy request, then lets the mock backend answer. */
function watchPolicyRequests() {
  const requests: PolicyRequest[] = [];
  server.use(
    http.get('*/api/session/policy', ({ request }) => {
      requests.push({
        ifNoneMatch: request.headers.get('If-None-Match'),
        tenant: request.headers.get(TENANT_HEADER),
      });
      return undefined;
    }),
  );
  return requests;
}

/** Makes the document report itself hidden or visible, as a browser does for a background tab. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  Reflect.deleteProperty(document, 'hidden');
});

describe('a hidden tab', () => {
  it('does not poll, and refreshes as soon as it is shown again if a refresh is due', async () => {
    const requests = watchPolicyRequests();
    setHidden(true);
    renderWithProviders(
      <>
        <Refresher intervalMs={25} />
        <Gated />
      </>,
    );
    await ready();
    revokePermission(TENANT_IDS.hospital, 'admin', 'billing:refund');

    await delay(120);
    expect(requests).toHaveLength(0);
    expect(refund()).toBeInTheDocument();

    setHidden(false);
    await waitFor(() => expect(refund()).not.toBeInTheDocument());
    expect(requests.length).toBeGreaterThanOrEqual(1);
  });

  it('does not refresh on becoming visible when the last refresh is recent', async () => {
    const requests = watchPolicyRequests();
    renderWithProviders(
      <>
        <Refresher intervalMs={600_000} />
        <Gated />
      </>,
    );
    await ready();
    setHidden(true);
    setHidden(false);
    await delay(60);
    expect(requests).toHaveLength(0);
  });
});

describe('a failed refresh', () => {
  it('keeps the current policy and succeeds on a later tick', async () => {
    let calls = 0;
    let failing = true;
    server.use(
      http.get('*/api/session/policy', () => {
        calls++;
        // 500 is not retried by the API client, so each refresh fails outright while this is on.
        return failing ? new HttpResponse(null, { status: 500 }) : undefined;
      }),
    );
    const { queryClient } = renderWithProviders(
      <>
        <Refresher intervalMs={25} />
        <Gated />
      </>,
    );
    await ready();
    const before = queryClient.getQueryData(sessionKey);
    revokePermission(TENANT_IDS.hospital, 'admin', 'billing:refund');

    // Several refreshes fail in a row.
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(3));
    // The failures changed nothing: same session object, action still offered.
    expect(queryClient.getQueryData(sessionKey)).toBe(before);
    expect(refund()).toBeInTheDocument();

    // The server recovers, and the next tick picks up the change.
    failing = false;
    await waitFor(() => expect(refund()).not.toBeInTheDocument());
  });
});

describe('an answer for another hospital', () => {
  it('is ignored', async () => {
    const clinicPolicy = sessionFor(USER_IDS.doctor, TENANT_IDS.clinic).policy;
    let calls = 0;
    server.use(
      http.get('*/api/session/policy', () => {
        calls++;
        return HttpResponse.json({ ...clinicPolicy, permissions: [], version: `other-${calls}` });
      }),
    );
    const { queryClient } = renderWithProviders(
      <>
        <Refresher intervalMs={15} />
        <Gated />
      </>,
    );
    await ready();
    const before = queryClient.getQueryData(sessionKey);

    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(3));

    expect(queryClient.getQueryData(sessionKey)).toBe(before);
    expect(refund()).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('lab on');
  });
});

describe('lifecycle', () => {
  it('stops polling when unmounted', async () => {
    const requests = watchPolicyRequests();
    const { unmount } = renderWithProviders(
      <>
        <Refresher intervalMs={15} />
        <Gated />
      </>,
    );
    await ready();
    await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(2));

    unmount();
    const settled = requests.length;
    await delay(100);
    // At most one request that was already on its way when the component went away.
    expect(requests.length).toBeLessThanOrEqual(settled + 1);
    const afterGrace = requests.length;
    await delay(100);
    expect(requests.length).toBe(afterGrace);
  });

  it('starts afresh for the new hospital after a switch', async () => {
    signIn(USER_IDS.doctor, TENANT_IDS.hospital);
    const requests = watchPolicyRequests();
    renderWithProviders(
      <>
        <Refresher intervalMs={20} />
        <Gated />
        <SwitchToClinic />
      </>,
    );
    await ready();
    expect(screen.getByRole('status')).toHaveTextContent('lab on');
    // By now the hospital's ETag is being sent.
    await waitFor(() => expect(requests.some((r) => r.ifNoneMatch !== null)).toBe(true));

    await userEvent.click(screen.getByRole('button', { name: 'Go to clinic' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('lab off'));

    await waitFor(() =>
      expect(requests.filter((r) => r.tenant === TENANT_IDS.clinic).length).toBeGreaterThanOrEqual(
        2,
      ),
    );
    const clinic = requests.filter((r) => r.tenant === TENANT_IDS.clinic);
    // The first request for the clinic does not carry the hospital's ETag.
    expect(clinic[0]?.ifNoneMatch).toBeNull();
    expect(clinic.at(-1)?.ifNoneMatch).toMatch(new RegExp(`^"${TENANT_IDS.clinic}\\.`));
  });
});
